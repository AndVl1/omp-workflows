import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyIncoming,
  sendTelegramText,
  writeAnswerMarker,
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


const MSG = { id: "tg:11", text: "Какой статус?", at: new Date().toISOString(), by: "telegram" };

test("bridge: active run -> task stays in local drop without run selection", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-active-"));
  try {
    activeRun(root);
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "local-task");
    assert.ok(result.filedPath?.startsWith(join(root, ".omp", "inbox")), "filed in the local drop");
    assert.equal(existsSync(result.filedPath!), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("bridge: nothing -> local drop without creating run state", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-empty-"));
  try {
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "local-task");
    assert.ok(result.filedPath?.startsWith(join(root, ".omp", "inbox")), "message is filed in local drop");
    assert.equal(existsSync(join(root, ".work-state")), false, "run state is not created implicitly");
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

test("bridge: sanitized ids suffix, while same-id conflicts fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-collision-"));
  try {
    const first = writeTaskDrop(root, { id: "a:b", text: "first", at: new Date().toISOString() });
    const second = writeTaskDrop(root, { id: "a-b", text: "second", at: new Date().toISOString() });
    assert.ok(first && second && first !== second);
    assert.equal(JSON.parse(readFileSync(first, "utf8")).id, "a:b");
    assert.equal(JSON.parse(readFileSync(second, "utf8")).id, "a-b");

    assert.throws(
      () => writeTaskDrop(root, { id: "a:b", text: "changed", at: new Date().toISOString() }),
      /conflicting content or kind/,
      "same transport id cannot create a second task",
    );
    assert.equal(JSON.parse(readFileSync(first, "utf8")).text, "first", "the original task remains authoritative");
    assert.ok(readdirSync(join(root, ".omp", "inbox", "rejected")).some((name) => name.includes(".conflict-")));

    const markerOne = writeAnswerMarker(root, { id: "answer:a", answer: "one" });
    const markerTwo = writeAnswerMarker(root, { id: "answer-a", answer: "two" });
    assert.ok(markerOne && markerTwo && markerOne !== markerTwo);
    assert.equal(JSON.parse(readFileSync(markerOne, "utf8")).id, "answer:a");
    assert.equal(JSON.parse(readFileSync(markerTwo, "utf8")).id, "answer-a");
    assert.throws(
      () => writeAnswerMarker(root, { id: "a:b", answer: "answer" }),
      /conflicting content or kind/,
      "task/answer kind collision under one transport id is rejected",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("bridge: processed source identity blocks changed task or answer before reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-processed-conflict-"));
  try {
    const first = writeTaskDrop(root, { id: "processed:id", text: "first", at: new Date().toISOString() });
    assert.ok(first);
    const processed = join(root, ".omp", "inbox", "processed");
    mkdirSync(processed, { recursive: true });
    renameSync(first, join(processed, "processed-id.json"));

    assert.throws(
      () => classifyIncoming(root, { id: "processed:id", text: "changed", at: new Date().toISOString() }),
      /conflicting content or kind/,
      "processed task identity is checked before classifyIncoming can reply",
    );
    assert.throws(
      () => writeAnswerMarker(root, { id: "processed:id", answer: "answer" }),
      /conflicting content or kind/,
      "a processed task cannot become a second answer wake",
    );
    assert.equal(
      readdirSync(join(root, ".omp", "inbox")).filter((name) => name.endsWith(".json")).length,
      0,
      "conflicting processed source creates no active replacement",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: processed sanitized-id collision still gets a deterministic suffix", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-processed-collision-"));
  try {
    const first = writeTaskDrop(root, { id: "a:b", text: "first", at: new Date().toISOString() });
    assert.ok(first);
    const processed = join(root, ".omp", "inbox", "processed");
    mkdirSync(processed, { recursive: true });
    renameSync(first, join(processed, "a-b.json"));
    const second = writeTaskDrop(root, { id: "a-b", text: "second", at: new Date().toISOString() });
    assert.ok(second && second !== first);
    assert.match(second, /a-b-[a-f0-9]{64}\.json$/);
    assert.equal(JSON.parse(readFileSync(join(processed, "a-b.json"), "utf8")).id, "a:b");
    assert.equal(JSON.parse(readFileSync(second, "utf8")).id, "a-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: answer marker IO failure is surfaced for Telegram retry", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-marker-error-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "inbox"), "not a directory");
    assert.throws(
      () => writeAnswerMarker(root, { id: "run-1/answer-1", answer: "retry me" }),
      /cannot verify|ENOTDIR|directory/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: persistence failures propagate instead of looking like duplicate delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-write-error-"));
  try {
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    // A directory at the deterministic task path proves the write was not
    // durable; treating any existing path as a duplicate would lose the update.
    mkdirSync(join(drop, "tg-11.json"));
    assert.throws(() => writeTaskDrop(root, MSG), /EEXIST|EISDIR|directory|is a directory/i);
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
