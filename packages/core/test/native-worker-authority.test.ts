import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createNativeWorkerAuthority, type NativeWorkerAuthority } from "../src/native-worker-authority.js";
import { newCtoState, appendWave, writeCtoState } from "../src/cto/state.js";
import { buildCtoSliceMarker } from "../src/cto/slice-gate.js";
import { resolveWorkflow } from "../src/engine/profile.js";
import { registerTeamWorkflow } from "../src/index.js";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";

const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";
const CTO_RUN_ID = "run-lifecycle-full-resume";

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
    const bus = new TestBus();
    const parent = createNativeWorkerAuthority(bus);
    const childAuthority = createNativeWorkerAuthority(bus);
    const lead = childSession(f.root, f.parentFile, "stale-lead");
    const input = { agent: "team-lead", task: `${buildCtoSliceMarker(CTO_RUN_ID, "slice-a")}\nlead` };
    startGrant(bus, parent, f.parentContext, input, "call-stale-lead", lead.file, "team-lead", 0, CTO_RUN_ID);
    rmSync(join(f.root, ".work-state", "cto", CTO_RUN_ID, "state.json"), { force: true });
    assert.equal(childAuthority.resolve(lead.context, f.root), undefined);
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
    childAuthority.admitTaskCall(lead.context, { toolName: "task", toolCallId: "call-nested", input: nestedInput }, "lead", CTO_RUN_ID);
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
    rmSync(join(f.root, ".work-state", "cto", CTO_RUN_ID, "state.json"));
    assert.equal(childAuthority.resolve(nested.context, f.root), undefined, "inherited worker grant goes stale with its CTO slice");
  } finally {
    f.close();
  }
});

test("registered no-run host grants CTO lead delegation without granting a copied foreign context", () => {
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
      getSessionController: (ctx) => ctx === f.parentContext
        ? controller
        : undefined,
      resolveTrustedToolCallActor: (ctx) => ctx === f.parentContext
        ? { kind: "authenticated-interactive-host-no-run" }
        : undefined,
    });
    registrations.push(handlers);
    return handlers;
  };
  try {
    const parent = register();
    const leadHooks = register();
    const lead = childSession(f.root, f.parentFile, "registered-lead");
    const marker = buildCtoSliceMarker(CTO_RUN_ID, "slice-a");
    const input = { tasks: [{ agent: "omp-team-lead", task: `${marker}\nlead slice` }] };
    const toolCallId = "registered-no-run-lead";
    assert.equal(parent.tool_call![0]!({ toolName: "task", toolCallId, input }, f.parentContext), undefined);
    for (const handler of parent.tool_execution_start ?? []) {
      handler({ toolName: "task", toolCallId, args: input }, f.parentContext);
    }
    bus.emit("task:subagent:lifecycle", {
      id: "registered-lead-lifecycle",
      agent: "omp-team-lead",
      status: "started",
      sessionFile: lead.file,
      parentToolCallId: toolCallId,
      index: 0,
    });
    const nested = {
      toolName: "task",
      toolCallId: "registered-lead-worker",
      input: { tasks: [{ agent: "developer-go", task: `${marker}\nworker slice` }] },
    };
    assert.equal(leadHooks.tool_call![0]!(nested, lead.context), undefined);
    const foreign = {
      ...lead.context,
      actor: "lead",
      sessionManager: { ...lead.manager },
    };
    assert.equal(
      (leadHooks.tool_call![0]!(nested, foreign) as { block?: boolean } | undefined)?.block,
      true,
    );
    assert.equal(leadHooks.tool_call![0]!(nested, lead.context), undefined);
  } finally {
    for (const handlers of registrations) {
      for (const handler of handlers.session_shutdown ?? []) handler({}, f.parentContext);
    }
    f.close();
  }
});
