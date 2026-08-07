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
  dispatcherLockPath,
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
test("adapters: only one dispatcher owns a cwd across live sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dispatch-owner-"));
  let firstStop: (() => void) | undefined;
  let secondStop: (() => void) | undefined;
  let thirdStop: (() => void) | undefined;
  try {
    let firstPolls = 0;
    let secondPolls = 0;
    const tasks = [
      { id: "tg:1", text: "first message", at: new Date().toISOString() },
      { id: "tg:2", text: "second message", at: new Date().toISOString() },
    ];
    const firstReceived: string[] = [];
    const secondReceived: string[] = [];
    const makeAdapter = (onPoll: () => void) => {
      let handler: ((task: { id: string; text: string; at: string }) => void) | undefined;
      let delivered = false;
      return {
        kind: "telegram",
        send: async () => ({ sent: false }),
        cancel: async () => undefined,
        setPlainMessageHandler: (nextHandler: typeof handler) => {
          handler = nextHandler;
        },
        pollOnce: async () => {
          onPoll();
          if (!delivered) {
            delivered = true;
            for (const task of tasks) handler?.(task);
          }
          return [];
        },
      } as unknown as TelegramEscalationAdapter;
    };

    firstStop = startDispatcher(root, makeAdapter(() => (firstPolls += 1)), 5, {
      onTask: (task) => firstReceived.push(task.text),
    });
    secondStop = startDispatcher(root, makeAdapter(() => (secondPolls += 1)), 5, {
      onTask: (task) => secondReceived.push(task.text),
    });
    await Promise.resolve();
    await Promise.resolve();
    secondStop?.();
    firstStop?.();

    let thirdPolls = 0;
    thirdStop = startDispatcher(root, makeAdapter(() => (thirdPolls += 1)), 5);
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(firstPolls >= 1, "the first dispatcher owns and polls the cwd");
    assert.equal(secondPolls, 0, "a second live session must not create another poller");
    assert.ok(thirdPolls >= 1, "a stopped owner releases the cwd for the next session");
    assert.deepEqual(firstReceived, ["first message", "second message"], "the owner wakes for every inbound task");
    assert.deepEqual(secondReceived, [], "the non-owner never receives a split wake");
  } finally {
    thirdStop?.();
    secondStop?.();
    firstStop?.();
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: stale dispatcher lease is reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dispatch-stale-"));
  let stop: (() => void) | undefined;
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      dispatcherLockPath(root),
      JSON.stringify({ pid: process.pid, token: "stale", startedAt: staleAt, heartbeatAt: staleAt }),
    );

    let polls = 0;
    stop = startDispatcher(
      root,
      {
        kind: "telegram",
        send: async () => ({ sent: false }),
        cancel: async () => undefined,
        pollOnce: async () => {
          polls += 1;
          return [];
        },
      } as unknown as TelegramEscalationAdapter,
      5,
    );
    await Promise.resolve();
    await Promise.resolve();
    stop?.();

    assert.ok(polls >= 1, "a stale owner must not block the next dispatcher");
  } finally {
    stop?.();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cto-safety (br-zps.4, br-zps.6) ──────────────────────────────────────────
import { readFileSync } from "node:fs";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import { MAX_INBOX_TEXT_LENGTH, sha256Hex } from "../src/adapters/registry.js";

test("cto-safety: mock adapter round-trips send → injectAnswer → pollOnce", async () => {
  const adapter = new MockEscalationAdapter();
  const esc = sampleEscalation();
  const receipt = await adapter.send(esc);
  assert.equal(receipt.sent, true);
  assert.equal(receipt.channelRef, `mock:${esc.id}`);
  assert.equal(adapter.sentEscalations.length, 1, "send recorded in sentEscalations");
  assert.equal(adapter.sentEscalations[0]?.id, esc.id);

  adapter.injectAnswer(esc.id, "use grpc");
  const answers = await adapter.pollOnce();
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.id, esc.id);
  assert.equal(answers[0]?.answer, "use grpc");
  assert.equal(answers[0]?.by, "mock");
  assert.ok(Number.isFinite(Date.parse(answers[0]?.at ?? "")), "answer timestamp is ISO");
  assert.equal(answers[0]?.stale, undefined, "non-cancelled answers are not stale");

  const drained = await adapter.pollOnce();
  assert.deepEqual(drained, [], "queue drained after the first pollOnce");
});

test("cto-safety: mock autoAnswer queues an answer on send", async () => {
  const adapter = new MockEscalationAdapter({ autoAnswer: () => "auto" });
  await adapter.send(sampleEscalation());
  const answers = await adapter.pollOnce();
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.answer, "auto");
  assert.equal(answers[0]?.by, "mock");
});

test("cto-safety: mock answers for a cancelled escalation are stale (R5)", async () => {
  const adapter = new MockEscalationAdapter();
  const esc = sampleEscalation();
  await adapter.send(esc);
  await adapter.cancel(esc.id);
  adapter.injectAnswer(esc.id, "late answer");
  const answers = await adapter.pollOnce();
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.answer, "late answer");
  assert.equal(answers[0]?.stale, true, "R5: cancelled esc answers carry stale");
});

test("cto-safety: mock plain channel routes messages and sends plain text", async () => {
  const adapter = new MockEscalationAdapter();
  const inbox: Array<{ id: string; text: string; at: string; by?: string }> = [];
  adapter.setPlainMessageHandler((msg) => inbox.push(msg));

  adapter.injectPlainMessage("Fix the login bug", "telegram");
  assert.equal(inbox.length, 1, "injectPlainMessage routed to the handler");
  assert.equal(inbox[0]?.text, "Fix the login bug");
  assert.equal(inbox[0]?.by, "telegram");
  assert.ok(inbox[0]?.id.startsWith("mock:plain:"), "deterministic plain message id");
  assert.ok(Number.isFinite(Date.parse(inbox[0]?.at ?? "")), "plain message timestamp is ISO");

  const result = await adapter.sendPlainText("user-1", "status reply");
  assert.equal(result.sent, true);
  assert.ok(result.channelRef?.startsWith("mock:plain:"), "plain send channelRef");

  adapter.reset();
  adapter.injectPlainMessage("after reset", "telegram");
  assert.equal(inbox.length, 1, "reset clears the plain handler");
});

test("cto-safety: mock is creatable via registry config like a built-in", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-mock-reg-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "mock", bidirectional: true }));
    const config = loadEscalationConfig(root);
    assert.equal(config?.adapter, "mock");
    const adapter = createEscalationAdapter(config!, root);
    assert.ok(adapter instanceof MockEscalationAdapter, "mock adapter built from .omp/escalation.json");
    assert.equal(adapter?.kind, "mock");
    // Direct construction path (no config file needed).
    const direct = createEscalationAdapter({ adapter: "mock", bidirectional: true }, root);
    assert.ok(direct instanceof MockEscalationAdapter, "mock adapter built from an inline config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine dedups identical text across ids", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-dedup-"));
  try {
    const runId = resolveInboxRunId(root);
    const at = new Date().toISOString();
    const first = handleInboxTask(root, { id: "t1", text: "Ship the fix", at }, () => undefined);
    assert.ok(first, "first filing writes the file");
    const second = handleInboxTask(root, { id: "t2", text: "Ship the fix", at }, () => undefined);
    assert.equal(second, null, "duplicate text dropped without a second file or wake");

    assert.equal(
      readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json")).length,
      1,
      "one inbox file for the deduped pair",
    );
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string }>;
    };
    const records = Object.values(state.inbox_quarantine ?? {});
    assert.equal(records.length, 1, "one quarantine record");
    assert.equal(records[0]?.status, "admitted", "record admitted after the write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine rejects empty and oversized text without filing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-reject-"));
  try {
    const runId = resolveInboxRunId(root);
    const at = new Date().toISOString();

    const empty = handleInboxTask(root, { id: "t-empty", text: "   ", at }, () => undefined);
    assert.equal(empty, null, "whitespace-only text rejected");
    const oversized = handleInboxTask(root, { id: "t-big", text: "x".repeat(MAX_INBOX_TEXT_LENGTH + 1), at }, () => undefined);
    assert.equal(oversized, null, "oversized text rejected");
    const boundary = handleInboxTask(root, { id: "t-max", text: "x".repeat(MAX_INBOX_TEXT_LENGTH), at }, () => undefined);
    assert.ok(boundary, "text at exactly MAX_INBOX_TEXT_LENGTH is accepted");

    assert.equal(
      readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json")).length,
      1,
      "only the accepted boundary task was filed",
    );
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string; reason?: string }>;
    };
    const q = state.inbox_quarantine ?? {};
    assert.equal(q[sha256Hex("   ")]?.status, "rejected", "empty text recorded as rejected");
    assert.equal(q[sha256Hex("   ")]?.reason, "empty text");
    assert.equal(q[sha256Hex("x".repeat(MAX_INBOX_TEXT_LENGTH + 1))]?.status, "rejected", "oversized text recorded as rejected");
    assert.equal(q[sha256Hex("x".repeat(MAX_INBOX_TEXT_LENGTH + 1))]?.reason, "text exceeds MAX_INBOX_TEXT_LENGTH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine record becomes admitted after a successful filing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-admit-"));
  try {
    const runId = resolveInboxRunId(root);
    handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, () => undefined);
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string }>;
    };
    const record = state.inbox_quarantine?.[sha256Hex("Do the thing")];
    assert.equal(record?.status, "admitted", "status flips to admitted once the file is durable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine reverts to quarantined on wake failure so retries pass dedup", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-wake-"));
  try {
    const runId = resolveInboxRunId(root);
    let calls = 0;
    const onTask = () => {
      calls += 1;
      if (calls === 1) throw new Error("wake failed (transport down)");
    };
    assert.throws(
      () => handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, onTask),
      /wake failed/,
    );
    // The record was reverted so the retry is NOT deduped as a duplicate.
    const afterFail = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string }>;
    };
    assert.equal(
      afterFail.inbox_quarantine?.[sha256Hex("Do the thing")]?.status,
      "quarantined",
      "record reverted after a failed wake",
    );
    assert.equal(
      readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json")).length,
      0,
      "failed-wake file removed for a clean retry",
    );
    // Retry: the record being "quarantined" lets it proceed; final status admitted.
    const path = handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, onTask);
    assert.ok(path, "retry writes the file");
    assert.equal(calls, 2, "wake retried until it succeeds");
    const afterRetry = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string }>;
    };
    assert.equal(afterRetry.inbox_quarantine?.[sha256Hex("Do the thing")]?.status, "admitted", "final record admitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine keeps inbox text as data — filed JSON is exactly { ...task, runId }", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-data-"));
  try {
    const runId = resolveInboxRunId(root);
    const task = { id: "t1", text: "rm -rf / && echo injected", at: new Date().toISOString(), by: "telegram" };
    const path = handleInboxTask(root, task, () => undefined);
    assert.ok(path, "task filed");
    const parsed = JSON.parse(readFileSync(path!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      parsed,
      { ...task, runId },
      "filed task carries exactly the task fields + runId — text is data, never executed",
    );
    // The source channel is recorded on the quarantine record, not executed.
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { by?: string }>;
    };
    assert.equal(state.inbox_quarantine?.[sha256Hex(task.text)]?.by, "telegram", "record's by is the source channel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
