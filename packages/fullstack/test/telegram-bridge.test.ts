/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EscalationAnswer } from "@andvl1/omp-workflows-core";
import {
  buildStatusReply,
  classifyIncoming,
  writeAnswerMarker,
  writeTaskDrop,
  type BridgeIncoming,
  type BridgeRuntimeContext,
} from "../src/telegram-bridge.js";
import { pollInbox, startDispatcher } from "../src/adapters/registry.js";
import { runtimeFixture } from "./runtime-fixtures.js";

function bridgeContext(root: string, status: BridgeRuntimeContext["run_status"]): BridgeRuntimeContext {
  const fixture = runtimeFixture(root, { runId: "run-one" });
  return { ...fixture.context, run_status: status };
}

function incoming(context: BridgeRuntimeContext, id = "tg:11", text = "Какой статус?"): BridgeIncoming {
  return { id, text, at: new Date().toISOString(), by: "telegram:user-1", run_identity: context.run_identity };
}

function absolute(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

function durableFilenameKey(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}


test("bridge: active run files a task in the explicit local drop without a reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-active-"));
  try {
    const context = bridgeContext(root, "active");
    const result = classifyIncoming(context, incoming(context));
    assert.equal(result.action, "active-task");
    assert.equal(result.reply, undefined, "the active session owns the conversation");
    assert.ok(result.filedPath?.startsWith(".omp/inbox/"), "filed in the manager-owned local drop");
    assert.equal(existsSync(absolute(root, result.filedPath!)), true);
    const stored = JSON.parse(readFileSync(absolute(root, result.filedPath!), "utf8")) as BridgeIncoming;
    assert.equal(stored.run_identity.run_id, "run-one", "file preserves the exact run identity");
    assert.equal(stored.by, "telegram:user-1", "sender provenance is retained");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: completed run replies from supplied summary and files the task", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-done-"));
  try {
    const context: BridgeRuntimeContext = {
      ...bridgeContext(root, "completed"),
      summary: { verdict: "APPROVE", first_sweep: { "#348": { action: "fixes pushed", state: "awaiting review" } } },
    };
    const result = classifyIncoming(context, incoming(context));
    assert.equal(result.action, "completed-status");
    assert.ok(result.reply?.includes("run-one"));
    assert.ok(result.reply?.includes("APPROVE"));
    assert.ok(result.reply?.includes("#348"));
    assert.ok(result.filedPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: unavailable status never discovers a run or creates standby state", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-empty-"));
  try {
    const context = bridgeContext(root, "unavailable");
    const result = classifyIncoming(context, incoming(context));
    assert.equal(result.action, "unavailable");
    assert.ok(result.reply?.includes("No prepared CTO run"));
    assert.equal(result.filedPath, undefined);
    assert.equal(existsSync(join(root, ".omp", "inbox")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: task writes are idempotent only for one exact record", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-idem-"));
  try {
    const context = bridgeContext(root, "active");
    const message = incoming(context);
    const first = writeTaskDrop(context, message);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const expectedPath = `.omp/inbox/task-${durableFilenameKey(message.id)}.json`;
    assert.equal(first.value, expectedPath);
    assert.match(expectedPath, /^\.omp\/inbox\/task-[0-9a-f]{64}\.json$/u);
    const second = writeTaskDrop(context, message);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.value, null, "identical replay is skipped");
    const conflict = writeTaskDrop(context, { ...message, text: "different text" });
    assert.equal(conflict.ok, false, "same key with different content is an explicit conflict");
    const stored = JSON.parse(readFileSync(absolute(root, expectedPath), "utf8")) as BridgeIncoming;
    assert.equal(stored.id, message.id, "the original task id remains in the durable record");
    assert.equal(stored.text, message.text, "the original exact record is retained after conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: task drop rejects a foreign run identity", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-identity-"));
  try {
    const context = bridgeContext(root, "active");
    const foreign = runtimeFixture(root, { runId: "other-run" });
    const result = writeTaskDrop(context, { ...incoming(context), run_identity: foreign.run_identity });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
    assert.equal(existsSync(join(root, ".omp", "inbox")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: persistence failures return a diagnostic instead of duplicate success", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-write-error-"));
  try {
    const context = bridgeContext(root, "active");
    const file = `task-${durableFilenameKey("tg:11")}.json`;
    const drop = join(root, ".omp", "inbox", file);
    mkdirSync(drop, { recursive: true });
    const result = writeTaskDrop(context, incoming(context));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "ACTIVATION_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: supplied summary formatting and answer marker preserve run identity", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-summary-"));
  try {
    const context = bridgeContext(root, "completed");
    const reply = buildStatusReply("run-one", { verdict: "APPROVE", first_sweep: { "#355": { action: "r2 fixes pushed", state: "awaiting review" } } });
    assert.ok(reply.includes("#355") && reply.includes("r2 fixes pushed"));
    const answer: EscalationAnswer = { id: "run-one/team-a/q1", answer: "yes", at: new Date().toISOString(), by: "telegram:user-1", run_identity: context.run_identity };
    const marker = writeAnswerMarker(context, answer);
    assert.equal(marker.ok, true);
    if (marker.ok) {
      const expectedPath = `.omp/inbox/answer-${durableFilenameKey(answer.id)}.json`;
      assert.equal(marker.value, expectedPath);
      assert.match(expectedPath, /^\.omp\/inbox\/answer-[0-9a-f]{64}\.json$/u);
      assert.ok(marker.value);
      const stored = JSON.parse(readFileSync(absolute(root, marker.value), "utf8")) as { id?: string; kind?: string; run_identity?: { run_id?: string }; by?: string };
      assert.equal(stored.id, answer.id, "the original answer id remains in the durable record");
      assert.equal(stored.kind, "answer");
      assert.equal(stored.run_identity?.run_id, "run-one");
      assert.equal(stored.by, "telegram:user-1");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: max-length ASCII and UTF-8 task drop names stay bounded and process", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-task-filename-hash-"));
  try {
    const context = bridgeContext(root, "active");
    const ids = ["A".repeat(512), "я".repeat(512)];
    for (const [index, id] of ids.entries()) {
      const filed = writeTaskDrop(context, incoming(context, id, `task ${index}`));
      assert.equal(filed.ok, true);
      if (!filed.ok) return;
      const expectedPath = `.omp/inbox/task-${durableFilenameKey(id)}.json`;
      assert.equal(filed.value, expectedPath);
      assert.match(expectedPath, /^\.omp\/inbox\/task-[0-9a-f]{64}\.json$/u);
      const stored = JSON.parse(readFileSync(absolute(root, expectedPath), "utf8")) as BridgeIncoming;
      assert.equal(stored.id, id, "the full original task id is stored");
    }

    const processedIds: string[] = [];
    const started = startDispatcher(context, null, {
      intervalMs: 60_000,
      onTask: async (task) => { processedIds.push(task.id); },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    for (const id of ids) {
      const processedPath = absolute(root, `.omp/inbox/processed/task-${durableFilenameKey(id)}.json`);
      await waitFor(() => existsSync(processedPath), `timed out processing task ${id}`);
      const processed = JSON.parse(readFileSync(processedPath, "utf8")) as BridgeIncoming;
      assert.equal(processed.id, id);
    }
    await started.value.stop();
    assert.deepEqual(new Set(processedIds), new Set(ids), "each max-length task is processed once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: max-length ASCII and UTF-8 answer marker names stay bounded and process", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-answer-filename-hash-"));
  try {
    const context = bridgeContext(root, "active");
    const ids = ["B".repeat(512), "ю".repeat(512)];
    for (const [index, id] of ids.entries()) {
      const answer: EscalationAnswer = {
        id,
        answer: `answer ${index}`,
        at: "2026-08-28T00:00:00.000Z",
        by: "filename-test",
        run_identity: context.run_identity,
      };
      const filed = writeAnswerMarker(context, answer);
      assert.equal(filed.ok, true);
      if (!filed.ok) return;
      const expectedPath = `.omp/inbox/answer-${durableFilenameKey(id)}.json`;
      assert.equal(filed.value, expectedPath);
      assert.match(expectedPath, /^\.omp\/inbox\/answer-[0-9a-f]{64}\.json$/u);
      const stored = JSON.parse(readFileSync(absolute(root, expectedPath), "utf8")) as { id?: string; answer?: string };
      assert.equal(stored.id, id, "the full original answer id is stored");
      assert.equal(stored.answer, answer.answer);
    }

    const processedIds: string[] = [];
    const polled = await pollInbox(context, null, undefined, (answer) => { processedIds.push(answer.id); });
    assert.equal(polled.ok, true);
    assert.equal(polled.diagnostics.length, 0);
    for (const id of ids) {
      const pendingPath = absolute(root, `.omp/inbox/answer-${durableFilenameKey(id)}.json`);
      const processedPath = absolute(root, `.omp/inbox/processed/answer-${durableFilenameKey(id)}.json`);
      assert.equal(existsSync(pendingPath), false);
      assert.equal(existsSync(processedPath), true);
      const processed = JSON.parse(readFileSync(processedPath, "utf8")) as { id?: string };
      assert.equal(processed.id, id);
    }
    assert.deepEqual(new Set(processedIds), new Set(ids), "each max-length answer is processed once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: answer markers coalesce exact duplicates and retain conflicting records", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-answer-idem-"));
  try {
    const context = bridgeContext(root, "active");
    const answer: EscalationAnswer = {
      id: "run-one/team-a/answer-1",
      answer: "yes",
      at: "2026-08-28T00:00:00.000Z",
      by: "telegram:user-1",
      run_identity: context.run_identity,
    };
    const expectedPath = `.omp/inbox/answer-${durableFilenameKey(answer.id)}.json`;
    const first = writeAnswerMarker(context, answer);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value, expectedPath);
    const duplicate = writeAnswerMarker(context, answer);
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(duplicate.value, null);
    const conflict = writeAnswerMarker(context, { ...answer, answer: "no" });
    assert.equal(conflict.ok, false, "same answer id with different content is rejected");
    const stored = JSON.parse(readFileSync(absolute(root, expectedPath), "utf8")) as { id?: string; answer?: string };
    assert.equal(stored.id, answer.id);
    assert.equal(stored.answer, answer.answer, "the original answer record is retained");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: complete task and answer validation rejects before any durable write", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-timestamp-validation-"));
  try {
    const context = bridgeContext(root, "active");
    const oversized = "x".repeat(4_001);
    const invalidTasks: BridgeIncoming[] = [
      { ...incoming(context, ""), },
      { ...incoming(context, "task-text-empty", " "), },
      { ...incoming(context, "task-id-oversized"), id: "i".repeat(513), },
      { ...incoming(context, "task-text-oversized"), text: oversized, },
      { ...incoming(context, "task-by-empty"), by: "", },
      { ...incoming(context, "task-by-oversized"), by: oversized, },
    ];
    for (const task of invalidTasks) {
      const result = writeTaskDrop(context, task);
      assert.equal(result.ok, false, "the task writer uses the complete inbound record validator");
      if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CONFIG_MALFORMED");
      assert.equal(existsSync(join(root, ".omp", "inbox")), false, "invalid task records do not create durable inbox state");
    }

    const invalidAnswers: EscalationAnswer[] = [
      { id: "", answer: "reply", at: new Date().toISOString(), by: "writer-test", run_identity: context.run_identity },
      { id: "answer-empty", answer: " ", at: new Date().toISOString(), by: "writer-test", run_identity: context.run_identity },
      { id: "a".repeat(513), answer: "reply", at: new Date().toISOString(), by: "writer-test", run_identity: context.run_identity },
      { id: "answer-text-oversized", answer: oversized, at: new Date().toISOString(), by: "writer-test", run_identity: context.run_identity },
      { id: "answer-by-empty", answer: "reply", at: new Date().toISOString(), by: "", run_identity: context.run_identity },
      { id: "answer-by-oversized", answer: "reply", at: new Date().toISOString(), by: oversized, run_identity: context.run_identity },
    ];
    for (const answer of invalidAnswers) {
      const result = writeAnswerMarker(context, answer);
      assert.equal(result.ok, false, "the answer writer uses the complete inbound record validator");
      if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CONFIG_MALFORMED");
      assert.equal(existsSync(join(root, ".omp", "inbox")), false, "invalid answer records do not create durable inbox state");
    }
    const validIso = "2026-08-28T00:00:00.000Z";
    const invalidTimestamps = [
      "",
      `${validIso}${" ".repeat(105)}`,
      "not-a-date",
      `\u0009${validIso}`,
      `${validIso}\u000A`,
    ];
    for (const [index, at] of invalidTimestamps.entries()) {
      const task = writeTaskDrop(context, { ...incoming(context, `invalid-task-${index}`), at });
      assert.equal(task.ok, false);
      if (!task.ok) assert.equal(task.diagnostics[0]?.code, "CONFIG_MALFORMED");
      const answer: EscalationAnswer = {
        id: `invalid-answer-${index}`,
        answer: "reply",
        at,
        by: "timestamp-test",
        run_identity: context.run_identity,
      };
      const marker = writeAnswerMarker(context, answer);
      assert.equal(marker.ok, false);
      if (!marker.ok) assert.equal(marker.diagnostics[0]?.code, "CONFIG_MALFORMED");
      assert.equal(existsSync(join(root, ".omp", "inbox")), false, "invalid timestamps do not create durable inbox state");
    }

    const boundaryAt = new Date(8_640_000_000_000_000).toISOString();
    const task = writeTaskDrop(context, { ...incoming(context, "valid-boundary-task"), at: boundaryAt });
    assert.equal(task.ok, true);
    const answer = writeAnswerMarker(context, {
      id: "valid-boundary-answer",
      answer: "boundary",
      at: boundaryAt,
      by: "timestamp-test",
      run_identity: context.run_identity,
    });
    assert.equal(answer.ok, true);
    assert.equal(JSON.parse(readFileSync(join(root, ".omp", "inbox", `task-${durableFilenameKey("valid-boundary-task")}.json`), "utf8")).at, boundaryAt);
    assert.equal(JSON.parse(readFileSync(join(root, ".omp", "inbox", `answer-${durableFilenameKey("valid-boundary-answer")}.json`), "utf8")).at, boundaryAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

