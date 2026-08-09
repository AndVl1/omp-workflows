/**
 * Persisted fake-RW transport tests (MockEscalationAdapter persisted mode).
 *
 * Covers: cross-instance persistence (adapter A writes, adapter B observes
 * answers + tasks), outbound logs (messages.jsonl / plain.jsonl) with
 * receipts, same-process dedupe of disk+memory answers, handler-failure
 * retry of inbound files, reset() emptying persisted state, and the
 * registry factory's config.mock wiring (explicit dir + default dir).
 * Layout contract: .work-state/artifacts/fullstack-dispatch/fake-rw-contract.md
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEscalationAdapter, loadEscalationConfig, MAX_INBOX_TEXT_LENGTH } from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";

function withConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}

test("fake-rw: adapter A persists; adapter B observes the answer and the task", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-cross-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    const b = new MockEscalationAdapter({ persisted: { dir } });

    // A: outbound + inbound, no handler on A.
    await a.send({ id: "run-1/team-a/q1", level: "question", title: "Q", body: "q" });
    const tasks: Array<{ id: string; text: string; at: string; by?: string }> = [];
    b.setPlainMessageHandler((msg) => tasks.push(msg));
    a.injectAnswer("run-1/team-a/q1", "use grpc", "user-1");
    a.injectTask("Fix the login bug", "telegram");

    // B polls: sees the durable answer + the durable task via its handler.
    const answers = await b.pollOnce();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.id, "run-1/team-a/q1");
    assert.equal(answers[0]?.answer, "use grpc");
    assert.equal(answers[0]?.by, "user-1");
    assert.equal(tasks.length, 1, "B's handler received the task persisted by A");
    assert.equal(tasks[0]?.text, "Fix the login bug");
    assert.equal(tasks[0]?.by, "telegram");

    // Consumed files land in processed/.
    assert.equal(readdirSync(join(dir, "answers", "processed")).filter((n) => n.endsWith(".json")).length, 1);
    assert.equal(readdirSync(join(dir, "inbound", "processed")).filter((n) => n.endsWith(".json")).length, 1);

    // outbound/messages.jsonl readable with a receipt.
    const messages = readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(messages.length, 1);
    const line = JSON.parse(messages[0]!) as {
      escId: string;
      title: string;
      body: string;
      at: string;
      receipt: { sent: boolean; channelRef?: string };
    };
    assert.equal(line.escId, "run-1/team-a/q1");
    assert.equal(line.title, "Q");
    assert.equal(line.body, "q");
    assert.equal(line.receipt.sent, true);
    assert.ok(line.receipt.channelRef, "receipt channelRef recorded");
    assert.ok(Number.isFinite(Date.parse(line.at)), "outbound line timestamp is ISO");

    // A second poll is empty — everything durable was consumed.
    assert.deepEqual(await b.pollOnce(), []);
    assert.equal(tasks.length, 1, "no re-delivery of the task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: sendPlainText appends plain.jsonl with a receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-plain-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    const result = await a.sendPlainText("user-1", "status reply");
    assert.equal(result.sent, true);
    const lines = readFileSync(join(dir, "outbound", "plain.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]!) as {
      target: string;
      text: string;
      at: string;
      receipt: { sent: boolean; channelRef?: string };
    };
    assert.equal(line.target, "user-1");
    assert.equal(line.text, "status reply");
    assert.equal(line.receipt.sent, true);
    assert.ok(Number.isFinite(Date.parse(line.at)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: injectAnswer writes the file AND queues in memory without double-return", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dedupe-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    a.injectAnswer("run/esc/1", "answer", "u");
    // The file is durable on disk.
    assert.equal(readdirSync(join(dir, "answers")).filter((n) => n.endsWith(".json")).length, 1);
    const answers = await a.pollOnce();
    assert.equal(answers.length, 1, "disk + in-memory copies merge to one");
    assert.equal(answers[0]?.answer, "answer");
    const again = await a.pollOnce();
    assert.deepEqual(again, [], "answer consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: a throwing plain handler leaves the inbound file for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-retry-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    a.injectTask("do it", "mock"); // durable on disk; no handler on A
    const b = new MockEscalationAdapter({ persisted: { dir } });
    const inboundDir = join(dir, "inbound");
    let calls = 0;
    b.setPlainMessageHandler(() => {
      calls += 1;
      if (calls === 1) throw new Error("wake failed (transport down)");
    });
    await b.pollOnce();
    assert.equal(calls, 1);
    assert.equal(
      readdirSync(inboundDir).filter((n) => n.endsWith(".json")).length,
      1,
      "handler failure leaves the file in place for retry",
    );
    await b.pollOnce();
    assert.equal(calls, 2, "handler retried on the next poll");
    assert.equal(readdirSync(inboundDir).filter((n) => n.endsWith(".json")).length, 0, "consumed after success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: reset clears in-memory state AND the persisted dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-reset-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    await a.send({ id: "x/1", level: "question", title: "t", body: "b" });
    a.injectTask("task");
    a.injectAnswer("x/1", "ans");
    a.reset();
    assert.equal(a.sentEscalations.length, 0, "in-memory sends cleared");
    assert.equal(existsSync(join(dir, "inbound")), false, "inbound dir emptied");
    assert.equal(existsSync(join(dir, "answers")), false, "answers dir emptied");
    assert.equal(existsSync(join(dir, "outbound")), false, "outbound dir emptied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry factory builds the persisted adapter from config.mock", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-factory-"));
  try {
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "my-rw" } });
    const adapter = createEscalationAdapter(loadEscalationConfig(root)!, root);
    assert.ok(adapter instanceof MockEscalationAdapter);
    (adapter as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, "my-rw", "inbound")), "persisted dir resolved under cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: default persisted dir is .omp/fake-rw", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-default-"));
  try {
    withConfig(root, { adapter: "mock", mock: { persisted: true } });
    const adapter = createEscalationAdapter(loadEscalationConfig(root)!, root);
    assert.ok(adapter instanceof MockEscalationAdapter);
    (adapter as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, ".omp", "fake-rw", "inbound")), "default dir is .omp/fake-rw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: empty task file in inbound/ → moved to inbound/rejected/ with a durable record", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-rej-empty-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    mkdirSync(join(dir, "inbound"), { recursive: true });
    writeFileSync(join(dir, "inbound", "empty.json"), JSON.stringify({ id: "e1", text: "   " }));
    await a.pollOnce();
    assert.equal(existsSync(join(dir, "inbound", "empty.json")), false, "rejected file consumed from inbound/");
    assert.ok(existsSync(join(dir, "inbound", "rejected", "empty.json")), "original moved to inbound/rejected/");
    const record = JSON.parse(readFileSync(join(dir, "inbound", "rejected", "empty.json.json"), "utf8")) as {
      file: string;
      reason: string;
      at: string;
      id?: string;
    };
    assert.equal(record.file, "empty.json", "record names the original file");
    assert.equal(record.reason, "empty text");
    assert.equal(record.id, "e1");
    assert.ok(Number.isFinite(Date.parse(record.at)), "record timestamp is ISO");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: malformed task files in inbound/ (missing text / missing id) → rejected with records", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-rej-mal-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    mkdirSync(join(dir, "inbound"), { recursive: true });
    writeFileSync(join(dir, "inbound", "no-text.json"), JSON.stringify({ id: "m1" }));
    writeFileSync(join(dir, "inbound", "no-id.json"), JSON.stringify({ text: "orphan" }));
    await a.pollOnce();
    assert.equal(existsSync(join(dir, "inbound", "no-text.json")), false);
    assert.equal(existsSync(join(dir, "inbound", "no-id.json")), false);
    const noText = JSON.parse(readFileSync(join(dir, "inbound", "rejected", "no-text.json.json"), "utf8")) as {
      file: string;
      reason: string;
      id?: string;
    };
    assert.equal(noText.reason, "malformed (missing id or text)");
    assert.equal(noText.id, "m1", "parsed id recorded when present");
    const noId = JSON.parse(readFileSync(join(dir, "inbound", "rejected", "no-id.json.json"), "utf8")) as {
      file: string;
      reason: string;
      id?: string;
    };
    assert.equal(noId.reason, "malformed (missing id or text)");
    assert.equal(noId.id, undefined, "no id field when none parsed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: oversized task file in inbound/ → rejected with a durable record", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-rej-big-"));
  try {
    const dir = join(root, "rw");
    const a = new MockEscalationAdapter({ persisted: { dir } });
    mkdirSync(join(dir, "inbound"), { recursive: true });
    writeFileSync(join(dir, "inbound", "big.json"), JSON.stringify({ id: "b1", text: "x".repeat(MAX_INBOX_TEXT_LENGTH + 1) }));
    await a.pollOnce();
    assert.equal(existsSync(join(dir, "inbound", "big.json")), false, "oversized file consumed from inbound/");
    assert.ok(existsSync(join(dir, "inbound", "rejected", "big.json")), "original moved to rejected/");
    const record = JSON.parse(readFileSync(join(dir, "inbound", "rejected", "big.json.json"), "utf8")) as {
      file: string;
      reason: string;
      id?: string;
    };
    assert.equal(record.reason, "text exceeds MAX_INBOX_TEXT_LENGTH");
    assert.equal(record.id, "b1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry factory rejects absolute and .. persisted dirs, allows relative", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-sec-"));
  try {
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "/abs/path" } });
    assert.equal(createEscalationAdapter(loadEscalationConfig(root)!, root), null, "absolute dir rejected at the config boundary");
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "../escape" } });
    assert.equal(createEscalationAdapter(loadEscalationConfig(root)!, root), null, ".. segment rejected at the config boundary");
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "..\\escape" } });
    assert.equal(createEscalationAdapter(loadEscalationConfig(root)!, root), null, "backslash .. segment rejected too");
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "ok/rel" } });
    const adapter = createEscalationAdapter(loadEscalationConfig(root)!, root);
    assert.ok(adapter instanceof MockEscalationAdapter, "relative dir works");
    (adapter as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, "ok", "rel", "inbound")), "relative dir resolved under the project cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
