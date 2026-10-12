import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  createWorkflowSessionController,
  registerTeamWorkflow,
  registerWorkflowTools,
  LifecycleError,
} from "../src/index.js";
import type { WorkflowSessionController } from "../src/engine/host-controller.js";
import { readRunControl } from "../src/engine/run-store.js";
import {
  admitCtoLeadAndWorker,
  admitOrdinaryWorker,
  CLASSIFICATION,
  ctoHarness,
  ctoIngress,
  ordinaryHarness,
  ordinaryIngress,
  RELIABLE_PROFILE,
  sessionManager,
  type Harness,
  type SessionManager,
  type WorkerFixture,
} from "./reliable-stage-execution-fixture.js";

type TestContext = {
  cwd: string;
  mode: string;
  hasUI: boolean;
  session_id: string;
  sessionFile: string;
  sessionManager: SessionManager;
  ui?: { select: () => Promise<string>; notify: () => void };
};
type Hook = (event: unknown, context: unknown) => unknown;
type RegisteredTool = {
  execute: (id: string, params: unknown, signal: unknown, update: unknown, context: unknown) => Promise<{ details: unknown }>;
};
type CoreExtension = {
  readonly root: string;
  readonly context: TestContext;
  readonly events: TestBus;
  readonly hooks: Map<string, Hook[]>;
  readonly tools: Map<string, RegisteredTool>;
};
type ControllerResolver = (context: unknown, cwd: string) => WorkflowSessionController | undefined;
type ActorResolver = (context: unknown, cwd: string, runId: string | undefined) => unknown;

/** Mirror the SDK EventBus contract: emit is synchronous and does not await listeners. */
class TestBus {
  private readonly listeners = new Map<string, Set<(value: unknown) => unknown>>();

  on(channel: string, listener: (value: unknown) => unknown): () => void {
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  emit(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) void listener(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextCwd(context: unknown): string | undefined {
  if (!isRecord(context) || !isRecord(context.sessionManager)) return undefined;
  const manager = context.sessionManager as { getCwd?: unknown };
  if (typeof manager.getCwd !== "function") return undefined;
  try {
    const cwd = (manager.getCwd as () => unknown)();
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-ordinary-task-lineage-"));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({
    roles: { dev: "developer" },
    scope_map: [{ glob: ["**/*"], scope: "backend", dev_agent: "developer" }],
  }) + "\n");
  return root;
}

function makeContext(
  cwd: string,
  id: string,
  file: string,
  mode: "tui" | "print",
  hasUI: boolean,
  parentSession?: string,
): TestContext {
  const manager = sessionManager(cwd, id, file, parentSession);
  return {
    cwd,
    mode,
    hasUI,
    session_id: id,
    sessionFile: file,
    sessionManager: manager,
    ...(hasUI ? { ui: { select: async () => "proceed", notify() {} } } : {}),
  };
}

function makeController(root: string, sessionId: string): WorkflowSessionController {
  return createWorkflowSessionController({
    cwd: root,
    context: {
      session_id: sessionId,
      caller: "host",
      process_id: process.pid,
      worktree: root,
      branch: "main",
      authority: "coordinator",
    },
  });
}

function registerCoreExtension(
  root: string,
  context: TestContext,
  options: {
    readonly actor: "interactive-no-run" | "idle-basic" | "unresolved";
    readonly getController?: ControllerResolver;
    readonly resolveActor?: ActorResolver;
  },
): CoreExtension {
  const events = new TestBus();
  const hooks = new Map<string, Hook[]>();
  const tools = new Map<string, RegisteredTool>();
  const on = (name: string, handler: Hook): void => {
    let handlers = hooks.get(name);
    if (!handlers) {
      handlers = [];
      hooks.set(name, handlers);
    }
    handlers.push(handler);
  };
  const pi = {
    zod: { z },
    setLabel() {},
    on,
    events,
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<{ details: unknown }> }) {
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
    registerCommand() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  const actorResolver: ActorResolver = options.resolveActor ?? ((candidate) => {
    if (candidate !== context) return undefined;
    if (options.actor === "interactive-no-run") return { kind: "authenticated-interactive-host-no-run" };
    if (options.actor === "idle-basic") return { kind: "authenticated-host-idle-basic-tools" };
    return undefined;
  });
  const resolveCwd = (candidate: unknown): string | undefined => contextCwd(candidate);
  registerTeamWorkflow(pi as never, {
    observability: false,
    resolveCwd,
    workflowProfiles: [RELIABLE_PROFILE],
    roles: { dev: "developer" },
    scopeMap: [{ glob: ["**/*"], scope: "backend", dev_agent: "developer" }],
    ...(options.getController ? { getSessionController: options.getController } : {}),
    resolveTrustedToolCallActor: actorResolver,
  });
  registerWorkflowTools(pi as never, { resolveCwd });
  return { root, context, events, hooks, tools };
}

function fireHook(extension: CoreExtension, name: string, event: unknown, context: unknown): unknown[] {
  const results: unknown[] = [];
  for (const handler of extension.hooks.get(name) ?? []) results.push(handler(event, context));
  return results;
}

async function startSession(extension: CoreExtension, context: TestContext): Promise<void> {
  await Promise.all(fireHook(extension, "session_start", { type: "session_start" }, context).map(async (result) => await result));
}

async function stopSession(extension: CoreExtension, context: TestContext): Promise<void> {
  await Promise.all(fireHook(extension, "session_shutdown", { type: "session_shutdown" }, context).map(async (result) => await result));
}

function firstBlock(results: unknown[]): Record<string, unknown> | undefined {
  return results.find((result): result is Record<string, unknown> => isRecord(result) && result.block === true);
}

function toolCall(
  extension: CoreExtension,
  context: TestContext,
  toolName: string,
  input: unknown,
  toolCallId?: string,
): unknown[] {
  return fireHook(extension, "tool_call", {
    toolName,
    input,
    ...(toolCallId ? { toolCallId } : {}),
  }, context);
}

function assertAllowed(extension: CoreExtension, context: TestContext, toolName: string, input: unknown, toolCallId?: string): void {
  const results = toolCall(extension, context, toolName, input, toolCallId);
  assert.equal(firstBlock(results), undefined, `${toolName} should be admitted, got ${JSON.stringify(results)}`);
}

function assertBlocked(extension: CoreExtension, context: TestContext, toolName: string, input: unknown, toolCallId?: string): Record<string, unknown> {
  const result = firstBlock(toolCall(extension, context, toolName, input, toolCallId));
  assert.ok(result, `${toolName} should be denied`);
  return result;
}

function startTaskExecution(
  extension: CoreExtension,
  context: TestContext,
  toolCallId: string,
  input: unknown,
  args: unknown = input,
): void {
  assertAllowed(extension, context, "task", input, toolCallId);
  fireHook(extension, "tool_execution_start", { toolName: "task", toolCallId, args }, context);
}

function lifecycleStart(
  parent: CoreExtension,
  input: { id: string; agent: string; sessionFile: string; parentToolCallId: string; index: number },
): void {
  parent.events.emit("task:subagent:lifecycle", { ...input, status: "started" });
}

function extensionToolsResult(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "registered tool result details must be an object");
  return value;
}

async function executeTool(
  extension: CoreExtension,
  name: string,
  id: string,
  params: unknown,
  context: TestContext,
): Promise<Record<string, unknown>> {
  const tool = extension.tools.get(name);
  assert.ok(tool, `registered ${name} API is available`);
  const result = await tool.execute(id, params, undefined, undefined, context);
  return extensionToolsResult(result.details);
}

function ordinaryRoot(root: string, context: TestContext, controller = makeController(root, context.session_id)): CoreExtension {
  return registerCoreExtension(root, context, {
    actor: "interactive-no-run",
    getController: (candidate) => candidate === context ? controller : undefined,
  });
}

function ordinaryChild(root: string, context: TestContext, actor: "idle-basic" | "unresolved" = "unresolved"): CoreExtension {
  return registerCoreExtension(root, context, { actor });
}

async function activateChild(
  root: string,
  parent: CoreExtension,
  input: { id: string; agent: string; sessionFile: string; parentToolCallId: string; index: number },
  context: TestContext,
  actor: "idle-basic" | "unresolved" = "unresolved",
): Promise<CoreExtension> {
  lifecycleStart(parent, input);
  const child = ordinaryChild(root, context, actor);
  await startSession(child, context);
  return child;
}

const CANONICAL_CLASSIFICATION = {
  ...CLASSIFICATION,
  workflow: RELIABLE_PROFILE.name,
};

test("registered ordinary root admits an independent nested task chain outside workflow state", async () => {
  const root = makeWorkspace();
  const rootFile = join(root, "interactive-root.jsonl");
  const rootContext = makeContext(root, "interactive-root", rootFile, "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const control = readRunControl(root);
    assert.equal(control.execution_claim, null);
    assert.deepEqual(control.selections, {});

    assertAllowed(extension, rootContext, "ask", { question: "Should this continue?" });
    const rootInput = { agent: "developer-go", task: "inspect this ordinary request" };
    const rootCallId = "ordinary-root-task";
    startTaskExecution(extension, rootContext, rootCallId, rootInput);

    const childCwd = join(root, "isolated-child-worktree");
    mkdirSync(childCwd, { recursive: true });
    const childFile = join(childCwd, "child-session.jsonl");
    const childContext = makeContext(childCwd, "ordinary-child-session", childFile, "print", false);
    assert.notStrictEqual(childContext.sessionManager, rootContext.sessionManager);
    assert.equal(childContext.sessionManager.getHeader().parentSession, undefined, "fresh SDK child headers need not carry parentSession");
    const child = await activateChild(root, extension, {
      id: "ordinary-root-lifecycle",
      agent: rootInput.agent,
      sessionFile: childFile,
      parentToolCallId: rootCallId,
      index: 0,
    }, childContext);
    children.push({ extension: child, context: childContext });
    assert.equal(childContext.sessionManager.getCwd(), childContext.sessionManager.getHeader().cwd);
    assert.equal(childContext.sessionManager.getHeader().cwd, childCwd, "isolated child cwd is validated against its own manager/header, not the root cwd");

    const childWrite = { path: join(childCwd, "src", "ordinary-child.txt"), content: "ordinary work" };
    assertAllowed(child, childContext, "bash", { command: "printf ordinary" });
    assertAllowed(child, childContext, "write", childWrite);
    assertAllowed(child, childContext, "edit", { path: childWrite.path, oldText: "before", newText: "after" });
    await stopSession(extension, { ...rootContext, mode: "print", hasUI: false, ui: undefined });
    assertAllowed(child, childContext, "bash", { command: "printf root-survives-headless-callback" });

    assertBlocked(child, childContext, "write", {
      path: join(root, ".work-state", "run-control.json"),
      content: "{}\n",
    });
    assertBlocked(child, childContext, "bash", { command: `printf corrupt > ${join(root, ".work-state", "run-control.json")}` });
    assertBlocked(child, childContext, "write", { path: "../.work-state/run-control.json", content: "{}" });
    assertBlocked(child, childContext, "edit", { path: "../.work-state/run-control.json", oldText: "null", newText: "{}" });
    assertBlocked(child, childContext, "bash", { command: "printf corrupt > ../.work-state/run-control.json" });
    assertAllowed(child, childContext, "write", { path: "relative-ordinary.txt", content: "ordinary child-relative target" });
    assertBlocked(child, childContext, "bash", { command: "rm -rf /" });

    const submitted = await executeTool(child, "workflow_submit_result", "ordinary-child-submit", {
      outputs: { implementation: { ready: true, validation_run: true, validation_evidence: "ordinary task is not a workflow assignment", files_touched: ["src/ordinary-child.txt"] } },
    }, childContext);
    assert.equal(submitted.ok, false, "ordinary lineage grants task tools, never workflow publication authority");
    const prepared = await executeTool(child, "workflow_prepare", "ordinary-child-prepare", {
      mode: "new",
      task: "an ordinary child cannot start a workflow",
      classification: CANONICAL_CLASSIFICATION,
    }, childContext);
    assert.equal(prepared.ok, false, "public workflow control tools remain unavailable to ordinary task children");

    fireHook(extension, "tool_execution_end", {
      toolName: "task",
      toolCallId: rootCallId,
      isError: false,
      result: { details: { async: { state: "completed" } } },
    }, rootContext);
    assertAllowed(child, childContext, "bash", { command: "printf still-running-child" });

    const nestedInput = { agent: "qa", task: "perform nested ordinary check" };
    const nestedCallId = "ordinary-child-nested-task";
    startTaskExecution(child, childContext, nestedCallId, nestedInput);
    const nestedCwd = join(childCwd, "nested-isolated-worktree");
    mkdirSync(nestedCwd, { recursive: true });
    const nestedFile = join(nestedCwd, "nested-session.jsonl");
    const nestedContext = makeContext(nestedCwd, "ordinary-grandchild-session", nestedFile, "print", false);
    const nested = await activateChild(nestedCwd, child, {
      id: "ordinary-child-nested-lifecycle",
      agent: nestedInput.agent,
      sessionFile: nestedFile,
      parentToolCallId: nestedCallId,
      index: 0,
    }, nestedContext);
    children.push({ extension: nested, context: nestedContext });
    assert.equal(nestedContext.sessionManager.getHeader().parentSession, undefined);
    assertAllowed(nested, nestedContext, "bash", { command: "printf nested-ordinary-work" });

    const stillEmpty = readRunControl(root);
    assert.equal(stillEmpty.execution_claim, null);
    assert.deepEqual(stillEmpty.selections, {});
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("inactive historical workflow selections do not block an authenticated no-run ordinary task", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "inactive-history-root", join(root, "inactive-history-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootContext);
    const control = readRunControl(root);
    control.selections["historic-session"] = {
      run_id: "123e4567-e89b-12d3-a456-426614174000",
      branch: "main",
      selected_at: "2026-01-01T00:00:00.000Z",
      active: false,
    };
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "run-control.json"), `${JSON.stringify(control, null, 2)}\n`);
    const persisted = readRunControl(root);
    assert.equal(persisted.execution_claim, null);
    assert.deepEqual(Object.values(persisted.selections).map((selection) => selection.active), [false]);

    const input = { agent: "developer-go", task: "continue with unrelated ordinary work" };
    const toolCallId = "inactive-history-root-task";
    startTaskExecution(extension, rootContext, toolCallId, input);
    const file = join(root, "inactive-history-child.jsonl");
    childContext = makeContext(root, "inactive-history-child", file, "print", false);
    child = await activateChild(root, extension, {
      id: "inactive-history-lifecycle",
      agent: input.agent,
      sessionFile: file,
      parentToolCallId: toolCallId,
      index: 0,
    }, childContext);
    assertAllowed(child, childContext, "write", { path: join(root, "src", "inactive-history.txt"), content: "allowed" });
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch ordinary children bind original indexes and reject mismatched lifecycle slots", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "batch-root", join(root, "batch-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const tasks = [
      { agent: "developer-zero", task: "original slot zero" },
      { agent: "qa-one", task: "original slot one" },
      { agent: "developer-two", task: "original slot two" },
    ];
    const input = { context: "one batch call", tasks };
    const toolCallId = "ordinary-batch-slots";
    startTaskExecution(extension, rootContext, toolCallId, input, structuredClone(input));

    const slotTwoFile = join(root, "batch-slot-two.jsonl");
    const slotTwoContext = makeContext(root, "batch-slot-two", slotTwoFile, "print", false);
    const slotTwo = await activateChild(root, extension, {
      id: "batch-slot-two-lifecycle",
      agent: tasks[2]!.agent,
      sessionFile: slotTwoFile,
      parentToolCallId: toolCallId,
      index: 2,
    }, slotTwoContext);
    children.push({ extension: slotTwo, context: slotTwoContext });
    assertAllowed(slotTwo, slotTwoContext, "bash", { command: "printf slot-two" });

    const slotZeroFile = join(root, "batch-slot-zero.jsonl");
    const slotZeroContext = makeContext(root, "batch-slot-zero", slotZeroFile, "print", false);
    const slotZero = await activateChild(root, extension, {
      id: "batch-slot-zero-lifecycle",
      agent: tasks[0]!.agent,
      sessionFile: slotZeroFile,
      parentToolCallId: toolCallId,
      index: 0,
    }, slotZeroContext);
    children.push({ extension: slotZero, context: slotZeroContext });
    assertAllowed(slotZero, slotZeroContext, "write", { path: join(root, "src", "slot-zero.txt"), content: "allowed" });

    const spoofedSlotOneFile = join(root, "batch-slot-one.jsonl");
    lifecycleStart(extension, {
      id: "batch-slot-one-wrong-index",
      agent: tasks[1]!.agent,
      sessionFile: spoofedSlotOneFile,
      parentToolCallId: toolCallId,
      index: 2,
    });
    const spoofedSlotOneContext = makeContext(root, "batch-slot-one", spoofedSlotOneFile, "print", false);
    const spoofedSlotOne = ordinaryChild(root, spoofedSlotOneContext);
    children.push({ extension: spoofedSlotOne, context: spoofedSlotOneContext });
    await startSession(spoofedSlotOne, spoofedSlotOneContext);
    assertBlocked(spoofedSlotOne, spoofedSlotOneContext, "bash", { command: "printf slot-one-must-not-bind" });
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary lineage requires unchanged task args and one exact lifecycle/session identity", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "tuple-root", join(root, "tuple-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);

    const admitted = { agent: "developer-go", task: "admitted task text" };
    const changedArgs = { agent: "developer-go", task: "different execution args" };
    const changedCallId = "ordinary-changed-execution-args";
    startTaskExecution(extension, rootContext, changedCallId, admitted, changedArgs);
    const changedFile = join(root, "changed-args-child.jsonl");
    lifecycleStart(extension, {
      id: "changed-args-lifecycle",
      agent: changedArgs.agent,
      sessionFile: changedFile,
      parentToolCallId: changedCallId,
      index: 0,
    });
    const changedContext = makeContext(root, "changed-args-child", changedFile, "print", false);
    const changedChild = ordinaryChild(root, changedContext);
    children.push({ extension: changedChild, context: changedContext });
    await startSession(changedChild, changedContext);
    assertBlocked(changedChild, changedContext, "bash", { command: "printf changed-args-denied" });

    const ambiguousCallId = "ordinary-ambiguous-lifecycle";
    const exactInput = { agent: "qa", task: "one exact slot" };
    startTaskExecution(extension, rootContext, ambiguousCallId, exactInput);
    const ambiguousFile = join(root, "ambiguous-child.jsonl");
    const lifecycle = {
      agent: exactInput.agent,
      sessionFile: ambiguousFile,
      parentToolCallId: ambiguousCallId,
      index: 0,
    };
    lifecycleStart(extension, { id: "ambiguous-lifecycle-a", ...lifecycle });
    lifecycleStart(extension, { id: "ambiguous-lifecycle-b", ...lifecycle });
    const ambiguousContext = makeContext(root, "ambiguous-child", ambiguousFile, "print", false);
    const ambiguousChild = ordinaryChild(root, ambiguousContext);
    children.push({ extension: ambiguousChild, context: ambiguousContext });
    await startSession(ambiguousChild, ambiguousContext);
    assertBlocked(ambiguousChild, ambiguousContext, "write", { path: join(root, "src", "ambiguous.txt"), content: "denied" });

    const fileCallId = "ordinary-lifecycle-file-mismatch";
    const fileInput = { agent: "developer-go", task: "exact admitted and executed" };
    startTaskExecution(extension, rootContext, fileCallId, fileInput);
    const lifecycleFile = join(root, "lifecycle-file.jsonl");
    lifecycleStart(extension, {
      id: "lifecycle-file-mismatch",
      agent: fileInput.agent,
      sessionFile: lifecycleFile,
      parentToolCallId: fileCallId,
      index: 0,
    });
    const actualFile = join(root, "actual-child-file.jsonl");
    const fileContext = makeContext(root, "lifecycle-file-child", actualFile, "print", false);
    const fileChild = ordinaryChild(root, fileContext);
    children.push({ extension: fileChild, context: fileContext });
    await startSession(fileChild, fileContext);
    assertBlocked(fileChild, fileContext, "bash", { command: "printf lifecycle-file-mismatch" });

    const managerCallId = "ordinary-manager-replacement";
    const managerInput = { agent: "qa", task: "manager snapshot identity" };
    startTaskExecution(extension, rootContext, managerCallId, managerInput);
    const managerFile = join(root, "manager-child.jsonl");
    lifecycleStart(extension, {
      id: "manager-replacement-lifecycle",
      agent: managerInput.agent,
      sessionFile: managerFile,
      parentToolCallId: managerCallId,
      index: 0,
    });
    const managerContext = makeContext(root, "manager-child", managerFile, "print", false);
    const managerChild = ordinaryChild(root, managerContext);
    children.push({ extension: managerChild, context: managerContext });
    await startSession(managerChild, managerContext);
    assertAllowed(managerChild, managerContext, "bash", { command: "printf bound-manager" });
    managerContext.sessionManager = sessionManager(root, "replacement-manager-id", managerFile);
    assertBlocked(managerChild, managerContext, "bash", { command: "printf replacement-manager-denied" });
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow claim appearing during an ordinary child revokes its task lineage", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "claim-change-root", join(root, "claim-change-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootContext);
    const input = { agent: "developer-go", task: "begin as an ordinary no-run task" };
    const callId = "ordinary-before-workflow-claim";
    startTaskExecution(extension, rootContext, callId, input);
    const file = join(root, "claim-change-child.jsonl");
    childContext = makeContext(root, "claim-change-child", file, "print", false);
    child = await activateChild(root, extension, {
      id: "claim-change-child-lifecycle",
      agent: input.agent,
      sessionFile: file,
      parentToolCallId: callId,
      index: 0,
    }, childContext);
    assertAllowed(child, childContext, "bash", { command: "printf before-workflow" });

    const prepared = await executeTool(extension, "workflow_prepare", "claim-change-prepare", {
      mode: "new",
      task: "a real workflow now owns this workspace",
      classification: CANONICAL_CLASSIFICATION,
    }, rootContext);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const begun = await executeTool(extension, "workflow_begin", "claim-change-begin", {}, rootContext);
    assert.equal(begun.ok, true, JSON.stringify(begun));
    assert.ok(readRunControl(root).execution_claim, "the workflow tools acquired a real canonical execution claim");
    assertBlocked(child, childContext, "bash", { command: "printf ordinary-lineage-must-be-revoked" });
    assertBlocked(child, childContext, "task", { agent: "qa", task: "ordinary child cannot nest after claim change" }, "ordinary-after-workflow-claim");
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("root session replacement revokes a live ordinary child", async () => {
  const root = makeWorkspace();
  const rootA = makeContext(root, "switch-root-a", join(root, "switch-root-a.jsonl"), "tui", true);
  const rootB = makeContext(root, "switch-root-b", join(root, "switch-root-b.jsonl"), "tui", true);
  const controllerA = makeController(root, rootA.session_id);
  const controllerB = makeController(root, rootB.session_id);
  let currentContext = rootA;
  let currentController = controllerA;
  const extension = registerCoreExtension(root, rootA, {
    actor: "unresolved",
    getController: (candidate) => candidate === currentContext ? currentController : undefined,
    resolveActor: (candidate) => candidate === currentContext
      ? { kind: "authenticated-interactive-host-no-run" }
      : undefined,
  });
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootA);
    const input = { agent: "developer-go", task: "root A ordinary dispatch" };
    const callId = "root-a-switch-task";
    startTaskExecution(extension, rootA, callId, input);
    const file = join(root, "switch-child.jsonl");
    childContext = makeContext(root, "switch-child", file, "print", false);
    child = await activateChild(root, extension, {
      id: "switch-child-lifecycle",
      agent: input.agent,
      sessionFile: file,
      parentToolCallId: callId,
      index: 0,
    }, childContext);
    assertAllowed(child, childContext, "write", { path: join(root, "src", "before-switch.txt"), content: "allowed" });
    // The SDK replaces the header/file on the existing manager during a switch.
    Object.assign(rootA.sessionManager, rootB.sessionManager);
    rootB.sessionManager = rootA.sessionManager;
    currentContext = rootB;
    currentController = controllerB;

    const switchHandlers = extension.hooks.get("session_switch") ?? [];
    await Promise.all(switchHandlers.map(async (handler) => await handler({
      type: "session_switch",
      reason: "new",
      previousSessionFile: rootA.sessionFile,
    }, rootB)));
    assertBlocked(child, childContext, "bash", { command: "printf old-root-lineage-denied" });
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootB);
    rmSync(root, { recursive: true, force: true });
  }
});

test("headless idle-basic identity cannot seed an ordinary root lineage", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "headless-idle-root", join(root, "headless-idle-root.jsonl"), "print", false);
  const controller = makeController(root, rootContext.session_id);
  const extension = registerCoreExtension(root, rootContext, {
    actor: "idle-basic",
    getController: (candidate) => candidate === rootContext ? controller : undefined,
  });
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootContext);
    const input = { agent: "developer-go", task: "untrusted headless root attempt" };
    const callId = "headless-idle-root-task";
    const admission = toolCall(extension, rootContext, "task", input, callId);
    if (!firstBlock(admission)) {
      fireHook(extension, "tool_execution_start", { toolName: "task", toolCallId: callId, args: input }, rootContext);
    }
    const file = join(root, "headless-idle-child.jsonl");
    if (!firstBlock(admission)) {
      lifecycleStart(extension, {
        id: "headless-idle-child-lifecycle",
        agent: input.agent,
        sessionFile: file,
        parentToolCallId: callId,
        index: 0,
      });
    }
    childContext = makeContext(root, "headless-idle-child", file, "print", false);
    child = ordinaryChild(root, childContext);
    await startSession(child, childContext);
    assertBlocked(child, childContext, "bash", { command: "printf generic-idle-basic-is-not-root-authority" });
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow and native workers cannot inherit ordinary nested-task rights or revive after terminal", async () => {
  const workflow: Harness = ordinaryHarness();
  let workflowExtension: CoreExtension | undefined;
  let nativeExtension: CoreExtension | undefined;
  try {
    const { handoff } = await ordinaryIngress(workflow);
    const ordinaryWorker: WorkerFixture = await admitOrdinaryWorker(workflow, handoff, "ordinary-lineage-security");
    workflowExtension = ordinaryChild(workflow.root, ordinaryWorker.childContext, "idle-basic");
    await startSession(workflowExtension, ordinaryWorker.childContext);
    assertBlocked(workflowExtension, ordinaryWorker.childContext, "task", { agent: "qa", task: "workflow worker must not re-delegate" }, "workflow-worker-nested-task");

    const native: Harness = ctoHarness();
    try {
      const { runId } = await ctoIngress(native);
      const nativeWorker = await admitCtoLeadAndWorker(native, runId, "ordinary-lineage-security");
      nativeExtension = ordinaryChild(native.root, nativeWorker.childContext, "idle-basic");
      await startSession(nativeExtension, nativeWorker.childContext);
      assertBlocked(nativeExtension, nativeWorker.childContext, "task", { agent: "developer", task: "native worker must not re-delegate" }, "native-worker-nested-task");

      await native.emit("task:subagent:lifecycle", {
        id: `${nativeWorker.toolCallId}-lifecycle`,
        agent: nativeWorker.input.agent,
        status: "completed",
        sessionFile: nativeWorker.childFile,
        parentToolCallId: nativeWorker.toolCallId,
        index: 0,
      });
      assertBlocked(nativeExtension, nativeWorker.childContext, "bash", { command: "printf revoked-native-child-cannot-fall-back-to-idle-basic" });
    } finally {
      if (nativeExtension) await stopSession(nativeExtension, nativeExtension.context);
      await native.close();
    }
  } finally {
    if (workflowExtension) await stopSession(workflowExtension, workflowExtension.context);
    await workflow.close();
  }
});

test("successful synchronous batch completion closes never-started slots but preserves a live child", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "sync-batch-root", join(root, "sync-batch-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const tasks = [
      { agent: "developer-zero", task: "start slot zero" },
      { agent: "qa-one", task: "leave slot one pending" },
    ];
    const input = { context: "synchronous batch", tasks };
    const toolCallId = "sync-batch-task";
    startTaskExecution(extension, rootContext, toolCallId, input, structuredClone(input));

    const activeLifecycle = {
      id: "sync-slot-zero-lifecycle",
      agent: tasks[0]!.agent,
      sessionFile: join(root, "sync-slot-zero.jsonl"),
      parentToolCallId: toolCallId,
      index: 0,
    };
    const activeContext = makeContext(root, "sync-slot-zero", activeLifecycle.sessionFile, "print", false);
    const activeChild = await activateChild(root, extension, activeLifecycle, activeContext, "idle-basic");
    children.push({ extension: activeChild, context: activeContext });
    assertAllowed(activeChild, activeContext, "bash", { command: "printf active-slot-zero" });

    fireHook(extension, "tool_execution_end", {
      toolName: "task",
      toolCallId,
      isError: false,
      result: { details: {} },
    }, rootContext);

    const lateLifecycle = {
      id: "sync-slot-one-lifecycle",
      agent: tasks[1]!.agent,
      sessionFile: join(root, "sync-slot-one.jsonl"),
      parentToolCallId: toolCallId,
      index: 1,
    };
    lifecycleStart(extension, lateLifecycle);
    const lateContext = makeContext(root, "sync-slot-one", lateLifecycle.sessionFile, "print", false);
    const lateChild = ordinaryChild(root, lateContext, "idle-basic");
    children.push({ extension: lateChild, context: lateContext });
    await startSession(lateChild, lateContext);
    assertBlocked(lateChild, lateContext, "bash", { command: "printf late-sync-slot-one" });
    assertAllowed(activeChild, activeContext, "bash", { command: "printf active-slot-zero-after-late-start" });

    extension.events.emit("task:subagent:lifecycle", { ...activeLifecycle, status: "completed" });
    assertBlocked(activeChild, activeContext, "bash", { command: "printf terminal-slot-zero" });
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("running SDK acknowledgements preserve only exact pending lifecycle slots", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "async-ack-root", join(root, "async-ack-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const tasks = [
      { agent: "qa-zero", task: "valid acknowledged slot" },
      { agent: "qa-one", task: "mismatched acknowledged id" },
      { agent: "qa-two", task: "mismatched acknowledged index" },
      { agent: "qa-three", task: "mismatched acknowledged agent" },
    ];
    const input = { context: "SDK queued task batch", tasks };
    const toolCallId = "async-ack-task";
    startTaskExecution(extension, rootContext, toolCallId, input, structuredClone(input));
    fireHook(extension, "tool_execution_end", {
      toolName: "task",
      toolCallId,
      isError: false,
      result: {
        details: {
          async: { state: "running", jobId: "sdk-task-job", type: "task" },
          progress: [
            { id: "sdk-slot-zero", index: 0, agent: "qa-zero", status: "pending" },
            { id: "sdk-slot-one", index: 1, agent: "qa-one", status: "running" },
            { id: "sdk-slot-two", index: 8, agent: "qa-two", status: "pending" },
            { id: "sdk-slot-three", index: 3, agent: "other-agent", status: "running" },
          ],
        },
      },
    }, rootContext);

    const starts = [
      { id: "sdk-slot-zero", index: 0, agent: "qa-zero", allowed: true },
      { id: "different-slot-one-id", index: 1, agent: "qa-one", allowed: false },
      { id: "sdk-slot-two", index: 2, agent: "qa-two", allowed: false },
      { id: "sdk-slot-three", index: 3, agent: "qa-three", allowed: false },
    ];
    for (const [index, start] of starts.entries()) {
      const sessionFile = join(root, `async-child-${index}.jsonl`);
      lifecycleStart(extension, {
        id: start.id,
        agent: start.agent,
        sessionFile,
        parentToolCallId: toolCallId,
        index: start.index,
      });
      const childContext = makeContext(root, `async-child-${index}`, sessionFile, "print", false);
      const child = ordinaryChild(root, childContext, "idle-basic");
      children.push({ extension: child, context: childContext });
      await startSession(child, childContext);
      if (start.allowed) {
        assertAllowed(child, childContext, "bash", { command: "printf exact-async-ack-slot" });
      } else {
        assertBlocked(child, childContext, "bash", { command: "printf mismatched-async-ack-slot" });
      }
    }
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal child lifecycle before execution_start cannot be resurrected", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "prestart-terminal-root", join(root, "prestart-terminal-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootContext);
    const input = { agent: "qa", task: "terminal before execution starts" };
    const toolCallId = "prestart-terminal-task";
    assertAllowed(extension, rootContext, "task", input, toolCallId);

    const lifecycle = {
      id: "prestart-terminal-lifecycle",
      agent: input.agent,
      sessionFile: join(root, "prestart-terminal-child.jsonl"),
      parentToolCallId: toolCallId,
      index: 0,
    };
    lifecycleStart(extension, lifecycle);
    extension.events.emit("task:subagent:lifecycle", { ...lifecycle, status: "completed" });
    fireHook(extension, "tool_execution_start", {
      toolName: "task",
      toolCallId,
      args: structuredClone(input),
    }, rootContext);

    childContext = makeContext(root, "prestart-terminal-child", lifecycle.sessionFile, "print", false);
    child = ordinaryChild(root, childContext, "idle-basic");
    await startSession(child, childContext);
    assertBlocked(child, childContext, "bash", { command: "printf must-not-revive-terminal-slot" });
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalized explicit SDK agents retain restrictions while whitespace uses the task default", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "agent-normalization-root", join(root, "agent-normalization-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const tasks = [
      { agent: " qa ", task: "trim the explicit task agent" },
      { agent: " \t ", task: "use the SDK-selected default agent" },
      { agent: "qa", task: "keep an explicit different agent forbidden" },
    ];
    const input = { context: "agent normalization boundaries", tasks };
    const toolCallId = "agent-normalization-task";
    startTaskExecution(extension, rootContext, toolCallId, input, structuredClone(input));
    const lifecycleAgents = ["qa", "developer-go", "reviewer"];

    for (const [index, agent] of lifecycleAgents.entries()) {
      const sessionFile = join(root, `agent-normalization-child-${index}.jsonl`);
      lifecycleStart(extension, {
        id: `agent-normalization-lifecycle-${index}`,
        agent,
        sessionFile,
        parentToolCallId: toolCallId,
        index,
      });
      const childContext = makeContext(root, `agent-normalization-child-${index}`, sessionFile, "print", false);
      const child = ordinaryChild(root, childContext, "idle-basic");
      children.push({ extension: child, context: childContext });
      await startSession(child, childContext);
      if (index < 2) {
        assertAllowed(child, childContext, "bash", { command: "printf normalized-agent-slot" });
      } else {
        assertBlocked(child, childContext, "bash", { command: "printf wrong-explicit-agent" });
      }
    }
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("known ordinary children with malformed active or terminal headers cannot fall back to idle-basic", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "malformed-child-header-root", join(root, "malformed-child-header-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  let originalHeader: (() => { id: string; cwd: string; parentSession?: string }) | undefined;
  try {
    await startSession(extension, rootContext);
    const input = { agent: "developer-go", task: "start a child with a validated header" };
    const toolCallId = "malformed-child-header-task";
    startTaskExecution(extension, rootContext, toolCallId, input);
    const lifecycle = {
      id: "malformed-child-header-lifecycle",
      agent: input.agent,
      sessionFile: join(root, "malformed-child-header.jsonl"),
      parentToolCallId: toolCallId,
      index: 0,
    };
    childContext = makeContext(root, "malformed-child-header", lifecycle.sessionFile, "print", false);
    originalHeader = childContext.sessionManager.getHeader;
    child = await activateChild(root, extension, lifecycle, childContext, "idle-basic");
    assertAllowed(child, childContext, "bash", { command: "printf validated-child-header" });

    childContext.sessionManager.getHeader = () => ({
      ...originalHeader!(),
      cwd: join(root, "unexpected-header-cwd"),
    });
    assertBlocked(child, childContext, "bash", { command: "printf malformed-active-header" });

    childContext.sessionManager.getHeader = originalHeader;
    extension.events.emit("task:subagent:lifecycle", { ...lifecycle, status: "completed" });
    childContext.sessionManager.getHeader = () => {
      throw new Error("unreadable SDK child header");
    };
    assertBlocked(child, childContext, "bash", { command: "printf malformed-terminal-header" });
  } finally {
    if (child && childContext) {
      if (originalHeader) childContext.sessionManager.getHeader = originalHeader;
      await stopSession(child, childContext);
    }
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authoritative root recovery error revokes the child with its typed admission cause", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "typed-reread-root", join(root, "typed-reread-root.jsonl"), "tui", true);
  const controller = makeController(root, rootContext.session_id);
  const originalSelectedRunId = controller.selectedRunId;
  const extension = ordinaryRoot(root, rootContext, controller);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootContext);
    const input = { agent: "qa", task: "ordinary child before root state needs recovery" };
    const toolCallId = "typed-root-reread-task";
    startTaskExecution(extension, rootContext, toolCallId, input);
    const sessionFile = join(root, "typed-reread-child.jsonl");
    childContext = makeContext(root, "typed-reread-child", sessionFile, "print", false);
    child = await activateChild(root, extension, {
      id: "typed-reread-lifecycle", agent: input.agent, parentToolCallId: toolCallId, index: 0, sessionFile,
    }, childContext, "idle-basic");
    assertAllowed(child, childContext, "bash", { command: "printf before-root-recovery" });
    controller.selectedRunId = () => {
      throw new LifecycleError("recovery_required", "canonical root state could not be reread");
    };
    const denial = assertBlocked(child, childContext, "bash", { command: "printf after-root-recovery" });
    assert.match(String(denial.reason), /\[workflow_admission:workflow_state_recovery_required\]/);
  } finally {
    controller.selectedRunId = originalSelectedRunId;
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});


test("a formerly native SDK manager cannot obtain idle-basic rights by changing its session and workspace", async () => {
  const workflow = ordinaryHarness();
  const idleRoot = makeWorkspace();
  let child: CoreExtension | undefined;
  let replacement: CoreExtension | undefined;
  let independent: CoreExtension | undefined;
  try {
    const { handoff } = await ordinaryIngress(workflow);
    const worker = await admitOrdinaryWorker(workflow, handoff, "native-identity-history");
    child = ordinaryChild(workflow.root, worker.childContext, "idle-basic");
    await startSession(child, worker.childContext);
    assertAllowed(child, worker.childContext, "bash", { command: "printf live-workflow-worker" });
    await workflow.emit("task:subagent:lifecycle", {
      id: `${worker.toolCallId}-lifecycle`, agent: worker.input.agent, status: "completed",
      sessionFile: worker.childFile, parentToolCallId: worker.toolCallId, index: 0,
    });
    const next = makeContext(idleRoot, "native-sdk-new-session", join(idleRoot, "new-session.jsonl"), "print", false);
    Object.assign(worker.childContext.sessionManager, next.sessionManager);
    next.sessionManager = worker.childContext.sessionManager;
    replacement = ordinaryChild(idleRoot, next, "idle-basic");
    await startSession(replacement, next);
    const control = readRunControl(idleRoot);
    assert.equal(control.execution_claim, null);
    assert.deepEqual(control.selections, {});
    assertBlocked(replacement, next, "bash", { command: "printf native-manager-must-not-become-ordinary" });
    assertBlocked(replacement, next, "write", { path: join(idleRoot, "revived-native.txt"), content: "denied" });

    const fresh = makeContext(idleRoot, "independent-idle-session", join(idleRoot, "independent.jsonl"), "print", false);
    independent = ordinaryChild(idleRoot, fresh, "idle-basic");
    await startSession(independent, fresh);
    assertAllowed(independent, fresh, "bash", { command: "printf genuinely-independent-idle-host" });
  } finally {
    if (independent) await stopSession(independent, independent.context);
    if (replacement) await stopSession(replacement, replacement.context);
    if (child) await stopSession(child, child.context);
    await workflow.close();
    rmSync(idleRoot, { recursive: true, force: true });
  }
});

test("ordinary provenance cannot turn a broken child actor resolver into permission", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "resolver-root", join(root, "resolver-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  let mode: "healthy" | "threw" | "invalid" = "healthy";
  try {
    await startSession(extension, rootContext);
    const input = { agent: "qa", task: "ordinary SDK child with an independently registered actor adapter" };
    const toolCallId = "resolver-boundary-task";
    startTaskExecution(extension, rootContext, toolCallId, input);
    const sessionFile = join(root, "resolver-child.jsonl");
    childContext = makeContext(root, "resolver-child", sessionFile, "print", false);
    lifecycleStart(extension, { id: "resolver-child-lifecycle", agent: input.agent, parentToolCallId: toolCallId, index: 0, sessionFile });
    child = registerCoreExtension(root, childContext, {
      actor: "unresolved",
      resolveActor: () => {
        if (mode === "threw") throw new Error("host actor lookup failed");
        return mode === "invalid" ? {} : undefined;
      },
    });
    await startSession(child, childContext);
    assertAllowed(child, childContext, "write", { path: join(root, "ordinary.txt"), content: "healthy admission" });
    mode = "threw";
    const failed = assertBlocked(child, childContext, "write", { path: join(root, "ordinary.txt"), content: "must be denied" });
    assert.match(String(failed.reason), /\[workflow_admission:actor_resolver_failed\]/);
    mode = "invalid";
    assertBlocked(child, childContext, "task", { agent: "qa", task: "must not delegate under an invalid adapter" }, "invalid-resolver-task");
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("intersecting duplicate ACK ids and indexes revoke live and pending ordinary children", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "ambiguous-ack-root", join(root, "ambiguous-ack-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const input = { context: "SDK async batch ACK identity boundary", tasks: [{ agent: "qa", task: "first batch slot" }, { agent: "qa", task: "second batch slot" }] };
    const toolCallId = "ambiguous-ack-call";
    startTaskExecution(extension, rootContext, toolCallId, input);
    const firstFile = join(root, "ambiguous-live.jsonl");
    const firstContext = makeContext(root, "ambiguous-live", firstFile, "print", false);
    const first = await activateChild(root, extension, {
      id: "ack-A", index: 0, agent: "qa", sessionFile: firstFile, parentToolCallId: toolCallId,
    }, firstContext);
    children.push({ extension: first, context: firstContext });
    assertAllowed(first, firstContext, "bash", { command: "printf before-ambiguous-ack" });
    fireHook(extension, "tool_execution_end", {
      toolName: "task", toolCallId, isError: false,
      result: { details: {
        async: { state: "running", jobId: "ambiguous-sdk-batch", type: "task" },
        progress: [
          { id: "ack-A", index: 0, agent: "qa", status: "running" },
          { id: "ack-B", index: 0, agent: "qa", status: "pending" },
          { id: "ack-B", index: 1, agent: "qa", status: "pending" },
        ],
      } },
    }, rootContext);
    assertBlocked(first, firstContext, "bash", { command: "printf revoked-live-slot" });
    const lateFile = join(root, "ambiguous-late.jsonl");
    const lateContext = makeContext(root, "ambiguous-late", lateFile, "print", false);
    const late = await activateChild(root, extension, {
      id: "ack-B", index: 1, agent: "qa", sessionFile: lateFile, parentToolCallId: toolCallId,
    }, lateContext);
    children.push({ extension: late, context: lateContext });
    assertBlocked(late, lateContext, "bash", { command: "printf must-not-inherit-ambiguous-slot" });
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh root session_start restores ordinary delegation without reviving a shutdown child", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "restarted-root", join(root, "restarted-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  const children: Array<{ extension: CoreExtension; context: TestContext }> = [];
  try {
    await startSession(extension, rootContext);
    const input = { agent: "qa", task: "ordinary lifecycle restart check" };
    startTaskExecution(extension, rootContext, "before-root-shutdown", input);
    const oldFile = join(root, "old-shutdown-child.jsonl");
    const oldContext = makeContext(root, "old-shutdown-child", oldFile, "print", false);
    const old = await activateChild(root, extension, {
      id: "old-shutdown-lifecycle", index: 0, agent: "qa", sessionFile: oldFile, parentToolCallId: "before-root-shutdown",
    }, oldContext);
    children.push({ extension: old, context: oldContext });
    assertAllowed(old, oldContext, "bash", { command: "printf before-parent-shutdown" });
    await stopSession(extension, rootContext);
    assertBlocked(old, oldContext, "bash", { command: "printf revoked-by-parent-shutdown" });
    await startSession(extension, rootContext);
    assertAllowed(extension, rootContext, "bash", { command: "printf fresh-root-start" });
    startTaskExecution(extension, rootContext, "after-root-shutdown", input);
    const freshFile = join(root, "fresh-restart-child.jsonl");
    const freshContext = makeContext(root, "fresh-restart-child", freshFile, "print", false);
    const fresh = await activateChild(root, extension, {
      id: "fresh-restart-lifecycle", index: 0, agent: "qa", sessionFile: freshFile, parentToolCallId: "after-root-shutdown",
    }, freshContext);
    children.push({ extension: fresh, context: freshContext });
    assertAllowed(fresh, freshContext, "bash", { command: "printf new-delegation-after-restart" });
    assertBlocked(old, oldContext, "bash", { command: "printf old-child-still-revoked" });
    assertBlocked(extension, rootContext, "task", input, "before-root-shutdown");
  } finally {
    for (const child of children.reverse()) await stopSession(child.extension, child.context);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ACK-pending child starting after root shutdown cannot regain idle-basic admission", async () => {
  const root = makeWorkspace();
  const rootContext = makeContext(root, "late-shutdown-root", join(root, "late-shutdown-root.jsonl"), "tui", true);
  const extension = ordinaryRoot(root, rootContext);
  let child: CoreExtension | undefined;
  let childContext: TestContext | undefined;
  try {
    await startSession(extension, rootContext);
    const input = { agent: "qa", task: "SDK queued child during host teardown" };
    const toolCallId = "late-after-root-shutdown";
    startTaskExecution(extension, rootContext, toolCallId, input);
    fireHook(extension, "tool_execution_end", {
      toolName: "task", toolCallId, isError: false,
      result: { details: {
        async: { state: "running", jobId: "late-shutdown-job", type: "task" },
        progress: [{ id: "late-shutdown-lifecycle", index: 0, agent: "qa", status: "pending" }],
      } },
    }, rootContext);
    await stopSession(extension, rootContext);
    const sessionFile = join(root, "late-started-after-shutdown.jsonl");
    lifecycleStart(extension, {
      id: "late-shutdown-lifecycle", index: 0, agent: "qa", sessionFile, parentToolCallId: toolCallId,
    });
    childContext = makeContext(root, "late-shutdown-child", sessionFile, "print", false);
    child = ordinaryChild(root, childContext, "idle-basic");
    await startSession(child, childContext);
    assert.equal(readRunControl(root).execution_claim, null);
    assert.deepEqual(readRunControl(root).selections, {});
    assertBlocked(child, childContext, "bash", { command: "printf late-child-must-not-revive" });
    assertBlocked(child, childContext, "write", { path: join(root, "late.txt"), content: "denied" });
  } finally {
    if (child && childContext) await stopSession(child, childContext);
    await stopSession(extension, rootContext);
    rmSync(root, { recursive: true, force: true });
  }
});
