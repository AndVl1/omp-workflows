import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createNativeWorkerAuthority, type NativeWorkerAuthority } from "../src/native-worker-authority.js";
import { newCtoState, appendWave, writeCtoState, readCtoState } from "../src/cto/state.js";
import { buildCtoSliceMarker } from "../src/cto/slice-gate.js";
import { resolveWorkflow } from "../src/engine/profile.js";
import { registerTeamWorkflow } from "../src/index.js";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";
import { acquireCtoIngress, suspendCtoSession } from "../src/cto/run.js";
import { readRunControl } from "../src/engine/run-store.js";
const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";
const CTO_RUN_ID = "run-lifecycle-full-resume";
function ctoWorkerId(ownershipEpoch: string, toolCallId: string, index: number): string {
  return `cto:${ownershipEpoch}:${toolCallId}:${index}`;
}
function terminalTaskResult(index: number, task: string, agent = "developer-go") {
  return {
    index,
    id: `worker-${index}`,
    agent,
    agentSource: "project" as const,
    task,
    exitCode: 0,
    output: `${agent} output ${index}`,
    stderr: "",
    truncated: false,
    durationMs: 1,
    tokens: 1,
    requests: 1,
  };
}

class TestBus {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  on(channel: string, listener: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set<(value: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  }

  emit(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(value);
  }
}

function fixture() {
  const root = `/tmp/omp-native-worker-authority-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(join(root, ".work-state", "runs", RUN_ID), { recursive: true });
  writeFileSync(join(root, ".work-state", "runs", RUN_ID, "state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
  const cto = newCtoState({
    id: CTO_RUN_ID,
    task: "native authority",
    branch: "main",
    autonomous: true,
    plan: {
      id: CTO_RUN_ID,
      task: "native authority",
      teams: [{ team: "lead-a", scope: ["backend-kotlin"], slice: "slice-a", profile: "lightweight", worktree: "same_branch", depends_on: [] }],
      created_at: new Date().toISOString(),
    },
    standby: true,
  });
  const team = cto.teams[0]!;
  team.slice_id = "slice-a";
  team.classification = { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true };
  team.workflow = resolveWorkflow("FEATURE", "MEDIUM", true);
  appendWave(cto, { id: "wave-1", source: "test", source_id: "native", task: "native authority", slice_ids: ["slice-a"] });
  mkdirSync(join(root, ".work-state", "artifacts", "lead-a"), { recursive: true });
  writeFileSync(join(root, ".work-state", "artifacts", "lead-a", "dod.json"), JSON.stringify({
    items: [{ id: "d1", source: "test", criterion: "c", verify_method: "v", status: "pending", evidence: "" }],
    type_requirements_met: true,
    updated_at: new Date().toISOString(),
  }));
  writeCtoState(cto, root);
  const parentFile = join(root, "parent.jsonl");
  const parentHeader = { id: `parent-${Math.random()}`, cwd: root };
  const parentManager = {
    getCwd: () => root,
    getSessionId: () => parentHeader.id,
    getSessionFile: () => parentFile,
    getHeader: () => parentHeader,
  };
  const parentContext = { sessionManager: parentManager, mode: "tui", hasUI: true };
  return {
    root,
    parentFile,
    parentManager,
    parentContext,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function authorizeCtoFixture(f: { root: string; parentManager: { getSessionId: () => string } }) {
  const state = readCtoState(CTO_RUN_ID, f.root);
  if (!state) throw new Error("CTO fixture state is missing");
  state.owner_session = f.parentManager.getSessionId();
  writeCtoState(state, f.root);
  const controller = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: f.parentManager.getSessionId(),
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  acquireCtoIngress({
    cwd: f.root,
    branch: "main",
    task: "native authority",
    run_id: CTO_RUN_ID,
    controller,
  });
  return controller;
}

function childSession(root: string, parentFile: string, suffix: string) {
  const file = join(root, `${suffix}.jsonl`);
  const header = { id: `${suffix}-session`, cwd: root, parentSession: parentFile };
  const manager = {
    getCwd: () => root,
    getSessionId: () => header.id,
    getSessionFile: () => file,
    getHeader: () => header,
  };
  return { file, header, manager, context: { sessionManager: manager, mode: "print", hasUI: false } };
}

function startGrant(
  bus: TestBus,
  authority: NativeWorkerAuthority,
  parentContext: unknown,
  input: unknown,
  toolCallId: string,
  childFile: string,
  agent: string,
  index = 0,
  runId = RUN_ID,
): void {
  authority.admitTaskCall(parentContext, { toolName: "task", toolCallId, input }, "orchestrator", runId);
  authority.observeToolExecutionStart({ toolName: "task", toolCallId, args: input }, parentContext);
  bus.emit("task:subagent:lifecycle", {
    id: `${toolCallId}-lifecycle-${index}`,
    agent,
    status: "started",
    sessionFile: childFile,
    parentToolCallId: toolCallId,
    index,
  });
}

test("native worker bridge denies a foreign fork while the legitimate active grant remains usable", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "child");
    const foreign = childSession(f.root, f.parentFile, "fork");
    const input = { agent: "developer-go", task: "write the implementation" };
    startGrant(bus, parent, f.parentContext, input, "call-active", child.file, "developer-go");

    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.equal(childAuthority.resolve(foreign.context, f.root), undefined, "copied parent marker in a foreign session cannot bind");
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID }, "foreign probe does not revoke the real grant");
  } finally {
    f.close();
  }
});

test("native worker authority keeps pending candidates and active grants across an idle gap", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const pendingChild = childSession(f.root, f.parentFile, "idle-pending-child");
    const activeChild = childSession(f.root, f.parentFile, "idle-active-child");
    const pendingInput = { agent: "developer-go", task: "pending idle work" };
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "idle-pending", input: pendingInput }, "orchestrator", RUN_ID);
    assert.equal(childAuthority.resolve(pendingChild.context, f.root), undefined);

    startGrant(
      bus,
      parent,
      f.parentContext,
      { agent: "developer-go", task: "active idle work" },
      "idle-active",
      activeChild.file,
      "developer-go",
    );
    assert.deepEqual(childAuthority.resolve(activeChild.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    // Ordinary idle has no authority teardown. The pending candidate must
    // still be promotable, and the active grant must remain usable.
    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "idle-pending", args: structuredClone(pendingInput) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "idle-pending-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: pendingChild.file,
      parentToolCallId: "idle-pending",
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(pendingChild.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.deepEqual(childAuthority.resolve(activeChild.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native worker bridge accepts SDK headers without optional parentSession", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "sdk-18-0-6");
    delete child.header.parentSession;
    startGrant(bus, parent, f.parentContext, { agent: "developer-go", task: "header compatibility" }, "call-sdk-header", child.file, "developer-go");
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native authority owners isolate same tool-call identities while child factories share the namespace", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parentA = createNativeWorkerAuthority(bus, { bundleLabel: "shared-bundle" });
    const parentB = createNativeWorkerAuthority(bus, { bundleLabel: "shared-bundle" });
    const childA = childSession(f.root, f.parentFile, "owner-a-child");
    const childB = childSession(f.root, f.parentFile, "owner-b-child");
    const input = { agent: "developer-go", task: "same call identity" };
    parentA.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "same-call-a", input }, "orchestrator", RUN_ID);
    parentB.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "same-call-b", input }, "orchestrator", RUN_ID);
    parentA.observeToolExecutionStart({ toolName: "task", toolCallId: "same-call-a", args: structuredClone(input) }, f.parentContext);
    parentB.observeToolExecutionStart({ toolName: "task", toolCallId: "same-call-b", args: structuredClone(input) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "owner-a-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: childA.file,
      parentToolCallId: "same-call-a",
      index: 0,
    });
    bus.emit("task:subagent:lifecycle", {
      id: "owner-b-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: childB.file,
      parentToolCallId: "same-call-b",
      index: 0,
    });
    const childFactory = createNativeWorkerAuthority(bus, { bundleLabel: "shared-bundle" });
    assert.deepEqual(childFactory.resolve(childA.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.deepEqual(childFactory.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    bus.emit("task:subagent:lifecycle", {
      id: "owner-a-lifecycle",
      agent: "developer-go",
      status: "completed",
      sessionFile: childA.file,
      parentToolCallId: "same-call-a",
      index: 0,
    });
    assert.equal(childFactory.resolve(childA.context, f.root), undefined);
    assert.deepEqual(childFactory.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native authority teardown is owner-isolated and the same factory can be reused", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parentA = createNativeWorkerAuthority(bus);
    const parentB = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const childA = childSession(f.root, f.parentFile, "teardown-child-a");
    const childB = childSession(f.root, f.parentFile, "teardown-child-b");
    startGrant(bus, parentA, f.parentContext, { agent: "developer-go", task: "parent grant" }, "parent-call", childA.file, "developer-go");
    startGrant(bus, parentB, f.parentContext, { agent: "developer-go", task: "sibling grant" }, "sibling-call", childB.file, "developer-go");
    assert.deepEqual(childAuthority.resolve(childA.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.deepEqual(childAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    childAuthority.teardown();
    const newChildAuthority = createNativeWorkerAuthority(bus);
    assert.deepEqual(newChildAuthority.resolve(childA.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.deepEqual(newChildAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    parentA.teardown();
    assert.equal(newChildAuthority.resolve(childA.context, f.root), undefined);
    assert.deepEqual(newChildAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    const reusedChild = childSession(f.root, f.parentFile, "reused-child");
    startGrant(bus, parentA, f.parentContext, { agent: "developer-go", task: "reused grant" }, "reused-call", reusedChild.file, "developer-go");
    assert.deepEqual(newChildAuthority.resolve(reusedChild.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native authority session shutdown revokes only the exact owner's parent records", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parentA = createNativeWorkerAuthority(bus);
    const parentB = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const childA = childSession(f.root, f.parentFile, "shutdown-parent-a");
    const pendingA = childSession(f.root, f.parentFile, "shutdown-pending-a");
    const childB = childSession(f.root, f.parentFile, "shutdown-parent-b");
    startGrant(bus, parentA, f.parentContext, { agent: "developer-go", task: "parent shutdown grant" }, "shutdown-parent-call", childA.file, "developer-go");
    const pendingInput = { agent: "developer-go", task: "pending shutdown work" };
    parentA.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "shutdown-pending-call", input: pendingInput }, "orchestrator", RUN_ID);
    startGrant(bus, parentB, f.parentContext, { agent: "developer-go", task: "sibling shutdown grant" }, "shutdown-sibling-call", childB.file, "developer-go");
    assert.deepEqual(childAuthority.resolve(childA.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.deepEqual(childAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    parentA.observeSessionShutdown(f.parentContext);
    assert.equal(childAuthority.resolve(childA.context, f.root), undefined);
    assert.deepEqual(childAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    // The pending candidate was scoped to parentA and cannot be promoted
    // after parentA's exact shutdown.
    parentA.observeToolExecutionStart({ toolName: "task", toolCallId: "shutdown-pending-call", args: structuredClone(pendingInput) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "shutdown-pending-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: pendingA.file,
      parentToolCallId: "shutdown-pending-call",
      index: 0,
    });
    assert.equal(childAuthority.resolve(pendingA.context, f.root), undefined);
    assert.deepEqual(childAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native authority ignores foreign, headless, and missing shutdown snapshots", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "shutdown-legitimate-child");
    const foreign = childSession(f.root, f.parentFile, "shutdown-foreign-child");
    const headless = childSession(f.root, f.parentFile, "shutdown-headless-child");
    foreign.context.mode = "tui";
    foreign.context.hasUI = true;
    startGrant(bus, parent, f.parentContext, { agent: "developer-go", task: "survive foreign shutdown" }, "shutdown-foreign-call", child.file, "developer-go");
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    parent.observeSessionShutdown(foreign.context);
    parent.observeSessionShutdown(headless.context);
    parent.observeSessionShutdown(undefined);
    parent.observeSessionShutdown({});
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native authority child shutdown revokes its bound grant before a manager replacement can rebind", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const siblingParent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "shutdown-bound-child");
    const sibling = childSession(f.root, f.parentFile, "shutdown-bound-sibling");
    startGrant(bus, parent, f.parentContext, { agent: "developer-go", task: "bound shutdown grant" }, "shutdown-bound-call", child.file, "developer-go");
    startGrant(bus, siblingParent, f.parentContext, { agent: "developer-go", task: "sibling grant" }, "shutdown-bound-sibling-call", sibling.file, "developer-go");
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.deepEqual(childAuthority.resolve(sibling.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    childAuthority.observeSessionShutdown(child.context);
    const replacementHeader = { ...child.header };
    const replacementManager = {
      getCwd: () => f.root,
      getSessionId: () => replacementHeader.id,
      getSessionFile: () => child.file,
      getHeader: () => replacementHeader,
    };
    const replacementContext = { sessionManager: replacementManager, mode: "print", hasUI: false };
    assert.equal(childAuthority.resolve(replacementContext, f.root), undefined);
    assert.deepEqual(childAuthority.resolve(sibling.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native worker bridge requires structural execution arguments, not only a matching tool id", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "child-mismatch");
    const input = { agent: "developer-go", task: "write the implementation" };
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "call-mismatch", input }, "orchestrator", RUN_ID);
    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "call-mismatch", args: { ...input, task: "different request" } }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "call-mismatch-lifecycle",
      status: "started",
      sessionFile: child.file,
      parentToolCallId: "call-mismatch",
      index: 0,
    });
    assert.equal(childAuthority.resolve(child.context, f.root), undefined);
  } finally {
    f.close();
  }
});

test("successful execution end before lifecycle start does not revoke a pending grant", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "child-scheduled");
    const input = { agent: "developer-go", task: "scheduled work" };
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "call-scheduled", input }, "orchestrator", RUN_ID);
    parent.observeToolExecutionEnd({ toolName: "task", toolCallId: "call-scheduled", isError: false }, f.parentContext);
    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "call-scheduled", args: structuredClone(input) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "call-scheduled-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: child.file,
      parentToolCallId: "call-scheduled",
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("failed execution end before lifecycle start revokes the pending candidate", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "child-cancelled");
    const input = { agent: "developer-go", task: "cancelled work" };
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "call-cancelled", input }, "orchestrator", RUN_ID);
    parent.observeToolExecutionEnd({ toolName: "task", toolCallId: "call-cancelled", isError: true }, f.parentContext);
    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "call-cancelled", args: structuredClone(input) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "call-cancelled-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: child.file,
      parentToolCallId: "call-cancelled",
      index: 0,
    });
    assert.equal(childAuthority.resolve(child.context, f.root), undefined);
  } finally {
    f.close();
  }
});

test("native authority lifecycle completed, failed, and aborted statuses revoke grants", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const cases = [
      { suffix: "lifecycle-completed", callId: "lifecycle-completed-call", status: "completed" },
      { suffix: "lifecycle-failed", callId: "lifecycle-failed-call", status: "failed" },
      { suffix: "lifecycle-aborted", callId: "lifecycle-aborted-call", status: "aborted" },
    ] as const;
    const children = cases.map(({ suffix, callId }) => {
      const child = childSession(f.root, f.parentFile, suffix);
      startGrant(bus, parent, f.parentContext, { agent: "developer-go", task: suffix }, callId, child.file, "developer-go");
      assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
      return child;
    });

    cases.forEach(({ callId, status }, index) => {
      const child = children[index]!;
      bus.emit("task:subagent:lifecycle", {
        id: `${callId}-lifecycle-0`,
        agent: "developer-go",
        status,
        sessionFile: child.file,
        parentToolCallId: callId,
        index: 0,
      });
      assert.equal(childAuthority.resolve(child.context, f.root), undefined);
    });
  } finally {
    f.close();
  }
});

test("native authority preserves headless session-start invalidation", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "headless-start-child");
    const pendingChild = childSession(f.root, f.parentFile, "headless-start-pending-child");
    const pendingInput = { agent: "developer-go", task: "delayed headless work" };
    startGrant(bus, parent, f.parentContext, { agent: "developer-go", task: "headless invalidation" }, "headless-start-call", child.file, "developer-go");
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "headless-start-pending-call", input: pendingInput }, "orchestrator", RUN_ID);
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });

    parent.observeSessionStart({ sessionManager: f.parentManager, mode: "print", hasUI: false });
    assert.equal(childAuthority.resolve(child.context, f.root), undefined);

    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "headless-start-pending-call", args: structuredClone(pendingInput) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "headless-start-pending-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: pendingChild.file,
      parentToolCallId: "headless-start-pending-call",
      index: 0,
    });
    assert.equal(childAuthority.resolve(pendingChild.context, f.root), undefined);
  } finally {
    f.close();
  }
});

test("native worker bridge binds the exact batch index and revokes only its generation", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const childZero = childSession(f.root, f.parentFile, "child-zero");
    const childOne = childSession(f.root, f.parentFile, "child-one");
    const input = {
      context: "shared context",
      tasks: [
        { agent: "developer-go", task: "first" },
        { agent: "qa", task: "second" },
      ],
    };
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "call-batch", input }, "orchestrator", RUN_ID);
    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "call-batch", args: structuredClone(input) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "call-batch-lifecycle-one",
      agent: "qa",
      status: "started",
      sessionFile: childOne.file,
      parentToolCallId: "call-batch",
      index: 1,
    });
    assert.deepEqual(childAuthority.resolve(childOne.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    assert.equal(childAuthority.resolve(childZero.context, f.root), undefined, "index zero cannot borrow index one");

    bus.emit("task:subagent:lifecycle", {
      id: "call-batch-lifecycle-one",
      agent: "qa",
      status: "completed",
      sessionFile: childOne.file,
      parentToolCallId: "call-batch",
      index: 1,
    });
    assert.equal(childAuthority.resolve(childOne.context, f.root), undefined);
  } finally {
    f.close();
  }
});

test("late terminal for an older lifecycle id cannot revoke a newer generation", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "child-generation");
    const input = { agent: "developer-go", task: "generation" };
    startGrant(bus, parent, f.parentContext, input, "call-generation", child.file, "developer-go");
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
    parent.admitTaskCall(f.parentContext, { toolName: "task", toolCallId: "call-generation", input }, "orchestrator", RUN_ID);
    parent.observeToolExecutionStart({ toolName: "task", toolCallId: "call-generation", args: structuredClone(input) }, f.parentContext);
    bus.emit("task:subagent:lifecycle", {
      id: "call-generation-lifecycle-new",
      agent: "developer-go",
      status: "started",
      sessionFile: child.file,
      parentToolCallId: "call-generation",
      index: 0,
    });
    bus.emit("task:subagent:lifecycle", {
      id: "call-generation-lifecycle-old",
      agent: "developer-go",
      status: "completed",
      sessionFile: child.file,
      parentToolCallId: "call-generation",
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(child.context, f.root), { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});
test("native lead resolution fails when canonical CTO slice state becomes stale", () => {
  const f = fixture();
  try {
    const controller = authorizeCtoFixture(f);
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const lead = childSession(f.root, f.parentFile, "stale-lead");
    const input = { agent: "team-lead", task: `${buildCtoSliceMarker(CTO_RUN_ID, "slice-a")}\nlead` };
    startGrant(bus, parent, f.parentContext, input, "call-stale-lead", lead.file, "team-lead", 0, CTO_RUN_ID);
    const statePath = join(f.root, ".work-state", "cto", CTO_RUN_ID, "state.json");
    const stateContent = readFileSync(statePath);
    rmSync(statePath, { force: true });
    assert.equal(childAuthority.resolve(lead.context, f.root), undefined);
    writeFileSync(statePath, stateContent);
    suspendCtoSession(controller, "session-shutdown");
  } finally {
    f.close();
  }
});

test("native worker bridge does not let an active worker arm nested delegation", () => {
  const f = fixture();
  try {
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const child = childSession(f.root, f.parentFile, "child-no-nesting");
    const input = { agent: "developer-go", task: "worker" };
    startGrant(bus, parent, f.parentContext, input, "call-worker", child.file, "developer-go");
    const worker = childAuthority.resolve(child.context, f.root);
    assert.deepEqual(worker, { actor: "worker", kind: "workflow", runId: RUN_ID });
  } finally {
    f.close();
  }
});

test("native lead binding arms only matching CTO-slice children", () => {
  const f = fixture();
  try {
    const controller = authorizeCtoFixture(f);
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const lead = childSession(f.root, f.parentFile, "lead");
    const sliceMarker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
    const leadInput = { agent: "team-lead", task: `${sliceMarker}\nlead slice` };
    startGrant(bus, parent, f.parentContext, leadInput, "call-lead", lead.file, "team-lead", 0, CTO_RUN_ID);
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID });

    const nested = childSession(f.root, lead.file, "nested-worker");
    const nestedInput = { agent: "developer-go", task: `${sliceMarker}\nworker slice` };
    assert.equal(
      childAuthority.admitTaskCall(lead.context, { toolName: "task", toolCallId: "call-nested", input: nestedInput }, "lead", CTO_RUN_ID),
      true,
      "a live inherited lead grant admits a nested worker",
    );
    childAuthority.observeToolExecutionStart({ toolName: "task", toolCallId: "call-nested", args: structuredClone(nestedInput) }, lead.context);
    bus.emit("task:subagent:lifecycle", {
      id: "call-nested-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: nested.file,
      parentToolCallId: "call-nested",
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(nested.context, f.root), { actor: "worker", kind: "cto", runId: CTO_RUN_ID });

    const mismatched = childSession(f.root, lead.file, "nested-mismatch");
    const mismatchInput = { agent: "developer-go", task: `${buildCtoSliceMarker(CTO_RUN_ID, "slice-b")}\nwrong slice` };
    childAuthority.admitTaskCall(lead.context, { toolName: "task", toolCallId: "call-mismatch-slice", input: mismatchInput }, "lead", CTO_RUN_ID);
    childAuthority.observeToolExecutionStart({ toolName: "task", toolCallId: "call-mismatch-slice", args: structuredClone(mismatchInput) }, lead.context);
    bus.emit("task:subagent:lifecycle", {
      id: "call-mismatch-slice-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: mismatched.file,
      parentToolCallId: "call-mismatch-slice",
      index: 0,
    });
    assert.equal(childAuthority.resolve(mismatched.context, f.root), undefined);

    suspendCtoSession(controller, "session-shutdown");
    assert.deepEqual(
      childAuthority.resolve(nested.context, f.root),
      { actor: "worker", kind: "cto", runId: CTO_RUN_ID },
      "a reserved child may finish after coordinator handover",
    );
    assert.equal(
      childAuthority.admitTaskCall(lead.context, { toolName: "task", toolCallId: "call-stale-nested", input: nestedInput }, "lead", CTO_RUN_ID),
      false,
      "a historical lead grant cannot create new work after release",
    );
    const foreignLead = childSession(f.root, f.parentFile, "foreign-lead");
    assert.equal(
      childAuthority.admitTaskCall(foreignLead.context, { toolName: "task", toolCallId: "call-foreign-nested", input: nestedInput }, "lead", CTO_RUN_ID),
      false,
      "a foreign session cannot borrow the released lead grant",
    );
    const statePath = join(f.root, ".work-state", "cto", CTO_RUN_ID, "state.json");
    const stateContent = readFileSync(statePath);
    rmSync(statePath, { force: true });
    assert.equal(childAuthority.resolve(nested.context, f.root), undefined, "inherited worker grant goes stale with its CTO slice");
    writeFileSync(statePath, stateContent);
  } finally {
    f.close();
  }
});
test("native CTO reservations keep handover epochs distinct for duplicate tool-call slots", () => {
  const f = fixture();
  try {
    const controllerA = authorizeCtoFixture(f);
    const claimA = readRunControl(f.root).execution_claim;
    assert.ok(claimA);
    const bus = new TestBus();
    const parentA = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const childA = childSession(f.root, f.parentFile, "epoch-a-child");
    const input = { agent: "developer-go", task: "epoch collision" };
    const callId = "epoch-collision-call";
    startGrant(bus, parentA, f.parentContext, input, callId, childA.file, "developer-go", 0, CTO_RUN_ID);
    assert.deepEqual(childAuthority.resolve(childA.context, f.root), { actor: "worker", kind: "cto", runId: CTO_RUN_ID });

    suspendCtoSession(controllerA, "session-replacement");
    const parentBFile = join(f.root, "parent-b.jsonl");
    const parentBHeader = { id: "epoch-b-parent", cwd: f.root };
    const parentBManager = {
      getCwd: () => f.root,
      getSessionId: () => parentBHeader.id,
      getSessionFile: () => parentBFile,
      getHeader: () => parentBHeader,
    };
    const parentBContext = { sessionManager: parentBManager, mode: "tui", hasUI: true };
    const controllerB = createWorkflowSessionController({
      cwd: f.root,
      context: {
        session_id: parentBHeader.id,
        caller: "host",
        process_id: process.pid,
        worktree: f.root,
        branch: "main",
        authority: "coordinator",
      },
    });
    const ingressB = acquireCtoIngress({
      cwd: f.root,
      branch: "main",
      task: "epoch collision handover",
      run_id: CTO_RUN_ID,
      controller: controllerB,
    });
    assert.notEqual(ingressB.claim.claim.ownership_epoch, claimA.ownership_epoch);
    const parentB = createNativeWorkerAuthority(bus);
    assert.equal(
      parentB.admitTaskCall(parentBContext, { toolName: "task", toolCallId: callId, input }, "orchestrator", CTO_RUN_ID),
      false,
      "a new dispatch cannot reuse a pending tool-call/index slot across epochs",
    );

    const replacementCallId = "epoch-b-independent-call";
    const replacementInput = { agent: "developer-go", task: "replacement work" };
    assert.equal(
      parentB.admitTaskCall(parentBContext, { toolName: "task", toolCallId: replacementCallId, input: replacementInput }, "orchestrator", CTO_RUN_ID),
      true,
    );
    parentB.observeToolExecutionStart({ toolName: "task", toolCallId: replacementCallId, args: replacementInput }, parentBContext);
    const childB = childSession(f.root, parentBFile, "epoch-b-child");
    bus.emit("task:subagent:lifecycle", {
      id: "epoch-b-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: childB.file,
      parentToolCallId: replacementCallId,
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "cto", runId: CTO_RUN_ID });

    bus.emit("task:subagent:lifecycle", {
      id: `${callId}-lifecycle-0`,
      agent: "developer-go",
      status: "completed",
      sessionFile: childA.file,
      parentToolCallId: callId,
      index: 0,
    });
    const afterA = readRunControl(f.root);
    assert.deepEqual(afterA.execution_claim?.worker_ids, [ctoWorkerId(ingressB.claim.claim.ownership_epoch, replacementCallId, 0)]);
    assert.deepEqual(childAuthority.resolve(childB.context, f.root), { actor: "worker", kind: "cto", runId: CTO_RUN_ID });

    bus.emit("task:subagent:lifecycle", {
      id: `${callId}-lifecycle-0`,
      agent: "developer-go",
      status: "completed",
      sessionFile: childA.file,
      parentToolCallId: callId,
      index: 0,
    });
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [ctoWorkerId(ingressB.claim.claim.ownership_epoch, replacementCallId, 0)]);
    suspendCtoSession(controllerB, "session-shutdown");
  } finally {
  }
});
test("registered native main lead worker chain settles async lifecycle slots by captured identity", async () => {
  const f = fixture();
  const controller = authorizeCtoFixture(f);
  const bus = new TestBus();
  const childAuthority = createNativeWorkerAuthority(bus);
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers: Record<string, Handler[]> = {};
  registerTeamWorkflow({
    events: bus,
    setLabel() {},
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
  } as never, {
    cwd: f.root,
    observability: false,
    resolveCwd: () => f.root,
    getSessionController: (ctx) => ctx === f.parentContext ? controller : undefined,
    resolveTrustedToolCallActor: (ctx, _cwd, runId) => {
      if (ctx !== f.parentContext || runId !== CTO_RUN_ID) return undefined;
      const scope = controller.activeCtoClaim();
      return scope
        ? { kind: "authenticated-interactive-host-cto", run_id: scope.run_id, ownership_epoch: scope.ownership_epoch }
        : undefined;
    },
  });
  const sessionStartHandler = handlers.session_start?.[0];
  assert.ok(sessionStartHandler, "registered session_start hook is present");
  sessionStartHandler!({ type: "session_start" }, f.parentContext);
  const call = (name: string, event: unknown, ctx: unknown): unknown => {
    const handler = handlers[name]?.[0];
    assert.ok(handler, `missing registered ${name} handler`);
    return handler!(event, ctx);
  };
  const ownershipEpoch = readRunControl(f.root).execution_claim?.ownership_epoch;
  assert.ok(ownershipEpoch);
  try {
    const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
    const leadInput = { tasks: [{ agent: "team-lead", task: `${marker}\nregistered lead` }] };
    const leadCallId = "registered-main-lead";
    assert.equal(call("tool_call", {
      toolName: "task", toolCallId: leadCallId, input: leadInput,
    }, f.parentContext), undefined);
    call("tool_execution_start", { toolName: "task", toolCallId: leadCallId, args: leadInput }, f.parentContext);
    const lead = childSession(f.root, f.parentFile, "registered-lead");
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-lead-lifecycle",
      agent: "team-lead",
      status: "started",
      sessionFile: lead.file,
      parentToolCallId: leadCallId,
      index: 0,
    });
    call("tool_result", {
      toolName: "task",
      toolCallId: leadCallId,
      input: leadInput,
      content: [{ type: "text", text: "Spawned lead" }],
      details: { results: [], async: { state: "running", jobId: "lead-job", type: "task" } },
      isError: false,
    }, f.parentContext);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [ctoWorkerId(ownershipEpoch, leadCallId, 0)], "running async acknowledgement does not settle the lead slot");

    const nestedCallId = "registered-lead-workers";
    const nestedItems = [
      { agent: "developer-go", task: `${marker}\nworker zero` },
      { agent: "qa", task: `${marker}\nworker one` },
      { agent: "developer-go", task: `${marker}\nworker two` },
    ];
    const nestedInput = { tasks: nestedItems };
    assert.equal(call("tool_call", {
      toolName: "task", toolCallId: nestedCallId, input: nestedInput,
    }, lead.context), undefined);
    call("tool_execution_start", { toolName: "task", toolCallId: nestedCallId, args: nestedInput }, lead.context);
    const workers = [
      childSession(f.root, lead.file, "registered-worker-zero"),
      childSession(f.root, lead.file, "registered-worker-one"),
      childSession(f.root, lead.file, "registered-worker-two"),
    ];
    await Promise.all(workers.map((worker, index) => bus.emit("task:subagent:lifecycle", {
      id: `registered-worker-lifecycle-${index}`,
      agent: nestedItems[index]!.agent,
      status: "started",
      sessionFile: worker.file,
      parentToolCallId: nestedCallId,
      index,
    })));
    call("tool_result", {
      toolName: "task",
      toolCallId: nestedCallId,
      input: nestedInput,
      content: [{ type: "text", text: "Spawned workers" }],
      details: {
        results: [terminalTaskResult(0, nestedItems[0]!.task)],
        async: { state: "running", jobId: "workers-job", type: "task" },
      },
      isError: false,
    }, lead.context);
    assert.deepEqual(
      readRunControl(f.root).execution_claim?.worker_ids,
      [
        ctoWorkerId(ownershipEpoch, leadCallId, 0),
        ctoWorkerId(ownershipEpoch, nestedCallId, 0),
        ctoWorkerId(ownershipEpoch, nestedCallId, 1),
        ctoWorkerId(ownershipEpoch, nestedCallId, 2),
      ],
      "mixed native reservations remain pending after the async acknowledgement",
    );

    await bus.emit("task:subagent:lifecycle", {
      id: "registered-worker-lifecycle-0",
      status: "completed",
      sessionFile: workers[0]!.file,
      parentToolCallId: nestedCallId,
      index: 0,
    });
    assert.deepEqual(
      readRunControl(f.root).execution_claim?.worker_ids,
      [
        ctoWorkerId(ownershipEpoch, leadCallId, 0),
        ctoWorkerId(ownershipEpoch, nestedCallId, 1),
        ctoWorkerId(ownershipEpoch, nestedCallId, 2),
      ],
      "completed lifecycle settles only its captured slot",
    );
    assert.deepEqual(
      childAuthority.resolve(workers[1]!.context, f.root),
      { actor: "worker", kind: "cto", runId: CTO_RUN_ID },
      "the exact child binding is captured before coordinator shutdown",
    );
    const shutdownHandler = handlers.session_shutdown?.[0];
    assert.ok(shutdownHandler, "registered session_shutdown hook is present");
    shutdownHandler!({ type: "session_shutdown" }, f.parentContext);
    assert.deepEqual(
      childAuthority.resolve(workers[1]!.context, f.root),
      { actor: "worker", kind: "cto", runId: CTO_RUN_ID },
      "registered shutdown preserves the already-started child continuation",
    );
    const cloneHeader = { ...workers[1]!.header };
    const cloneManager = {
      getCwd: () => f.root,
      getSessionId: () => cloneHeader.id,
      getSessionFile: () => workers[1]!.file,
      getHeader: () => cloneHeader,
    };
    assert.equal(
      childAuthority.resolve({ sessionManager: cloneManager, mode: "print", hasUI: false }, f.root),
      undefined,
      "a clone with identical child metadata cannot use the settlement witness",
    );
    assert.equal(
      childAuthority.admitTaskCall(lead.context, { toolName: "task", toolCallId: "registered-stale-nested", input: nestedInput }, "lead", CTO_RUN_ID),
      false,
      "registered shutdown revokes new nested dispatch",
    );
    const foreign = childSession(f.root, lead.file, "registered-worker-foreign");
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-worker-lifecycle-1",
      status: "failed",
      sessionFile: foreign.file,
      parentToolCallId: nestedCallId,
      index: 1,
    });
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-worker-lifecycle-1",
      status: "failed",
      sessionFile: workers[1]!.file,
      index: 1,
    });
    assert.deepEqual(
      readRunControl(f.root).cto_releases[CTO_RUN_ID]?.pending_worker_ids,
      [
        ctoWorkerId(ownershipEpoch, leadCallId, 0),
        ctoWorkerId(ownershipEpoch, nestedCallId, 1),
        ctoWorkerId(ownershipEpoch, nestedCallId, 2),
      ],
      "foreign or missing lifecycle identity cannot settle a reservation",
    );
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-worker-lifecycle-1",
      status: "failed",
      sessionFile: workers[1]!.file,
      parentToolCallId: nestedCallId,
      index: 1,
    });
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-worker-lifecycle-2",
      status: "aborted",
      sessionFile: workers[2]!.file,
      parentToolCallId: nestedCallId,
      index: 2,
    });
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-lead-lifecycle",
      status: "completed",
      sessionFile: lead.file,
      parentToolCallId: leadCallId,
      index: 0,
    });
    await bus.emit("task:subagent:lifecycle", {
      id: "registered-worker-lifecycle-0",
      status: "completed",
      sessionFile: workers[0]!.file,
      parentToolCallId: nestedCallId,
      index: 0,
    });
    const settled = readRunControl(f.root);
    assert.equal(settled.execution_claim, null, "terminal lifecycle settles the exact released slots after handover");
    assert.deepEqual(settled.cto_releases[CTO_RUN_ID]?.pending_worker_ids, []);
  } finally {
    for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, f.parentContext);
    f.close();
  }
});

test("registered CTO task result classifier settles only pinned no-start and original sparse slots", () => {
  const f = fixture();
  const controller = authorizeCtoFixture(f);
  const bus = new TestBus();
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers: Record<string, Handler[]> = {};
  registerTeamWorkflow({
    events: bus,
    setLabel() {},
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
  } as never, {
    cwd: f.root,
    observability: false,
    resolveCwd: () => f.root,
    getSessionController: (ctx) => ctx === f.parentContext ? controller : undefined,
    resolveTrustedToolCallActor: (ctx, _cwd, runId) => {
      if (ctx !== f.parentContext || runId !== CTO_RUN_ID) return undefined;
      const scope = controller.activeCtoClaim();
      return scope
        ? { kind: "authenticated-interactive-host-cto", run_id: scope.run_id, ownership_epoch: scope.ownership_epoch }
        : undefined;
    },
  });
  const call = (name: string, event: unknown, ctx: unknown = f.parentContext): unknown => {
    const handler = handlers[name]?.[0];
    assert.ok(handler, `missing registered ${name} handler`);
    return handler!(event, ctx);
  };
  const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
  const task = (label: string): string => `${marker}\n${label}`;
  const admit = (toolCallId: string, input: unknown): string => {
    const outcome = call("tool_call", { toolName: "task", toolCallId, input });
    assert.notEqual((outcome as Record<string, unknown> | undefined)?.block, true, `${toolCallId} admission was blocked`);
    const epoch = readRunControl(f.root).execution_claim?.ownership_epoch;
    assert.ok(epoch, `${toolCallId} reservation has no ownership epoch`);
    return epoch;
  };
  const result = (
    toolCallId: string,
    input: unknown,
    text: string,
    details: unknown,
    isError = false,
  ): void => {
    call("tool_result", {
      toolName: "task",
      toolCallId,
      input,
      content: [{ type: "text", text }],
      details,
      isError,
    });
  };
  const emptyDetails = { projectAgentsDir: null, results: [], totalDurationMs: 0 };
  try {
    const staticInput = { task: task("static shape"), schema: { type: "object" } };
    admit("registered-static-shape", staticInput);
    assert.deepEqual(
      readRunControl(f.root).execution_claim?.worker_ids,
      [ctoWorkerId(readRunControl(f.root).execution_claim!.ownership_epoch, "registered-static-shape", 0)],
    );
    result(
      "registered-static-shape",
      staticInput,
      "The task tool uses `outputSchema`; rename the stale `schema` field.",
      emptyDetails,
      true,
    );
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "static validation settles its original slot");

    const flatPreflightInput = { agent: "developer-go", task: task("flat preflight") };
    admit("registered-flat-preflight", flatPreflightInput);
    result("registered-flat-preflight", flatPreflightInput, "Task execution failed: policy refused this agent", emptyDetails, true);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "flat preflight refusal settles before spawn");

    const batchPreflightInput = {
      context: "shared preflight context",
      tasks: [
        { name: "first", agent: "developer-go", task: task("batch first") },
        { agent: "qa", task: task("batch second") },
      ],
    };
    const batchEpoch = admit("registered-batch-preflight", batchPreflightInput);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [
      ctoWorkerId(batchEpoch, "registered-batch-preflight", 0),
      ctoWorkerId(batchEpoch, "registered-batch-preflight", 1),
    ]);
    result(
      "registered-batch-preflight",
      batchPreflightInput,
      "Task first failed preflight: disabled policy\nTask #2 failed preflight: disabled policy",
      emptyDetails,
      true,
    );
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "batch preflight refusal settles every original slot");

    const evalInput = { task: task("eval failure"), tools: ["missing-eval-tool"] };
    admit("registered-eval-failure", evalInput);
    result("registered-eval-failure", evalInput, "Task execution failed: Eval-defined tools are unavailable in plan mode.", emptyDetails, true);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "eval failure settles before policy and spawn");

    const allScheduleInput = { task: task("all schedule failure") };
    admit("registered-all-schedule", allScheduleInput);
    result("registered-all-schedule", allScheduleInput, "Failed to start background task job: agent-zero: scheduler unavailable", emptyDetails, true);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "all-schedule failure has no progress and settles every slot");

    const partialInput = {
      tasks: [
        { agent: "developer-go", task: task("partial zero") },
        { agent: "qa", task: task("partial one") },
        { agent: "developer-go", task: task("partial two") },
      ],
    };
    const partialEpoch = admit("registered-partial-schedule", partialInput);
    result(
      "registered-partial-schedule",
      partialInput,
      "Spawned 2 agents. Failed to schedule 1 spawn: agent-one: scheduler unavailable.",
      {
        projectAgentsDir: null,
        results: [],
        totalDurationMs: 0,
        progress: [
          { index: 0, id: "agent-zero", status: "pending" },
          { index: 1, id: "agent-one", status: "failed" },
          { index: 2, id: "agent-two", status: "pending" },
        ],
        async: { state: "running", jobId: "partial-job", type: "task" },
      },
      true,
    );
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [
      ctoWorkerId(partialEpoch, "registered-partial-schedule", 0),
      ctoWorkerId(partialEpoch, "registered-partial-schedule", 2),
    ], "partial schedule refusal preserves immutable original indexes");
    result(
      "registered-partial-schedule",
      partialInput,
      "completed",
      {
        results: [
          terminalTaskResult(0, partialInput.tasks[0]!.task),
          terminalTaskResult(2, partialInput.tasks[2]!.task),
        ],
      },
    );
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "terminal rows settle only the surviving original sparse slots");

    const unknownInput = {
      tasks: [
        { agent: "developer-go", task: task("unknown zero") },
        { agent: "qa", task: task("unknown one") },
      ],
    };
    const unknownEpoch = admit("registered-unknown-async", unknownInput);
    const unknownWorkerIds = [
      ctoWorkerId(unknownEpoch, "registered-unknown-async", 0),
      ctoWorkerId(unknownEpoch, "registered-unknown-async", 1),
    ];
    const pendingBeforeUnknown = readRunControl(f.root);
    const unknownAsync = { state: "unknown", jobId: "unknown-job", type: "task" };
    result(
      "registered-unknown-async",
      unknownInput,
      "provider returned an unrecognized async state",
      {
        results: [
          terminalTaskResult(0, unknownInput.tasks[0]!.task),
          terminalTaskResult(1, unknownInput.tasks[1]!.task, "qa"),
        ],
        async: unknownAsync,
      },
    );
    assert.deepEqual(readRunControl(f.root), pendingBeforeUnknown, "full rows with an unknown async state preserve the control image");
    result(
      "registered-unknown-async",
      unknownInput,
      "provider returned an unrecognized async state",
      { results: [{ index: 0 }, { index: 1 }], async: unknownAsync },
    );
    assert.deepEqual(readRunControl(f.root), pendingBeforeUnknown, "index-only rows with an unknown async state stay pending");
    result(
      "registered-unknown-async",
      unknownInput,
      "provider returned an incomplete async result",
      { results: [terminalTaskResult(0, unknownInput.tasks[0]!.task)], async: unknownAsync },
    );
    assert.deepEqual(readRunControl(f.root), pendingBeforeUnknown, "incomplete rows with an unknown async state stay pending");
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, unknownWorkerIds, "unknown async states preserve exact original worker ids");
    result(
      "registered-unknown-async",
      unknownInput,
      "completed",
      {
        results: [
          terminalTaskResult(0, unknownInput.tasks[0]!.task),
          terminalTaskResult(1, unknownInput.tasks[1]!.task, "qa"),
        ],
      },
    );
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "matching synchronous terminal rows settle exact indexes");
  } finally {
    suspendCtoSession(controller, "session-shutdown");
    f.close();
  }
});

test("registered CTO same-id replay is rejected after A settlement while distinct B handover remains usable", () => {
  const f = fixture();
  const controllerA = authorizeCtoFixture(f);
  const bus = new TestBus();
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers: Record<string, Handler[]> = {};
  const parentBFile = join(f.root, "parent-b.jsonl");
  const parentBHeader = { id: "epoch-b-parent", cwd: f.root };
  const parentBManager = {
    getCwd: () => f.root,
    getSessionId: () => parentBHeader.id,
    getSessionFile: () => parentBFile,
    getHeader: () => parentBHeader,
  };
  const parentBContext = { sessionManager: parentBManager, mode: "tui", hasUI: true };
  const controllerB = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: parentBHeader.id,
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  const controllerFor = (ctx: unknown): typeof controllerA | typeof controllerB | undefined =>
    ctx === f.parentContext ? controllerA : ctx === parentBContext ? controllerB : undefined;
  registerTeamWorkflow({
    events: bus,
    setLabel() {},
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
  } as never, {
    cwd: f.root,
    observability: false,
    resolveCwd: () => f.root,
    getSessionController: (ctx) => controllerFor(ctx),
    resolveTrustedToolCallActor: (ctx, _cwd, runId) => {
      const controller = controllerFor(ctx);
      if (!controller || runId !== CTO_RUN_ID) return undefined;
      const scope = controller.activeCtoClaim();
      return scope
        ? { kind: "authenticated-interactive-host-cto", run_id: scope.run_id, ownership_epoch: scope.ownership_epoch }
        : undefined;
    },
  });
  const call = (name: string, event: unknown, ctx: unknown): unknown => {
    const handler = handlers[name]?.[0];
    assert.ok(handler, `missing registered ${name} handler`);
    return handler!(event, ctx);
  };
  const sessionStartHandler = handlers.session_start?.[0];
  const sessionShutdownHandler = handlers.session_shutdown?.[0];
  const sessionSwitchHandler = handlers.session_switch?.[0];
  assert.ok(sessionStartHandler, "registered session_start hook is present");
  assert.ok(sessionShutdownHandler, "registered session_shutdown hook is present");
  assert.ok(sessionSwitchHandler, "registered session_switch hook is present");
  sessionStartHandler!({ type: "session_start" }, f.parentContext);
  const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
  const input = { agent: "developer-go", task: `${marker}\nreplayable task` };
  const result = (toolCallId: string, ctx: unknown): void => {
    call("tool_result", {
      toolName: "task",
      toolCallId,
      input,
      content: [{ type: "text", text: "completed" }],
      details: { results: [terminalTaskResult(0, input.task)] },
      isError: false,
    }, ctx);
  };
  try {
    const callId = "registered-replayed-call";
    const admissionA = call("tool_call", { toolName: "task", toolCallId: callId, input }, f.parentContext);
    assert.notEqual((admissionA as Record<string, unknown> | undefined)?.block, true);
    const epochA = readRunControl(f.root).execution_claim?.ownership_epoch;
    assert.ok(epochA);
    result(callId, f.parentContext);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, []);

    sessionShutdownHandler!({ type: "session_shutdown" }, f.parentContext);
    sessionStartHandler!({ type: "session_start" }, f.parentContext);
    sessionSwitchHandler!({
      type: "session_switch",
      reason: "new",
      previousSessionFile: f.parentFile,
    }, parentBContext);
    const ingressB = acquireCtoIngress({
      cwd: f.root,
      branch: "main",
      task: "same-id replay handover",
      run_id: CTO_RUN_ID,
      controller: controllerB,
    });
    assert.notEqual(ingressB.claim.claim.ownership_epoch, epochA);

    const reused = call("tool_call", { toolName: "task", toolCallId: callId, input }, parentBContext);
    assert.equal((reused as Record<string, unknown> | undefined)?.block, true, "ambiguous same-id B reuse is refused before native reservation");
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "rejected B does not alter the handover claim");
    result(callId, f.parentContext);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "late A replay under the original context cannot settle B");
    result(callId, parentBContext);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "late A replay under the current B context cannot settle B");

    const distinctCallId = "registered-distinct-b-call";
    const distinct = call("tool_call", { toolName: "task", toolCallId: distinctCallId, input }, parentBContext);
    assert.notEqual((distinct as Record<string, unknown> | undefined)?.block, true);
    const epochB = readRunControl(f.root).execution_claim?.ownership_epoch;
    assert.ok(epochB);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [
      ctoWorkerId(epochB, distinctCallId, 0),
    ]);
    result(distinctCallId, parentBContext);
    assert.deepEqual(readRunControl(f.root).execution_claim?.worker_ids, [], "distinct B remains independently settleable");
  } finally {
    suspendCtoSession(controllerB, "session-shutdown");
    f.close();
  }
});

test("registered no-run host rejects CTO marker-only admission but keeps ordinary Main tasks valid", () => {
  const f = fixture();
  const bus = new TestBus();
  const controller = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: f.parentManager.getSessionId(),
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const registrations: Array<Record<string, Handler[]>> = [];
  const register = () => {
    const handlers: Record<string, Handler[]> = {};
    registerTeamWorkflow({
      events: bus,
      setLabel() {},
      on(name: string, handler: Handler) {
        (handlers[name] ??= []).push(handler);
      },
    } as never, {
      observability: false,
      resolveCwd: () => f.root,
      getSessionController: (ctx) => ctx === f.parentContext ? controller : undefined,
      resolveTrustedToolCallActor: (ctx) => ctx === f.parentContext
        ? { kind: "authenticated-interactive-host-no-run" }
        : undefined,
    });
    registrations.push(handlers);
    return handlers;
  };
  try {
    const parent = register();
    const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
    const ctoMarkerInput = { tasks: [{ agent: "omp-team-lead", task: `${marker}\nlead slice` }] };
    const blocked = parent.tool_call![0]!({ toolName: "task", toolCallId: "registered-no-run-lead", input: ctoMarkerInput }, f.parentContext) as { block?: boolean; reason?: string } | undefined;
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /exact authenticated CTO claim or trusted owned legacy run/);

    const ordinary = parent.tool_call![0]!({
      toolName: "task",
      toolCallId: "registered-no-run-ordinary",
      input: { tasks: [{ agent: "team-lead", task: "ordinary Main task" }] },
    }, f.parentContext);
    assert.equal(ordinary, undefined, "no-run ordinary Main task remains valid");
  } finally {
    for (const handlers of registrations) {
      for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, f.parentContext);
    }
    f.close();
  }
});

test("registered exact legacy CTO owner passes both slice and actor admission", () => {
  const f = fixture();
  const ownerSession = f.parentManager.getSessionId();
  const legacy = readCtoState(CTO_RUN_ID, f.root);
  assert.ok(legacy);
  legacy!.standby = false;
  legacy!.owner_session = ownerSession;
  writeCtoState(legacy!, f.root);

  const controller = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: ownerSession,
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  const replacementContext = { sessionManager: f.parentManager, mode: "tui", hasUI: true };
  const replacementController = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: ownerSession,
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  assert.equal(readRunControl(f.root).execution_claim, null, "legacy bootstrap fixture has no managed execution claim");
  const bus = new TestBus();
  const childAuthority = createNativeWorkerAuthority(bus);
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const registrations: Array<Record<string, Handler[]>> = [];
  const register = () => {
    const handlers: Record<string, Handler[]> = {};
    registerTeamWorkflow({
      events: bus,
      setLabel() {},
      on(name: string, handler: Handler) {
        (handlers[name] ??= []).push(handler);
      },
    } as never, {
      observability: false,
      writeScope: { enabled: true, allow: ["src/**"] },
      resolveCwd: () => f.root,
      getSessionController: (ctx) => ctx === f.parentContext
        ? controller
        : ctx === replacementContext
          ? replacementController
          : undefined,
      resolveTrustedToolCallActor: (ctx) => ctx === f.parentContext || ctx === replacementContext
        ? { kind: "authenticated-interactive-host-no-run" }
        : undefined,
    });
    registrations.push(handlers);
    return handlers;
  };
  try {
    const parent = register();
    const sessionStart = parent.session_start?.[0];
    assert.ok(sessionStart, "registered session_start hook is present");
    sessionStart!({ type: "session_start" }, f.parentContext);
    const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
    const input = { tasks: [{ agent: "omp-team-lead", task: `${marker}\nlegacy lead slice` }] };
    const allowed = parent.tool_call![0]!({ toolName: "task", toolCallId: "registered-legacy-owner", input }, f.parentContext);
    assert.equal(allowed, undefined, "trusted owned legacy owner passes slice and actor gates");
    const call = (name: string, event: unknown, ctx: unknown): unknown => {
      const handler = parent[name]?.[0];
      assert.ok(handler, `missing registered ${name} handler`);
      return handler!(event, ctx);
    };
    call("tool_execution_start", { toolName: "task", toolCallId: "registered-legacy-owner", args: input }, f.parentContext);
    const lead = childSession(f.root, f.parentFile, "registered-legacy-lead-session");
    bus.emit("task:subagent:lifecycle", {
      id: "registered-legacy-lead-lifecycle",
      agent: "omp-team-lead",
      status: "started",
      sessionFile: lead.file,
      parentToolCallId: "registered-legacy-owner",
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID });

    const nestedCallId = "registered-legacy-workers";
    const nestedInput = {
      tasks: [
        { agent: "developer-go", task: `${marker}\nlegacy worker` },
      ],
    };
    assert.equal(call("tool_call", { toolName: "task", toolCallId: nestedCallId, input: nestedInput }, lead.context), undefined);
    call("tool_execution_start", { toolName: "task", toolCallId: nestedCallId, args: nestedInput }, lead.context);
    const nativeWorker = childSession(f.root, lead.file, "registered-legacy-worker-session");
    bus.emit("task:subagent:lifecycle", {
      id: "registered-legacy-worker-lifecycle",
      agent: "developer-go",
      status: "started",
      sessionFile: nativeWorker.file,
      parentToolCallId: nestedCallId,
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(nativeWorker.context, f.root), { actor: "worker", kind: "cto", runId: CTO_RUN_ID });
    const workerWrite = call("tool_call", {
      toolName: "write",
      toolCallId: "registered-legacy-worker-write",
      input: { path: join(f.root, "src", "legacy-worker.ts"), content: "legacy worker" },
    }, nativeWorker.context) as { block?: boolean } | undefined;
    assert.equal(workerWrite, undefined, "a live legacy worker may write within its source scope");
    const workerDelegation = call("tool_call", {
      toolName: "task",
      toolCallId: "registered-legacy-worker-nested",
      input: nestedInput,
    }, nativeWorker.context) as { block?: boolean; reason?: string } | undefined;
    assert.equal(workerDelegation?.block, true, "a legacy worker grant cannot delegate another task");
    sessionStart!({ type: "session_start" }, f.parentContext);
    assert.deepEqual(
      childAuthority.resolve(lead.context, f.root),
      { actor: "lead", kind: "cto", runId: CTO_RUN_ID },
      "a redundant session start preserves the original legacy binding",
    );
    const cloneHeader = { id: f.parentManager.getSessionId(), cwd: f.root };
    const cloneManager = {
      getCwd: () => f.root,
      getSessionId: () => cloneHeader.id,
      getSessionFile: () => f.parentFile,
      getHeader: () => cloneHeader,
    };
    const cloneContext = { sessionManager: cloneManager, mode: "tui", hasUI: true };
    sessionStart!({ type: "session_start" }, cloneContext);
    assert.deepEqual(
      childAuthority.resolve(lead.context, f.root),
      { actor: "lead", kind: "cto", runId: CTO_RUN_ID },
      "a same-metadata clone cannot revoke the original lifecycle binding",
    );
    sessionStart!({ type: "session_start" }, replacementContext);
    assert.deepEqual(
      childAuthority.resolve(lead.context, f.root),
      { actor: "lead", kind: "cto", runId: CTO_RUN_ID },
      "a changed controller cannot replace the active lifecycle binding on session_start",
    );
    const shutdown = parent.session_shutdown?.[0];
    assert.ok(shutdown, "registered session_shutdown hook is present");
    shutdown!({ type: "session_shutdown" }, f.parentContext);
    assert.equal(childAuthority.resolve(lead.context, f.root), undefined, "shutdown revokes the legacy parent grant");
    assert.equal(
      childAuthority.resolve(nativeWorker.context, f.root),
      undefined,
      "shutdown revokes the inherited legacy worker grant",
    );
    sessionStart!({ type: "session_start" }, f.parentContext);
    assert.equal(childAuthority.resolve(lead.context, f.root), undefined, "a new binding cannot revive the old legacy grant");
    const shutdownWorkerWrite = call("tool_call", {
      toolName: "write",
      toolCallId: "registered-legacy-worker-write-after-shutdown",
      input: { path: join(f.root, "src", "legacy-worker.ts"), content: "stale" },
    }, nativeWorker.context) as { block?: boolean } | undefined;
    assert.equal(shutdownWorkerWrite?.block, true, "a shutdown legacy worker cannot retain protected write access");
    sessionStart!({ type: "session_start" }, cloneContext);
    assert.equal(childAuthority.resolve(lead.context, f.root), undefined, "a same-metadata clone cannot mint a legacy grant");

    const foreignManager = {
      getCwd: () => f.root,
      getSessionId: () => "foreign-legacy-owner",
      getSessionFile: () => join(f.root, "foreign-legacy.jsonl"),
      getHeader: () => ({ id: "foreign-legacy-owner", cwd: f.root }),
    };
    const foreign = parent.tool_call![0]!({ toolName: "task", toolCallId: "registered-legacy-foreign", input }, {
      sessionManager: foreignManager,
      mode: "tui",
      hasUI: true,
    }) as { block?: boolean } | undefined;
    assert.equal(foreign?.block, true, "a foreign interactive manager cannot use the legacy owner marker");

    const worker = childSession(f.root, f.parentFile, "legacy-worker").context;
    const workerResult = parent.tool_call![0]!({ toolName: "task", toolCallId: "registered-legacy-worker", input }, worker) as { block?: boolean } | undefined;
    assert.equal(workerResult?.block, true, "a worker/headless context cannot use the legacy owner marker");
    const headlessResult = parent.tool_call![0]!({ toolName: "task", toolCallId: "registered-legacy-headless", input }, {
      cwd: f.root,
      mode: "json",
      hasUI: false,
      session_id: "legacy-headless",
    }) as { block?: boolean } | undefined;
    assert.equal(headlessResult?.block, true, "a headless context cannot use the legacy owner marker");
    const managedIngress = acquireCtoIngress({
      cwd: f.root,
      branch: "main",
      task: "managed legacy handoff",
      run_id: CTO_RUN_ID,
      controller,
    });
    assert.equal(managedIngress.run_id, CTO_RUN_ID);

    suspendCtoSession(controller, "session-shutdown");
    const managed = parent.tool_call![0]!({ toolName: "task", toolCallId: "registered-legacy-managed", input }, f.parentContext) as { block?: boolean } | undefined;
    assert.equal(managed?.block, true, "managed release provenance disables legacy bootstrap");
  } finally {
    for (const handlers of registrations) {
      for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, f.parentContext);
    }
    f.close();
  }
});
test("registered session start keeps the bound controller for an active managed claim", () => {
  const f = fixture();
  const controller = authorizeCtoFixture(f);
  const replacementContext = { sessionManager: f.parentManager, mode: "tui", hasUI: true };
  const replacementController = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: f.parentManager.getSessionId(),
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  const bus = new TestBus();
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers: Record<string, Handler[]> = {};
  registerTeamWorkflow({
    events: bus,
    setLabel() {},
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
  } as never, {
    observability: false,
    resolveCwd: () => f.root,
    getSessionController: (ctx) => ctx === f.parentContext
      ? controller
      : ctx === replacementContext
        ? replacementController
        : undefined,
  });
  try {
    const start = handlers.session_start?.[0];
    assert.ok(start, "registered session_start hook is present");
    start!({ type: "session_start" }, f.parentContext);
    start!({ type: "session_start" }, replacementContext);
    const shutdown = handlers.session_shutdown?.[0];
    assert.ok(shutdown, "registered session_shutdown hook is present");
    shutdown!({ type: "session_shutdown" }, f.parentContext);
    assert.equal(readRunControl(f.root).execution_claim, null, "shutdown releases the original managed controller claim");
  } finally {
    for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, f.parentContext);
    f.close();
  }
});
test("registered legacy switch requires the captured previous session file", () => {
  const f = fixture();
  let sessionId = "legacy-session-a";
  let sessionFile = f.parentFile;
  const manager = {
    getCwd: () => f.root,
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getHeader: () => ({ id: sessionId, cwd: f.root }),
  };
  const parentContext = { sessionManager: manager, mode: "tui", hasUI: true };
  const state = readCtoState(CTO_RUN_ID, f.root);
  assert.ok(state);
  state!.standby = false;
  state!.owner_session = sessionId;
  writeCtoState(state!, f.root);
  const controller = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: sessionId,
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  const controllerB = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: "legacy-session-b",
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  let resolvedController: typeof controller | undefined = controller;
  const bus = new TestBus();
  const childAuthority = createNativeWorkerAuthority(bus);
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers: Record<string, Handler[]> = {};
  registerTeamWorkflow({
    events: bus,
    setLabel() {},
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
  } as never, {
    observability: false,
    resolveCwd: () => f.root,
    getSessionController: (ctx) => ctx === parentContext ? resolvedController : undefined,
    resolveTrustedToolCallActor: (ctx) => ctx === parentContext
      ? { kind: "authenticated-interactive-host-no-run" }
      : undefined,
  });
  const emitSwitch = (previousSessionFile?: string) => {
    const event = {
      type: "session_switch",
      reason: "resume",
      ...(previousSessionFile ? { previousSessionFile } : {}),
    };
    for (const handler of handlers.session_switch ?? []) handler(event, parentContext);
  };
  try {
    const start = handlers.session_start?.[0];
    assert.ok(start, "registered session_start hook is present");
    start!({ type: "session_start" }, parentContext);
    const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
    const input = { tasks: [{ agent: "omp-team-lead", task: `${marker}\nlegacy switch lead` }] };
    assert.equal(handlers.tool_call?.[0]!({ toolName: "task", toolCallId: "legacy-switch-root", input }, parentContext), undefined);
    handlers.tool_execution_start?.[0]!({ toolName: "task", toolCallId: "legacy-switch-root", args: input }, parentContext);
    const lead = childSession(f.root, f.parentFile, "legacy-switch-lead");
    bus.emit("task:subagent:lifecycle", {
      id: "legacy-switch-lead-lifecycle",
      agent: "omp-team-lead",
      status: "started",
      sessionFile: lead.file,
      parentToolCallId: "legacy-switch-root",
      index: 0,
    });
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID });
    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = controller;
    start!({ type: "session_start" }, parentContext);
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID }, "stale controller session_start preserves legacy authority");

    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = undefined;
    start!({ type: "session_start" }, parentContext);
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID }, "missing controller session_start preserves legacy authority");

    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = controllerB;
    start!({ type: "session_start" }, parentContext);
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID }, "unverified session_start does not revoke legacy authority");
    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = controllerB;
    emitSwitch(join(f.root, "wrong-previous.jsonl"));
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID }, "wrong previous file preserves legacy authority");

    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = controllerB;
    emitSwitch();
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID }, "missing previous file preserves legacy authority");

    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = controller;
    emitSwitch(f.parentFile);
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.deepEqual(childAuthority.resolve(lead.context, f.root), { actor: "lead", kind: "cto", runId: CTO_RUN_ID }, "mismatched controller preserves legacy authority on an exact-file switch");

    sessionId = "legacy-session-b";
    sessionFile = join(f.root, "legacy-session-b.jsonl");
    resolvedController = controllerB;
    emitSwitch(f.parentFile);
    sessionId = "legacy-session-a";
    sessionFile = f.parentFile;
    resolvedController = controller;
    assert.equal(childAuthority.resolve(lead.context, f.root), undefined, "exact previous file permits legacy revocation on switch");

  } finally {
    for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, parentContext);
    f.close();
  }
});



test("registered stale CTO binding fails admission without ordinary fallback", () => {
  const f = fixture();
  const controller = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: f.parentManager.getSessionId(),
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  const legacy = readCtoState(CTO_RUN_ID, f.root);
  assert.ok(legacy);
  legacy!.owner_session = f.parentManager.getSessionId();
  writeCtoState(legacy!, f.root);
  const absent = createWorkflowSessionController({
    cwd: f.root,
    context: {
      session_id: "unbound-session",
      caller: "host",
      process_id: process.pid,
      worktree: f.root,
      branch: "main",
      authority: "coordinator",
    },
  });
  assert.equal(absent.activeCtoClaim(), undefined, "a controller without a private binding remains genuinely absent");
  const bus = new TestBus();
  const ingress = acquireCtoIngress({
    cwd: f.root,
    branch: "main",
    task: "stale native admission",
    run_id: CTO_RUN_ID,
    controller,
  });
  const controlPath = join(f.root, ".work-state", "run-control.json");
  const control = JSON.parse(readFileSync(controlPath, "utf8")) as Record<string, unknown>;
  const claim = control.execution_claim as Record<string, unknown>;
  claim.token = "stale-native-token";
  writeFileSync(controlPath, JSON.stringify(control) + "\n");
  const staleControl = readFileSync(controlPath, "utf8");
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers: Record<string, Handler[]> = {};
  registerTeamWorkflow({
    events: bus,
    setLabel() {},
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
  } as never, {
    observability: false,
    resolveCwd: () => f.root,
    getSessionController: (ctx) => ctx === f.parentContext ? controller : undefined,
  });
  try {
    const result = handlers.tool_call![0]!({
      toolName: "write",
      toolCallId: "registered-stale-cto-write",
      input: { path: join(f.root, "unsafe.txt"), content: "blocked" },
    }, f.parentContext) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /workflow session admission resolution failed/);
    assert.equal(readFileSync(controlPath, "utf8"), staleControl, "stale admission does not rewrite durable claim bytes");
    assert.equal(ingress.run_id, CTO_RUN_ID);
  } finally {
    for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, f.parentContext);
    f.close();
  }
});
