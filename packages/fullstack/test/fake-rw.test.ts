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
import { appendFileSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createEscalationAdapter, loadEscalationConfig, MAX_INBOX_TEXT_LENGTH } from "../src/adapters/registry.js";
import { PinnedProjectRoot } from "../../core/src/specification/pinned-root.js";
import { openFullstackRuntimeTest } from "./runtime-access-fixture.js";
import { MOCK_IDEMPOTENCY_KEY_MAX_BYTES, MockEscalationAdapter, MockPersistedRecordError } from "../src/adapters/mock.js";
import { processStartIdentity } from "@andvl1/omp-workflows-core";


const MOCK_MODULE_URL = new URL("../src/adapters/mock.ts", import.meta.url).href;
type FullstackRuntime = ReturnType<typeof openFullstackRuntimeTest>;
const runtimeFixtures = new Map<string, FullstackRuntime>();
function runtimeFor(root: string): FullstackRuntime {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const runtime = openFullstackRuntimeTest(root, "fake-rw-" + runtimeFixtures.size);
  runtimeFixtures.set(root, runtime);
  return runtime;
}
test.after(() => {
  for (const runtime of runtimeFixtures.values()) runtime.close();
  runtimeFixtures.clear();
});
function registryScope(root: string): { runtime: FullstackRuntime; pinnedRoot: PinnedProjectRoot } {
  const runtime = runtimeFor(root);
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("unable to pin fake-rw test root");
  return { runtime, pinnedRoot };
}
function withConfig(root: string, config: unknown): void {


  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}
function runIdempotentChild(
  dir: string,
  key: string,
  esc: Record<string, unknown>,
  gate: string,
  attempted?: string,
  completed?: string,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const script = `
    // Child processes intentionally load the TypeScript module at runtime.
    const { existsSync, writeFileSync } = await import("node:fs");
    const { MockEscalationAdapter } = await import(process.env.MOCK_MODULE_URL);
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(process.env.MOCK_GATE)) Atomics.wait(waitCell, 0, 0, 1);
    if (process.env.MOCK_ATTEMPTED) writeFileSync(process.env.MOCK_ATTEMPTED, "attempted");
    const adapter = new MockEscalationAdapter({ persisted: { dir: process.env.MOCK_DIR } });
    const receipt = await adapter.sendWithIdempotency(JSON.parse(process.env.MOCK_ESC), process.env.MOCK_KEY);
    if (process.env.MOCK_COMPLETED) writeFileSync(process.env.MOCK_COMPLETED, "completed");
    console.log(JSON.stringify(receipt));
  `;
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number | null; stderr: string; stdout: string }>();
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOCK_DIR: dir,
      MOCK_KEY: key,
      MOCK_ESC: JSON.stringify(esc),
      MOCK_GATE: gate,
      MOCK_MODULE_URL,
      ...(attempted ? { MOCK_ATTEMPTED: attempted } : {}),
      ...(completed ? { MOCK_COMPLETED: completed } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (status) => resolve({ status, stderr, stdout }));
  return promise;
}

function runTaskChild(dir: string, gate: string): Promise<{ status: number | null; stderr: string }> {
  const script = `
    const { existsSync } = await import("node:fs");
    const { MockEscalationAdapter } = await import(process.env.MOCK_MODULE_URL);
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(process.env.MOCK_GATE)) Atomics.wait(waitCell, 0, 0, 1);
    const adapter = new MockEscalationAdapter({ persisted: { dir: process.env.MOCK_DIR } });
    await adapter.injectTask("cross-process task");
  `;
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number | null; stderr: string }>();
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, MOCK_DIR: dir, MOCK_GATE: gate, MOCK_MODULE_URL },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (status) => resolve({ status, stderr }));
  return promise;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !existsSync(path); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(path), true, `expected file latch: ${path}`);
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
    a.injectAnswer("run-1", "run-1/team-a/q1", "use grpc", "user-1");
    await a.injectTask("Fix the login bug", "telegram");

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

test("fake-rw: pollOnce quarantines malformed answers and still returns later valid multiline content", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-answer-validation-"));
  try {
    const dir = join(root, "rw");
    const answers = join(dir, "answers");
    mkdirSync(answers, { recursive: true });
    const base = { run_id: "run-1", at: new Date().toISOString(), by: "test" };
    writeFileSync(join(answers, "a-number-id.json"), JSON.stringify({ ...base, id: 42, answer: "bad" }));
    writeFileSync(join(answers, "b-object-id.json"), JSON.stringify({ ...base, id: {}, answer: "bad" }));
    writeFileSync(join(answers, "c-null-id.json"), JSON.stringify({ ...base, id: null, answer: "bad" }));
    writeFileSync(join(answers, "d-control-answer.json"), JSON.stringify({ ...base, id: "run-1/control", answer: "bad\u001b[31m" }));
    writeFileSync(join(answers, "e-oversize-answer.json"), JSON.stringify({ ...base, id: "run-1/oversize", answer: "x".repeat(MAX_INBOX_TEXT_LENGTH + 1) }));
    writeFileSync(join(answers, "f-malformed-json.json"), "{not-json");
    writeFileSync(join(answers, "z-valid.json"), JSON.stringify({ ...base, id: "run-1/valid", answer: "first line\nsecond line" }));

    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    const received = await adapter.pollOnce();
    assert.deepEqual(received.map((answer) => ({ id: answer.id, answer: answer.answer })), [
      { id: "run-1/valid", answer: "first line\nsecond line" },
    ]);
    assert.equal(existsSync(join(answers, "processed", "z-valid.json")), true);
    assert.equal(readdirSync(join(answers, "rejected")).filter((name) => name.endsWith(".rejected.json")).length, 6);
    assert.deepEqual(await adapter.pollOnce(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: oversized injected answer is rejected before persisted queue creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-input-bound-"));
  const dir = join(root, "rw");
  try {
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    await assert.rejects(
      adapter.sendWithIdempotency(
        { id: "run-1/team-a/q1", level: "question", title: "q", body: "b" },
        "🙂".repeat(Math.floor(MOCK_IDEMPOTENCY_KEY_MAX_BYTES / 4) + 1),
      ),
      (error: unknown) => error instanceof MockPersistedRecordError && error.code === "MOCK_PERSISTED_RECORD_TOO_LARGE",
    );
    assert.equal(existsSync(join(dir, "outbound")), false, "rejected idempotency key creates no marker directory");
    assert.throws(
      () => adapter.injectAnswer("run-1", "run-1/team-a/q1", "🙂".repeat(MAX_INBOX_TEXT_LENGTH)),
      (error: unknown) => error instanceof MockPersistedRecordError && error.code === "MOCK_PERSISTED_INPUT_INVALID",
    );
    assert.equal(existsSync(join(dir, "answers")), false, "rejected answer creates no answer queue");
    const writer = adapter as unknown as { persistJson(path: string, prefix: string, value: unknown): string };
    assert.throws(
      () => writer.persistJson(dir, "ans", { oversized: "x".repeat(9 * 1024) }),
      (error: unknown) => error instanceof MockPersistedRecordError && error.code === "MOCK_PERSISTED_RECORD_TOO_LARGE",
    );
    await assert.rejects(
      adapter.injectTask("x".repeat(MAX_INBOX_TEXT_LENGTH + 1)),
      (error: unknown) => error instanceof MockPersistedRecordError && error.code === "MOCK_PERSISTED_INPUT_INVALID",
    );
    await assert.rejects(
      adapter.injectPlainMessage("ok", "\u202e"),
      (error: unknown) => error instanceof MockPersistedRecordError && error.code === "MOCK_PERSISTED_INPUT_INVALID",
    );
    assert.equal(existsSync(join(dir, "inbound")), false, "oversized generic record creates no inbound queue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted idempotency serializes barriered processes to one line and receipt", async () => {

  const root = mkdtempSync(join(tmpdir(), "fake-rw-idempotency-processes-"));
  try {
    const dir = join(root, "rw");
    const key = "cross-process-key";
    const esc = { id: "run/idempotent", level: "question", title: "Q", body: "same payload" } as const;
    const gate = join(root, "release-gate");
    const first = runIdempotentChild(dir, key, esc, gate);
    const second = runIdempotentChild(dir, key, esc, gate);
    writeFileSync(gate, "go");
    const results = await Promise.all([first, second]);
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const firstReceipt = JSON.parse(results[0]!.stdout.trim()) as { sent: boolean; channelRef: string };
    const secondReceipt = JSON.parse(results[1]!.stdout.trim()) as { sent: boolean; channelRef: string };
    assert.deepEqual(secondReceipt, firstReceipt);
    const lines = readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n");
    const matching = lines.filter((line) => (JSON.parse(line) as { idempotencyKey?: string }).idempotencyKey === key);
    assert.equal(matching.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fake-rw: persisted sequence publication never overwrites foreign files across process counter resets", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-sequence-"));
  try {
    const dir = join(root, "rw");
    const inbound = join(dir, "inbound");
    mkdirSync(inbound, { recursive: true });
    const foreign = join(inbound, "task-1.json");
    const foreignPayload = JSON.stringify({ id: "foreign", text: "do not overwrite" });
    writeFileSync(foreign, foreignPayload);
    const gate = join(root, "release-gate");
    const first = runTaskChild(dir, gate);
    const second = runTaskChild(dir, gate);
    writeFileSync(gate, "go");
    const results = await Promise.all([first, second]);
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(foreign, "utf8"), foreignPayload);
    const taskFiles = readdirSync(inbound).filter((name) => name.endsWith(".json")).sort();
    assert.equal(taskFiles.length, 3);
    assert.deepEqual(taskFiles, ["task-1.json", "task-2.json", "task-3.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted records and secret directories are private under umask 000", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-modes-"));
  try {
    const script = `
      const { readdirSync, statSync } = await import("node:fs");
      const { MockEscalationAdapter } = await import(process.env.MOCK_MODULE_URL);
      process.umask(0o000);
      const dir = process.env.MOCK_DIR;
      const adapter = new MockEscalationAdapter({ persisted: { dir } });
      await adapter.send({ id: "run/mode", level: "question", title: "Q", body: "body" });
      await adapter.sendPlainText("target", "plain");
      await adapter.sendWithIdempotency({ id: "run/idempotent", level: "question", title: "I", body: "body" }, "mode-key");
      adapter.injectAnswer("run", "run/mode", "answer");
      await adapter.injectTask("task");
      adapter.setPlainMessageHandler(() => undefined);
      await adapter.pollOnce();
      const mode = (path) => statSync(path).mode & 0o777;
      for (const path of [
        dir,
        dir + "/inbound",
        dir + "/inbound/processed",
        dir + "/answers",
        dir + "/answers/processed",
        dir + "/outbound",
        dir + "/outbound/idempotency",
      ]) if (mode(path) !== 0o700) throw new Error("directory mode " + path + ": " + mode(path).toString(8));
      for (const directory of [dir + "/inbound/processed", dir + "/answers/processed", dir + "/outbound"]) {
        for (const name of readdirSync(directory)) {
          if (name.endsWith(".json") || name.endsWith(".jsonl")) {
            const path = directory + "/" + name;
            if (mode(path) !== 0o600) throw new Error("record mode " + path + ": " + mode(path).toString(8));
          }
        }
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, MOCK_DIR: join(root, "rw"), MOCK_MODULE_URL },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted idempotency repairs marker-before-append and append-before-receipt crashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-idempotency-repair-"));
  try {
    const dir = join(root, "rw");
    const keyA = "marker-before-append";
    const escA = { id: "run/marker", level: "question", title: "marker", body: "payload" } as const;
    const markerDir = join(dir, "outbound", "idempotency");
    mkdirSync(markerDir, { recursive: true });
    const markerPathA = join(markerDir, createHash("sha256").update(keyA).digest("hex") + ".json");
    writeFileSync(markerPathA, JSON.stringify({ key: keyA, status: "prepared", esc: escA }));
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    await adapter.sendWithIdempotency(escA, keyA);
    const linesA = readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(linesA.length, 1);
    assert.equal((JSON.parse(readFileSync(markerPathA, "utf8")) as { status: string }).status, "delivered");

    const keyB = "append-before-receipt";
    const escB = { id: "run/append", level: "question", title: "append", body: "payload" } as const;
    const markerPathB = join(markerDir, createHash("sha256").update(keyB).digest("hex") + ".json");
    writeFileSync(markerPathB, JSON.stringify({ key: keyB, status: "prepared", esc: escB }));
    appendFileSync(join(dir, "outbound", "messages.jsonl"), JSON.stringify({
      escId: escB.id,
      idempotencyKey: keyB,
      title: escB.title,
      body: escB.body,
      esc: escB,
      receipt: { sent: true, channelRef: "mock:" + escB.id },
    }) + "\n");
    await adapter.sendWithIdempotency(escB, keyB);
    const linesB = readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(linesB.filter((line) => (JSON.parse(line) as { idempotencyKey?: string }).idempotencyKey === keyB).length, 1);
    assert.equal((JSON.parse(readFileSync(markerPathB, "utf8")) as { status: string }).status, "delivered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted idempotency rejects a conflicting payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-idempotency-conflict-"));
  try {
    const adapter = new MockEscalationAdapter({ persisted: { dir: join(root, "rw") } });
    const esc = { id: "run/conflict", level: "question", title: "original", body: "payload" } as const;
    await adapter.sendWithIdempotency(esc, "conflicting-key");
    await assert.rejects(
      adapter.sendWithIdempotency({ ...esc, body: "changed" }, "conflicting-key"),
      /already bound to another escalation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted idempotency reclaims a PID-reused lock generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-idempotency-pid-reuse-"));
  try {
    const dir = join(root, "rw");
    const key = "pid-reused-lock";
    const lockDir = join(dir, "outbound", "idempotency");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, createHash("sha256").update(`${key}\u0000lock`, "utf8").digest("hex") + ".lock");
    symlinkSync(JSON.stringify({ schema: 2, pid: process.pid, start_identity: "recycled-generation" }), lock);
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    await adapter.sendWithIdempotency({ id: "run/reused", level: "question", title: "Q", body: "payload" }, key);
    const lines = readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "a PID-reused lock cannot suppress the delivery forever");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted idempotency reclaims aged malformed and legacy locks", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-idempotency-legacy-lock-"));
  try {
    const dir = join(root, "rw");
    const key = "legacy-lock";
    const lockDir = join(dir, "outbound", "idempotency");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, createHash("sha256").update(`${key}\u0000lock`, "utf8").digest("hex") + ".lock");
    symlinkSync("not-json", lock);
    const old = new Date(Date.now() - 1_000);
    lutimesSync(lock, old, old);
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    await adapter.sendWithIdempotency({ id: "run/legacy", level: "question", title: "Q", body: "payload" }, key);
    assert.equal(readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: persisted idempotency does not reclaim a live process generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-idempotency-live-generation-"));
  let contender: Promise<{ status: number | null; stderr: string; stdout: string }> | undefined;
  let lock = "";
  try {
    const dir = join(root, "rw");
    const key = "live-generation";
    const lockDir = join(dir, "outbound", "idempotency");
    mkdirSync(lockDir, { recursive: true });
    lock = join(lockDir, createHash("sha256").update(`${key}\u0000lock`, "utf8").digest("hex") + ".lock");
    const startIdentity = processStartIdentity();
    assert.ok(startIdentity);
    symlinkSync(JSON.stringify({ schema: 2, pid: process.pid, start_identity: startIdentity }), lock);
    const gate = join(root, "release-gate");
    const attempted = join(root, "attempted");
    const completed = join(root, "completed");
    contender = runIdempotentChild(
      dir,
      key,
      { id: "run/live", level: "question", title: "Q", body: "payload" },
      gate,
      attempted,
      completed,
    );
    writeFileSync(gate, "go");
    await waitForFile(attempted);
    assert.equal(existsSync(completed), false, "contender remains fenced while the matching owner generation is live");
    rmSync(lock, { force: true });
    const result = await contender;
    assert.equal(result.status, 0, result.stderr);
    await waitForFile(completed);
    assert.equal(readFileSync(join(dir, "outbound", "messages.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally {
    if (lock) rmSync(lock, { force: true });
    if (contender) await contender.catch(() => undefined);
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
    a.injectAnswer("run", "run/esc/1", "answer", "u");
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
    await a.injectTask("do it", "mock"); // durable on disk; no handler on A
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

test("fake-rw: direct task/plain injection consumes once before poll", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-direct-once-"));
  try {
    const dir = join(root, "rw");
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    const received: string[] = [];
    adapter.setPlainMessageHandler((msg) => {
      received.push(msg.text);
    });
    await adapter.injectTask("task once", "mock");
    await adapter.injectPlainMessage("plain once", "mock");
    await adapter.pollOnce();
    assert.deepEqual(received.sort(), ["plain once", "task once"]);
    assert.equal(readdirSync(join(dir, "inbound", "processed")).filter((name) => name.endsWith(".json")).length, 2);
    assert.deepEqual(await adapter.pollOnce(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: direct handler failure remains durable for one restart retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-direct-retry-"));
  try {
    const dir = join(root, "rw");
    const first = new MockEscalationAdapter({ persisted: { dir } });
    let firstCalls = 0;
    first.setPlainMessageHandler(() => {
      firstCalls += 1;
      throw new Error("wake failed");
    });
    await first.injectTask("retry task once", "mock");
    await first.injectPlainMessage("retry plain once", "mock");
    assert.equal(firstCalls, 2);
    assert.equal(readdirSync(join(dir, "inbound")).filter((name) => name.endsWith(".json")).length, 2);

    const restarted = new MockEscalationAdapter({ persisted: { dir } });
    let retryCalls = 0;
    restarted.setPlainMessageHandler(() => {
      retryCalls += 1;
    });
    await restarted.pollOnce();
    assert.equal(retryCalls, 2);
    assert.equal(readdirSync(join(dir, "inbound", "processed")).filter((name) => name.endsWith(".json")).length, 2);
    assert.deepEqual(await restarted.pollOnce(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: concurrent task/plain injection and polling consume each file once", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-concurrent-inbound-"));
  try {
    const dir = join(root, "rw");
    const producer = new MockEscalationAdapter({ persisted: { dir } });
    const consumer = new MockEscalationAdapter({ persisted: { dir } });
    const received: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = 0;
    let resolveCompleted!: () => void;
    const completedPromise = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    producer.setPlainMessageHandler(async (msg) => {
      received.push(`producer:${msg.text}`);
      await hold;
      completed += 1;
      if (completed === 2) resolveCompleted();
    });
    consumer.setPlainMessageHandler((msg) => {
      received.push(`consumer:${msg.text}`);
    });
    const injectedTask = producer.injectTask("task concurrent", "mock");
    const injectedPlain = producer.injectPlainMessage("plain concurrent", "mock");
    const poll = consumer.pollOnce();
    release();
    await Promise.all([poll, injectedTask, injectedPlain, completedPromise]);
    assert.deepEqual(received.sort(), ["producer:plain concurrent", "producer:task concurrent"]);
    assert.equal(readdirSync(join(dir, "inbound", "processed")).filter((name) => name.endsWith(".json")).length, 2);
    assert.deepEqual(await consumer.pollOnce(), []);
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
    await a.injectTask("task");
    a.injectAnswer("x", "x/1", "ans");
    a.reset();
    assert.equal(a.sentEscalations.length, 0, "in-memory sends cleared");
    assert.equal(existsSync(join(dir, "inbound")), false, "inbound dir emptied");
    assert.equal(existsSync(join(dir, "answers")), false, "answers dir emptied");
    assert.equal(existsSync(join(dir, "outbound")), false, "outbound dir emptied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry factory builds the persisted adapter from config.mock", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-factory-"));
  const scope = registryScope(root);
  try {
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "my-rw" } });
    const config = loadEscalationConfig(root, { kind: "mock", runtimeAccess: scope.runtime.access, pinnedRoot: scope.pinnedRoot });
    const adapter = createEscalationAdapter(config!, root, scope.pinnedRoot, scope.runtime.access, scope.runtime.proofAuthority);
    assert.ok(adapter instanceof MockEscalationAdapter);
    await (adapter as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, "my-rw", "inbound")), "persisted dir resolved under cwd");
  } finally {
    scope.pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: default persisted dir is .omp/fake-rw", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-default-"));
  const scope = registryScope(root);
  try {
    withConfig(root, { adapter: "mock", mock: { persisted: true } });
    const config = loadEscalationConfig(root, { kind: "mock", runtimeAccess: scope.runtime.access, pinnedRoot: scope.pinnedRoot });
    const adapter = createEscalationAdapter(config!, root, scope.pinnedRoot, scope.runtime.access, scope.runtime.proofAuthority);
    assert.ok(adapter instanceof MockEscalationAdapter);
    await (adapter as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, ".omp", "fake-rw", "inbound")), "default dir is .omp/fake-rw");
  } finally {
    scope.pinnedRoot.close();
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

test("fake-rw: malformed JSON/schema/identity and oversize inbound files reject once while later valid input proceeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-rej-restart-"));
  try {
    const dir = join(root, "rw");
    const first = new MockEscalationAdapter({ persisted: { dir } });
    const received: string[] = [];
    first.setPlainMessageHandler((message) => received.push(message.text));
    mkdirSync(join(dir, "inbound"), { recursive: true });
    writeFileSync(join(dir, "inbound", "a-json.json"), "{not json");
    writeFileSync(join(dir, "inbound", "b-schema.json"), JSON.stringify({ text: "missing id" }));
    writeFileSync(join(dir, "inbound", "c-identity.json"), JSON.stringify({ id: "   ", text: "blank identity" }));
    writeFileSync(join(dir, "inbound", "d-large.json"), JSON.stringify({ id: "large", text: "x".repeat(MAX_INBOX_TEXT_LENGTH + 1) }));
    writeFileSync(join(dir, "inbound", "z-valid.json"), JSON.stringify({ id: "valid", text: "process me" }));

    await first.pollOnce();
    assert.deepEqual(received, ["process me"]);
    assert.equal(readdirSync(join(dir, "inbound", "rejected")).filter((name) => name.endsWith(".json") && !name.endsWith(".json.json")).length, 4);
    assert.equal(existsSync(join(dir, "inbound", "processed", "z-valid.json")), true);

    const restarted = new MockEscalationAdapter({ persisted: { dir } });
    let retried = 0;
    restarted.setPlainMessageHandler(() => { retried += 1; });
    await restarted.pollOnce();
    await restarted.pollOnce();
    assert.equal(retried, 0, "permanent malformed inputs do not spin after restart");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: crash after durable rejection record finishes the own processing claim on restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-rej-crash-"));
  try {
    const dir = join(root, "rw");
    const processing = join(dir, "inbound", "processing");
    const rejected = join(dir, "inbound", "rejected");
    mkdirSync(processing, { recursive: true });
    mkdirSync(rejected, { recursive: true });
    writeFileSync(join(processing, "crashed.json"), JSON.stringify({ id: "crashed", text: "bad" }));
    writeFileSync(join(processing, "crashed.json.claim"), JSON.stringify({ pid: 999999999, owner: "dead" }));
    writeFileSync(join(rejected, "crashed.json.json"), JSON.stringify({
      file: "crashed.json",
      reason: "malformed JSON",
      at: new Date().toISOString(),
    }));
    const restarted = new MockEscalationAdapter({ persisted: { dir } });
    await restarted.pollOnce();
    assert.equal(existsSync(join(rejected, "crashed.json")), true);
    assert.equal(existsSync(join(processing, "crashed.json")), false);
    assert.equal(existsSync(join(processing, "crashed.json.claim")), false);
    await restarted.pollOnce();
    assert.equal(existsSync(join(rejected, "crashed.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: matching process-start identity keeps a live inbound claim fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-claim-live-generation-"));
  try {
    const dir = join(root, "rw");
    const processing = join(dir, "inbound", "processing");
    mkdirSync(processing, { recursive: true });
    writeFileSync(join(processing, "live.json"), JSON.stringify({ id: "live", text: "do not duplicate" }));
    const startIdentity = processStartIdentity();
    assert.ok(startIdentity);
    writeFileSync(join(processing, "live.json.claim"), JSON.stringify({
      schema: 2,
      pid: process.pid,
      start_identity: startIdentity,
      owner: "live-owner",
    }));
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    const received: string[] = [];
    adapter.setPlainMessageHandler((message) => received.push(message.id));
    await adapter.pollOnce();
    assert.deepEqual(received, []);
    assert.equal(existsSync(join(processing, "live.json")), true, "a live owner keeps its claim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: PID reuse and aged malformed/legacy claims recover exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-claim-generations-"));
  try {
    const dir = join(root, "rw");
    const processing = join(dir, "inbound", "processing");
    mkdirSync(processing, { recursive: true });
    const startIdentity = processStartIdentity();
    assert.ok(startIdentity);
    const claims = [
      ["reused.json", { id: "reused", text: "recovered after pid reuse" }, { schema: 2, pid: process.pid, start_identity: "old-generation", owner: "old" }],
      ["legacy.json", { id: "legacy", text: "recovered from legacy" }, { pid: 999999999, owner: "dead" }],
      ["malformed.json", { id: "malformed", text: "recovered from malformed" }, "{not-json"],
    ] as const;
    for (const [name, payload, marker] of claims) {
      writeFileSync(join(processing, name), JSON.stringify(payload));
      writeFileSync(join(processing, `${name}.claim`), typeof marker === "string" ? marker : JSON.stringify(marker));
      const markerPath = join(processing, `${name}.claim`);
      const old = new Date(Date.now() - 1_000);
      utimesSync(markerPath, old, old);
    }
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    const received: string[] = [];
    adapter.setPlainMessageHandler((message) => received.push(message.id));
    await adapter.pollOnce();
    assert.deepEqual(received.sort(), ["legacy", "malformed", "reused"]);
    assert.equal(existsSync(join(dir, "inbound", "processed", "reused.json")), true);
    assert.equal(existsSync(join(dir, "inbound", "processed", "legacy.json")), true);
    assert.equal(existsSync(join(dir, "inbound", "processed", "malformed.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry factory rejects absolute and .. persisted dirs, allows relative", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-sec-"));
  const scope = registryScope(root);
  const load = () => loadEscalationConfig(root, { kind: "mock", pinnedRoot: scope.pinnedRoot, runtimeAccess: scope.runtime.access });
  const create = (config: NonNullable<ReturnType<typeof loadEscalationConfig>>) => createEscalationAdapter(config, root, scope.pinnedRoot, scope.runtime.access);
  try {
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "/abs/path" } });
    assert.equal(create(load()!), null, "absolute dir rejected at the config boundary");
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "../escape" } });
    assert.equal(create(load()!), null, ".. segment rejected at the config boundary");
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "..\\escape" } });
    assert.equal(create(load()!), null, "backslash .. segment rejected too");
    withConfig(root, { adapter: "mock", mock: { persisted: true, dir: "ok/rel" } });
    const adapter = create(load()!);
    assert.ok(adapter instanceof MockEscalationAdapter, "relative dir works");
    await (adapter as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, "ok", "rel", "inbound")), "relative dir resolved under the project cwd");
  } finally {
    scope.pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("fake-rw: nonregular and oversized persisted queue entries quarantine without starving valid rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-bounded-queue-"));
  try {
    const dir = join(root, "rw");
    const answers = join(dir, "answers");
    const inbound = join(dir, "inbound");
    mkdirSync(answers, { recursive: true });
    mkdirSync(inbound, { recursive: true });
    const answerAt = new Date().toISOString();
    writeFileSync(join(answers, "a-huge.json"), JSON.stringify({
      id: "run/huge",
      run_id: "run",
      answer: "x".repeat(16 * 1024),
      at: answerAt,
      by: "test",
    }));
    assert.equal(spawnSync("mkfifo", [join(answers, "b-fifo.json")]).status, 0);
    symlinkSync("/dev/null", join(answers, "c-device.json"));
    writeFileSync(join(answers, "z-valid.json"), JSON.stringify({
      id: "run/valid",
      run_id: "run",
      answer: "first\nsecond",
      at: answerAt,
      by: "test",
    }));
    writeFileSync(join(inbound, "a-huge.json"), JSON.stringify({ id: "in/huge", text: "x".repeat(16 * 1024) }));
    assert.equal(spawnSync("mkfifo", [join(inbound, "b-fifo.json")]).status, 0);
    writeFileSync(join(inbound, "z-valid.json"), JSON.stringify({ id: "in/valid", text: "deliver me", at: answerAt, by: "test" }));

    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    const received: string[] = [];
    adapter.setPlainMessageHandler((message) => { received.push(message.text); });
    const drained = await adapter.pollOnce();
    assert.deepEqual(drained.map((answer) => answer.id), ["run/valid"]);
    assert.deepEqual(received, ["deliver me"]);
    assert.equal(readdirSync(join(answers, "rejected")).filter((name) => name.endsWith(".rejected.json")).length, 3);
    assert.equal(readdirSync(join(inbound, "rejected")).filter((name) => name.endsWith(".json") && !name.endsWith(".json.json")).length, 2);
    assert.deepEqual(await adapter.pollOnce(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
