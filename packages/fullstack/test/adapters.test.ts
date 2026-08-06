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
  ensureStandbyRun,
  inboxDir,
  isBridgeAlive,
  writeBridgeLock,
  clearBridgeLock,
  registerEscalationAdapter,
  isBidirectionalChannel,
  startDispatcher,
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

test("adapters: telegram concurrent pollOnce calls share one getUpdates round", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-cc-"));
  try {
    let updatesCalled = 0;
    const fetchImpl = (async (url: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "sendMessage") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
      }
      if (method === "getUpdates") {
        updatesCalled += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 7 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "c", cwd: root, fetchImpl });
    await adapter.send(sampleEscalation());

    // Both calls are in flight together; the second must reuse the first's
    // round instead of issuing a second getUpdates.
    const first = adapter.pollOnce();
    const second = adapter.pollOnce();
    assert.equal(updatesCalled, 1, "concurrent pollOnce calls issue exactly one getUpdates");

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.length, 1);
    assert.equal(a[0]?.answer, "rest");
    assert.equal(b.length, 1);
    assert.equal(b[0]?.answer, "rest");
    assert.equal(updatesCalled, 1, "still exactly one getUpdates after both settle");
    assert.equal(readAnswers("run-1", root).length, 1, "answer persisted once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: telegram pollOnce keeps the offset on answer persistence failure (retry)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-retry-"));
  try {
    let getUpdatesCalls = 0;
    const fetchImpl = (async (url: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "sendMessage") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
      }
      if (method === "getUpdates") {
        getUpdatesCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 7 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "c", cwd: root, fetchImpl });
    await adapter.send(sampleEscalation());

    // Sabotage answer persistence: the answers dir path is occupied by a
    // regular file, so ensureAnswersDir's recursive mkdirSync throws EEXIST.
    writeFileSync(join(root, ".work-state", "cto", "run-1", "answers"), "blocker");

    await assert.rejects(() => adapter.pollOnce(), /EEXIST/);
    assert.equal(getUpdatesCalls, 1);
    assert.deepEqual(readAnswers("run-1", root), [], "failed persistence wrote no answer");

    // Unblock and poll again: the same update is re-delivered (the offset did
    // not advance past the failed update) and processed to completion.
    rmSync(join(root, ".work-state", "cto", "run-1", "answers"));
    const answers = await adapter.pollOnce();
    assert.equal(getUpdatesCalls, 2);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.answer, "rest");
    const persisted = readAnswers("run-1", root);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.answer, "rest");
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

    // Same task id again -> dropped (wx), onTask NOT re-invoked: the first
    // write wins and wakes; duplicates are at-most-once.
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


test("adapters: consumer transport registers and builds like a built-in", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-reg-"));
  try {
    registerEscalationAdapter("slack", (config) => {
      if (!config.slack?.token) return null;
      return {
        kind: "slack",
        send: async () => ({ sent: true }),
        cancel: async () => undefined,
        pollOnce: async () => [],
      };
    });
    // built via the same factory path as http/telegram
    const config = loadEscalationConfig(root);
    assert.equal(config, null);
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "escalation.json"),
      JSON.stringify({ adapter: "slack", bidirectional: true, slack: { token: "x" } }),
    );
    const adapter = createEscalationAdapter(loadEscalationConfig(root)!, root);
    assert.equal(adapter?.kind, "slack", "consumer adapter created from config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: bidirectional detected by flag for non-telegram transports", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-bi-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "slack", bidirectional: true }));
    assert.equal(isBidirectionalChannel(root), true, "bidirectional flag -> bidirectional");
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "http", bidirectional: false }));
    assert.equal(isBidirectionalChannel(root), false, "http without flag -> push-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: telegram sendPlainText posts plain text without markup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-plain-"));
  try {
    let payload: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "sendMessage") {
        payload = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "c", cwd: root, fetchImpl });
    const result = await adapter.sendPlainText("c", "status reply");
    assert.equal(result.sent, true);
    assert.equal(payload?.chat_id, "c");
    assert.equal(payload?.text, "status reply");
    assert.equal("reply_markup" in (payload ?? {}), false, "plain text, no reply markup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: handleInboxTask propagates a failing wake and retries it", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-wake-"));
  try {
    const runId = resolveInboxRunId(root);
    let calls = 0;
    const onTask = () => {
      calls += 1;
      if (calls === 1) throw new Error("wake failed (transport down)");
    };
    // First attempt: the file is written, then the wake throws — the
    // exception must reach the transport (not be hidden as a null result)
    // and the just-created file is removed so the next poll retries with a
    // fresh write instead of hitting a wx collision (which would skip the
    // wake and lose the update).
    assert.throws(
      () => handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, onTask),
      /wake failed/,
    );
    assert.equal(
      readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json")).length,
      0,
      "failed-wake file removed for a clean retry",
    );
    // Retry: no wx collision — the file is written fresh and the wake fires
    // again until it succeeds.
    const path = handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, onTask);
    assert.ok(path, "retry writes the file");
    assert.equal(calls, 2, "wake retried until it succeeds");
    assert.equal(
      readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json")).length,
      1,
      "exactly one inbox file after the successful retry",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox keeps the drop file and retries the wake on callback failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-drop-retry-"));
  try {
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(join(drop, "task-a.json"), JSON.stringify({ id: "local-a", text: "Task from local drop" }));

    let calls = 0;
    const onTask = () => {
      calls += 1;
      if (calls === 1) throw new Error("wake failed");
    };

    await pollInbox(root, null, onTask);
    assert.equal(calls, 1, "first wake attempt fails");
    assert.equal(existsSync(join(drop, "processed", "task-a.json")), false, "drop file kept in place for retry");

    // Next tick: the wake succeeds and the drop file is finally processed.
    await pollInbox(root, null, onTask);
    assert.equal(calls, 2, "wake retried on the next tick");
    assert.ok(existsSync(join(drop, "processed", "task-a.json")), "drop file moved to processed after a successful wake");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: dispatcher tick never overlaps (one drain+poll pass at a time)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tick-"));
  try {
    let active = 0;
    let maxActive = 0;
    let polls = 0;
    const stub = {
      kind: "telegram",
      send: async () => ({ sent: false }),
      cancel: async () => undefined,
      pollOnce: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 120));
        active -= 1;
        polls += 1;
        return [];
      },
    } as unknown as import("../src/adapters/telegram.js").TelegramEscalationAdapter;

    // Interval (40ms) is much shorter than a poll pass (120ms): without the
    // no-overlap guard ticks would pile up and poll concurrently.
    const stop = startDispatcher(root, stub, 40);
    await new Promise((resolve) => setTimeout(resolve, 550));
    stop();

    assert.equal(maxActive, 1, "poll passes never overlap");
    assert.ok(polls >= 2, `dispatcher kept ticking after the first pass (${polls} passes)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: answer dedupe is scoped per root, not global", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "cto-dedupe-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "cto-dedupe-b-"));
  try {
    const answersA: Array<{ id: string; answer: string }> = [];
    const answersB: Array<{ id: string; answer: string }> = [];
    const stub = {
      kind: "telegram",
      pollOnce: async () => [{ id: "run-1/team-a/q1", answer: "use grpc" }],
    } as unknown as import("../src/adapters/telegram.js").TelegramEscalationAdapter;

    await pollInbox(rootA, stub, undefined, (a) => answersA.push(a));
    // The same esc id in a DIFFERENT cwd must still wake (no global dedupe).
    await pollInbox(rootB, stub, undefined, (a) => answersB.push(a));
    assert.equal(answersA.length, 1);
    assert.equal(answersB.length, 1, "different cwd wakes independently");
    // The same root still dedupes (contract preserved).
    await pollInbox(rootA, stub, undefined, (a) => answersA.push(a));
    assert.equal(answersA.length, 1, "same root still dedupes");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("adapters: ensureStandbyRun reuses an existing active standby run", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-standby-reuse-"));
  try {
    const first = resolveInboxRunId(root);
    assert.ok(first.startsWith("standby-"), "standby run created when none active");
    // A direct call must not mint a second run with a fresh inbox: tasks
    // filed by the bridge before /cto starts must land in the SAME standby
    // inbox, otherwise the command would start a second run and miss them.
    const again = ensureStandbyRun(root);
    assert.equal(again, first, "existing active standby run reused");
    assert.equal(
      readdirSync(inboxDir(first, root)).filter((n) => n.endsWith(".json")).length,
      0,
      "no second run dir with an empty inbox",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
