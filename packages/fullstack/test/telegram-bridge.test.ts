import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyIncoming,
  buildStatusReply,
  findCompletedSummary,
  sendTelegramText,
  writeTaskDrop,
} from "../src/telegram-bridge.js";

function activeRun(root: string): void {
  const runDir = join(root, ".work-state", "cto", "run-one");
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schema: 1,
      id: "run-one",
      task: "Active task",
      branch: "main",
      autonomous: true,
      plan: { id: "run-one", task: "Active task", teams: [], created_at: now },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: now,
    }),
  );
}

function finishedRun(root: string): void {
  const runDir = join(root, ".work-state", "cto", "run-done");
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify({
      runId: "run-done",
      verdict: "APPROVE",
      first_sweep: {
        "#348": { action: "r5 fixes pushed", state: "awaiting next review" },
        "#355": { action: "r2 fixes pushed", state: "awaiting next review" },
      },
    }),
  );
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schema: 1,
      id: "run-done",
      task: "Done task",
      branch: "main",
      autonomous: true,
      plan: { id: "run-done", task: "Done task", teams: [], created_at: now },
      teams: [],
      integration: { status: "done" },
      pause: { kind: "done", reason: "" },
      updated_at: now,
    }),
  );
}

const MSG = { id: "tg:11", text: "Какой статус?", at: new Date().toISOString(), by: "telegram" };

test("bridge: active run -> task filed in the local drop, no reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-active-"));
  try {
    activeRun(root);
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "active-task");
    assert.equal(result.reply, undefined, "no reply — the session owns the conversation");
    assert.ok(result.filedPath?.startsWith(join(root, ".omp", "inbox")), "filed in the local drop");
    assert.equal(existsSync(result.filedPath!), true);
    assert.equal(result.runId, "run-one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: finished run -> status reply + standby task filed", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-done-"));
  try {
    finishedRun(root);
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "completed-status");
    assert.ok(result.reply!.includes("run-done"), "reply names the run");
    assert.ok(result.reply!.includes("APPROVE"), "reply carries the verdict");
    assert.ok(result.reply!.includes("#348"), "reply carries per-item status");
    assert.ok(result.filedPath, "message still filed (user may have meant a task)");
    assert.equal(result.runId, "run-done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: nothing -> standby run + saved reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-empty-"));
  try {
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "standby-task");
    assert.ok(result.reply!.includes("saved"), "reply says the message was saved");
    assert.ok(result.runId!.startsWith("standby-"), "standby run created");
    const inboxFiles = readdirSync(join(root, ".work-state", "cto", result.runId!, "inbox")).filter((f) => f.endsWith(".json"));
    assert.equal(inboxFiles.length, 1, "task filed in the standby inbox");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: buildStatusReply + findCompletedSummary agree", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-summary-"));
  try {
    finishedRun(root);
    const found = findCompletedSummary(root);
    assert.equal(found?.runId, "run-done");
    const reply = buildStatusReply(found!.runId, found!.summary);
    assert.ok(reply.includes("#355") && reply.includes("r2 fixes pushed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: task writes are wx-idempotent (duplicate delivery skipped)", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-idem-"));
  try {
    const first = writeTaskDrop(root, MSG);
    assert.ok(first, "first write succeeds");
    // Same message redelivered (bridge restart) -> deterministic file name by
    // message id -> wx collision -> null, no duplicate task on disk.
    const second = writeTaskDrop(root, MSG);
    assert.equal(second, null, "duplicate delivery skipped");
    const files = readdirSync(join(root, ".omp", "inbox")).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "exactly one task file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: sendTelegramText posts to the bot API and reports ok", async () => {
  let payload: Record<string, unknown> | null = null;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const method = String(url).split("/").pop();
    if (method === "sendMessage") {
      payload = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected method: ${method}`);
  }) as typeof fetch;

  const ok = await sendTelegramText("t", "c", "hello", fetchImpl);
  assert.equal(ok, true);
  assert.equal(payload?.chat_id, "c");
  assert.equal(payload?.text, "hello");
  assert.equal("reply_markup" in (payload ?? {}), false, "plain text, no reply markup");
});
