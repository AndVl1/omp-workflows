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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observabilityHooks, flushRecorder } from "../../src/observability/hooks.js";
import { readCanonicalObservabilityPointer } from "../../src/observability/recorder.js";
import { writeStateBootstrap } from "../../src/engine/state.js";
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
  return writeStateBootstrap(cwd, state, { target }).statePath;
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
