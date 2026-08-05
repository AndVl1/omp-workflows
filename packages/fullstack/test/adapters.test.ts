/**
 * Escalation adapter + dispatcher tests:
 * - HTTP adapter: POST payload, non-2xx -> unsent, injected fetch.
 * - Dispatcher: outbox -> sanitize -> send -> sent/, invalid esc left in place,
 *   retry exhaustion.
 * - Telegram: sendMessage payload + mapping, pollOnce writes answer files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Escalation,
  readAnswers,
} from "@andvl1/omp-workflows-core";
import { HttpEscalationAdapter } from "../src/adapters/http.js";
import {
  TelegramEscalationAdapter,
} from "../src/adapters/telegram.js";
import {
  handleInboxTask,
  pollInbox,
  resolveInboxRunId,
  inboxDir,
  isBridgeAlive,
  writeBridgeLock,
  clearBridgeLock,
} from "../src/adapters/registry.js";
import {
  loadEscalationConfig,
  createEscalationAdapter,
  drainOutbox,
  outboxDir,
} from "../src/adapters/registry.js";

function sampleEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "run-1/team-a/clarify/1",
    level: "question",
    title: "API shape",
    body: "REST or gRPC?\nAuthorization: Bearer sekrit",
    options: [
      { id: "rest", label: "REST", apply: "now" },
      { id: "grpc", label: "gRPC", apply: "on_next_checkpoint" },
    ],
    default: "rest",
    timeoutMs: 3_600_000,
    ...overrides,
  };
}

test("adapters: HTTP send posts sanitized JSON and reports ok", async () => {
  let seenUrl = "";
  let seenBody = "";
  const fetchImpl = (async (url: unknown, init: unknown) => {
    seenUrl = String(url);
    const body = (init as { body: string }).body;
    seenBody = body;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const adapter = new HttpEscalationAdapter({ url: "https://ntfy.sh/test", fetchImpl });
  const receipt = await adapter.send(sampleEscalation());

  assert.equal(receipt.sent, true);
  assert.equal(seenUrl, "https://ntfy.sh/test");
  const parsed = JSON.parse(seenBody) as Escalation;
  assert.equal(parsed.id, "run-1/team-a/clarify/1");
  // R4 sanitization happens in the dispatcher, not the adapter — the adapter
  // sends what it is given.
  assert.equal(parsed.body, "REST or gRPC?\nAuthorization: Bearer sekrit");
});

test("adapters: HTTP non-2xx and network errors report unsent", async () => {
  const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  assert.equal((await new HttpEscalationAdapter({ url: "http://x", fetchImpl: failing }).send(sampleEscalation())).sent, false);

  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const receipt = await new HttpEscalationAdapter({ url: "http://x", fetchImpl: throwing }).send(sampleEscalation());
  assert.equal(receipt.sent, false);
  assert.ok(receipt.channelRef?.includes("ECONNREFUSED"));
});

test("adapters: dispatcher drains outbox, sanitizes (R4), moves to sent/", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dispatch-"));
  try {
    const esc = sampleEscalation();
    const runId = "run-1";
    const outbox = outboxDir(runId, root);
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, "run-1-team-a-clarify-1.json"), JSON.stringify(esc));

    const sent: Escalation[] = [];
    const adapter = {
      kind: "http",
      send: async (e: Escalation) => {
        sent.push(e);
        return { sent: true };
      },
      cancel: async () => undefined,
    };

    const results = await drainOutbox(root, adapter);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    // Sanitized before the adapter sees it (secret line dropped).
    assert.equal(sent[0]?.body, "REST or gRPC?");
    assert.ok(existsSync(join(outbox, "sent", "run-1-team-a-clarify-1.json")), "file moved to sent/");
    // Invalid escalation stays in place.
    writeFileSync(join(outbox, "bad.json"), JSON.stringify({ id: "x", level: "nope", title: "t", body: "b" }));
    const results2 = await drainOutbox(root, adapter);
    assert.equal(results2.length, 1);
    assert.equal(results2[0]?.sent, false);
    assert.ok(results2[0]?.error?.includes("escalation.level"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: dispatcher retries a failing adapter and gives up", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dispatch-retry-"));
  try {
    const outbox = outboxDir("run-1", root);
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, "esc.json"), JSON.stringify(sampleEscalation()));

    let attempts = 0;
    const adapter = {
      kind: "http",
      send: async () => {
        attempts += 1;
        return { sent: false };
      },
      cancel: async () => undefined,
    };

    const results = await drainOutbox(root, adapter, 3);
    assert.equal(results[0]?.sent, false);
    assert.equal(attempts, 3, "retried up to maxRetries");
    assert.ok(existsSync(join(outbox, "esc.json")), "unsent escalation stays for the next drain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: loadEscalationConfig + createEscalationAdapter", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-cfg-"));
  try {
    assert.equal(loadEscalationConfig(root), null, "no config -> null");
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "escalation.json"),
      JSON.stringify({ adapter: "http", http: { url: "https://ntfy.sh/x" } }),
    );
    const config = loadEscalationConfig(root);
    assert.equal(config?.adapter, "http");
    assert.ok(createEscalationAdapter(config!, root));
    // Bad config -> null adapter.
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "http" }));
    assert.equal(createEscalationAdapter(loadEscalationConfig(root)!, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: telegram sendMessage + pollOnce writes answer files", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-"));
  try {
    let sentPayload: Record<string, unknown> | null = null;
    let updatesCalled = 0;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "sendMessage") {
        sentPayload = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
      }
      if (method === "getUpdates") {
        updatesCalled += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 42 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "c", cwd: root, fetchImpl });
    const receipt = await adapter.send(sampleEscalation());
    assert.equal(receipt.sent, true);
    assert.equal((sentPayload as { chat_id?: string })?.chat_id, "c");
    const keyboard = (sentPayload as { reply_markup?: { inline_keyboard?: unknown[][] } })?.reply_markup as {
      inline_keyboard?: unknown[][];
    };
    assert.ok(keyboard.inline_keyboard, "options rendered as inline buttons");

    const answers = await adapter.pollOnce();
    assert.equal(updatesCalled, 1);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.answer, "rest");
    assert.equal(answers[0]?.by, "telegram:reply");

    const persisted = readAnswers("run-1", root);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.answer, "rest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: telegram callback_query maps to an option answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-cb-"));
  try {
    const fetchImpl = (async (url: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "sendMessage") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
      }
      if (method === "getUpdates") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 2,
                callback_query: { id: "q1", message: { message_id: 7 }, data: "run-1/team-a/clarify/1::grpc" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "c", cwd: root, fetchImpl });
    await adapter.send(sampleEscalation());
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.answer, "grpc");
    assert.equal(answers[0]?.by, "telegram:callback");
    assert.equal(answers[0]?.id, "run-1/team-a/clarify/1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("adapters: telegram plain message routes to the inbox handler (not an answer)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-inbox-"));
  try {
    const inboxMessages: Array<{ id: string; text: string; at: string }> = [];
    const fetchImpl = (async (url: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "getUpdates") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [{ update_id: 3, message: { message_id: 200, text: "Fix the login bug" } }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({
      token: "t",
      chatId: "c",
      cwd: root,
      fetchImpl,
      onPlainMessage: (msg) => inboxMessages.push(msg),
    });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 0, "plain message is not an answer");
    assert.equal(inboxMessages.length, 1, "plain message routed to inbox handler");
    assert.equal(inboxMessages[0]?.text, "Fix the login bug");
    assert.ok(inboxMessages[0]?.id.includes("200"), "message id becomes the task id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: handleInboxTask files a task under the active run and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-"));
  try {
    // No active run -> a standby run is created.
    const runId = resolveInboxRunId(root);
    assert.ok(runId.startsWith("standby-"), "standby run created when none active");
    assert.ok(existsSync(join(root, ".work-state", "cto", runId, "state.json")), "standby state persisted");

    const tasks: Array<{ id: string; text: string; at: string; runId?: string }> = [];
    const path = handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, (t) => tasks.push(t));
    assert.ok(path, "task filed");
    assert.equal(tasks.length, 1, "onTask called once");
    assert.equal(tasks[0]?.runId, runId);

    // Same task id again -> dropped (wx), onTask not re-invoked.
    const again = handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, (t) => tasks.push(t));
    assert.equal(again, null, "duplicate task id dropped");
    assert.equal(tasks.length, 1, "onTask not re-invoked for duplicates");

    const filed = readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json"));
    assert.equal(filed.length, 1, "one inbox file on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox ingests local .omp/inbox drop files", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-drop-"));
  try {
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(join(drop, "task-a.json"), JSON.stringify({ id: "local-a", text: "Task from local drop" }));

    const tasks: Array<{ id: string; text: string; at: string; runId?: string }> = [];
    await pollInbox(root, null, (t) => tasks.push(t));

    assert.equal(tasks.length, 1, "drop task ingested");
    assert.equal(tasks[0]?.text, "Task from local drop");
    assert.ok(tasks[0]?.runId?.startsWith("standby-"), "filed under a standby run");
    assert.ok(existsSync(join(drop, "processed", "task-a.json")), "drop file moved to processed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("adapters: pollInbox wakes on a new escalation answer (user-initiated)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answer-wake-"));
  try {
    const answers: Array<{ id: string; answer: string }> = [];
    // Stub adapter exposing only pollOnce (telegram-like).
    const stub = {
      kind: "telegram",
      pollOnce: async () => [{ id: "run-1/team-a/q1", answer: "use grpc" }],
    } as unknown as import("../src/adapters/telegram.js").TelegramEscalationAdapter;

    await pollInbox(root, stub, undefined, (a) => answers.push(a));
    assert.equal(answers.length, 1, "answer wake fired");
    assert.equal(answers[0]?.id, "run-1/team-a/q1");
    assert.equal(answers[0]?.answer, "use grpc");

    // Same answer again -> deduped (no re-wake).
    await pollInbox(root, stub, undefined, (a) => answers.push(a));
    assert.equal(answers.length, 1, "duplicate answer not re-woken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("adapters: bridge lock — alive while pid lives, stale after exit", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-"));
  try {
    assert.equal(isBridgeAlive(root), false, "no lock -> not alive");
    // lock with a dead pid -> stale, treated as not alive
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "tg-bridge.lock"), JSON.stringify({ pid: 99999999 }));
    assert.equal(isBridgeAlive(root), false, "stale lock (dead pid) ignored");
    // lock with OUR live pid -> alive
    writeBridgeLock(root);
    assert.equal(isBridgeAlive(root), true, "live lock -> bridge owns the bot");
    clearBridgeLock(root);
    assert.equal(isBridgeAlive(root), false, "cleared on shutdown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox skips telegram polling while the bridge is alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-bridge-"));
  try {
    let polls = 0;
    const stub = {
      kind: "telegram",
      pollOnce: async () => {
        polls += 1;
        return [];
      },
    } as unknown as import("../src/adapters/telegram.js").TelegramEscalationAdapter;

    await pollInbox(root, stub, undefined, undefined);
    assert.equal(polls, 1, "no bridge -> session polls telegram");

    writeBridgeLock(root);
    await pollInbox(root, stub, undefined, undefined);
    assert.equal(polls, 1, "bridge alive -> session must NOT poll telegram");
    clearBridgeLock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox wakes [CTO-ANSWER] from a bridge answer marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-ansmark-"));
  try {
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(
      join(drop, "esc-1.json"),
      JSON.stringify({ kind: "answer", id: "run-1/team-a/q1", text: "use grpc", by: "telegram-bridge" }),
    );
    const answers: Array<{ id: string; answer: string }> = [];
    await pollInbox(root, null, undefined, (a) => answers.push(a));
    assert.equal(answers.length, 1, "answer marker woke the session");
    assert.equal(answers[0]?.answer, "use grpc");
    assert.ok(existsSync(join(drop, "processed", "esc-1.json")), "marker moved to processed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
