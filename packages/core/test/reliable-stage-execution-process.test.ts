import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { scenarioTest, recordScenarioEvent } from "./reliable-stage-trace.js";
import { readCtoState } from "../src/cto/state.js";
import { readRunState } from "../src/engine/run-store.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const coreIndexUrl = new URL("../src/index.ts", import.meta.url).href;
const ctoStateUrl = new URL("../src/cto/state.ts", import.meta.url).href;
const runStoreUrl = new URL("../src/engine/run-store.ts", import.meta.url).href;

const BRANCH = "reliable-stage-execution-process";
const CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: "lightweight",
};

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  result?: Record<string, unknown>;
};

type Handoff = {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  stage_cursor: string;
  cursor_epoch: string;
  loop_iteration: number;
  profile_hash?: string;
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
};

const childRoutes = new WeakMap<ChildProcess, "O" | "C">();
const childAttempts = new WeakMap<ChildProcess, string>();
const childRecords = new WeakMap<ChildProcess, {
  output: string;
  close: Promise<[number | null, NodeJS.Signals | null]>;
}>();
type ChildMessageWaiter = {
  predicate: (message: unknown) => boolean;
  resolve: () => void;
};
const childMessages = new WeakMap<ChildProcess, unknown[]>();
const childMessageWaiters = new WeakMap<ChildProcess, ChildMessageWaiter[]>();
let nextProcessAttempt = 0;
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", BRANCH], { stdio: "ignore" });
  return root;
}

function parseResult(output: string): Record<string, unknown> | undefined {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("@@RESULT@@"));
  const line = lines.at(-1);
  if (!line) return undefined;
  const value: unknown = JSON.parse(line.slice("@@RESULT@@".length));
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function childScript(): string {
  return `
const [{ default: assert }, { default: fsDefault, existsSync, mkdirSync, readFileSync, watch, writeFileSync }, { join }, { z }, { syncBuiltinESMExports }] = await Promise.all([
  import("node:assert/strict"), import("node:fs"), import("node:path"), import("zod"), import("node:module")
]);
const core = await import(${JSON.stringify(coreIndexUrl)});
const [root, phase, handoffJson, barrier, route] = process.argv.slice(1);
const isCto = route === "cto";
const BRANCH = ${JSON.stringify(BRANCH)};
const CLASSIFICATION = ${JSON.stringify(CLASSIFICATION)};
const handoff = handoffJson ? JSON.parse(handoffJson) : undefined;
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};
let faultArmed = false;
let faultRunId = "";
let faultDispatchId = "";
let pendingKill = false;
let pendingMessages = 0;
let scriptFinished = false;
const closeIpc = () => {
  if (pendingKill || !scriptFinished || pendingMessages !== 0) return;
  if (typeof process.disconnect === "function" && process.connected) process.disconnect();
};
const notifyBarrier = (name, callback, ready = name) => {
  const message = { type: "barrier-ready", name, ready, pid: process.pid };
  if (typeof process.send === "function" && process.connected) {
    pendingMessages += 1;
    process.send(message, () => {
      pendingMessages -= 1;
      if (callback) callback();
      closeIpc();
    });
  } else if (callback) {
    callback();
  }
};
const notifyBarrierBestEffort = (name, ready = name) => {
  if (typeof process.send !== "function" || !process.connected) return;
  try {
    process.send({ type: "barrier-ready", name, ready, pid: process.pid });
  } catch {}
};
const killAfterBarrier = (name) => {
  pendingKill = true;
  notifyBarrierBestEffort(name);
  process.kill(process.pid, "SIGKILL");
};
const faultStatus = "prepared";
const originalRenameSync = fsDefault.renameSync;
fsDefault.renameSync = (source, destination, ...args) => {
  const result = originalRenameSync.call(fsDefault, source, destination, ...args);
  if (faultArmed && typeof destination === "string") {
    const normalizedDestination = destination.replaceAll("\\\\", "/");
    let matchedLifecycle = false;
    if (normalizedDestination.endsWith("/transaction.json")) {
      try {
        const record = JSON.parse(readFileSync(destination, "utf8"));
        const afterImages = record.after && typeof record.after === "object" ? Object.values(record.after) : [];
        const hasTargetReceipt = afterImages.some((value) => {
          if (typeof value !== "string") return false;
          try {
            const state = JSON.parse(value);
            const runIdentity = isCto ? state.id : state.run_key;
            const receipt = state.stage_receipts?.[faultDispatchId];
            return runIdentity === faultRunId
              && receipt?.dispatch_id === faultDispatchId
              && receipt?.work_identity?.run_id === faultRunId;
          } catch {
            return false;
          }
        });
        matchedLifecycle = record.operation === "resume"
          && record.status === faultStatus
          && hasTargetReceipt;
      } catch {}
    }
    if (matchedLifecycle) {
      writeFileSync(join(root, barrier), faultStatus + "\\n");
      faultArmed = false;
      killAfterBarrier(barrier);
    }
  }
  return result;
};
syncBuiltinESMExports();
const scopeMap = [{ glob: ["**/*"], scope: isCto ? "backend" : "default", dev_agent: "developer" }];
mkdirSync(join(root, ".omp"), { recursive: true });
writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({
  roles: isCto ? { dev: "developer", "team-lead": "team-lead" } : { dev: "developer" },
  scope_map: scopeMap,
}) + "\\n");
if (isCto) {
  writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify([{ id: "team-a", name: "Team A", scope: ["backend"], profile: "lightweight", lead: "team-lead", roster: ["dev"] }]) + "\\n");
}
const handlers = new Map();
const commands = new Map();
const tools = new Map();
const messages = [];
const on = (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]);
const manager = (id, file, parentSession) => ({
  getCwd: () => root,
  getSessionId: () => id,
  getSessionFile: () => file,
  getHeader: () => ({ id, cwd: root, ...(parentSession ? { parentSession } : {}) }),
});
const hostSession = "reliable-process-host";
const hostFile = join(root, "reliable-process-host.jsonl");
const hostManager = manager(hostSession, hostFile);
const host = {
  session_id: hostSession,
  caller: "host",
  process_id: process.pid,
  worktree: root,
  branch: BRANCH,
  authority: "coordinator",
  cwd: root,
  mode: "tui",
  hasUI: true,
  sessionFile: hostFile,
  sessionManager: hostManager,
  ui: { select: async () => {
    if (phase === "checkpoint-pending") {
      writeFileSync(join(root, "barrier", "checkpoint-ready-" + process.pid), "ready\\n");
      notifyBarrier("barrier/checkpoint-ready-" + process.pid);
      await waitBarrier(barrier);
    }
    if (phase === "recover" && typeof handoff?.recovery_decision === "string") return handoff.recovery_decision;
    return "proceed";
  }, notify() {} },
};
const controller = core.createWorkflowSessionController({
  cwd: root,
  context: {
    session_id: hostSession, caller: "host", process_id: process.pid,
    worktree: root, branch: BRANCH, authority: "coordinator",
  },
  ...(isCto ? { owner_kind: "cto" } : {}),
});
const actorResolver = (ctx, cwd, runId) => {
  if (ctx !== host || !runId) return undefined;
  if (isCto) {
    const claim = controller.activeCtoClaim();
    return claim && claim.run_id === runId
      ? { kind: "authenticated-interactive-host-cto", run_id: claim.run_id, ownership_epoch: claim.ownership_epoch }
      : undefined;
  }
  return { actor: "orchestrator", artifactsDir: core.runTarget(cwd, runId).artifactsDir };
};
const pi = {
  zod: { z },
  setLabel() {},
  on,
  events: { on },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  sendMessage(message, options) { messages.push({ message, options }); },
  sendUserMessage(message) { messages.push(message); },
};
const registeredWorkflowProfiles = isCto
  ? [core.loadProfile("lightweight")].filter((profile) => profile !== undefined)
  : undefined;
const registration = {
  cwd: root,
  roles: isCto ? { dev: "developer", "team-lead": "team-lead" } : { dev: "developer" },
  scopeMap,
  ...(registeredWorkflowProfiles ? { workflowProfiles: registeredWorkflowProfiles } : {}),
  getSessionController: (ctx) => ctx === host ? controller : undefined,
  resolveTrustedToolCallActor: actorResolver,
  observability: false,
};
core.registerTeamWorkflow(pi, registration);
core.registerWorkflowTools(pi, registration);
core.registerWorkflowCommands(pi, {
  cwd: root,
  resolveCwd: () => root,
  getSessionController: (ctx) => ctx === host ? controller : undefined,
});
const emit = async (name, ...args) => {
  const results = [];
  for (const handler of handlers.get(name) ?? []) {
    const result = await handler(...args);
    results.push(result);
    if (name === "tool_call" && result && typeof result === "object" && !Array.isArray(result) && result.block === true) break;
  }
  return results;
};
const details = (value) => {
  assert.equal(typeof value, "object");
  assert.ok(value !== null && !Array.isArray(value));
  return value;
};
const tool = (name) => {
  const value = tools.get(name);
  assert.ok(value, "registered tool missing: " + name);
  return value;
};
const handoffIdentity = (value) => {
  for (const key of ["advance_token", "capability_id", "run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch"]) {
    assert.equal(typeof value[key], "string", "workflow handoff must carry the current " + key);
  }
  assert.equal(Number.isInteger(value.loop_iteration), true, "workflow handoff must carry the current loop iteration");
  return {
    token: value.advance_token,
    capability_id: value.capability_id,
    run_key: value.run_key,
    branch: value.branch,
    workflow: value.workflow,
    stage_cursor: value.stage_cursor,
    cursor_epoch: value.cursor_epoch,
    loop_iteration: value.loop_iteration,
  };
};
const advanceInput = (value, evidence) => ({ ...handoffIdentity(value), profile_hash: value.profile_hash, evidence });
const checkpointInput = (value) => ({ ...handoffIdentity(value), profile_hash: value.profile_hash });
const checkpointAskInput = (value) => handoffIdentity(value);
const invoke = async (name, id, input, ctx = host) => details((await tool(name).execute(id, input, undefined, undefined, ctx)).details);
const emitResult = async (
  callId,
  input,
  parent = host,
  childId = "reliable-process-worker",
  childFile = join(root, "reliable-process-worker.jsonl"),
  agent = input.agent,
) => {
  const admission = await emit("tool_call", { toolName: "task", toolCallId: callId, input }, parent);
  assert.equal(admission.filter(Boolean).length, 0, JSON.stringify(admission));
  await emit("tool_execution_start", { toolName: "task", toolCallId: callId, args: input }, parent);
  const childManager = manager(childId, childFile, parent.sessionFile);
  const child = { cwd: root, mode: "print", hasUI: false, session_id: childId, sessionFile: childFile, sessionManager: childManager };
  const lifecycleId = callId + "-lifecycle";
  await emit("task:subagent:lifecycle", { id: lifecycleId, agent, status: "started", sessionFile: childFile, parentToolCallId: callId, index: 0 });
  return { child, childId, childFile, lifecycleId, parent };
};
const terminal = async (callId, input, childFile, lifecycleId, failed = false) => {
  await emit("tool_result", {
    toolName: "task", toolCallId: callId, input,
    details: { results: [{ index: 0, id: callId + "-result", agent: input.agent, agentSource: "project", task: input.task, exitCode: failed ? 1 : 0, output: failed ? "worker failed" : "worker terminal result", stderr: "", truncated: false, durationMs: 1, tokens: 1, requests: 1 }] },
    content: [{ type: "text", text: failed ? "worker failed" : "worker terminal result" }],
    isError: failed,
  }, host);
  await emit("task:subagent:lifecycle", { id: lifecycleId, agent: input.agent, status: failed ? "failed" : "completed", sessionFile: childFile, parentToolCallId: callId, index: 0 });
};
const processImplementation = { files_touched: ["packages/core/src/engine/reliable-stage.ts"], ready: true, validation_run: true, validation_evidence: "process acceptance observed the registered submission receipt and worker lifecycle handoff" };
const registerChildExtension = (child) => {
  const childHandlers = new Map();
  const childTools = new Map();
  const childCommands = new Map();
  const childOn = (name, handler) => childHandlers.set(name, [...(childHandlers.get(name) ?? []), handler]);
  const childPi = {
    zod: { z },
    setLabel() {},
    on: childOn,
    events: { on: childOn },
    registerTool(tool) { childTools.set(tool.name, tool); },
    registerCommand(name, command) { childCommands.set(name, command); },
    sendMessage() {},
    sendUserMessage() {},
  };
  const childController = core.createWorkflowSessionController({
    cwd: root,
    context: {
      session_id: child.session_id,
      caller: "host",
      process_id: process.pid,
      worktree: root,
      branch: BRANCH,
      authority: "coordinator",
    },
  });
  const childRegistration = {
    cwd: root,
    resolveCwd: () => root,
    roles: isCto ? { dev: "developer", "team-lead": "team-lead" } : { dev: "developer" },
    scopeMap,
    ...(registeredWorkflowProfiles ? { workflowProfiles: registeredWorkflowProfiles } : {}),
    getSessionController: (ctx) => ctx === child ? childController : undefined,
    resolveTrustedToolCallActor: () => undefined,
    observability: false,
  };
  core.registerTeamWorkflow(childPi, childRegistration);
  core.registerWorkflowTools(childPi, childRegistration);
  const childSubmitTool = childTools.get("workflow_submit_result");
  assert.ok(childSubmitTool, "child extension must register workflow_submit_result");
  return {
    submit: async () => details((await childSubmitTool.execute(
      "reliable-process-submit",
      { outputs: { implementation: processImplementation } },
      undefined,
      undefined,
      child,
    )).details),
    close: async () => {
      for (const handler of childHandlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, child);
    },
  };
};
const submit = async (child) => {
  const extension = registerChildExtension(child);
  try {
    return await extension.submit();
  } finally {
    await extension.close();
  }
};
const nativeAcceptedReplayChild = async (runId) => {
  const persisted = JSON.parse(readFileSync(join(root, "barrier", "native-sdk-session.json"), "utf8"));
  assert.equal(persisted.run_id, runId, JSON.stringify(persisted));
  const sessionId = persisted.session_id;
  const sessionFile = persisted.session_file;
  const header = persisted.header;
  assert.equal(typeof sessionId, "string", JSON.stringify(persisted));
  assert.equal(typeof sessionFile, "string", JSON.stringify(persisted));
  assert.ok(header && typeof header === "object", JSON.stringify(persisted));
  assert.equal(header.id, sessionId, JSON.stringify(persisted));
  assert.equal(header.cwd, root, JSON.stringify(persisted));
  assert.equal(typeof header.parentSession, "string", JSON.stringify(persisted));
  const childManager = manager(sessionId, sessionFile, header.parentSession);
  return {
    cwd: root,
    mode: "print",
    hasUI: false,
    session_id: sessionId,
    sessionFile,
    sessionManager: childManager,
  };
};
const ordinaryAcceptedReplayChild = async (runId) => {
  const persisted = JSON.parse(readFileSync(join(root, "barrier", "ordinary-sdk-session.json"), "utf8"));
  assert.equal(persisted.run_id, runId, JSON.stringify(persisted));
  const sessionId = persisted.session_id;
  const sessionFile = persisted.session_file;
  const header = persisted.header;
  assert.equal(typeof sessionId, "string", JSON.stringify(persisted));
  assert.equal(typeof sessionFile, "string", JSON.stringify(persisted));
  assert.ok(header && typeof header === "object", JSON.stringify(persisted));
  assert.equal(header.id, sessionId, JSON.stringify(persisted));
  assert.equal(header.cwd, root, JSON.stringify(persisted));
  assert.equal(typeof header.parentSession, "string", JSON.stringify(persisted));
  const childManager = manager(sessionId, sessionFile, header.parentSession);
  return {
    cwd: root,
    mode: "print",
    hasUI: false,
    session_id: sessionId,
    sessionFile,
    sessionManager: childManager,
  };
};
const resumeOrdinary = async () => {
  assert.ok(handoff && typeof handoff.run_id === "string");
  const requestSuffix = phase + "-" + process.pid;
  const resumed = await invoke("workflow_prepare", "reliable-process-resume-" + requestSuffix, { mode: "resume", run_id: handoff.run_id });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const begun = await invoke("workflow_begin", "reliable-process-resume-begin-" + requestSuffix, {});
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.ok(begun.handoff && typeof begun.handoff === "object");
  return { runId: handoff.run_id, handoff: { ...begun.handoff, run_id: handoff.run_id } };
};
const resumeOrdinaryReadOnly = async () => {
  assert.ok(handoff && typeof handoff.run_id === "string");
  const resumed = await invoke("workflow_prepare", "reliable-process-readonly-resume-" + process.pid, { mode: "resume", run_id: handoff.run_id });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  return { runId: handoff.run_id };
};
const resumeCto = async () => {
  assert.ok(handoff && typeof handoff.run_id === "string");
  const command = commands.get("cto");
  assert.ok(command, "registered CTO command missing");
  await command.handler("--run " + handoff.run_id, host);
  const { readCtoState } = await import(${JSON.stringify(ctoStateUrl)});
  const state = readCtoState(handoff.run_id, root);
  assert.ok(state && typeof state === "object", JSON.stringify(state));
  return { runId: handoff.run_id, state };
};
const admitCurrent = async () => {
  const suffix = typeof handoff?.retry_suffix === "string" ? handoff.retry_suffix : "";
  if (!isCto) {
    const resumed = await resumeOrdinary();
    const current = resumed.handoff;
    const input = { agent: current.expected_roster[0].agent, task: current.dispatch_markers[0].marker };
    const callId = "reliable-process-task" + suffix;
    const assignment = await emitResult(callId, input);
    return { ...resumed, current, input, assignment, callId, child: assignment.child };
  }
  const resumed = await resumeCto();
  const marker = core.buildCtoSliceMarker(resumed.runId, "slice-a");
  const processTag = suffix + "-" + process.pid;
  const leadInput = { agent: "team-lead", task: marker + "\\nlead handoff" };
  const leadCallId = "reliable-process-lead-task" + processTag;
  const lead = await emitResult(leadCallId, leadInput, host, "reliable-process-lead" + processTag, join(root, "reliable-process-lead" + processTag + ".jsonl"), "team-lead");
  const workerInput = { agent: "developer", task: marker + "\\nworker handoff" };
  const workerCallId = "reliable-process-worker-task" + processTag;
  const worker = await emitResult(workerCallId, workerInput, lead.child, "reliable-process-worker" + processTag, join(root, "reliable-process-worker" + processTag + ".jsonl"), "developer");
  return { ...resumed, input: workerInput, lead, worker, callId: workerCallId, child: worker.child };
};
const activeDispatchId = async (runId) => {
  if (!isCto) {
    const { readRunState } = await import(${JSON.stringify(runStoreUrl)});
    const state = readRunState(root, runId);
    const dispatch = state?.dispatch_capability?.dispatches?.find((entry) => !["succeeded", "failed", "cancelled"].includes(entry.status));
    assert.equal(typeof dispatch?.id, "string", JSON.stringify(state));
    return dispatch.id;
  }
  const { readCtoState } = await import(${JSON.stringify(ctoStateUrl)});
  const state = readCtoState(runId, root);
  const assignment = Object.values(state?.native_stage_progress ?? {})
    .flatMap((progress) => Object.values(progress.assignments ?? {}))
    .find((entry) => ["reserved", "running"].includes(entry.status));
  assert.equal(typeof assignment?.identity?.dispatch_id, "string", JSON.stringify(state));
  return assignment.identity.dispatch_id;
};
const persistWorkerSdkSession = (runId, child) => {
  assert.ok(child && typeof child === "object" && child.sessionManager && typeof child.sessionManager.getHeader === "function");
  const header = child.sessionManager.getHeader();
  assert.ok(header && typeof header === "object", JSON.stringify(child));
  const record = JSON.stringify({
    run_id: runId,
    session_id: child.session_id,
    session_file: child.sessionFile,
    header,
  }) + "\\n";
  writeFileSync(join(root, "barrier", isCto ? "native-sdk-session.json" : "ordinary-sdk-session.json"), record);
};
const submitCurrent = async (armFault = false) => {
  const admitted = await admitCurrent();
  persistWorkerSdkSession(admitted.runId, admitted.child);
  const dispatchId = await activeDispatchId(admitted.runId);
  if (armFault) {
    faultRunId = admitted.runId;
    faultDispatchId = dispatchId;
    faultArmed = true;
  }
  const accepted = await submit(admitted.child);
  return { admitted, dispatchId, accepted };
};
const output = (value) => { process.stdout.write("@@RESULT@@" + JSON.stringify(value) + "\\n"); };
const waitBarrier = async (name) => {
  const path = join(root, name);
  const ready = join(root, "barrier", "ready-" + process.pid);
  const { promise: released, resolve: release } = deferred();
  const onRelease = (message) => {
    if (!message || typeof message !== "object" || message.type !== "barrier-release" || message.name !== name) return;
    release();
  };
  process.on("message", onRelease);
  writeFileSync(ready, "ready\\n");
  notifyBarrier(name, undefined, "barrier/ready-" + process.pid);
  if (existsSync(path)) {
    process.off("message", onRelease);
    return;
  }
  const { promise, resolve, reject } = deferred();
  const watcher = watch(join(root, "barrier"), () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve();
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  const timeout = setTimeout(() => { watcher.close(); reject(new Error("barrier timeout: " + name)); }, 5000);
  try {
    await Promise.race([promise, released]);
  } finally {
    clearTimeout(timeout);
    watcher.close();
    process.off("message", onRelease);
  }
};
await emit("session_start", { type: "session_start" }, host);
if (phase === "prepare") {
  if (!isCto) {
    const prepared = await invoke("workflow_prepare", "reliable-process-prepare", { mode: "new", task: "reliable process scenario", classification: CLASSIFICATION, files: ["packages/core/src/engine/reliable-stage.ts"] });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const runId = prepared.state.run_id;
    const begun = await invoke("workflow_begin", "reliable-process-begin", {});
    assert.equal(begun.ok, true, JSON.stringify(begun));
    const discoveryHandoff = begun.handoff;
    assert.ok(discoveryHandoff && typeof discoveryHandoff === "object");
    const discovery = { task: "reliable process discovery", branch: BRANCH, constraints: [] };
    const dod = {
      items: [{ id: "d1", source: "process-test", criterion: "native result", verify_method: "submission", status: "pending", evidence: "" }],
      type_requirements_met: true,
      updated_at: new Date().toISOString(),
    };
    const discoverySubmitted = await invoke("workflow_submit_result", "reliable-process-discovery-submit", { outputs: { discovery, dod } });
    assert.equal(discoverySubmitted.ok, true, JSON.stringify(discoverySubmitted));
    const advanced = await invoke("workflow_advance", "reliable-process-discovery-advance", advanceInput(discoveryHandoff, "registered process discovery"));
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    const begunImplementation = await invoke("workflow_begin", "reliable-process-implementation-begin", {});
    assert.equal(begunImplementation.ok, true, JSON.stringify(begunImplementation));
    const current = begunImplementation.handoff;
    assert.ok(current && typeof current === "object");
    output({ run_id: runId, handoff: { ...current, run_id: runId } });
  } else {
    const command = commands.get("cto");
    assert.ok(command, "registered CTO command missing");
    await command.handler("reliable native process scenario", host);
    const { readRunControl } = await import(${JSON.stringify(runStoreUrl)});
    const runId = readRunControl(root).execution_claim?.run_id;
    assert.ok(runId);
    const read = await invoke("cto_state", "reliable-process-cto-read", { operation: "read", run_id: runId });
    assert.equal(read.ok, true, JSON.stringify(read));
    const candidate = structuredClone(read.state);
    candidate.plan.teams = [{ team: "team-a", scope: ["backend"], slice: "slice-a", profile: "lightweight", worktree: "same_branch", depends_on: [] }];
    candidate.teams = [{ id: "team-a", status: "pending", escalations: {}, slice_id: "slice-a", classification: CLASSIFICATION, workflow: "lightweight", dod_path: ".work-state/artifacts/team-a/dod.json" }];
    const { appendWave, readCtoState } = await import(${JSON.stringify(ctoStateUrl)});
    appendWave(candidate, { id: "wave-1", source: "process-test", source_id: "reliable-process-wave-1", task: candidate.task, slice_ids: ["slice-a"] });
    mkdirSync(join(root, ".work-state", "artifacts", "team-a"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "team-a", "dod.json"), JSON.stringify({ items: [{ id: "d1", source: "process-test", criterion: "native result", verify_method: "submission", status: "pending", evidence: "" }], type_requirements_met: true, updated_at: new Date().toISOString() }) + "\\n");
    const committed = await invoke("cto_state", "reliable-process-cto-commit", { operation: "commit", run_id: runId, expected_state_revision: read.state_revision, state: candidate });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const marker = core.buildCtoSliceMarker(runId, "slice-a");
    const leadInput = { agent: "team-lead", task: marker + "\\nlead handoff" };
    const discoveryLead = await emitResult("reliable-process-discovery-lead-task", leadInput, host, "reliable-process-discovery-lead", join(root, "reliable-process-discovery-lead.jsonl"), "team-lead");
    const dod = JSON.parse(readFileSync(join(root, ".work-state", "artifacts", "team-a", "dod.json"), "utf8"));
    const discovery = { task: "reliable process discovery", branch: BRANCH, constraints: [] };
    const discoverySubmitted = await invoke("workflow_submit_result", "reliable-process-discovery-submit", { outputs: { discovery, dod } }, discoveryLead.child);
    assert.equal(discoverySubmitted.ok, true, JSON.stringify(discoverySubmitted));
    const advanced = await invoke("cto_stage_advance", "reliable-process-discovery-advance", { slice_id: "slice-a" });
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    await terminal("reliable-process-discovery-lead-task", leadInput, discoveryLead.childFile, discoveryLead.lifecycleId);
    const current = readCtoState(runId, root);
    const stageCursor = current?.native_stage_progress?.["team-a"]?.stage_id;
    assert.equal(stageCursor, "implementation", JSON.stringify(current));
    const workerMarker = core.buildCtoSliceMarker(runId, "slice-a") + "\\nworker handoff";
    output({ run_id: runId, handoff: { run_id: runId, stage_cursor: stageCursor, dispatch_markers: [{ role: "dev", agent: "developer", marker: workerMarker }], expected_roster: [{ role: "dev", agent: "developer" }] } });
  }
} else if (phase === "submit-crash-after-commit") {
  assert.ok(handoff);
  const result = await submitCurrent();
  assert.equal(result.accepted.ok, true, JSON.stringify(result.accepted));
  writeFileSync(join(root, barrier), "committed\\n");
  killAfterBarrier(barrier);
} else if (phase === "submit-replay") {
  assert.ok(handoff);
  if (isCto) {
    const resumed = await resumeCto();
    const replayChild = await nativeAcceptedReplayChild(resumed.runId);
    const accepted = await submit(replayChild);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, host);
    output({ replay: accepted });
  } else {
    const resumed = await resumeOrdinaryReadOnly();
    const replayChild = await ordinaryAcceptedReplayChild(resumed.runId);
    const accepted = await submit(replayChild);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, host);
    output({ replay: accepted });
  }
} else if (phase === "submit-crash-before-commit") {
  assert.ok(handoff);
  const result = await submitCurrent(true);
  throw new Error("registered submission returned without the armed commit fault: " + JSON.stringify(result.accepted));
} else if (phase === "submit-after-restart") {
  assert.ok(handoff);
  const result = await submitCurrent();
  output({ accepted: result.accepted, dispatch_id: result.dispatchId });
} else if (phase === "terminal-failure") {
  assert.ok(handoff);
  const admitted = await admitCurrent();
  const worker = admitted.assignment ?? admitted.worker;
  const dispatchId = await activeDispatchId(admitted.runId);
  await terminal(admitted.callId, admitted.input, worker.childFile, worker.lifecycleId, true);
  output({ failed: true, dispatch_id: dispatchId });
} else if (phase === "admit-pending") {
  assert.ok(handoff);
  const admitted = await admitCurrent();
  output({ pending: true, dispatch_id: await activeDispatchId(admitted.runId) });
} else if (phase === "recover") {
  try {
    if (barrier.startsWith("barrier/")) await waitBarrier(barrier);
    if (isCto) await resumeCto();
    else await resumeOrdinary();
    const operation = barrier.includes("reconcile") ? "reconcile" : "diagnose";
    const recovery = await invoke("workflow_recover", "reliable-process-recover" + (operation === "reconcile" ? "-replace" : "-diagnose"), { operation, ...(operation === "reconcile" ? { intent: "replace" } : {}) });
    output({ recovery });
  } catch (error) {
    output({ recovery: { ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: String(error) } });
  }
} else if (phase === "advance") {
  assert.ok(handoff);
  const admitted = await admitCurrent();
  const accepted = await submit(admitted.child);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const worker = admitted.assignment ?? admitted.worker;
  await terminal(admitted.callId, admitted.input, worker.childFile, worker.lifecycleId);
  if (isCto) {
    const ask = await invoke("cto_checkpoint_ask", "reliable-process-cto-checkpoint-ask", { slice_id: "slice-a" });
    assert.equal(ask.ok, true, JSON.stringify(ask));
    const advanced = await invoke("cto_stage_advance", "reliable-process-cto-advance", { slice_id: "slice-a" });
    writeFileSync(join(root, barrier), "advanced\\n");
    notifyBarrier(barrier);
    output({ ask, advanced, run_id: admitted.runId, operation_id: "reliable-process-cto-advance" });
  } else {
    const current = admitted.current;
    writeFileSync(join(root, "barrier", "advance-handoff.json"), JSON.stringify(current) + "\\n");
    const denied = await invoke("workflow_advance", "reliable-process-advance", advanceInput(current, "accepted process result"));
    assert.equal(denied.ok, false, JSON.stringify(denied));
    const ask = await invoke("workflow_checkpoint_ask", "reliable-process-ask", { ...checkpointAskInput(current), checkpoint: "approve_implementation", checkpoint_id: "approve_implementation", checkpoint_kind: "implementation_approval" });
    assert.equal(ask.ok, true, JSON.stringify(ask));
    const provenance = ask.actor_provenance;
    const recorded = await invoke("workflow_checkpoint", "reliable-process-checkpoint", { ...checkpointInput(current), checkpoint: "approve_implementation", checkpoint_id: "approve_implementation", checkpoint_kind: "implementation_approval", authorization: "human", actor_provenance: provenance, decision: ask.decision, rationale: "process scenario approval" });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const advanced = await invoke("workflow_advance", "reliable-process-advance-after-approval", advanceInput(current, "approved process result"));
    writeFileSync(join(root, barrier), "advanced\\n");
    notifyBarrier(barrier);
    output({ advanced, run_id: admitted.runId, operation_id: "reliable-process-advance-after-approval" });
  }
} else if (phase === "advance-replay") {
  assert.ok(handoff);
  if (isCto) {
    await resumeCto();
    const { readCtoState } = await import(${JSON.stringify(ctoStateUrl)});
    const beforeReplay = readCtoState(handoff.run_id, root);
    const replay = await invoke("cto_stage_advance", "reliable-process-cto-advance", { slice_id: "slice-a" });
    output({ replay, operation_id: "reliable-process-cto-advance", before_replay: beforeReplay });
  } else {
    const sourceHandoff = JSON.parse(readFileSync(join(root, "barrier", "advance-handoff.json"), "utf8"));
    const resumed = await resumeOrdinary();
    assert.notEqual(resumed.handoff.stage_cursor, sourceHandoff.stage_cursor, "advance replay must first bind the real downstream stage");
    const { readRunState } = await import(${JSON.stringify(runStoreUrl)});
    const beforeReplay = readRunState(root, handoff.run_id);
    const replay = await invoke("workflow_advance", "reliable-process-advance-after-approval", advanceInput(sourceHandoff, "approved process result"));
    output({ replay, operation_id: "reliable-process-advance-after-approval", before_replay: beforeReplay });
  }
} else if (phase === "checkpoint-pending") {
  assert.ok(handoff);
  const admitted = await admitCurrent();
  const accepted = await submit(admitted.child);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const worker = admitted.assignment ?? admitted.worker;
  await terminal(admitted.callId, admitted.input, worker.childFile, worker.lifecycleId);
  let pendingAsk;
  if (isCto) {
    pendingAsk = await invoke("cto_checkpoint_ask", "reliable-process-pending-ask", { slice_id: "slice-a" });
  } else {
    writeFileSync(join(root, "barrier", "checkpoint-handoff.json"), JSON.stringify(admitted.current) + "\\n");
    pendingAsk = await invoke("workflow_checkpoint_ask", "reliable-process-pending-ask", { ...checkpointAskInput(admitted.current), checkpoint: "approve_implementation", checkpoint_id: "approve_implementation", checkpoint_kind: "implementation_approval" });
  }
  output({ pending: true, ask: pendingAsk, run_id: admitted.runId });
} else if (phase === "checkpoint-replay") {
  assert.ok(handoff);
  let ask;
  if (isCto) {
    await resumeCto();
    ask = await invoke("cto_checkpoint_ask", "reliable-process-pending-ask", { slice_id: "slice-a" });
  } else {
    const pendingHandoff = JSON.parse(readFileSync(join(root, "barrier", "checkpoint-handoff.json"), "utf8"));
    const resumed = await invoke("workflow_prepare", "reliable-process-checkpoint-replay-resume-" + process.pid, { mode: "resume", run_id: handoff.run_id });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    ask = await invoke("workflow_checkpoint_ask", "reliable-process-pending-ask", { ...checkpointAskInput(pendingHandoff), checkpoint: "approve_implementation", checkpoint_id: "approve_implementation", checkpoint_kind: "implementation_approval" });
  }
  assert.equal(ask.ok, true, JSON.stringify(ask));
  output({ ask });
} else if (phase === "cto-end") {
  assert.ok(handoff && typeof handoff.run_id === "string");
  await resumeCto();
  const read = await invoke("cto_state", "reliable-process-cto-read", { operation: "read", run_id: handoff.run_id });
  output({ read });
} else {
  throw new Error("unknown phase " + phase);
}
scriptFinished = true;
closeIpc();
`;
}

function launch(
  root: string,
  phase: string,
  handoff?: Record<string, unknown>,
  barrier = "barrier/release",
  route: "ordinary" | "cto" = "ordinary",
): ChildProcess {
  mkdirSync(join(root, "barrier"), { recursive: true });
  const encoded = handoff ? JSON.stringify(handoff) : "";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript(), root, phase, encoded, barrier, route], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.once("close", () => {
    childMessages.delete(child);
    childMessageWaiters.delete(child);
  });
  childMessages.set(child, []);
  childMessageWaiters.set(child, []);
  child.on("message", (message: unknown) => {
    childMessages.get(child)?.push(message);
    const waiters = childMessageWaiters.get(child) ?? [];
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      waiter.resolve();
    }
  });
  const record = {
    output: "",
    close: new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (code, signal) => resolve([code, signal]));
    }),
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { record.output += chunk; });
  child.stderr?.on("data", (chunk: string) => { record.output += chunk; });
  childRecords.set(child, record);
  const traceRoute = route === "ordinary" ? "O" : "C";
  const attempt = `${phase}-${++nextProcessAttempt}`;
  childRoutes.set(child, traceRoute);
  childAttempts.set(child, attempt);
  recordScenarioEvent({ kind: "attempt_started", route: traceRoute, phase, identities: { attempt }, outcome: "STARTED" });
  return child;
}

async function finish(child: ChildProcess): Promise<ChildResult> {
  const record = childRecords.get(child);
  assert.ok(record, "process child must be registered before it exits");
  const [code, signal] = await record.close;
  const output = record.output;
  const parsed = parseResult(output);
  const attempt = childAttempts.get(child);
  const route = childRoutes.get(child);
  recordScenarioEvent({
    kind: "attempt_completed",
    ...(route ? { route } : {}),
    phase: "process",
    ...(attempt ? { identities: { attempt } } : {}),
    outcome: signal ? "FAIL" : code === 0 ? "COMPLETED" : "FAIL",
  });
  if (signal) {
    recordScenarioEvent({ kind: "fault_observed", ...(route ? { route } : {}), phase: "process", faultPoint: "process", outcome: "FAIL" });
  }
  const resultValue = parsed?.replay ?? parsed?.accepted;
  const resultRecord = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue) ? resultValue as Record<string, unknown> : undefined;
  if (resultRecord && typeof resultRecord.ok === "boolean") {
    const receipt = resultRecord.receipt && typeof resultRecord.receipt === "object" && !Array.isArray(resultRecord.receipt)
      ? resultRecord.receipt as Record<string, unknown>
      : undefined;
    const dispatch = typeof receipt?.dispatch_id === "string" ? receipt.dispatch_id : undefined;
    const receiptId = typeof receipt?.receipt_id === "string" ? receipt.receipt_id : undefined;
    recordScenarioEvent({
      kind: "stage_submitted",
      ...(route ? { route } : {}),
      phase: "result-ipc",
      ...(dispatch || receiptId ? { identities: { ...(dispatch ? { dispatch } : {}), ...(receiptId ? { receipt: receiptId } : {}) } } : {}),
      ...(dispatch && receiptId ? { links: { dispatch_of: receiptId, dispatch } } : {}),
      outcome: resultRecord.ok ? "ACCEPTED" : "REJECTED",
    });
  }
  return { code, signal, output, result: parsed };
}

function waitForChildBarrier(child: ChildProcess, name: string): Promise<void> {
  const isReady = (message: unknown): boolean => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const value = message as Record<string, unknown>;
    return value.type === "barrier-ready" && (value.name === name || value.ready === name);
  };
  const messages = childMessages.get(child) ?? [];
  if (messages.some(isReady)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = childMessageWaiters.get(child) ?? [];
    waiters.push({ predicate: isReady, resolve });
    childMessageWaiters.set(child, waiters);
  });
}

async function waitForMarker(root: string, name: string, route?: "O" | "C", child?: ChildProcess): Promise<void> {
  const barrier = basename(name);
  recordScenarioEvent({ kind: "barrier_wait", ...(route ? { route } : {}), barrier, identities: { barrier }, outcome: "PENDING" });
  const path = join(root, name);
  if (existsSync(path)) {
    recordScenarioEvent({ kind: "barrier_released", ...(route ? { route } : {}), barrier, identities: { barrier }, outcome: "COMPLETED" });
    return;
  }
  const { promise, resolve, reject } = deferred<void>();
  const childExit = child
    ? (() => {
      const record = childRecords.get(child);
      assert.ok(record, "process child must be registered before barrier wait");
      return record.close.then(([code, signal]) => {
        if (existsSync(path)) return;
        const output = record.output.trim();
        throw new Error(`child exited before barrier '${name}' (code=${String(code)}, signal=${String(signal)})${output ? `\n${output}` : ""}`);
      });
    })()
    : undefined;
  const childReady = child ? waitForChildBarrier(child, name) : undefined;
  const parent = dirname(path);
  const watcher = watch(parent, () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve(undefined);
  });
  if (existsSync(path)) {
    watcher.close();
    resolve(undefined);
  }
  const timeout = setTimeout(() => {
    watcher.close();
    recordScenarioEvent({ kind: "barrier_timeout", ...(route ? { route } : {}), barrier, identities: { barrier }, outcome: "TIMEOUT" });
    const childState = child
      ? { exitCode: child.exitCode, signalCode: child.signalCode, target_exists: existsSync(path) }
      : { target_exists: existsSync(path) };
    reject(new Error(`barrier '${name}' timed out; child_state=${JSON.stringify(childState)}`));
  }, 5_000);
  try {
    const marker = childReady ? Promise.race([promise, childReady]) : promise;
    await Promise.race(childExit ? [marker, childExit] : [marker]);
    recordScenarioEvent({ kind: "barrier_released", ...(route ? { route } : {}), barrier, identities: { barrier }, outcome: "COMPLETED" });
  } finally {
    clearTimeout(timeout);
    watcher.close();
  }
}

function releaseBarrier(root: string, name: string, children: ChildProcess[]): void {
  writeFileSync(join(root, name), "release\n");
  for (const child of children) {
    if (child.connected) child.send({ type: "barrier-release", name });
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function requireHandoff(value: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(value.handoff, "child must persist a registered handoff");
}

function targetDispatchId(root: string, route: "ordinary" | "cto", runId: string): string {
  if (route === "ordinary") {
    const state = readRunState(root, runId) as {
      dispatch_capability?: {
        dispatches?: Array<{ id?: unknown; status?: unknown }>;
        work_identity?: { dispatch_id?: unknown };
      };
      work_identity?: { dispatch_id?: unknown };
    } | null;
    const dispatch = state?.dispatch_capability?.dispatches?.find((entry) => entry.status !== "succeeded" && entry.status !== "failed" && entry.status !== "cancelled");
    const dispatchId = dispatch?.id ?? state?.dispatch_capability?.work_identity?.dispatch_id ?? state?.work_identity?.dispatch_id;
    assert.equal(typeof dispatchId, "string", `ordinary process stage must expose its assigned dispatch id: ${JSON.stringify(state)}`);
    return dispatchId as string;
  }
  const state = readCtoState(runId, root) as {
    native_stage_progress?: Record<string, { assignments?: Record<string, { status?: unknown; identity?: { dispatch_id?: unknown } }> }>;
  } | null;
  const assignment = Object.values(state?.native_stage_progress ?? {})
    .flatMap((progress) => Object.values(progress.assignments ?? {}))
    .find((entry) => entry.status === "reserved" || entry.status === "running");
  const dispatchId = assignment?.identity?.dispatch_id;
  assert.equal(typeof dispatchId, "string", `native process stage must expose its assigned dispatch id: ${JSON.stringify(state)}`);
  return dispatchId as string;
}
function canonicalProcessState(root: string, route: "ordinary" | "cto", runId: string): Record<string, unknown> {
  const value = route === "ordinary" ? readRunState(root, runId) : readCtoState(runId, root);
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `canonical ${route} state must be readable`);
  return structuredClone(value as Record<string, unknown>);
}

function stageReceipts(root: string, route: "ordinary" | "cto", runId: string): Record<string, unknown> {
  const state = canonicalProcessState(root, route, runId);
  const receipts = state.stage_receipts;
  assert.ok(receipts && typeof receipts === "object" && !Array.isArray(receipts), `canonical ${route} state must expose stage receipts`);
  return receipts as Record<string, unknown>;
}
function stageReceiptsFor(root: string, route: "ordinary" | "cto", runId: string, stageId: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(stageReceipts(root, route, runId)).filter(([, entry]) => {
    const identity = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).work_identity
      : undefined;
    return identity && typeof identity === "object" && !Array.isArray(identity)
      && (identity as Record<string, unknown>).stage_id === stageId;
  }));
}
function publicReceiptFromLedger(value: unknown): Record<string, unknown> {
  const ledgerReceipt = requireRecord(value, "persisted stage receipt");
  const projection: Record<string, unknown> = {};
  for (const key of ["receipt_id", "submission_id", "digest", "outputs", "evidence", "accepted_at"]) {
    assert.ok(key in ledgerReceipt, `persisted stage receipt must expose ${key}`);
    projection[key] = ledgerReceipt[key];
  }
  const binding = ledgerReceipt.binding;
  if (binding && typeof binding === "object" && !Array.isArray(binding)) projection.binding = binding;
  return projection;
}

function dispatchIds(root: string, route: "ordinary" | "cto", runId: string): string[] {
  const state = canonicalProcessState(root, route, runId);
  if (route === "ordinary") {
    const capability = state.dispatch_capability;
    const dispatches = capability && typeof capability === "object" && !Array.isArray(capability)
      ? (capability as Record<string, unknown>).dispatches
      : undefined;
    return Array.isArray(dispatches)
      ? dispatches.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string" ? [(entry as Record<string, unknown>).id as string] : [])
      : [];
  }
  const progress = state.native_stage_progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return [];
  return Object.values(progress as Record<string, unknown>).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const assignments = (entry as Record<string, unknown>).assignments;
    if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) return [];
    return Object.values(assignments as Record<string, unknown>).flatMap((assignment) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return [];
      const identity = (assignment as Record<string, unknown>).identity;
      return identity && typeof identity === "object" && typeof (identity as Record<string, unknown>).dispatch_id === "string"
        ? [(identity as Record<string, unknown>).dispatch_id as string]
        : [];
    });
  });
}

async function prepare(root: string, route: "ordinary" | "cto"): Promise<{ child: ChildResult; handoff: Record<string, unknown>; runId: string }> {
  const child = launch(root, "prepare", undefined, "barrier/release", route);
  const result = await finish(child);
  assert.equal(result.code, 0, result.output);
  assert.ok(result.result, result.output);
  const value = result.result;
  const runId = value.run_id;
  assert.equal(typeof runId, "string", result.output);
  const handoff = requireHandoff(value);
  const traceRoute = route === "ordinary" ? "O" : "C";
  recordScenarioEvent({ kind: "workflow_started", route: traceRoute, workflow: CLASSIFICATION.workflow, identities: { run: runId as string } });
  const stage = handoff.stage_cursor;
  if (typeof stage === "string") recordScenarioEvent({ kind: "stage_entered", route: traceRoute, workflow: CLASSIFICATION.workflow, stage, identities: { run: runId as string, stage } });
  return { child: result, handoff, runId: runId as string };
}

async function crashAt(root: string, phase: string, handoff: Record<string, unknown>, marker: string, route: "ordinary" | "cto"): Promise<ChildResult> {
  const child = launch(root, phase, handoff, marker, route);
  await waitForMarker(root, marker, route === "ordinary" ? "O" : "C", child);
  const result = await finish(child);
  assert.notEqual(result.code, 0, `fault boundary '${phase}' must terminate the child process`);
  return result;
}

async function cleanup(root: string): Promise<void> {
  rmSync(root, { recursive: true, force: true });
}

scenarioTest("[O:S06] [C:S06] process replay after a committed submission returns the same receipt exactly once", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-s06`);
    try {
      const fixture = await prepare(root, route);
      await crashAt(root, "submit-crash-after-commit", fixture.handoff, "barrier/committed", route);
      const committedReceipts = stageReceiptsFor(root, route, fixture.runId, "implementation");
      const committedIds = Object.keys(committedReceipts);
      assert.equal(committedIds.length, 1, `${route} commit must publish one implementation receipt`);
      const committedReceipt = committedReceipts[committedIds[0]!];
      const committedReceiptBytes = JSON.stringify(committedReceipt);
      const publicCommittedReceipt = publicReceiptFromLedger(committedReceipt);
      const committedDispatches = dispatchIds(root, route, fixture.runId);
      const replay = await finish(launch(root, "submit-replay", fixture.handoff, "barrier/replay", route));
      assert.equal(replay.code, 0, replay.output);
      const value = requireRecord(replay.result, `${route} replay result`);
      const details = requireRecord(value.replay, `${route} replay details`);
      assert.equal(details.ok, true, replay.output);
      assert.deepEqual(details.receipt, publicCommittedReceipt, `${route} replay must return the public receipt projection`);
      const replayedReceipts = stageReceiptsFor(root, route, fixture.runId, "implementation");
      assert.equal(Object.keys(replayedReceipts).length, 1, `${route} replay must retain one raw implementation receipt`);
      assert.equal(JSON.stringify(replayedReceipts[committedIds[0]!]), committedReceiptBytes, `${route} replay must not change raw receipt bytes`);
      assert.deepEqual(replayedReceipts, committedReceipts, `${route} replay must not create a second receipt version`);
      assert.deepEqual(dispatchIds(root, route, fixture.runId), committedDispatches, `${route} replay must not create a second dispatch`);
    } finally {
      await cleanup(root);
    }
  }
});

scenarioTest("[O:S08] [C:S08] process crash before commit leaves no partial result and restart reconciles the journal", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-s08`);
    try {
      const fixture = await prepare(root, route);
      await crashAt(root, "submit-crash-before-commit", fixture.handoff, "barrier/prepared", route);
      const hit = readFileSync(join(root, "barrier", "prepared"), "utf8").trim();
      assert.equal(hit, "prepared", `${route} must report the selected lifecycle-journal publication fault boundary`);
      const dispatchId = targetDispatchId(root, route, fixture.runId);
      recordScenarioEvent({
        kind: "fault_observed",
        route: route === "ordinary" ? "O" : "C",
        phase: hit,
        faultPoint: "publication",
        identities: { run: fixture.runId, dispatch: dispatchId },
        outcome: "FAIL",
      });
      assert.deepEqual(Object.keys(stageReceiptsFor(root, route, fixture.runId, "implementation")), [], `${route} prepared publication must leave no accepted implementation receipt`);
      const restarted = await finish(launch(root, "recover", fixture.handoff, "diagnose", route));
      assert.equal(restarted.code, 0, restarted.output);
      const value = requireRecord(restarted.result, `${route} restart recovery result`);
      const details = requireRecord(value.recovery, restarted.output);
      assert.equal(details.ok, true, restarted.output);
      const recovery = requireRecord(details.recovery, restarted.output);
      assert.equal(recovery.worker, "unknown", restarted.output);
      assert.equal(recovery.action, "wait", restarted.output);
      assert.equal(recovery.code, "worker_outcome_unknown", restarted.output);
      assert.deepEqual(Object.keys(stageReceiptsFor(root, route, fixture.runId, "implementation")), [], `${route} journal recovery must not publish a partial implementation receipt`);
      assert.ok(dispatchIds(root, route, fixture.runId).includes(dispatchId), `${route} journal recovery must retain the original dispatch identity`);
    } finally {
      await cleanup(root);
    }
  }
});

scenarioTest("[O:R02] [C:R02] process replay of advance keeps one operation and one downstream stage dispatch contract", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-r02`);
    try {
      const fixture = await prepare(root, route);
      const advanced = await finish(launch(root, "advance", fixture.handoff, "barrier/advanced", route));
      assert.equal(advanced.code, 0, advanced.output);
      const advancedValue = requireRecord(advanced.result, `${route} advance result`);
      const advancedDetails = requireRecord(advancedValue.advanced, `${route} advance details`);
      assert.equal(advancedDetails.ok, true, advanced.output);
      assert.equal(advancedValue.operation_id, route === "ordinary" ? "reliable-process-advance-after-approval" : "reliable-process-cto-advance");
      const afterAdvance = canonicalProcessState(root, route, fixture.runId);
      const downstreamStage = route === "ordinary"
        ? afterAdvance.stage_cursor
        : Object.values((afterAdvance.native_stage_progress ?? {}) as Record<string, unknown>)
          .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).stage_id : undefined)
          .find((stage): stage is string => typeof stage === "string");
      assert.notEqual(downstreamStage, "implementation", `${route} advance must enter its downstream stage`);
      const downstreamDispatches = dispatchIds(root, route, fixture.runId);
      const downstreamReceipts = stageReceipts(root, route, fixture.runId);
      const replay = await finish(launch(root, "advance-replay", fixture.handoff, "barrier/replay", route));
      assert.equal(replay.code, 0, replay.output);
      const replayValue = requireRecord(replay.result, `${route} transition replay`);
      const replayDetails = requireRecord(replayValue.replay, `${route} transition details`);
      assert.equal(replayDetails.ok, true, replay.output);
      assert.equal(replayValue.operation_id, advancedValue.operation_id, `${route} replay must use the original operation identity`);
      assert.deepEqual(replayDetails.transition, advancedDetails.transition, `${route} replay must return the original transition`);
      const beforeReplay = requireRecord(replayValue.before_replay, `${route} downstream state before replay`);
      assert.deepEqual(canonicalProcessState(root, route, fixture.runId), beforeReplay, `${route} replay must preserve exact downstream canonical state`);
      assert.equal(dispatchIds(root, route, fixture.runId).length, downstreamDispatches.length, `${route} replay must preserve exact downstream dispatch count`);
      assert.deepEqual(dispatchIds(root, route, fixture.runId), downstreamDispatches, `${route} replay must not dispatch a second downstream worker`);
      assert.deepEqual(stageReceipts(root, route, fixture.runId), downstreamReceipts, `${route} replay must not create a second receipt version`);
    } finally {
      await cleanup(root);
    }
  }
});

scenarioTest("[O:R09] [C:R09] process restart preserves unknown worker state without replacement", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-r09`);
    try {
      const fixture = await prepare(root, route);
      const pending = await finish(launch(root, "admit-pending", fixture.handoff, "barrier/pending", route));
      assert.equal(pending.code, 0, pending.output);
      const unknown = await finish(launch(root, "recover", fixture.handoff, "diagnose", route));
      assert.equal(unknown.code, 0, unknown.output);
      const value = requireRecord(unknown.result, `${route} unknown recovery`);
      const details = requireRecord(value.recovery, `${route} recovery details`);
      assert.equal(details.ok, true, unknown.output);
      const recovery = requireRecord(details.recovery, unknown.output);
      assert.equal(recovery.worker, "unknown", unknown.output);
      assert.equal(recovery.action, "wait", unknown.output);
      assert.equal(recovery.code, "worker_outcome_unknown", unknown.output);
    } finally {
      await cleanup(root);
    }
  }
});

scenarioTest("[O:R13] [C:R13] competing process recovery has one durable winner", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-r13`);
    try {
      const fixture = await prepare(root, route);
      const failed = await finish(launch(root, "terminal-failure", fixture.handoff, "barrier/failed", route));
      assert.equal(failed.code, 0, failed.output);
      const first = launch(root, "recover", fixture.handoff, "barrier/reconcile", route);
      const second = launch(root, "recover", fixture.handoff, "barrier/reconcile", route);
      await Promise.all([
        waitForMarker(root, `barrier/ready-${first.pid}`, route === "ordinary" ? "O" : "C", first),
        waitForMarker(root, `barrier/ready-${second.pid}`, route === "ordinary" ? "O" : "C", second),
      ]);
      releaseBarrier(root, "barrier/reconcile", [first, second]);
      const [left, right] = await Promise.all([finish(first), finish(second)]);
      assert.equal(left.code, 0, left.output);
      assert.equal(right.code, 0, right.output);
      const responses = [left, right].map((result, index) => requireRecord(result.result, `${route} recovery race ${index}`)).map((value) => requireRecord(value.recovery, `${route} recovery race response`));
      const winners = responses.filter((response) => response.ok === true && response.recovery && typeof response.recovery === "object" && (response.recovery as Record<string, unknown>).code === "replacement_dispatched");
      const responseSummary = responses.map((response) => {
        const nested = response.recovery && typeof response.recovery === "object" && !Array.isArray(response.recovery)
          ? response.recovery as Record<string, unknown>
          : undefined;
        return { ok: response.ok, code: response.code, worker: response.worker, action: response.action, recovery_ok: nested?.ok, recovery_code: nested?.code };
      });
      const responseIdentityIds = responses.flatMap((response) => {
        const nested = response.recovery && typeof response.recovery === "object" && !Array.isArray(response.recovery)
          ? response.recovery as Record<string, unknown>
          : undefined;
        const evidence = nested?.evidence && typeof nested.evidence === "object" && !Array.isArray(nested.evidence)
          ? nested.evidence as Record<string, unknown>
          : undefined;
        const identity = evidence?.new_identity && typeof evidence.new_identity === "object" && !Array.isArray(evidence.new_identity)
          ? evidence.new_identity as Record<string, unknown>
          : undefined;
        return typeof identity?.dispatch_id === "string" ? [identity.dispatch_id] : [];
      });
      assert.ok(winners.length >= 1, `${route} recovery race must produce a replacement response: ${JSON.stringify(responseSummary)}`);
      assert.equal(new Set(responseIdentityIds).size, 1, `${route} recovery responses must share one replacement identity: ${JSON.stringify(responseSummary)}`);
      const state = canonicalProcessState(root, route, fixture.runId);
      const ledger = requireRecord(state.stage_recovery, `${route} recovery race ledger`);
      const lineages = requireRecord(ledger.lineages, `${route} recovery race lineages`);
      const operations = Object.values(lineages).flatMap((lineage) => {
        const entries = lineage && typeof lineage === "object" && !Array.isArray(lineage)
          ? (lineage as Record<string, unknown>).operations
          : undefined;
        return Array.isArray(entries) ? entries : [];
      }).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
      const replacementOperations = operations.filter((operation) => operation.action === "replace" && operation.error_class === "terminal_failure");
      assert.equal(replacementOperations.length, 1, `${route} recovery race must persist one replacement operation: ${JSON.stringify(responseSummary)}`);
      const operation = replacementOperations[0]!;
      assert.equal(operation.status, "acked", `${route} recovery race replacement must be acknowledged`);
      const replacementIdentity = requireRecord(operation.replacement_identity, `${route} recovery race replacement identity`);
      assert.equal(typeof replacementIdentity.dispatch_id, "string", `${route} recovery race replacement identity must be durable`);
      assert.equal(new Set([...responseIdentityIds, replacementIdentity.dispatch_id]).size, 1, `${route} recovery race response/ledger identity mismatch`);
      const admission = requireRecord(operation.admission, `${route} recovery race replacement permit`);
      assert.equal(admission.state, "ready", `${route} recovery race must leave one queued replacement permit`);
      const operationResponse = requireRecord(operation.response, `${route} recovery race operation response`);
      assert.equal(operationResponse.code, "replacement_dispatched", `${route} recovery race operation must record replacement response`);
      const budgets = Object.values(lineages).flatMap((lineage) => {
        const entries = lineage && typeof lineage === "object" && !Array.isArray(lineage)
          ? (lineage as Record<string, unknown>).budgets
          : undefined;
        return Array.isArray(entries) ? entries : [];
      }).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
      const terminalBudget = budgets.find((budget) => budget.error_class === "terminal_failure");
      assert.ok(terminalBudget, `${route} recovery race must persist terminal-failure budget`);
      assert.equal(terminalBudget.used, 1, `${route} recovery race must consume one terminal-failure budget`);
    } finally {
      await cleanup(root);
    }
  }
});

scenarioTest("[O:R14] [C:R14] process restart preserves bounded recovery budget until explicit continuation", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-r14`);
    try {
      const fixture = await prepare(root, route);
      let handoff = { ...fixture.handoff };
      const replacements: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await finish(launch(root, "terminal-failure", handoff, `barrier/failed-${attempt}`, route));
        assert.equal(failed.code, 0, failed.output);
        const recoveryHandoff = attempt === 2 ? { ...handoff, recovery_decision: "do_not_retry" } : handoff;
        const recovered = await finish(launch(root, "recover", recoveryHandoff, "reconcile", route));
        assert.equal(recovered.code, 0, recovered.output);
        const value = requireRecord(recovered.result, `${route} R14 recovery ${attempt}`);
        const response = requireRecord(value.recovery, `${route} R14 recovery response ${attempt}`);
        if (attempt < 2) {
          assert.equal(response.ok, true, recovered.output);
          const details = requireRecord(response.recovery, recovered.output);
          assert.equal(details.code, "replacement_dispatched", recovered.output);
          const evidence = requireRecord(details.evidence, recovered.output);
          const identity = requireRecord(evidence.new_identity, recovered.output);
          assert.equal(typeof identity.dispatch_id, "string", recovered.output);
          replacements.push(identity.dispatch_id as string);
          handoff = { ...handoff, retry_suffix: `-retry-${attempt + 1}` };
        } else {
          assert.equal(response.ok, false, recovered.output);
          assert.equal(response.code, "WORKFLOW_RECOVERY_GRANT_REJECTED", recovered.output);
        }
      }
      assert.equal(new Set(replacements).size, 2, `${route} R14 must consume two distinct default replacement attempts`);
      const continued = await finish(launch(root, "recover", { ...handoff, recovery_decision: "authorize_one_retry" }, "reconcile", route));
      assert.equal(continued.code, 0, continued.output);
      const continuedValue = requireRecord(continued.result, `${route} R14 bounded continuation`);
      const continuedResponse = requireRecord(continuedValue.recovery, continued.output);
      assert.equal(continuedResponse.ok, true, continued.output);
      assert.equal(requireRecord(continuedResponse.recovery, continued.output).code, "replacement_dispatched", continued.output);
      const state = canonicalProcessState(root, route, fixture.runId);
      const ledger = state.stage_recovery;
      assert.ok(ledger && typeof ledger === "object" && !Array.isArray(ledger), `${route} R14 must persist the recovery ledger`);
      const lineages = (ledger as Record<string, unknown>).lineages;
      assert.ok(lineages && typeof lineages === "object" && !Array.isArray(lineages), `${route} R14 ledger must persist lineages`);
      const grants = Object.values(lineages as Record<string, unknown>).flatMap((lineage) => {
        if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return [];
        const entries = (lineage as Record<string, unknown>).grants;
        return Array.isArray(entries) ? entries : [];
      });
      assert.equal(grants.length, 1, `${route} R14 must persist one bounded UI grant`);
      assert.equal(requireRecord(grants[0], continued.output).limit, 1, `${route} R14 UI grant must be limited to one retry`);
    } finally {
      await cleanup(root);
    }
  }
});

scenarioTest("[C:R22] process END with an active native worker waits for terminal acknowledgement before release", async () => {
  const root = scratch("reliable-p-cto-r22");
  try {
    const fixture = await prepare(root, "cto");
    const admitted = await finish(launch(root, "admit-pending", fixture.handoff, "barrier/native-pending", "cto"));
    assert.equal(admitted.code, 0, admitted.output);
    const pending = await finish(launch(root, "cto-end", fixture.handoff, "barrier/end", "cto"));
    assert.equal(pending.code, 0, pending.output);
    const value = requireRecord(pending.result, "native END result");
    const read = requireRecord(value.read, "native END read result");
    assert.equal(read.ok, true, pending.output);
    assert.ok(read.state && typeof read.state === "object", pending.output);
  } finally {
    await cleanup(root);
  }
});

scenarioTest("[O:R24] [C:R24] process restart resumes a genuinely pending checkpoint without repeating worker or advance", async () => {
  for (const route of ["ordinary", "cto"] as const) {
    const root = scratch(`reliable-p-${route}-r24`);
    try {
      const fixture = await prepare(root, route);
      const pending = launch(root, "checkpoint-pending", fixture.handoff, "barrier/checkpoint-release", route);
      await waitForMarker(root, `barrier/checkpoint-ready-${pending.pid}`, route === "ordinary" ? "O" : "C", pending);
      pending.kill("SIGKILL");
      const stopped = await finish(pending);
      assert.equal(stopped.signal, "SIGKILL", stopped.output);
      const pendingDispatches = dispatchIds(root, route, fixture.runId);
      const resumed = await finish(launch(root, "checkpoint-replay", fixture.handoff, "barrier/replayed", route));
      assert.equal(resumed.code, 0, resumed.output);
      const value = requireRecord(resumed.result, `${route} checkpoint resume`);
      const ask = requireRecord(value.ask, `${route} checkpoint answer`);
      assert.equal(ask.ok, true, resumed.output);
      assert.deepEqual(dispatchIds(root, route, fixture.runId), pendingDispatches, `${route} checkpoint restart must not repeat worker dispatch`);
      const state = canonicalProcessState(root, route, fixture.runId);
      const stage = route === "ordinary"
        ? state.stage_cursor
        : Object.values((state.native_stage_progress ?? {}) as Record<string, unknown>)
          .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).stage_id : undefined)
          .find((candidate): candidate is string => typeof candidate === "string");
      assert.equal(stage, "implementation", `${route} checkpoint restart must not advance the stage`);
      assert.equal(Object.keys(stageReceiptsFor(root, route, fixture.runId, "implementation")).length, 1, `${route} checkpoint restart must retain one worker receipt`);
    } finally {
      await cleanup(root);
    }
  }
});
