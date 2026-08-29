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
import type { CompletionEnvelope, WorkIdentity } from "../../src/engine/types.js";
import { readWorkflowProfile, workflowV2Fixture } from "../workflow-v2-fixtures.js";

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
const workIdentity: WorkIdentity = {
  run_id: "run-1",
  wave_id: "wave-1",
  slice_id: "slice-1",
  session_id: "session-1",
  workflow: "standard",
  stage_id: "implementation",
  stage_cursor: "implementation",
  capability_id: "cap-1",
  capability_epoch: "epoch-1",
  slot_id: "analyst#1",
  task_id: "task-1",
  dispatch_id: "dispatch-1",
  attempt: 1,
  worker_id: "worker-1",
};

const workflowFixture = workflowV2Fixture(readWorkflowProfile(workIdentity.workflow), {
  runId: workIdentity.run_id,
  session: { session_id: workIdentity.session_id, lifecycle_id: "lifecycle-1" },
});

function completionEnvelope(
  identity: WorkIdentity,
  outcome: CompletionEnvelope["outcome"],
  terminalSignal: CompletionEnvelope["terminal_signal"],
): CompletionEnvelope {
  return {
    schema_version: 1,
    identity,
    run_identity: workflowFixture.run_identity,
    outcome,
    terminal_signal: terminalSignal,
    artifact_refs: outcome === "pending"
      ? []
      : [{
          artifact_id: "result",
          path: "artifacts/result.json",
          sha256: "a".repeat(64),
          schema_status: "met",
          dod_status: "met",
        }],
    evidence_ref: outcome === "pending" ? null : "evidence/dispatch-1",
    conflict_ref: null,
    completed_by: "engine_task_caller",
    emitted_at: ts(100),
  };
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

test("recorder: strips prompts and secrets while retaining bounded relative artifact evidence", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-private", nextId: makeIdGen() });
    const secretPrompt = "PROMPT transcript secret=top-secret api_key=do-not-persist";
    await r.append({
      kind: "artifact_written",
      ts: ts(0),
      artifactId: "result",
      artifactPath: join(cwd, "safe", "result.json"),
      artifactBytes: 12,
      artifactSha256: "b".repeat(64),
      gateReason: secretPrompt,
      prompt: secretPrompt,
      transcript: secretPrompt,
    } as unknown as Omit<ObservabilityEvent, "id" | "branch">);
    const line = readFileSync(r.path, "utf8");
    assert.doesNotMatch(line, /top-secret|do-not-persist|transcript/);
    const event = r.readAll()[0]!;
    assert.equal(event.artifactPath, "safe/result.json");
    assert.equal(event.artifact_summaries?.[0]?.path, "safe/result.json");
    assert.equal(event.artifact_summaries?.[0]?.sha256, "b".repeat(64));
    assert.match(event.gateReason ?? "", /^redacted:/);
    assert.equal("prompt" in event, false);
    assert.equal("transcript" in event, false);
  } finally {
    cleanup();
  }
});

test("recorder: persists canonical identity tuple and profile/policy bindings", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-identity", nextId: makeIdGen() });
    const profileHash = "c".repeat(64);
    const policyHash = "d".repeat(64);
    const envelope = completionEnvelope(workIdentity, "failed", "provider_terminal");
    await r.append({
      kind: "work_terminal",
      ts: ts(0),
      work_identity: workIdentity,
      capability_epoch: workIdentity.capability_epoch,
      profile_hash: profileHash,
      policy_hash: policyHash,
      outcome: "failed",
      status: "failed",
      terminal_signal: "provider_terminal",
      completion_envelope: envelope,
    });
    const event = r.readAll()[0]!;
    assert.deepEqual(event.work_identity, workIdentity);
    assert.equal(event.capability_epoch, "epoch-1");
    assert.equal(event.profile_hash, profileHash);
    assert.equal(event.policy_hash, policyHash);
    assert.equal(event.completion_envelope?.identity.dispatch_id, "dispatch-1");
    assert.equal(event.terminal_signal, "provider_terminal");
  } finally {
    cleanup();
  }
});

test("recorder: exact terminal replay is idempotent and does not repeat the event", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-replay", nextId: makeIdGen() });
    const event: Omit<ObservabilityEvent, "id" | "branch"> = {
      kind: "work_terminal",
      ts: ts(0),
      work_identity: workIdentity,
      outcome: "failed",
      status: "failed",
      terminal_signal: "contract_failure",
      completion_envelope: completionEnvelope(workIdentity, "failed", "contract_failure"),
    };
    const first = await r.append(event);
    const replay = await r.append(event);
    assert.equal(replay.id, first.id);
    assert.equal(r.readAll().length, 1);
    assert.equal(r.buildRollup().terminalSignals?.contract_failure, 1);
  } finally {
    cleanup();
  }
});

test("recorder: terminal replacement requires identity evidence or explicit retry linkage", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-replacement", nextId: makeIdGen() });
    await r.append({
      kind: "work_terminal",
      ts: ts(0),
      work_identity: workIdentity,
      outcome: "failed",
      status: "failed",
      terminal_signal: "provider_terminal",
      completion_envelope: completionEnvelope(workIdentity, "failed", "provider_terminal"),
    });
    const retryIdentity = { ...workIdentity, dispatch_id: "dispatch-2", attempt: 2 };
    await assert.rejects(
      r.append({
        kind: "work_terminal",
        ts: ts(10),
        work_identity: retryIdentity,
        outcome: "failed",
        status: "failed",
        terminal_signal: "contract_failure",
      }),
      /identity-bound completion envelope or retry_of/,
    );
    assert.throws(
      () => r.append({
        kind: "work_terminal",
        ts: ts(20),
        work_identity: retryIdentity,
        outcome: "failed",
        status: "failed",
        terminal_signal: "contract_failure",
        completion_envelope: completionEnvelope(workIdentity, "failed", "contract_failure"),
      }),
      (error: unknown) => error instanceof Error && error.message === "completion envelope identity mismatch",
    );
    await r.append({
      kind: "work_terminal",
      ts: ts(30),
      work_identity: retryIdentity,
      outcome: "failed",
      status: "failed",
      terminal_signal: "contract_failure",
      retry_of: "dispatch-1",
    });
    assert.equal(r.readAll().length, 2);
  } finally {
    cleanup();
  }
});

test("recorder: neutral pending reasons stay active while provider terminal signals are terminal", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const r = new EventRecorder({ cwd, branch: "main", featureSlug: "feat-lifecycle", nextId: makeIdGen() });
    const pendingReasons = ["provider_running", "awaiting_result", "transport_reconnect"] as const;
    for (const [index, reason] of pendingReasons.entries()) {
      const identity = { ...workIdentity, dispatch_id: `pending-${index + 1}` };
      await r.append({
        kind: "work_pending",
        ts: ts(index),
        work_identity: identity,
        pending_reason: reason,
        status: "pending",
        outcome: "pending",
        terminal_signal: null,
        completion_envelope: completionEnvelope(identity, "pending", null),
      });
    }
    for (const [index, signal] of (["provider_terminal", "contract_failure"] as const).entries()) {
      const identity = { ...workIdentity, dispatch_id: `terminal-${index + 1}` };
      await r.append({
        kind: "work_terminal",
        ts: ts(10 + index),
        work_identity: identity,
        outcome: "failed",
        status: "failed",
        terminal_signal: signal,
        completion_envelope: completionEnvelope(identity, "failed", signal),
      });
    }
    const rollup = r.buildRollup();
    assert.equal(rollup.pendingEvents, 3);
    assert.deepEqual(rollup.pendingReasons, {
      provider_running: 1,
      awaiting_result: 1,
      transport_reconnect: 1,
    });
    assert.deepEqual(rollup.terminalSignals, {
      provider_terminal: 1,
      contract_failure: 1,
    });
    await assert.rejects(
      r.append({
        kind: "work_pending",
        ts: ts(20),
        work_identity: { ...workIdentity, dispatch_id: "pending-invalid" },
        pending_reason: "provider_running",
        status: "pending",
        outcome: "pending",
        terminal_signal: "provider_terminal",
        completion_envelope: completionEnvelope({ ...workIdentity, dispatch_id: "pending-invalid" }, "pending", null),
      }),
      /cannot claim a terminal signal/,
    );
  } finally {
    cleanup();
  }
});
