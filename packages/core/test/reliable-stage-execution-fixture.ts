import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  buildCtoSliceMarker,
  createWorkflowSessionController,
  parseDispatchMarker,
  registerStageProducerTool,
  registerTeamWorkflow,
  registerWorkflowCommands,
  registerWorkflowTools,
  type CtoState,
  type Profile,
  type StageRecoveryHost,
  type StageProducerToolDefinition,
  type TrustedExecutionContext,
  type WorkflowSessionController,
} from "../src/index.js";
import { createTaskCaller } from "../src/engine/stage.js";
import type { TaskCaller, TaskResult, TaskToolLike } from "../src/engine/stage.js";
import { appendWave, readCtoState } from "../src/cto/state.js";
import { readRunControl, runTarget } from "../src/engine/run-store.js";
import { assertCtoSliceDispatchable } from "../src/cto/slice-gate.js";
import { loadProfile } from "../src/engine/profile.js";
import { recordScenarioEvent } from "./reliable-stage-trace.js";

export const BRANCH = "reliable-stage-execution";
export const CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: "reliable-stage-test",
};
export const CTO_CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
};

const checkpointPolicy = loadProfile("lightweight")?.checkpoint_policy;
if (!checkpointPolicy) throw new Error("lightweight checkpoint policy is required by the reliable-stage fixture");

export const RELIABLE_PROFILE: Profile = {
  name: "reliable-stage-test",
  title: "Reliable stage execution test profile",
  description: "A real registered two-stage profile used only by deterministic acceptance.",
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
    {
      id: "next",
      title: "Next stage",
      type: "single",
      role: "dev",
      produces: "next",
    },
  ],
};

export type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};

export type RegisteredCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};

export type SessionManager = {
  getCwd: () => string;
  getSessionId: () => string;
  getSessionFile: () => string;
  getHeader: () => { id: string; cwd: string; parentSession?: string };
};

export type HostContext = Record<string, unknown> & {
  sessionManager: SessionManager;
  session_id: string;
  cwd: string;
  sessionFile: string;
};

export type CapturedHostMessage = {
  message: unknown;
  options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
};

export type RecoveryDispatchBarrier = {
  queued: Promise<void>;
  release: () => void;
};

export type Harness = {
  root: string;
  context: HostContext;
  controller: WorkflowSessionController;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  messages: CapturedHostMessage[];
  waitForRecoveryMessage: (predicate?: (message: CapturedHostMessage) => boolean) => Promise<CapturedHostMessage>;
  withRecoveryDispatchBarrier: <T>(callback: (barrier: RecoveryDispatchBarrier) => Promise<T>) => Promise<T>;
  emit: (name: string, ...args: unknown[]) => Promise<unknown[]>;
  close: () => Promise<void>;
  registeredWorkflowProfiles?: Profile[];
  ctoTeams?: CtoTeamFixture[];
  ctoTeamsConfigured?: boolean;
};

export type Handoff = {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  stage_cursor: string;
  cursor_epoch: string;
  loop_iteration: number;
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
  [key: string]: unknown;
};

export type ToolDetails = Record<string, unknown>;

export type InterpreterTaskRequest = {
  agent: string;
  task: string;
  name?: string;
  effort?: "lo" | "med" | "hi";
};

export type WorkerFixture = {
  toolCallId: string;
  input: InterpreterTaskRequest;
  childContext: HostContext;
  childFile: string;
};
export type NativeWorkerFixture = WorkerFixture & {
  lead: WorkerFixture;
};

export type InterpreterTaskExecute = (worker: WorkerFixture, request: InterpreterTaskRequest) => TaskResult | PromiseLike<TaskResult>;

export type FixtureRoute = "ordinary" | "cto";

export type CtoTeamFixture = {
  id: string;
  sliceId: string;
  lead: string;
  roster: string[];
  name?: string;
  scope?: string[];
  profile?: string;
};

export type CoreFixtureOptions = {
  route?: FixtureRoute;
  root?: string;
  branch?: string;
  sessionId?: string;
  workflowProfiles?: Profile[];
  roles?: Record<string, string>;
  scopeMap?: Array<{ glob: string[]; scope: string; dev_agent: string }>;
  stageProducerTools?: StageProducerToolDefinition[];
  stageRecoveryHost?: StageRecoveryHost;
  readOnlyBashAgents?: readonly string[];
  ctoTeams?: CtoTeamFixture[];
};

type PrepareDetails = {
  ok?: boolean;
  error?: string;
  state?: { run_id?: string };
};

export function toolDetails(value: unknown): ToolDetails {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as ToolDetails;
}

export const details = toolDetails;

export async function emit(harness: Harness, name: string, ...args: unknown[]): Promise<unknown[]> {
  return harness.emit(name, ...args);
}

export function sessionManager(root: string, id: string, file: string, parentSession?: string): SessionManager {
  const header = { id, cwd: root, ...(parentSession ? { parentSession } : {}) };
  return {
    getCwd: () => root,
    getSessionId: () => id,
    getSessionFile: () => file,
    getHeader: () => header,
  };
}

function createRoot(prefix: string, branch: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
  return root;
}

function registerHarness(
  root: string,
  context: HostContext,
  controller: WorkflowSessionController,
  options: {
    workflowProfiles?: Profile[];
    roles: Record<string, string>;
    scopeMap: Array<{ glob: string[]; scope: string; dev_agent: string }>;
    stageProducerTools?: StageProducerToolDefinition[];
    stageRecoveryHost?: StageRecoveryHost;
    readOnlyBashAgents?: readonly string[];
    ctoTeams?: CtoTeamFixture[];
    ctoTeamsConfigured?: boolean;
  },
  cto = false,
  ownsRoot = true,
): Harness {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const messages: CapturedHostMessage[] = [];
  const waiters: Array<{
    predicate: (message: CapturedHostMessage) => boolean;
    resolve: (message: CapturedHostMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const on = (name: string, handler: (...args: unknown[]) => unknown): void => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  const waitForRecoveryMessage = (
    predicate: (message: CapturedHostMessage) => boolean = (entry) => {
      const message = entry.message;
      return Boolean(message && typeof message === "object" && (message as { customType?: unknown }).customType === "omp-workflow-stage-recovery");
    },
  ): Promise<CapturedHostMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (closed) return Promise.reject(new Error("fixture harness is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("timed out waiting for a recovery host message"));
      }, 5_000);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };
  const deliverMessage = (captured: CapturedHostMessage): void => {
    messages.push(captured);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(captured)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(captured);
    }
  };
  type PendingRecoveryDispatch = {
    captured: CapturedHostMessage;
    resolve: () => void;
  };
  type ActiveRecoveryDispatchBarrier = {
    pending: PendingRecoveryDispatch[];
    resolveQueued: () => void;
    queued: boolean;
    released: boolean;
  };
  let activeRecoveryDispatchBarrier: ActiveRecoveryDispatchBarrier | undefined;
  const isRecoveryMessage = (message: unknown): boolean => Boolean(
    message
    && typeof message === "object"
    && !Array.isArray(message)
    && (message as { customType?: unknown }).customType === "omp-workflow-stage-recovery",
  );
  const sendMessage = (message: unknown, options?: CapturedHostMessage["options"]): void | Promise<void> => {
    const captured: CapturedHostMessage = { message, ...(options ? { options } : {}) };
    const barrier = activeRecoveryDispatchBarrier;
    if (barrier && isRecoveryMessage(message)) {
      const delivery = new Promise<void>((resolve) => {
        barrier.pending.push({ captured, resolve });
      });
      if (!barrier.queued) {
        barrier.queued = true;
        barrier.resolveQueued();
      }
      return delivery;
    }
    deliverMessage(captured);
  };
  const withRecoveryDispatchBarrier = async <T>(
    callback: (barrier: RecoveryDispatchBarrier) => Promise<T>,
  ): Promise<T> => {
    if (activeRecoveryDispatchBarrier) throw new Error("recovery dispatch barrier already active");
    let resolveQueued!: () => void;
    const queued = new Promise<void>((resolve) => { resolveQueued = resolve; });
    const state: ActiveRecoveryDispatchBarrier = { pending: [], resolveQueued, queued: false, released: false };
    activeRecoveryDispatchBarrier = state;
    const barrier: RecoveryDispatchBarrier = {
      queued,
      release: () => {
        if (state.released) return;
        state.released = true;
        if (activeRecoveryDispatchBarrier === state) activeRecoveryDispatchBarrier = undefined;
        for (const pending of state.pending.splice(0)) {
          deliverMessage(pending.captured);
          pending.resolve();
        }
      },
    };
    try {
      return await callback(barrier);
    } finally {
      barrier.release();
    }
  };
  const pi = {
    zod: { z },
    setLabel() {},
    on,
    events: { on },
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    sendMessage,
    sendUserMessage() {},
  };
  const actorResolver = (ctx: unknown, cwd: string, runId: string | undefined) => {
    if (ctx !== context) return undefined;
    if (cto) {
      const scope = controller.activeCtoClaim();
      if (scope && (!runId || scope.run_id === runId)) {
        return { kind: "authenticated-interactive-host-cto" as const, run_id: scope.run_id, ownership_epoch: scope.ownership_epoch };
      }
      return !scope && !runId ? { kind: "authenticated-interactive-host-no-run" as const } : undefined;
    }
    if (!runId) return { kind: "authenticated-interactive-host-no-run" as const };
    const artifactsDir = runTarget(cwd, runId).artifactsDir;
    return { actor: "orchestrator" as const, artifactsDir };
  };
  const registration = {
    cwd: root,
    resolveCwd: () => root,
    roles: options.roles,
    scopeMap: options.scopeMap,
    workflowProfiles: options.workflowProfiles,
    getSessionController: (ctx: unknown) => ctx === context ? controller : undefined,
    resolveTrustedToolCallActor: actorResolver,
    readOnlyBashAgents: options.readOnlyBashAgents,
    ...(options.stageRecoveryHost ? { stageRecoveryHost: options.stageRecoveryHost } : {}),
    observability: false,
  };
  registerTeamWorkflow(pi as never, registration);
  registerWorkflowTools(pi as never, registration);
  for (const producer of options.stageProducerTools ?? []) {
    registerStageProducerTool(pi as never, producer);
    recordScenarioEvent({ kind: "tool_registered", route: cto ? "C" : "O", tool: producer.name });
  }
  registerWorkflowCommands(pi as never, {
    cwd: root,
    resolveCwd: () => root,
    getSessionController: (ctx: unknown) => ctx === context ? controller : undefined,
  });
  recordScenarioEvent({ kind: "workflow_registered", route: cto ? "C" : "O", count: tools.size });
  const submitTool = tools.get("workflow_submit_result");
  if (submitTool) {
    const execute = submitTool.execute;
    tools.set("workflow_submit_result", {
      ...submitTool,
      execute: async (...args: unknown[]) => {
        const result = await execute(...args);
        const detail = result.details;
        const record = detail && typeof detail === "object" && !Array.isArray(detail) ? detail as Record<string, unknown> : undefined;
        const receipt = record?.receipt && typeof record.receipt === "object" && !Array.isArray(record.receipt) ? record.receipt as Record<string, unknown> : undefined;
        const binding = receipt?.binding && typeof receipt.binding === "object" && !Array.isArray(receipt.binding) ? receipt.binding as Record<string, unknown> : undefined;
        const identity = binding?.identity && typeof binding.identity === "object" && !Array.isArray(binding.identity) ? binding.identity as Record<string, unknown> : undefined;
        recordScenarioEvent({
          kind: "stage_submitted",
          route: cto ? "C" : "O",
          tool: "workflow_submit_result",
          ...(typeof record?.ok === "boolean" ? { outcome: record.ok ? "ACCEPTED" : "REJECTED" } : {}),
          ...(typeof receipt?.receipt_id === "string" ? { identities: { receipt: receipt.receipt_id } } : {}),
          ...(typeof identity?.dispatch_id === "string" && typeof receipt?.receipt_id === "string"
            ? { links: { dispatch_of: receipt.receipt_id, dispatch: identity.dispatch_id } }
            : {}),
        });
        return result;
      },
    });
  }
  const emitHandlers = async (name: string, args: unknown[]): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(...args);
      results.push(result);
      if (
        name === "tool_call"
        && result
        && typeof result === "object"
        && !Array.isArray(result)
        && (result as { block?: unknown }).block === true
      ) break;
    }
    return results;
  };
  return {
    root,
    context,
    controller,
    tools,
    commands,
    messages,
    waitForRecoveryMessage,
    withRecoveryDispatchBarrier,
    emit: async (name, ...args) => emitHandlers(name, args),
    registeredWorkflowProfiles: options.workflowProfiles,
    ctoTeams: options.ctoTeams,
    ctoTeamsConfigured: options.ctoTeamsConfigured,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try {
          activeRecoveryDispatchBarrier?.release();
          await emitHandlers("session_shutdown", [{ type: "session_shutdown" }, context]);
        } finally {
          closed = true;
          const error = new Error("fixture harness is closed");
          for (const waiter of waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
          }
          if (ownsRoot) rmSync(root, { recursive: true, force: true });
        }
      })();
      return closePromise;
    },
  };
}

export function createCoreFixture(options: CoreFixtureOptions = {}): Harness {
  const route = options.route ?? "ordinary";
  const branch = options.branch ?? BRANCH;
  const cto = route === "cto";
  const ownsRoot = options.root === undefined;
  const root = options.root ?? createRoot(`omp-reliable-stage-${route}-`, branch);
  const roles = options.roles ?? (cto ? {
    dev: "developer",
    "team-lead": "team-lead",
    ...(options.ctoTeams ? Object.fromEntries(options.ctoTeams.flatMap((team): Array<[string, string]> => [[team.lead, team.lead], ...team.roster.map((agent): [string, string] => [agent, agent])])) : {}),
  } : { dev: "developer" });
  const scopeMap = options.scopeMap ?? [{ glob: ["**/*"], scope: cto ? "backend" : "default", dev_agent: "developer" }];
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles, scope_map: scopeMap }) + "\n");
  const ctoTeams = cto
    ? options.ctoTeams ?? (() => {
      const lead = Object.entries(roles).find(([, agent]) => agent === "team-lead")?.[0] ?? "team-lead";
      const roster = Object.keys(roles).filter((role) => role !== lead);
      return [{ id: "team-a", sliceId: "slice-a", name: "Team A", scope: ["backend"], profile: "lightweight", lead, roster }];
    })()
    : undefined;
  if (cto) {
    writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify((ctoTeams ?? []).map((team) => ({
      id: team.id,
      name: team.name ?? team.id,
      scope: team.scope ?? ["backend"],
      profile: team.profile ?? "lightweight",
      lead: team.lead,
      roster: team.roster,
    }))) + "\n");
  }
  const sessionId = options.sessionId ?? `reliable-stage-${route}`;
  const sessionFile = join(root, `${sessionId}-host.jsonl`);
  const manager = sessionManager(root, sessionId, sessionFile);
  const trusted: TrustedExecutionContext = {
    session_id: sessionId,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch,
    authority: "coordinator",
  };
  const controller = createWorkflowSessionController({ cwd: root, context: trusted, ...(cto ? { owner_kind: "cto" as const } : {}) });
  const context: HostContext = {
    ...trusted,
    cwd: root,
    mode: "tui",
    hasUI: true,
    session_id: sessionId,
    sessionFile,
    sessionManager: manager,
    ui: { select: async () => "proceed", notify() {} },
  };
  return registerHarness(root, context, controller, {
    workflowProfiles: options.workflowProfiles,
    roles,
    scopeMap: options.scopeMap ?? [{ glob: ["**/*"], scope: cto ? "backend" : "default", dev_agent: "developer" }],
    stageProducerTools: options.stageProducerTools,
    stageRecoveryHost: options.stageRecoveryHost,
    readOnlyBashAgents: options.readOnlyBashAgents,
    ctoTeams,
    ctoTeamsConfigured: options.ctoTeams !== undefined,
  }, cto, ownsRoot);
}

export function ordinaryHarness(options: Pick<CoreFixtureOptions, "root" | "workflowProfiles" | "stageProducerTools" | "stageRecoveryHost" | "readOnlyBashAgents" | "branch" | "sessionId" | "roles" | "scopeMap" | "ctoTeams"> = {}): Harness {
  return createCoreFixture({ route: "ordinary", workflowProfiles: options.workflowProfiles ?? [RELIABLE_PROFILE], ...options });
}

export function ctoHarness(options: Pick<CoreFixtureOptions, "root" | "workflowProfiles" | "stageProducerTools" | "stageRecoveryHost" | "branch" | "sessionId" | "roles" | "scopeMap" | "ctoTeams"> = {}): Harness {
  return createCoreFixture({ route: "cto", ...options });
}

export type OrdinaryIngressOptions = {
  classification?: Record<string, unknown>;
  task?: string;
  files?: string[];
  prepare_id?: string;
  begin_id?: string;
};

export async function ordinaryIngress(harness: Harness, options: OrdinaryIngressOptions = {}): Promise<{ runId: string; handoff: Handoff }> {
  await emit(harness, "session_start", { type: "session_start" }, harness.context);
  const prepare = harness.tools.get("workflow_prepare");
  assert.ok(prepare, "registered workflow_prepare ingress is required");
  const prepared = await prepare.execute(
    options.prepare_id ?? "reliable-stage-prepare",
    {
      mode: "new",
      task: options.task ?? "exercise reliable stage execution",
      classification: options.classification ?? CLASSIFICATION,
      ...(options.files === undefined ? {} : { files: options.files }),
    },
    undefined,
    undefined,
    harness.context,
  );
  const preparedDetails = toolDetails(prepared.details) as PrepareDetails;
  assert.equal(preparedDetails.ok, true, preparedDetails.error);
  const runId = preparedDetails.state?.run_id;
  assert.ok(runId, "registered workflow_prepare must persist a run identity");
  const begin = harness.tools.get("workflow_begin");
  assert.ok(begin, "registered workflow_begin ingress is required");
  const begun = await begin.execute(options.begin_id ?? "reliable-stage-begin", {}, undefined, undefined, harness.context);
  const begunDetails = toolDetails(begun.details);
  assert.equal(begunDetails.ok, true, JSON.stringify(begunDetails));
  const handoff = begunDetails.handoff;
  assert.ok(handoff && typeof handoff === "object" && !Array.isArray(handoff), "workflow_begin must return an opaque stage handoff");
  const typedHandoff = handoff as Handoff;
  const workflow = typeof (options.classification ?? CLASSIFICATION).workflow === "string"
    ? (options.classification ?? CLASSIFICATION).workflow as string
    : "reliable-stage-test";
  recordScenarioEvent({ kind: "workflow_started", route: "O", workflow, identities: { run: runId } });
  recordScenarioEvent({ kind: "stage_entered", route: "O", workflow, stage: typedHandoff.stage_cursor, identities: { run: runId, stage: typedHandoff.stage_cursor } });
  return { runId, handoff: typedHandoff };
}

export type CtoIngressOptions = {
  profile?: string;
  classification?: Record<string, unknown>;
};

export async function ctoIngress(harness: Harness, options: CtoIngressOptions = {}): Promise<{ runId: string; state: CtoState }> {
  await emit(harness, "session_start", { type: "session_start" }, harness.context);
  const command = harness.commands.get("cto");
  assert.ok(command, "registered cto ingress is required");
  await command.handler("exercise reliable native stage execution", harness.context);
  const runId = readRunControl(harness.root).execution_claim?.run_id;
  assert.ok(runId, "registered CTO ingress must acquire a claim");
  const ctoStateTool = harness.tools.get("cto_state");
  assert.ok(ctoStateTool, "registered cto_state ingress is required");
  const read = await ctoStateTool.execute("reliable-cto-read", { operation: "read", run_id: runId }, undefined, undefined, harness.context);
  const readDetails = toolDetails(read.details);
  assert.equal(readDetails.ok, true, JSON.stringify(readDetails));
  const state = readDetails.state;
  assert.ok(state && typeof state === "object" && !Array.isArray(state), "cto_state read must return canonical native state");
  const candidate = structuredClone(state) as CtoState;
  const teams = harness.ctoTeamsConfigured
    ? harness.ctoTeams ?? []
    : [{ id: "team-a", sliceId: "slice-a", lead: "team-lead", roster: ["developer"], scope: ["backend"], profile: options.profile ?? "lightweight" }];
  assert.ok(teams.length > 0, "native CTO fixture requires at least one configured team");
  candidate.plan.teams = teams.map((team) => ({
    team: team.id,
    scope: team.scope ?? ["backend"],
    slice: team.sliceId,
    profile: team.profile ?? options.profile ?? "lightweight",
    worktree: "same_branch",
    depends_on: [],
  }));
  candidate.teams = teams.map((team) => ({
    id: team.id,
    status: "pending",
    escalations: {},
    slice_id: team.sliceId,
    classification: options.classification ?? CTO_CLASSIFICATION,
    workflow: team.profile ?? options.profile ?? "lightweight",
    dod_path: `.work-state/artifacts/${team.id}/dod.json`,
  }));
  appendWave(candidate, {
    id: "wave-1",
    source: "test",
    source_id: "reliable-stage-wave-1",
    task: candidate.task,
    slice_ids: teams.map((team) => team.sliceId),
  });
  for (const team of teams) {
    mkdirSync(join(harness.root, ".work-state", "artifacts", team.id), { recursive: true });
    writeFileSync(join(harness.root, ".work-state", "artifacts", team.id, "dod.json"), JSON.stringify({
      items: [{ id: "d1", source: "test", criterion: `${team.id} native result`, verify_method: "submission", status: "pending", evidence: "" }],
      type_requirements_met: true,
      updated_at: new Date().toISOString(),
    }) + "\n");
  }
  const committed = await ctoStateTool.execute(
    "reliable-cto-setup",
    { operation: "commit", run_id: runId, expected_state_revision: String(readDetails.state_revision), state: candidate },
    undefined,
    undefined,
    harness.context,
  );
  const committedDetails = toolDetails(committed.details);
  assert.equal(committedDetails.ok, true, JSON.stringify(committedDetails));
  const workflow = teams[0]?.profile ?? options.profile ?? "lightweight";
  const configuredProfile = harness.registeredWorkflowProfiles === undefined
    ? loadProfile(workflow)
    : harness.registeredWorkflowProfiles.find((profile) => profile.name === workflow);
  const canonicalStage = teams[0] ? readCtoState(runId, harness.root)?.native_stage_progress?.[teams[0].id]?.stage_id : undefined;
  const initialStage = canonicalStage ?? configuredProfile?.stages[0]?.id;
  recordScenarioEvent({ kind: "workflow_started", route: "C", workflow, identities: { run: runId } });
  if (initialStage) {
    recordScenarioEvent({ kind: "stage_entered", route: "C", workflow, stage: initialStage, identities: { run: runId, stage: initialStage } });
  }
  return { runId, state: candidate };
}

async function admitOrdinaryWorkerInput(
  harness: Harness,
  toolCallId: string,
  input: InterpreterTaskRequest,
  suffix: string,
  stageCursor: string,
): Promise<WorkerFixture> {
  const blocked = await emit(harness, "tool_call", { toolName: "task", toolCallId, input }, harness.context);
  assert.equal(blocked.filter(Boolean).length, 0, JSON.stringify(blocked));
  await emit(harness, "tool_execution_start", { toolName: "task", toolCallId, args: input }, harness.context);
  const childFile = join(harness.root, `${suffix}-worker.jsonl`);
  const childId = `reliable-${suffix}-worker`;
  const childManager = sessionManager(harness.root, childId, childFile, harness.context.sessionFile);
  const childContext: HostContext = {
    cwd: harness.root,
    mode: "print",
    hasUI: false,
    session_id: childId,
    sessionFile: childFile,
    sessionManager: childManager,
  };
  await emit(harness, "task:subagent:lifecycle", {
    id: `${toolCallId}-lifecycle`,
    agent: input.agent,
    status: "started",
    sessionFile: childFile,
    parentToolCallId: toolCallId,
    index: 0,
  });
  recordScenarioEvent({
    kind: "worker_admitted",
    route: "O",
    tool: "task",
    identities: { worker: childId, task: toolCallId, stage: stageCursor },
    links: { worker_of: toolCallId, stage_of: stageCursor },
    outcome: "STARTED",
  });
  recordScenarioEvent({ kind: "worker_started", route: "O", tool: "task", identities: { worker: childId, task: toolCallId } });
  return { toolCallId, input, childContext, childFile };
}

async function admitOrdinaryBatchInputs(
  harness: Harness,
  toolCallId: string,
  input: { context: string; tasks: InterpreterTaskRequest[] },
  suffix: string,
  stageCursor: string,
): Promise<WorkerFixture[]> {
  assert.ok(input.tasks.length > 1, "consilium fixture must expose multiple worker assignments");
  const blocked = await emit(harness, "tool_call", { toolName: "task", toolCallId, input }, harness.context);
  assert.equal(blocked.filter(Boolean).length, 0, JSON.stringify(blocked));
  await emit(harness, "tool_execution_start", { toolName: "task", toolCallId, args: input }, harness.context);
  const workers: WorkerFixture[] = [];
  for (const [index, taskInput] of input.tasks.entries()) {
    const childFile = join(harness.root, `${suffix}-worker-${index}.jsonl`);
    const childId = `reliable-${suffix}-worker-${index}`;
    const childManager = sessionManager(harness.root, childId, childFile, harness.context.sessionFile);
    const childContext: HostContext = {
      cwd: harness.root,
      mode: "print",
      hasUI: false,
      session_id: childId,
      sessionFile: childFile,
      sessionManager: childManager,
    };
    await emit(harness, "task:subagent:lifecycle", {
      id: `${toolCallId}-lifecycle-${index}`,
      agent: taskInput.agent,
      status: "started",
      sessionFile: childFile,
      parentToolCallId: toolCallId,
      index,
    });
    const worker = { toolCallId, input: taskInput, childContext, childFile };
    workers.push(worker);
    recordScenarioEvent({
      kind: "worker_admitted",
      route: "O",
      tool: "task",
      identities: { worker: childId, task: toolCallId, stage: stageCursor, slot: index },
      links: { worker_of: toolCallId, stage_of: stageCursor },
      outcome: "STARTED",
    });
    recordScenarioEvent({ kind: "worker_started", route: "O", tool: "task", identities: { worker: childId, task: toolCallId, slot: index } });
  }
  return workers;
}

export async function admitOrdinaryWorker(harness: Harness, handoff: Handoff, suffix: string): Promise<WorkerFixture> {
  const roster = handoff.expected_roster[0];
  const marker = handoff.dispatch_markers[0];
  assert.ok(roster && marker, "workflow_begin must expose exactly one worker assignment");
  return admitOrdinaryWorkerInput(
    harness,
    `reliable-${suffix}-task`,
    { agent: roster.agent, task: marker.marker },
    suffix,
    handoff.stage_cursor,
  );
}

export async function admitOrdinaryBatchWorkers(harness: Harness, handoff: Handoff, suffix: string): Promise<WorkerFixture[]> {
  assert.ok(handoff.expected_roster.length > 1, "consilium fixture must expose multiple worker assignments");
  assert.equal(handoff.dispatch_markers.length, handoff.expected_roster.length, "consilium fixture roster and markers must align");
  const inputs = handoff.expected_roster.map((roster, index) => {
    const marker = handoff.dispatch_markers[index];
    assert.ok(marker, `consilium fixture must expose marker ${index}`);
    return { agent: roster.agent, task: marker.marker };
  });
  return admitOrdinaryBatchInputs(
    harness,
    `reliable-${suffix}-task`,
    { context: "shared context", tasks: inputs },
    suffix,
    handoff.stage_cursor,
  );
}

export async function admitCtoLeadForTeam(
  harness: Harness,
  runId: string,
  teamId: string,
  sliceId: string,
  leadAgent: string,
  suffix = "",
): Promise<WorkerFixture> {
  const claim = readRunControl(harness.root).execution_claim;
  assert.equal(claim?.owner_kind, "cto", "fixture must retain a native CTO claim");
  assert.equal(claim?.coordinator_session_id, harness.context.sessionManager.getSessionId(), "fixture host must own the CTO claim");
  const state = readCtoState(runId, harness.root);
  assert.ok(state, "fixture native state must exist");
  const sliceReady = assertCtoSliceDispatchable(state, { sliceId, root: harness.root, markerRunId: runId });
  assert.equal(sliceReady.ok, true, JSON.stringify(sliceReady));
  const tag = suffix ? `-${suffix}` : "";
  const leadBase = teamId === "team-a" ? "reliable-cto-lead" : `reliable-cto-${teamId}-lead`;
  const leadCallId = `${leadBase}-task${tag}`;
  const marker = buildCtoSliceMarker(runId, sliceId);
  const leadInput = { agent: leadAgent, task: `${marker}\nlead handoff` };
  const rootAdmission = await emit(harness, "tool_call", { toolName: "task", toolCallId: leadCallId, input: leadInput }, harness.context);
  assert.equal(rootAdmission.filter(Boolean).length, 0, JSON.stringify(rootAdmission));
  await emit(harness, "tool_execution_start", { toolName: "task", toolCallId: leadCallId, args: leadInput }, harness.context);
  const leadFile = join(harness.root, `${leadBase}${tag}.jsonl`);
  const leadId = `${leadBase}${tag}`;
  const leadManager = sessionManager(harness.root, leadId, leadFile, harness.context.sessionFile);
  const leadContext: HostContext = { cwd: harness.root, mode: "print", hasUI: false, session_id: leadId, sessionFile: leadFile, sessionManager: leadManager };
  await emit(harness, "task:subagent:lifecycle", {
    id: `${leadCallId}-lifecycle`, agent: leadAgent, status: "started", sessionFile: leadFile, parentToolCallId: leadCallId, index: 0,
  });
  recordScenarioEvent({ kind: "worker_admitted", route: "C", tool: "task", identities: { worker: leadId, task: leadCallId, run: runId, team: teamId, slice: sliceId }, links: { worker_of: leadCallId }, outcome: "STARTED" });
  recordScenarioEvent({ kind: "worker_started", route: "C", tool: "task", identities: { worker: leadId, task: leadCallId, run: runId, team: teamId, slice: sliceId } });
  return { toolCallId: leadCallId, input: leadInput, childContext: leadContext, childFile: leadFile };
}

export async function admitCtoLead(harness: Harness, runId: string, suffix = ""): Promise<WorkerFixture> {
  return admitCtoLeadForTeam(harness, runId, "team-a", "slice-a", "team-lead", suffix);
}
export type CtoLeadBatchSpec = {
  teamId: string;
  sliceId: string;
  suffix?: string;
  leadAgent?: string;
};

export async function admitCtoLeadBatch(harness: Harness, runId: string, specs: CtoLeadBatchSpec[]): Promise<WorkerFixture[]> {
  const admitted: WorkerFixture[] = [];
  for (const spec of specs) {
    const configured = harness.ctoTeams?.find((team) => team.id === spec.teamId);
    admitted.push(await admitCtoLeadForTeam(
      harness,
      runId,
      spec.teamId,
      spec.sliceId,
      spec.leadAgent ?? configured?.lead ?? "team-lead",
      spec.suffix ?? spec.teamId,
    ));
  }
  return admitted;
}


export async function admitCtoWorkerForTeam(
  harness: Harness,
  runId: string,
  lead: WorkerFixture,
  teamId: string,
  sliceId: string,
  suffix = "",
  agent = "developer",
): Promise<NativeWorkerFixture> {
  const marker = buildCtoSliceMarker(runId, sliceId);
  const tag = suffix ? `-${suffix}` : "";
  const workerBase = teamId === "team-a" ? "reliable-cto-worker" : `reliable-cto-${teamId}-worker`;
  const workerCallId = `${workerBase}-task${tag}`;
  const workerInput = { agent, task: `${marker}\nworker handoff` };
  const workerAdmission = await emit(harness, "tool_call", { toolName: "task", toolCallId: workerCallId, input: workerInput }, lead.childContext);
  assert.equal(workerAdmission.filter(Boolean).length, 0, JSON.stringify(workerAdmission));
  await emit(harness, "tool_execution_start", { toolName: "task", toolCallId: workerCallId, args: workerInput }, lead.childContext);
  const workerFile = join(harness.root, `${workerBase}${tag}.jsonl`);
  const workerId = `${workerBase}${tag}`;
  const workerManager = sessionManager(harness.root, workerId, workerFile, lead.childFile);
  const childContext: HostContext = { cwd: harness.root, mode: "print", hasUI: false, session_id: workerId, sessionFile: workerFile, sessionManager: workerManager };
  await emit(harness, "task:subagent:lifecycle", {
    id: `${workerCallId}-lifecycle`, agent, status: "started", sessionFile: workerFile, parentToolCallId: workerCallId, index: 0,
  });
  recordScenarioEvent({ kind: "worker_admitted", route: "C", tool: "task", identities: { worker: workerId, task: workerCallId, run: runId, team: teamId, slice: sliceId }, links: { worker_of: workerCallId }, outcome: "STARTED" });
  recordScenarioEvent({ kind: "worker_started", route: "C", tool: "task", identities: { worker: workerId, task: workerCallId, run: runId, team: teamId, slice: sliceId } });
  return { toolCallId: workerCallId, input: workerInput, childContext, childFile: workerFile, lead };
}

export async function admitCtoWorker(
  harness: Harness,
  runId: string,
  lead: WorkerFixture,
  suffix = "",
  agent = "developer",
): Promise<NativeWorkerFixture> {
  return admitCtoWorkerForTeam(harness, runId, lead, "team-a", "slice-a", suffix, agent);
}

async function admitDefaultCtoDiscoveryAndWorker(harness: Harness, runId: string, suffix: string): Promise<NativeWorkerFixture> {
  const discoveryTag = suffix ? `${suffix}-discovery` : "discovery";
  const lead = await admitCtoLead(harness, runId, discoveryTag);
  const dodPath = join(harness.root, ".work-state", "artifacts", "team-a", "dod.json");
  const dod = JSON.parse(readFileSync(dodPath, "utf8")) as Record<string, unknown>;
  const discovery = {
    task: "exercise reliable native stage execution",
    branch: BRANCH,
    constraints: [],
  };
  const submitted = toolDetails((await requireTool(harness, "workflow_submit_result").execute(
    `reliable-cto-discovery-submit${suffix ? `-${suffix}` : ""}`,
    submission({ discovery, dod }),
    undefined,
    undefined,
    lead.childContext,
  )).details);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const advanced = await advanceCtoStage(
    harness,
    "slice-a",
    `reliable-cto-discovery-advance${suffix ? `-${suffix}` : ""}`,
  );
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  await terminalWorker(harness, lead);
  const nextLead = await admitCtoLead(harness, runId, suffix ? `${suffix}-lead` : "lead");
  return admitCtoWorker(harness, runId, nextLead, suffix);
}

export async function admitCtoLeadAndWorker(harness: Harness, runId: string, suffix = ""): Promise<NativeWorkerFixture> {
  const state = readCtoState(runId, harness.root);
  const team = state?.plan.teams.find((entry) => entry.team === "team-a");
  const nativeStage = state?.native_stage_progress?.["team-a"]?.stage_id;
  if (harness.registeredWorkflowProfiles === undefined
    && team?.profile === "lightweight"
    && (nativeStage === undefined || nativeStage === "discovery")) {
    return admitDefaultCtoDiscoveryAndWorker(harness, runId, suffix);
  }
  const lead = await admitCtoLead(harness, runId, suffix);
  return admitCtoWorker(harness, runId, lead, suffix);
}

function isTerminalTaskResult(result: TaskResult | undefined): result is TaskResult {
  return Boolean(
    result
    && result.pending !== true
    && typeof result.id === "string"
    && typeof result.output === "string"
    && Number.isFinite(result.exitCode),
  );
}


function taskResultRow(worker: WorkerFixture, result: TaskResult | undefined, index: number, failed: boolean, batch = false): Record<string, unknown> {
  const terminal = isTerminalTaskResult(result);
  const exitCode = terminal ? result.exitCode : failed ? 1 : 0;
  const output = terminal ? result.output : failed ? "worker failed" : "worker terminal result";
  return {
    index,
    id: terminal ? result.id : `${worker.toolCallId}-result${batch ? `-${index}` : index === 0 ? "" : `-${index}`}`,
    ...(terminal && result.slot_id ? { slot_id: result.slot_id } : {}),
    ...(terminal && result.task_id ? { task_id: result.task_id } : {}),
    ...(terminal && result.dispatch_id ? { dispatch_id: result.dispatch_id } : {}),
    ...(terminal && result.capability_id ? { capability_id: result.capability_id } : {}),
    ...(terminal && result.capability_epoch ? { capability_epoch: result.capability_epoch } : {}),
    agent: worker.input.agent,
    agentSource: "project",
    task: worker.input.task,
    exitCode,
    output,
    ...(terminal && result.error ? { error: result.error } : {}),
    stderr: "",
    truncated: false,
    durationMs: 1,
    tokens: 1,
    requests: 1,
  };
}

export async function terminalWorker(harness: Harness, worker: WorkerFixture, failed = false, result?: TaskResult): Promise<void> {
  const terminal = result === undefined || isTerminalTaskResult(result);
  if (!terminal) return;
  const effectiveFailed = result ? result.exitCode !== 0 || Boolean(result.error) : failed;
  const row = taskResultRow(worker, result, 0, effectiveFailed);
  await emit(harness, "tool_result", {
    toolName: "task",
    toolCallId: worker.toolCallId,
    input: worker.input,
    details: { results: [row] },
    content: [{ type: "text", text: effectiveFailed ? (result?.error ?? "worker failed") : (result?.output || "worker terminal result") }],
    isError: effectiveFailed,
  }, harness.context);
  await emit(harness, "task:subagent:lifecycle", {
    id: `${worker.toolCallId}-lifecycle`,
    agent: worker.input.agent,
    status: effectiveFailed ? "failed" : "completed",
    sessionFile: worker.childFile,
    parentToolCallId: worker.toolCallId,
    index: 0,
  });
  const route = readRunControl(harness.root).execution_claim?.owner_kind === "cto" ? "C" : "O";
  recordScenarioEvent({
    kind: effectiveFailed ? "worker_failed" : "worker_completed",
    route,
    tool: "task",
    identities: { worker: worker.childContext.sessionManager.getSessionId(), task: worker.toolCallId },
    outcome: effectiveFailed ? "FAIL" : "COMPLETED",
    verdict: effectiveFailed ? "FAIL" : "PASS",
  });
}

type BatchTerminalOptions = {
  input?: { context: string; tasks: InterpreterTaskRequest[] };
  results?: Array<TaskResult | undefined>;
};

export async function terminalOrdinaryBatchWorkers(
  harness: Harness,
  workers: WorkerFixture[],
  failed = false,
  options: BatchTerminalOptions = {},
): Promise<void> {
  assert.ok(workers.length > 1, "consilium fixture must retain every worker in the batch");
  const toolCallId = workers[0]?.toolCallId;
  assert.ok(toolCallId, "consilium fixture must retain the batch task identity");
  assert.ok(workers.every((worker) => worker.toolCallId === toolCallId), "consilium workers must share one batch task identity");
  const selected = workers
    .map((worker, index) => ({ worker, index, result: options.results?.[index] }))
    .filter((entry) => options.results === undefined || isTerminalTaskResult(entry.result));
  if (selected.length === 0) return;
  const resultFailed = selected.some(({ result }) => result !== undefined && (result.exitCode !== 0 || Boolean(result.error)));
  const effectiveFailed = options.results === undefined ? failed : resultFailed;
  const input = options.input ?? { context: "shared context", tasks: workers.map((worker) => worker.input) };
  const rows = selected.map(({ worker, index, result }) => taskResultRow(worker, result, index, effectiveFailed, true));
  await emit(harness, "tool_result", {
    toolName: "task",
    toolCallId,
    input,
    details: { results: rows },
    content: [{ type: "text", text: effectiveFailed ? (rows.find((row) => typeof row.error === "string")?.error as string | undefined ?? "worker failed") : "worker terminal result" }],
    isError: effectiveFailed,
  }, harness.context);
  for (const { worker, index, result } of selected) {
    const workerFailed = options.results === undefined ? failed : Boolean(result && (result.exitCode !== 0 || result.error));
    await emit(harness, "task:subagent:lifecycle", {
      id: `${toolCallId}-lifecycle-${index}`,
      agent: worker.input.agent,
      status: workerFailed ? "failed" : "completed",
      sessionFile: worker.childFile,
      parentToolCallId: toolCallId,
      index,
    });
    const route = readRunControl(harness.root).execution_claim?.owner_kind === "cto" ? "C" : "O";
    recordScenarioEvent({
      kind: workerFailed ? "worker_failed" : "worker_completed",
      route,
      tool: "task",
      identities: { worker: worker.childContext.session_id, task: toolCallId, slot: index },
      outcome: workerFailed ? "FAIL" : "COMPLETED",
      verdict: workerFailed ? "FAIL" : "PASS",
    });
  }
}
function interpreterSuffix(toolCallId: string): string {
  const safeId = toolCallId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `interpreter-${safeId}`;
}

function taskStageCursor(task: string): string {
  return parseDispatchMarker(task)?.stage ?? "unknown";
}

function isPendingTaskResult(result: TaskResult | undefined): result is TaskResult {
  return Boolean(result && result.pending === true && typeof result.id === "string");
}

function assertInterpreterTaskResult(result: TaskResult | undefined): TaskResult {
  if (isTerminalTaskResult(result) || isPendingTaskResult(result)) return result;
  throw new Error("interpreter task execute returned an unknown result; refusing to invent terminal completion");
}

function pendingTaskRow(result: TaskResult, index: number): Record<string, unknown> {
  return {
    index,
    id: result.id,
    pending: true,
    error: result.error ?? "task remains asynchronous",
  };
}

function wireTaskRow(worker: WorkerFixture, result: TaskResult, index: number, batch: boolean): Record<string, unknown> {
  return isPendingTaskResult(result)
    ? pendingTaskRow(result, index)
    : taskResultRow(worker, result, index, result.exitCode !== 0 || Boolean(result.error), batch);
}

function taskToolContent(result: TaskResult, fallback: string): Array<{ type: "text"; text: string }> {
  const text = result.error ?? result.output ?? fallback;
  return [{ type: "text", text: text || fallback }];
}

/**
 * Adapt the interpreter's TaskCaller contract to the same registered host
 * boundaries as the production task adapter. The wrapped TaskToolLike receives
 * the caller-issued ID, so admission, SDK child lineage, result and receipt
 * reconciliation all observe one exact physical invocation.
 */
export function createInterpreterTaskCaller(harness: Harness, execute: InterpreterTaskExecute): TaskCaller {
  const scriptedTool: TaskToolLike = {
    async execute(toolCallId, params) {
      const rawTasks = params.tasks;
      if (Array.isArray(rawTasks)) {
        const tasks = rawTasks.map((task) => {
          assert.ok(task && typeof task === "object" && !Array.isArray(task), "interpreter batch task must be an object");
          const candidate = task as Record<string, unknown>;
          const agent = candidate.agent;
          const taskText = candidate.task;
          assert.equal(typeof agent, "string", "interpreter batch task agent is required");
          assert.equal(typeof taskText, "string", "interpreter batch task prompt is required");
          return {
            agent: agent as string,
            task: taskText as string,
            ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
            ...(candidate.effort === "lo" || candidate.effort === "med" || candidate.effort === "hi" ? { effort: candidate.effort } : {}),
          };
        });
        const context = params.context;
        assert.equal(typeof context, "string", "interpreter batch context is required");
        const input = { context: context as string, tasks };
        const workers = await admitOrdinaryBatchInputs(
          harness,
          toolCallId,
          input,
          interpreterSuffix(toolCallId),
          taskStageCursor(tasks[0]?.task ?? ""),
        );
        const results = await Promise.all(workers.map((worker, index) => execute(worker, tasks[index]!)));
        const normalized = results.map(assertInterpreterTaskResult);
        await terminalOrdinaryBatchWorkers(harness, workers, false, { input, results: normalized });
        const rows = normalized.map((result, index) => wireTaskRow(workers[index]!, result, index, true));
        return {
          details: { results: rows },
          content: [{ type: "text", text: rows.some((row) => row.pending === true) ? "task remains asynchronous" : "worker terminal result" }],
          isError: rows.some((row) => row.pending !== true && row.exitCode !== 0),
        };
      }

      const agent = params.agent;
      const taskText = params.task;
      assert.equal(typeof agent, "string", "interpreter task agent is required");
      assert.equal(typeof taskText, "string", "interpreter task prompt is required");
      const request: InterpreterTaskRequest = {
        agent: agent as string,
        task: taskText as string,
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        ...(params.effort === "lo" || params.effort === "med" || params.effort === "hi" ? { effort: params.effort } : {}),
      };
      const worker = await admitOrdinaryWorkerInput(
        harness,
        toolCallId,
        request,
        interpreterSuffix(toolCallId),
        taskStageCursor(request.task),
      );
      const result = assertInterpreterTaskResult(await execute(worker, request));
      if (isPendingTaskResult(result)) {
        return {
          details: { async: { state: "running" }, results: [pendingTaskRow(result, 0)] },
          content: taskToolContent(result, "task remains asynchronous"),
          isError: false,
        };
      }
      await terminalWorker(harness, worker, result.exitCode !== 0 || Boolean(result.error), result);
      return {
        details: { results: [taskResultRow(worker, result, 0, result.exitCode !== 0 || Boolean(result.error))] },
        content: taskToolContent(result, "worker terminal result"),
        isError: result.exitCode !== 0 || Boolean(result.error),
      };
    },
  };
  return createTaskCaller(scriptedTool);
}


export function requireTool(harness: Harness, name: string): RegisteredTool {
  const tool = harness.tools.get(name);
  assert.ok(tool, `${name} must be registered on the production ingress`);
  return tool;
}

export function implementationOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    files_touched: ["packages/core/src/engine/reliable-stage.ts"],
    ...overrides,
  };
}

export function submission(outputs: Record<string, unknown>): { outputs: Record<string, unknown> } {
  return { outputs };
}

export function terminalPayload(worker: WorkerFixture, failed = false): Record<string, unknown> {
  return {
    toolName: "task",
    toolCallId: worker.toolCallId,
    input: worker.input,
    details: { results: [{ agent: worker.input.agent, task: worker.input.task, exitCode: failed ? 1 : 0 }] },
    isError: failed,
  };
}

export async function cleanupHarness(harness: Harness): Promise<void> {
  await harness.close();
}

export function ctoSliceMarker(runId: string, sliceId = "slice-a"): string {
  return buildCtoSliceMarker(runId, sliceId);
}

export function ctoStateSnapshot(runId: string, root: string): CtoState | undefined {
  return readCtoState(runId, root);
}
export async function askCtoCheckpoint(harness: Harness, sliceId: string, callId: string): Promise<ToolDetails> {
  recordScenarioEvent({ kind: "tool_called", route: "C", tool: "cto_checkpoint_ask", stage: sliceId, identities: { checkpoint: callId } });
  const result = toolDetails((await requireTool(harness, "cto_checkpoint_ask").execute(callId, { slice_id: sliceId }, undefined, undefined, harness.context)).details);
  recordScenarioEvent({ kind: result.ok === true ? "checkpoint_accepted" : "checkpoint_rejected", route: "C", tool: "cto_checkpoint_ask", stage: sliceId, identities: { checkpoint: callId }, outcome: result.ok === true ? "ACCEPTED" : "REJECTED" });
  return result;
}

export async function advanceCtoStage(harness: Harness, sliceId: string, callId: string): Promise<ToolDetails> {
  recordScenarioEvent({ kind: "tool_called", route: "C", tool: "cto_stage_advance", stage: sliceId, identities: { attempt: callId } });
  const result = toolDetails((await requireTool(harness, "cto_stage_advance").execute(callId, { slice_id: sliceId }, undefined, undefined, harness.context)).details);
  recordScenarioEvent({ kind: result.ok === true ? "stage_exited" : "stage_entered", route: "C", tool: "cto_stage_advance", stage: sliceId, outcome: result.ok === true ? "ACCEPTED" : "REJECTED" });
  return result;
}
