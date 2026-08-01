/**
 * Recorder unit tests.
 *
 * Covers: append, jsonl line format, rollup aggregation, persistence
 * across recorder instances (re-read on construct), and the
 * ObservabilityPointer shape that `TeamState.observability` carries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventRecorder, rollupFromEvents, readObservabilityPointer } from "../../src/observability/recorder.js";
import type { ObservabilityEvent } from "../../src/observability/events.js";

function withTempDir(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "omp-obs-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function ts(offsetMs: number): string {
  return new Date(1700000000000 + offsetMs).toISOString();
}

function makeIdGen(prefix = "e"): () => string {
  let n = 0;
  return () => `${prefix}-${(++n).toString(36)}`;
}

test("recorder: appends one event per call as a single jsonl line", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-a", nextId: makeIdGen() });
    await r.append({ kind: "session_start", ts: ts(0) });
    await r.append({ kind: "agent_start", ts: ts(100) });
    await r.append({ kind: "agent_end", ts: ts(200), messageCount: 3 });
    const text = readFileSync(r.path, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as ObservabilityEvent;
      assert.equal(parsed.branch, "main");
      assert.ok(parsed.id.startsWith("e-"), "id is monotonic and prefixed");
    }
    const last = JSON.parse(lines[2]!) as ObservabilityEvent;
    assert.equal(last.messageCount, 3);
    const first = JSON.parse(lines[0]!) as ObservabilityEvent;
    const second = JSON.parse(lines[1]!) as ObservabilityEvent;
    assert.ok(first.id < second.id, "ids are monotonic within a recorder");
  } finally {
    cleanup();
  }
});

test("recorder: rollupFromEvents aggregates per agent, tool, error, skill", () => {
  const events: ObservabilityEvent[] = [
    { id: "1", branch: "main", kind: "agent_start", ts: ts(0) },
    { id: "2", branch: "main", kind: "before_agent_start", ts: ts(0), skills: ["skill-a", "skill-b"] },
    { id: "3", branch: "main", kind: "tool_call", ts: ts(10), toolName: "task", subagent: "developer-go" },
    { id: "4", branch: "main", kind: "tool_result", ts: ts(20), toolName: "task", isError: false },
    { id: "5", branch: "main", kind: "tool_call", ts: ts(30), toolName: "bash" },
    { id: "6", branch: "main", kind: "tool_result", ts: ts(40), toolName: "bash", isError: true },
    { id: "7", branch: "main", kind: "before_agent_start", ts: ts(50), skills: ["skill-a"] },
    { id: "8", branch: "main", kind: "agent_end", ts: ts(60), messageCount: 4 },
  ];
  const rollup = rollupFromEvents(events);
  assert.equal(rollup.agentInvocations, 1);
  assert.equal(rollup.agents["__main__"], 1);
  assert.equal(rollup.tools["task"], 1);
  assert.equal(rollup.tools["bash"], 1);
  assert.equal(rollup.toolErrors["bash"], 1);
  assert.equal(rollup.totalToolCalls, 2);
  assert.equal(rollup.totalToolErrors, 1);
  assert.equal(rollup.subagents["developer-go"], 1);
  assert.equal(rollup.skills["skill-a"], 2);
  assert.equal(rollup.skills["skill-b"], 1);
  assert.equal(rollup.durationMs, 60);
});

test("recorder: readObservabilityPointer is null when feature has no event log", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const result = readObservabilityPointer(cwd, "no-such-feature");
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

test("recorder: readObservabilityPointer returns the rollup for an existing feature", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r1 = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-x" });
    await r1.append({ kind: "session_start", ts: ts(0) });
    await r1.append({ kind: "tool_call", ts: ts(10), toolName: "read" });
    await r1.append({ kind: "tool_result", ts: ts(20), toolName: "read", isError: true });
    // Construct a second recorder against the same feature — it should
    // re-aggregate from the persisted log.
    const r2 = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-x" });
    const pointer = r2.buildPointer();
    assert.equal(pointer.rollup.totalToolCalls, 1);
    assert.equal(pointer.rollup.totalToolErrors, 1);
    assert.equal(pointer.rollup.tools["read"], 1);
    assert.ok(pointer.lastEventId.length > 0);
    assert.equal(pointer.rollupThroughId, pointer.lastEventId);
  } finally {
    cleanup();
  }
});

test("recorder: append under concurrent calls is serialized", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-parallel" });
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      promises.push(r.append({ kind: "agent_start", ts: ts(i) }));
    }
    await Promise.all(promises);
    const text = readFileSync(r.path, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 10, "all 10 events appended, none lost");
  } finally {
    cleanup();
  }
});

test("recorder: readAll skips corrupt lines instead of throwing", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-corrupt" });
    await r.append({ kind: "session_start", ts: ts(0) });
    // Append a deliberately corrupt line
    mkdirSync(join(cwd, ".work-state", "features", "feat-corrupt", "observability"), { recursive: true });
    writeFileSync(r.path, readFileSync(r.path, "utf8") + "this is not json\n", "utf8");
    await r.append({ kind: "agent_start", ts: ts(10) });
    const all = r.readAll();
    assert.equal(all.length, 2, "skips the corrupt line, returns the 2 valid ones");
  } finally {
    cleanup();
  }
});

test("recorder: empty event log yields a zeroed rollup with sensible defaults", () => {
  const rollup = rollupFromEvents([]);
  assert.equal(rollup.agentInvocations, 0);
  assert.equal(rollup.totalToolCalls, 0);
  assert.deepEqual(rollup.agents, {});
  assert.equal(rollup.durationMs, 0);
  assert.equal(rollup.firstEventAt, new Date(0).toISOString());
});
