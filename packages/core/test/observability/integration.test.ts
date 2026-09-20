/**
 * Integration coverage for the OMP hook → recorder pipeline.
 *
 * Every event is emitted with the selected canonical run and trusted session
 * context. The recorder must keep telemetry owned by that run; branch names
 * and legacy `.active-feature` pointers are not selectors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observabilityHooks, flushRecorder } from "../../src/observability/hooks.js";
import { registerObservabilityHooks } from "../../src/observability/index.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readCanonicalObservabilityPointer } from "../../src/observability/recorder.js";

import { runTarget } from "../../src/engine/run-store.js";
import type { TeamState } from "../../src/engine/types.js";

const RUN_ID = "22222222-2222-4222-8222-222222222222";

function withTempDir(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "omp-obs-int-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const ctx = (cwd: string): unknown => ({
  cwd,
  run_id: RUN_ID,
  session_id: "observability-regression-session",
});

function makeInitialState(branch: string): TeamState {
  return {
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active",
    title: "synthetic workflow",
    branch,
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", workflow: "lightweight", autonomous: false },
    task: "synthetic workflow",
    workflow_override: false,
    issue: null,
    stage_cursor: "discovery",
    stages: [{ id: "discovery", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

function prepareCanonicalState(cwd: string, state: TeamState = makeInitialState("main")): string {
  const target = runTarget(cwd, RUN_ID);
  mkdirSync(target.stateDir!, { recursive: true });
  mkdirSync(target.artifactsDir!, { recursive: true });
  writeFileSync(target.statePath!, `${JSON.stringify(state, null, 2)}\n`);
  return target.statePath!;
}

test("integration: selected canonical run owns a full lifecycle telemetry rollup", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    observabilityHooks.onBeforeAgentStart(
      { systemPrompt: ["skill://a\nskill://b\nmore prompt"] },
      ctx(cwd),
    );
    observabilityHooks.onAgentStart({ type: "agent_start" }, ctx(cwd));
    observabilityHooks.onToolCall(
      { toolName: "read", toolCallId: "tc-1", input: { path: "/x" } },
      ctx(cwd),
    );
    observabilityHooks.onToolResult(
      { toolName: "read", toolCallId: "tc-1", isError: false } as unknown,
      ctx(cwd),
    );
    observabilityHooks.onAgentEnd({ messages: [{}, {}, {}] } as unknown, ctx(cwd));
    observabilityHooks.onBeforeAgentStart(
      { systemPrompt: ["skill://a\nmore prompt"] },
      ctx(cwd),
    );
    observabilityHooks.onToolCall(
      {
        toolName: "task",
        toolCallId: "tc-2",
        input: { agent: "developer-go", task: "implement X" },
      },
      ctx(cwd),
    );
    observabilityHooks.onAgentStart({ type: "agent_start" }, ctx(cwd));
    observabilityHooks.onToolResult(
      { toolName: "task", toolCallId: "tc-2", isError: true } as unknown,
      ctx(cwd),
    );
    observabilityHooks.onAgentEnd({ messages: [{}, {}] } as unknown, ctx(cwd));
    observabilityHooks.onSessionStop({ session_id: "s-123", turn_id: 1 }, ctx(cwd));
    await flushRecorder(cwd);

    const pointer = readCanonicalObservabilityPointer(cwd, RUN_ID);
    assert.ok(pointer, "selected run has a canonical observability pointer");
    const obs = pointer!.rollup;
    assert.equal(obs.totalToolCalls, 2, "read + task");
    assert.equal(obs.totalToolErrors, 1, "task failed");
    assert.equal(obs.subagents["developer-go"], 1);
    assert.equal(obs.skills["a"], 2, "skill 'a' appeared in 2 before_agent_starts");
    assert.equal(obs.skills["b"], 1);
    assert.equal(obs.agentInvocations, 2, "main + subagent start events");
    assert.ok(pointer!.lastEventId.length > 0);
    assert.equal(
      existsSync(join(cwd, ".work-state", "features")),
      false,
      "telemetry is not redirected through legacy feature storage",
    );
  } finally {
    cleanup();
  }
});

test("integration: canonical selected run stores jsonl under .work-state/runs/<run>/observability", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    observabilityHooks.onBeforeAgentStart({ systemPrompt: [] }, ctx(cwd));
    observabilityHooks.onAgentStart({}, ctx(cwd));
    await flushRecorder(cwd);
    const logPath = join(cwd, ".work-state", "runs", RUN_ID, "observability", "events.jsonl");
    assert.ok(existsSync(logPath), "log file exists at canonical run path");
    const text = readFileSync(logPath, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
  } finally {
    cleanup();
  }
});

test("integration: canonical bootstrap without an event log still produces valid state", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const statePath = prepareCanonicalState(cwd, makeInitialState("featureless"));
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(onDisk.observability, undefined, "canonical state owns telemetry by run path");
  } finally {
    cleanup();
  }
});

test("integration: missing cwd in context is silently ignored (hooks never throw)", () => {
  observabilityHooks.onAgentStart({}, undefined);
  observabilityHooks.onToolCall({ toolName: "bash", toolCallId: "x" } as unknown, {});
  observabilityHooks.onToolResult({ toolName: "bash", toolCallId: "x", isError: false } as unknown, null);
  observabilityHooks.onSessionStop({ session_id: "y" }, { cwd: 123 });
  assert.ok(true);
});

test("integration: subagent task tool with batch input captures the first agent only", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    observabilityHooks.onBeforeAgentStart({ systemPrompt: [] }, ctx(cwd));
    observabilityHooks.onToolCall(
      {
        toolName: "task",
        toolCallId: "tc-batch",
        input: {
          context: "parallel",
          tasks: [
            { agent: "developer-go", task: "do A" },
            { agent: "qa", task: "audit B" },
          ],
        },
      },
      ctx(cwd),
    );
    await flushRecorder(cwd);

    const pointer = readCanonicalObservabilityPointer(cwd, RUN_ID);
    assert.ok(pointer);
    assert.equal(pointer!.rollup.subagents["developer-go"], 1);
    assert.equal(pointer!.rollup.subagents["qa"], undefined);
  } finally {
    cleanup();
  }
});


test("integration: admitted run identity survives selection switch and unknown workers are dropped", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const runA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let selected = runB;
    type Handler = (event: unknown, ctx: unknown) => void;
    const handlers = new Map<string, Handler>();
    const pi = {
      on(event: string, handler: Handler): void {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    registerObservabilityHooks(pi, {
      getRunId: () => selected,
    });

    const beforeAgentStart = handlers.get("before_agent_start")!;
    const toolResult = handlers.get("tool_result")!;
    const admittedA = { systemPrompt: [], admission: "A" };
    // The event was admitted with A; selection is already B when the host
    // invokes this callback, so getRunId() must not redirect the event.
    beforeAgentStart(admittedA, { cwd, run_id: runA });
    beforeAgentStart({ systemPrompt: [] }, { cwd, run_id: runB });
    toolResult({ toolName: "task", toolCallId: "unknown-worker-result" }, { cwd, actor: "worker" });
    await flushRecorder(cwd);

    const pointerA = readCanonicalObservabilityPointer(cwd, runA);
    const pointerB = readCanonicalObservabilityPointer(cwd, runB);
    assert.ok(pointerA);
    assert.ok(pointerB);
    assert.equal(pointerA!.rollup.agentInvocations, 0);
    assert.deepEqual(pointerA!.rollup.skills, {});

    assert.equal(pointerB!.rollup.agentInvocations, 0);
    assert.equal(pointerB!.rollup.totalToolCalls, 0);
    assert.equal(pointerB!.rollup.totalToolErrors, 0);

    const aLines = readFileSync(join(cwd, ".work-state", "runs", runA, "observability", "events.jsonl"), "utf8").trim().split("\n");
    const bLines = readFileSync(join(cwd, ".work-state", "runs", runB, "observability", "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(aLines.length, 1, "the admitted A event remains in A after switching to B");
    assert.equal(bLines.length, 1, "B owns only its own event");
    assert.equal((JSON.parse(aLines[0]!) as { runId: string; kind: string }).runId, runA);
    assert.equal((JSON.parse(aLines[0]!) as { runId: string; kind: string }).kind, "before_agent_start");
    assert.equal((JSON.parse(bLines[0]!) as { runId: string; kind: string }).runId, runB);
  } finally {
    cleanup();
  }
});


test("integration: session stop stays on the run captured at session start", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const runA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const runB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let selected = runA;
    type Handler = (event: unknown, ctx: unknown) => void;
    const handlers = new Map<string, Handler>();
    const pi = {
      on(event: string, handler: Handler): void {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    registerObservabilityHooks(pi, { getRunId: () => selected });
    const sessionStart = handlers.get("session_start")!;
    const sessionStop = handlers.get("session_stop")!;
    sessionStart({ session_id: "session-captured" }, { cwd });
    selected = runB;
    sessionStop({ session_id: "session-captured" }, { cwd });
    await flushRecorder(cwd);

    const pointerA = readCanonicalObservabilityPointer(cwd, runA);
    assert.ok(pointerA);

    assert.equal(readCanonicalObservabilityPointer(cwd, runB), null);
    const lines = readFileSync(join(cwd, ".work-state", "runs", runA, "observability", "events.jsonl"), "utf8").trim().split("\n");
    assert.deepEqual(lines.map((line) => (JSON.parse(line) as { kind: string }).kind), ["session_start", "session_stop"]);
  } finally {
    cleanup();
  }
});
