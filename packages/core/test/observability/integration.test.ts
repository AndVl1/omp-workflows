/**
 * Integration test for the OMP hook → recorder → TeamState pipeline.
 *
 * Drives the public `observabilityHooks` with synthetic OMP event payloads
 * (matching the real ExtensionAPI shapes) and asserts that:
 *   1. The event log captures every kind.
 *   2. The rollup reflects subagent spawns (toolName="task" → subagent).
 *   3. Skills are extracted from before_agent_start systemPrompt.
 *   4. The `writeState` engine call picks up the pointer and embeds it in
 *      TeamState.observability (so /pulse can read it without touching
 *      the jsonl directly).
 *
 * Tests use `flushRecorder(cwd)` to drain the in-memory write queue
 * instead of real timers — the latter would race on loaded machines and
 * slow CI on every run.
 *
 * Test isolation note: the recorder resolves the active feature slug from
 * `.work-state/.active-feature`. The test setup writes that pointer so
 * `writeState` (which derives the feature from the branch in the state)
 * and the recorder agree on the same directory. Without the pin, the
 * recorder would write to `features/default/...` while `writeState` reads
 * from `features/<branch-slug>/...` and the pointer would be missing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { observabilityHooks, flushRecorder } from "../../src/observability/hooks.js";
import { writeState } from "../../src/engine/state.js";
import type { TeamState } from "../../src/engine/types.js";

function withTempDir(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "omp-obs-int-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function pinActiveFeature(cwd: string, slug: string): void {
  const wsDir = resolve(cwd, ".work-state");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, ".active-feature"), `${slug}\n`, "utf8");
}

const ctx = (cwd: string): unknown => ({ cwd });

function makeInitialState(branch: string): TeamState {
  return {
    schema: 1,
    branch,
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", workflow: "lightweight" },
    task: "synthetic workflow",
    autonomous: true,
    workflow_override: false,
    issue: null,
    stage_cursor: "discovery",
    stages: [{ id: "discovery", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

test("integration: full lifecycle — 3 agents, 1 subagent, 2 skills, 1 error", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    pinActiveFeature(cwd, "main");

    // 1. before_agent_start: main agent has skill://a and skill://b
    observabilityHooks.onBeforeAgentStart(
      { systemPrompt: ["skill://a\nskill://b\nmore prompt"] },
      ctx(cwd),
    );

    // 2. agent_start / agent_end for main
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

    // 3. spawn a developer-go subagent
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

    // 4. session_stop
    observabilityHooks.onSessionStop({ session_id: "s-123", turn_id: 1 }, ctx(cwd));

    // Drain the queue deterministically — no setTimeout, no real wait.
    await flushRecorder(cwd);

    // 5. writeState — should pick up the pointer
    const state = makeInitialState("main");
    const { statePath } = writeState(cwd, state);
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.ok(onDisk.observability, "TeamState.observability is populated");
    const obs = onDisk.observability!;
    assert.equal(obs.rollup.totalToolCalls, 2, "read + task");
    assert.equal(obs.rollup.totalToolErrors, 1, "task failed");
    assert.equal(obs.rollup.subagents["developer-go"], 1);
    assert.equal(obs.rollup.skills["a"], 2, "skill 'a' appeared in 2 before_agent_starts");
    assert.equal(obs.rollup.skills["b"], 1);
    assert.equal(obs.rollup.agentInvocations, 2, "main + subagent start events");
    assert.ok(obs.lastEventId.length > 0);
  } finally {
    cleanup();
  }
});

test("integration: writes the jsonl log under .work-state/features/default/observability/", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    pinActiveFeature(cwd, "default");
    observabilityHooks.onBeforeAgentStart({ systemPrompt: [] }, ctx(cwd));
    observabilityHooks.onAgentStart({}, ctx(cwd));
    await flushRecorder(cwd);
    const logPath = join(cwd, ".work-state", "features", "default", "observability", "events.jsonl");
    assert.ok(existsSync(logPath), "log file exists at expected path");
    const text = readFileSync(logPath, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
  } finally {
    cleanup();
  }
});

test("integration: writeState without an event log still produces valid state", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    // No hooks fired. writeState must still succeed; observability is omitted.
    const state = makeInitialState("featureless");
    const { statePath } = writeState(cwd, state);
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(onDisk.observability, undefined);
  } finally {
    cleanup();
  }
});

test("integration: missing cwd in context is silently ignored (hooks never throw)", () => {
  // No cwd, no observable side effect, no throw.
  observabilityHooks.onAgentStart({}, undefined);
  observabilityHooks.onToolCall({ toolName: "bash", toolCallId: "x" } as unknown, {});
  observabilityHooks.onToolResult({ toolName: "bash", toolCallId: "x", isError: false } as unknown, null);
  observabilityHooks.onSessionStop({ session_id: "y" }, { cwd: 123 }); // wrong type — ignored
  // If we get here without throwing, the test passes.
  assert.ok(true);
});

test("integration: subagent task tool with batch input captures the first agent only", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    pinActiveFeature(cwd, "main");
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

    const state = makeInitialState("main");
    const { statePath } = writeState(cwd, state);
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    const obs = onDisk.observability!;
    // Only the first agent in the batch is attributed to the rollup;
    // the full batch roster is in the OMP session jsonl.
    assert.equal(obs.rollup.subagents["developer-go"], 1);
    assert.equal(obs.rollup.subagents["qa"], undefined);
  } finally {
    cleanup();
  }
});
