/**
 * Escalation adapter + dispatcher tests:
 * - HTTP adapter: POST payload, non-2xx -> unsent, injected fetch.
 * - Dispatcher: outbox -> sanitize -> send -> sent/, invalid esc left in place,
 *   retry exhaustion.
 * - Telegram: sendMessage payload + mapping, pollOnce writes answer files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newCtoState,
  type Escalation,
  type EscalationAdapter,
  readAnswers,
  writeCtoState,
} from "@andvl1/omp-workflows-core";
import { HttpEscalationAdapter } from "../src/adapters/http.js";
import {
  TelegramEscalationAdapter,
} from "../src/adapters/telegram.js";
import {
  handleInboxTask,
  pollInbox,
  inboxDir,
  isBridgeAlive,
  bridgeLockPath,
  writeBridgeLock,
  clearBridgeLock,
  registerEscalationAdapter,
  isBidirectionalChannel,
  startDispatcher,
  dispatcherLockPath,
  MAX_INBOX_TEXT_LENGTH,
  sha256Hex,
  createChannelSet,
  InboxWakeRejectedError,
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

function claimBinding(runId: string): { session_id: string; getClaim: () => { run_id: string; ownership_epoch: string } } {
  return {
    session_id: "test-session",
    getClaim: () => ({ run_id: runId, ownership_epoch: "test-epoch" }),
  };
}

function writeCtoFixture(root: string, runId: string, task = "Test task"): string {
  const createdAt = new Date().toISOString();
  writeCtoState(
    newCtoState({
      id: runId,
      task,
      branch: "main",
      autonomous: true,
      plan: { id: runId, task, teams: [], created_at: createdAt },
    }),
    root,
  );
  return runId;
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
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 42 }, chat: { id: 100 }, from: { id: 100 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "100", cwd: root, fetchImpl });
    const receipt = await adapter.send(sampleEscalation());
    assert.equal(receipt.sent, true);
    assert.equal((sentPayload as { chat_id?: string })?.chat_id, "100");
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
                callback_query: {
                  id: "q1",
                  from: { id: 100 },
                  message: { message_id: 7, chat: { id: 100 } },
                  data: "run-1/team-a/clarify/1::grpc",
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "100", cwd: root, fetchImpl });
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
            result: [{ update_id: 3, message: { message_id: 200, text: "Fix the login bug", chat: { id: 100 }, from: { id: 100 } } }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({
      token: "t",
      chatId: "100",
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
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 7 }, chat: { id: 100 }, from: { id: 100 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "100", cwd: root, fetchImpl });
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
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 7 }, chat: { id: 100 }, from: { id: 100 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "100", cwd: root, fetchImpl });
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

test("adapters: telegram marker failure keeps the update pending until marker persistence succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-marker-"));
  try {
    let getUpdatesCalls = 0;
    let markerAttempts = 0;
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
              { update_id: 1, message: { message_id: 100, text: "rest", reply_to_message: { message_id: 7 }, chat: { id: 100 }, from: { id: 100 } } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "100", cwd: root, fetchImpl });
    await adapter.send(sampleEscalation());
    adapter.setAnswerMarkerHandler(() => {
      markerAttempts += 1;
      if (markerAttempts === 1) throw new Error("marker storage unavailable");
    });

    await assert.rejects(() => adapter.pollOnce(), /marker storage unavailable/);
    assert.equal(getUpdatesCalls, 1);
    const answers = await adapter.pollOnce();
    assert.equal(getUpdatesCalls, 2, "the failed marker round leaves the Telegram update retryable");
    assert.equal(answers.length, 1);
    assert.equal(markerAttempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: telegram pollOnce returns prior answers when a later marker fails and retries the failed update", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tg-partial-"));
  try {
    let getUpdatesCalls = 0;
    const offsets: number[] = [];
    const markerIds: string[] = [];
    const firstUpdate = {
      update_id: 1,
      callback_query: {
        id: "q1",
        from: { id: 100 },
        message: { message_id: 11, chat: { id: 100 } },
        data: "run-1/team-a/clarify/1::rest",
      },
    };
    const secondUpdate = {
      update_id: 2,
      callback_query: {
        id: "q2",
        from: { id: 100 },
        message: { message_id: 12, chat: { id: 100 } },
        data: "run-1/team-a/clarify/2::grpc",
      },
    };
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const method = String(url).split("/").pop();
      if (method === "getUpdates") {
        const rawBody = init && typeof init === "object" && "body" in init ? init.body : undefined;
        if (typeof rawBody !== "string") throw new Error("missing getUpdates request body");
        const parsed: unknown = JSON.parse(rawBody);
        const offset =
          parsed && typeof parsed === "object" && "offset" in parsed && typeof parsed.offset === "number" ? parsed.offset : -1;
        offsets.push(offset);
        getUpdatesCalls += 1;
        const result = getUpdatesCalls === 1 ? [firstUpdate, secondUpdate] : [secondUpdate];
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      throw new Error(`unexpected method: ${method}`);
    }) as typeof fetch;

    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: "100", cwd: root, fetchImpl });
    adapter.setAnswerMarkerHandler((answer) => {
      markerIds.push(answer.id);
      if (markerIds.length === 2) throw new Error("marker storage unavailable");
    });

    const firstAnswers = await adapter.pollOnce();
    assert.equal(firstAnswers.length, 1, "the successful first answer is returned despite the later failure");
    assert.equal(firstAnswers[0]?.id, "run-1/team-a/clarify/1");
    assert.equal(firstAnswers[0]?.answer, "rest");
    assert.deepEqual(offsets, [0], "the first round starts at the initial offset");
    assert.deepEqual(markerIds, ["run-1/team-a/clarify/1", "run-1/team-a/clarify/2"]);
    assert.equal(readAnswers("run-1", root).length, 2, "the failed marker does not undo canonical answer persistence");

    const recovered = await adapter.pollOnce();
    assert.deepEqual(offsets, [0, 2], "the next round starts at the failed update's offset");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.id, "run-1/team-a/clarify/2");
    assert.equal(recovered[0]?.answer, "grpc");
    assert.deepEqual(markerIds, [
      "run-1/team-a/clarify/1",
      "run-1/team-a/clarify/2",
      "run-1/team-a/clarify/2",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: handleInboxTask requires an explicit run and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-"));
  try {
    const at = new Date().toISOString();
    const unbound = handleInboxTask(root, { id: "unbound", text: "No implicit run", at }, () => {
      throw new Error("unbound task must not wake");
    });
    assert.equal(unbound, null, "unbound task is rejected without a run binding");
    assert.equal(existsSync(join(root, ".work-state")), false, "unbound task does not create run authority");

    const runId = writeCtoFixture(root, "run-explicit");
    const tasks: Array<{ id: string; text: string; at: string; runId?: string }> = [];
    const path = handleInboxTask(root, { id: "t1", text: "Do the thing", at, runId }, (t) => tasks.push(t));
    assert.ok(path, "task filed");
    assert.equal(tasks.length, 1, "onTask called once");
    assert.equal(tasks[0]?.runId, runId);

    // Same task id again -> dropped (wx), onTask NOT re-invoked: the first
    // write wins and wakes; duplicates are at-most-once.
    const again = handleInboxTask(root, { id: "t1", text: "Do the thing", at, runId }, (t) => tasks.push(t));
    assert.equal(again, null, "duplicate task id dropped");
    assert.equal(tasks.length, 1, "onTask not re-invoked for duplicates");

    const filed = readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json"));
    assert.equal(filed.length, 1, "one inbox file on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: run inbox keeps distinct ids that sanitize to one filename and rejects same-id conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-collision-"));
  try {
    const runId = writeCtoFixture(root, "run-collision");
    const first = handleInboxTask(root, { id: "a:b", text: "first", at: new Date().toISOString(), runId }, () => undefined);
    const second = handleInboxTask(root, { id: "a-b", text: "second", at: new Date().toISOString(), runId }, () => undefined);
    assert.ok(first && second && first !== second);
    assert.equal(JSON.parse(readFileSync(first, "utf8")).id, "a:b");
    assert.equal(JSON.parse(readFileSync(second, "utf8")).id, "a-b");

    assert.throws(
      () => handleInboxTask(root, { id: "a:b", text: "changed", at: new Date().toISOString(), runId }, () => undefined),
      (error: unknown) => error instanceof InboxWakeRejectedError && /conflicting content or kind/.test(error.message),
    );
    assert.equal(JSON.parse(readFileSync(first, "utf8")).text, "first", "the original task remains authoritative");
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string; reason?: string }>;
    };
    const conflict = Object.values(state.inbox_quarantine ?? {}).find((entry) => entry.reason?.includes("conflicting content"));
    assert.equal(conflict?.status, "rejected", "same-id conflict is durably rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: same transport id text/kind conflicts fail closed before wake and preserve accepted hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-identity-"));
  try {
    const runId = writeCtoFixture(root, "run-identity");
    let wakes = 0;
    const at = new Date().toISOString();
    handleInboxTask(
      root,
      { id: "same-id", kind: "task", text: "same body", at, runId },
      () => {
        wakes += 1;
      },
    );
    assert.throws(
      () => handleInboxTask(root, { id: "same-id", kind: "answer", text: "same body", at, runId }, () => { wakes += 1; }),
      (error: unknown) => error instanceof InboxWakeRejectedError && /conflicting content or kind/.test(error.message),
    );
    assert.equal(wakes, 1, "a changed marker kind never reaches the host callback");

    const runState = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string; reason?: string }>;
    };
    assert.equal(runState.inbox_quarantine?.[sha256Hex("same body")]?.status, "admitted");
    assert.equal(
      readdirSync(inboxDir(runId, root)).filter((name) => name.endsWith(".json")).length,
      1,
      "the original task remains the only durable run-inbox source",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const dedupRoot = mkdtempSync(join(tmpdir(), "cto-inbox-hash-identity-"));
  try {
    const runId = writeCtoFixture(dedupRoot, "run-hash-identity");
    const at = new Date().toISOString();
    handleInboxTask(dedupRoot, { id: "A", text: "alpha", at, runId }, () => undefined);
    handleInboxTask(dedupRoot, { id: "B", text: "beta", at, runId }, () => undefined);
    assert.throws(
      () => handleInboxTask(dedupRoot, { id: "A", text: "beta", at, runId }, () => undefined),
      (error: unknown) => error instanceof InboxWakeRejectedError && /conflicting content or kind/.test(error.message),
    );
    const state = JSON.parse(readFileSync(join(dedupRoot, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { id?: string; status?: string; reason?: string }>;
    };
    assert.equal(state.inbox_quarantine?.[sha256Hex("beta")]?.id, "B", "the accepted beta hash remains owned by B");
    assert.equal(state.inbox_quarantine?.[sha256Hex("beta")]?.status, "admitted", "the accepted beta hash remains admitted");
  } finally {
    rmSync(dedupRoot, { recursive: true, force: true });
  }
});
test("adapters: absent task callback refuses before filing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-no-callback-"));
  try {
    const runId = writeCtoFixture(root, "run-no-task-callback");
    assert.throws(
      () => handleInboxTask(root, { id: "t1", text: "must not wake", at: new Date().toISOString(), runId }),
      (error: unknown) => error instanceof InboxWakeRejectedError && /no onTask callback/.test(error.message),
    );
    assert.equal(existsSync(inboxDir(runId, root)), false, "missing callback does not file an admitted task");
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string; reason?: string }>;
    };
    const refusal = Object.values(state.inbox_quarantine ?? {}).find((entry) => entry.reason?.includes("no onTask callback"));
    assert.equal(refusal?.status, "rejected", "missing callback is durably rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: absent answer callback keeps the canonical answer and retry marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answer-no-callback-"));
  try {
    const runId = writeCtoFixture(root, "run-no-answer-callback");
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    const answerId = `${runId}/team-a/q1`;
    writeFileSync(
      join(drop, "answer.json"),
      JSON.stringify({ kind: "answer", id: answerId, text: "yes", by: "telegram-bridge" }),
    );

    await pollInbox(root, null, undefined, undefined, claimBinding(runId));

    const marker = JSON.parse(readFileSync(join(drop, "answer.json"), "utf8")) as {
      delivery_status?: string;
      delivery_reason?: string;
    };
    assert.equal(marker.delivery_status, "pre-send-rejected", "missing callback is not accepted");
    assert.match(marker.delivery_reason ?? "", /no host callback/);
    assert.equal(existsSync(join(drop, "processed", "answer.json")), false, "the original marker remains retryable");
    const canonical = JSON.parse(
      readFileSync(join(root, ".work-state", "cto", runId, "answers", `${runId}-team-a-q1.json`), "utf8"),
    ) as { answer?: string; delivery_status?: string };
    assert.equal(canonical.answer, "yes");
    assert.equal(canonical.delivery_status, "pre-send-rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox ingests local .omp/inbox drop files only after an exact claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-drop-"));
  try {
    const runId = writeCtoFixture(root, "run-drop");
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(join(drop, "task-a.json"), JSON.stringify({ id: "local-a", kind: "task", text: "Task from local drop" }));

    const tasks: Array<{ id: string; text: string; at: string; kind?: string; runId?: string }> = [];
    await pollInbox(root, null, (t) => tasks.push(t), undefined, claimBinding(runId));

    assert.equal(tasks.length, 1, "drop task ingested");
    assert.equal(tasks[0]?.text, "Task from local drop");
    assert.equal(tasks[0]?.kind, "task", "local-drop marker kind reaches the host callback");
    assert.equal(tasks[0]?.runId, runId, "task is routed to the exact claimed run");
    assert.ok(existsSync(join(drop, "processed", "task-a.json")), "drop file moved to processed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: typed stale claim stays fail-closed, retains source, and surfaces recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-drop-stale-claim-"));
  const diagnostics: string[] = [];
  const originalError = console.error;
  try {
    const runId = writeCtoFixture(root, "run-stale-claim");
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(join(drop, "stale.json"), JSON.stringify({ id: "stale-task", text: "keep this source" }));
    console.error = (...args: unknown[]) => {
      diagnostics.push(args.map(String).join(" "));
    };
    const staleBinding = {
      session_id: "stale-session",
      getClaim(): never {
        throw Object.assign(new Error("bound CTO claim ownership epoch is stale"), {
          code: "run_busy" as const,
          next_action: "reconcile the previous CTO session before continuing",
        });
      },
    };
    await pollInbox(root, null, () => {
      throw new Error("stale claim must not wake a task");
    }, undefined, staleBinding);
    assert.equal(existsSync(join(root, ".omp", "inbox", "stale.json")), true, "stale claim leaves the source durable");
    assert.ok(
      diagnostics.some((message) => message.includes("run_busy") && message.includes("reconcile the previous CTO session")),
      "typed stale-claim recovery action is surfaced",
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox rejects empty and oversized drop files to drop/rejected/ with quarantine records", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-drop-reject-"));
  try {
    const runId = writeCtoFixture(root, "run-drop-reject");
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(join(drop, "empty.json"), JSON.stringify({ id: "e1", text: "   " }));
    writeFileSync(join(drop, "big.json"), JSON.stringify({ id: "b1", text: "x".repeat(MAX_INBOX_TEXT_LENGTH + 1) }));
    writeFileSync(join(drop, "valid.json"), JSON.stringify({ id: "v1", text: "Do the thing" }));

    const tasks: Array<{ id: string; text: string }> = [];
    await pollInbox(root, null, (t) => tasks.push(t), undefined, claimBinding(runId));

    // The valid file still processes as today:
    assert.equal(tasks.length, 1, "only the valid task woke");
    assert.equal(tasks[0]?.text, "Do the thing");
    assert.ok(existsSync(join(drop, "processed", "valid.json")), "valid drop file moved to processed");
    // Rejected files are moved OUT of drop/ (never skipped forever):
    assert.ok(existsSync(join(drop, "rejected", "empty.json")), "empty drop file moved to rejected/");
    assert.ok(existsSync(join(drop, "rejected", "big.json")), "oversized drop file moved to rejected/");
    // Durable quarantine records in the run state:
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string; reason?: string }>;
    };
    const q = state.inbox_quarantine ?? {};
    assert.equal(q[sha256Hex("   ")]?.status, "rejected", "empty text recorded as rejected");
    assert.equal(q[sha256Hex("   ")]?.reason, "empty text");
    assert.equal(q[sha256Hex("x".repeat(MAX_INBOX_TEXT_LENGTH + 1))]?.status, "rejected", "oversized text recorded as rejected");
    assert.equal(q[sha256Hex("x".repeat(MAX_INBOX_TEXT_LENGTH + 1))]?.reason, "text exceeds MAX_INBOX_TEXT_LENGTH");
    assert.equal(q[sha256Hex("Do the thing")]?.status, "admitted", "valid task admitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: drainOutbox RO-only — every sink fails → file stays in outbox, sent:false with sinkErrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-ro-fail-"));
  try {
    const runId = "run-ro-fail";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({ id: "run-ro-fail/sum/1", level: "question", title: "T", body: "b", intent: "summary" }),
    );
    const failing = (label: string): EscalationAdapter => ({
      kind: "mock",
      send: async () => {
        throw new Error(`sink ${label} down`);
      },
      cancel: async () => undefined,
    });
    const results = await drainOutbox(root, null, 3, { roSinks: [failing("a"), failing("b")] });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, false, "not archived when every attempted sink failed");
    assert.equal(results[0]?.error, "all ro sinks failed");
    assert.equal(results[0]?.sinkErrors?.length, 2, "both sink failures recorded");
    assert.ok(existsSync(join(outboxDir(runId, root), "s1.json")), "file LEFT in outbox/ for the next drain");
    assert.equal(existsSync(join(outboxDir(runId, root), "sent")), false, "nothing archived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: drainOutbox RO-only — partial sink failure → archived sent:true with sinkErrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-ro-partial-"));
  try {
    const runId = "run-ro-partial";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({ id: "run-ro-partial/sum/1", level: "question", title: "T", body: "b", intent: "summary" }),
    );
    const failing: EscalationAdapter = {
      kind: "mock",
      send: async () => {
        throw new Error("sink down");
      },
      cancel: async () => undefined,
    };
    const ok: EscalationAdapter = {
      kind: "mock",
      send: async () => ({ sent: true }),
      cancel: async () => undefined,
    };
    const results = await drainOutbox(root, null, 3, { roSinks: [failing, ok] });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true, "archived when at least one sink succeeded");
    assert.equal(results[0]?.sinkErrors?.length, 1, "partial sink failure recorded");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent", "s1.json")), "archived to sent/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: drainOutbox RO-only — all sinks subscription-skipped → archived sent:true, no sinkErrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-ro-skip-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "escalation.json"),
      JSON.stringify({ channels: [{ id: "audit", adapter: "mock", direction: "read-only", subscriptions: ["billing"] }] }),
    );
    const set = createChannelSet(root);
    assert.equal(set.primary, null, "RO-only set");
    assert.equal(set.roSinks.length, 1);
    const runId = "run-ro-skip";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({ id: "run-ro-skip/sum/1", level: "question", title: "T", body: "b", intent: "summary", topic: "progress" }),
    );
    const results = await drainOutbox(root, null, 3, { roSinks: set.roSinks });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true, "subscription-skipped summary archived as an honest no-op");
    assert.equal(results[0]?.sinkErrors, undefined, "no sinkErrors when nothing was attempted");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent", "s1.json")), "archived to sent/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: drainOutbox RO-only — succeeding sink → archived sent:true (today's behavior)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-ro-ok-"));
  try {
    const runId = "run-ro-ok";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({ id: "run-ro-ok/sum/1", level: "question", title: "T", body: "b", intent: "summary" }),
    );
    const ok: EscalationAdapter = {
      kind: "mock",
      send: async () => ({ sent: true }),
      cancel: async () => undefined,
    };
    const results = await drainOutbox(root, null, 3, { roSinks: [ok] });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.equal(results[0]?.sinkErrors, undefined, "no sinkErrors on full success");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent", "s1.json")), "archived to sent/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("adapters: pollInbox wakes on a new escalation answer (user-initiated)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answer-wake-"));
  try {
    const runId = writeCtoFixture(root, "run-1");
    const binding = claimBinding(runId);
    const answers: Array<{ id: string; answer: string }> = [];
    // Stub adapter exposing only pollOnce (telegram-like).
    const stub = {
      kind: "telegram",
      pollOnce: async () => [{ id: "run-1/team-a/q1", answer: "use grpc" }],
    } as unknown as TelegramEscalationAdapter;

    await pollInbox(root, stub, undefined, (a) => answers.push(a), binding);
    assert.equal(answers.length, 1, "answer wake fired");
    assert.equal(answers[0]?.id, "run-1/team-a/q1");
    assert.equal(answers[0]?.answer, "use grpc");

    // Same answer again -> deduped (no re-wake).
    await pollInbox(root, stub, undefined, (a) => answers.push(a), binding);
    assert.equal(answers.length, 1, "duplicate answer not re-woken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: an unsafe canonical answer target is refused without waking or consuming the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answer-unsafe-"));
  try {
    const runId = writeCtoFixture(root, "run-answer-unsafe");
    const dir = join(root, "rw");
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    adapter.injectAnswer("../unsafe", "answer", "mock");
    const answers: Array<{ id: string; answer: string }> = [];

    await pollInbox(root, adapter, undefined, (answer) => answers.push(answer), claimBinding(runId));

    assert.deepEqual(answers, [], "an unsafe target cannot produce a success wake");
    assert.equal(existsSync(join(dir, "answers", "ans-1.json")), true, "the invalid source remains recoverable");
    assert.equal(existsSync(join(dir, "answers", "processed", "ans-1.json")), false, "the invalid source is not archived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: canonical persistence reports an actionable error for an unsafe id", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answer-unsafe-error-"));
  try {
    const runId = writeCtoFixture(root, "run-answer-unsafe-error");
    let persist: ((answer: { id: string; answer: string }) => void) | undefined;
    const adapter = {
      kind: "mock",
      setAnswerPersistenceHandler: (handler: (answer: { id: string; answer: string }) => void) => {
        persist = handler;
      },
      pollOnce: async () => [],
    } as unknown as TelegramEscalationAdapter;

    await pollInbox(root, adapter, undefined, undefined, claimBinding(runId));
    assert.ok(persist, "registry installs the optional persistence boundary");
    assert.throws(
      () => persist!({ id: "../unsafe", answer: "answer" }),
      /unsafe id\/path/,
      "invalid canonical targets fail closed with recovery guidance",
    );
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
    writeFileSync(bridgeLockPath(root), JSON.stringify({ pid: 99999999 }));
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
    const runId = writeCtoFixture(root, "run-bridge");
    const binding = claimBinding(runId);
    let polls = 0;
    const stub = {
      kind: "telegram",
      pollOnce: async () => {
        polls += 1;
        return [];
      },
    } as unknown as TelegramEscalationAdapter;

    await pollInbox(root, stub, undefined, undefined, binding);
    assert.equal(polls, 1, "no bridge -> session polls telegram");

    writeBridgeLock(root);
    await pollInbox(root, stub, undefined, undefined, binding);
    assert.equal(polls, 1, "bridge alive -> session must NOT poll telegram");
    clearBridgeLock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox — persisted mock RW adapter polls through a live tg-bridge lock and delivers the inbound task exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-mock-lock-"));
  const dir = join(root, "rw");
  const runId = writeCtoFixture(root, "run-mock-lock");
  const binding = claimBinding(runId);
  const tasks: Array<{ id: string; text: string }> = [];
  try {
    const adapter = new MockEscalationAdapter({ persisted: { dir } });
    adapter.setPlainMessageHandler((m) => tasks.push({ id: m.id, text: m.text }));

    // Live-lock resident repro: the tg-bridge lock is up BEFORE the first poll.
    writeBridgeLock(root);

    // Second-process path: a SEPARATE writer drops the inbound file; this
    // adapter instance only ever sees it via pollOnce() (no injection-time
    // in-memory fire), so delivery is observable through the handler alone.
    const inbound = join(dir, "inbound");
    mkdirSync(inbound, { recursive: true });
    writeFileSync(
      join(inbound, "task-1.json"),
      JSON.stringify({ id: "task-1", text: "bridge-lock mock task", at: new Date().toISOString(), by: "second-process" }),
    );

    await pollInbox(root, adapter, undefined, undefined, binding);

    assert.equal(tasks.length, 1, "live tg-bridge lock must not suppress a non-telegram RW adapter");
    assert.equal(tasks[0]?.text, "bridge-lock mock task");
    assert.ok(existsSync(join(inbound, "processed", "task-1.json")), "inbound task consumed (moved to processed)");

    // Next tick: nothing new to drain — delivered exactly once.
    await pollInbox(root, adapter, undefined, undefined, binding);
    assert.equal(tasks.length, 1, "inbound task delivered exactly once");
  } finally {
    clearBridgeLock(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: pollInbox — send-only adapter (no pollOnce) is never polled", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-sendonly-"));
  try {
    const runId = writeCtoFixture(root, "run-sendonly");
    const binding = claimBinding(runId);
    const stub = {
      kind: "http",
      send: async () => ({ sent: true }),
    } as unknown as EscalationAdapter;
    const tasks: Array<{ id: string; text: string }> = [];
    const answers: Array<{ id: string; answer: string }> = [];
    // Two ticks: resolves without throwing, and delivers nothing (RO/send-only
    // adapters remain non-pollable).
    await pollInbox(root, stub, (t) => tasks.push(t), (a) => answers.push(a), binding);
    await pollInbox(root, stub, (t) => tasks.push(t), (a) => answers.push(a), binding);
    assert.equal(tasks.length, 0, "send-only adapter delivers no inbound tasks");
    assert.equal(answers.length, 0, "send-only adapter delivers no answers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox wakes [CTO-ANSWER] from a bridge answer marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-ansmark-"));
  try {
    const runId = writeCtoFixture(root, "run-1");
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(
      join(drop, "esc-1.json"),
      JSON.stringify({ kind: "answer", id: `${runId}/team-a/q1`, text: "use grpc", by: "telegram-bridge" }),
    );
    const answers: Array<{ id: string; answer: string }> = [];
    await pollInbox(root, null, undefined, (a) => answers.push(a), claimBinding(runId));
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

test("adapters: handleInboxTask retains an ambiguous wake send without retrying", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-wake-"));
  try {
    const runId = writeCtoFixture(root, "run-wake");
    let calls = 0;
    const onTask = () => {
      calls += 1;
      throw new Error("wake result unknown after host invocation");
    };
    const task = { id: "t1", text: "Do the thing", at: new Date().toISOString(), runId };
    const path = handleInboxTask(root, task, onTask);
    assert.ok(path, "ambiguous wake still returns the durable inbox file");
    assert.equal(calls, 1, "host wake is invoked once");
    assert.equal(existsSync(path!), true, "ambiguous wake retains durable task");

    const retry = handleInboxTask(root, task, onTask);
    assert.equal(retry, null, "durable task is not retried as a new admission");
    assert.equal(calls, 1, "ambiguous wake is not repeated");
    assert.equal(readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: pollInbox processes a task after an ambiguous wake and does not retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-drop-retry-"));
  try {
    const runId = writeCtoFixture(root, "run-drop-retry");
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    writeFileSync(join(drop, "task-a.json"), JSON.stringify({ id: "local-a", text: "Task from local drop" }));

    let calls = 0;
    const onTask = () => {
      calls += 1;
      throw new Error("wake result unknown");
    };

    await pollInbox(root, null, onTask, undefined, claimBinding(runId));
    assert.equal(calls, 1, "wake attempted once");
    assert.ok(existsSync(join(drop, "processed", "task-a.json")), "ambiguous task is retained as processed durable work");

    // Next tick: processed source is not woken a second time.
    await pollInbox(root, null, onTask, undefined, claimBinding(runId));
    assert.equal(calls, 1, "ambiguous wake is not retried");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapters: dispatcher tick never overlaps (one drain+poll pass at a time)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-tick-"));
  try {
    const runId = writeCtoFixture(root, "run-overlap");
    const binding = claimBinding(runId);
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
    } as unknown as TelegramEscalationAdapter;

    // Interval (40ms) is much shorter than a poll pass (120ms): without the
    // no-overlap guard ticks would pile up and poll concurrently.
    const stop = startDispatcher(root, stub, 40, { binding });
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
    writeCtoFixture(rootA, "run-1");
    writeCtoFixture(rootB, "run-1");
    const answersB: Array<{ id: string; answer: string }> = [];
    const stub = {
      kind: "telegram",
      pollOnce: async () => [{ id: "run-1/team-a/q1", answer: "use grpc" }],
    } as unknown as TelegramEscalationAdapter;

    await pollInbox(rootA, stub, undefined, (a) => answersA.push(a), claimBinding("run-1"));
    // The same esc id in a DIFFERENT cwd must still wake (no global dedupe).
    await pollInbox(rootB, stub, undefined, (a) => answersB.push(a), claimBinding("run-1"));
    assert.equal(answersA.length, 1);
    assert.equal(answersB.length, 1, "different cwd wakes independently");
    // The same root still dedupes (contract preserved).
    await pollInbox(rootA, stub, undefined, (a) => answersA.push(a), claimBinding("run-1"));
    assert.equal(answersA.length, 1, "same root still dedupes");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("adapters: unbound inbox task never creates a run", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-no-run-"));
  try {
    const result = handleInboxTask(
      root,
      { id: "t1", text: "No implicit run", at: new Date().toISOString() },
      () => {
        throw new Error("unbound task must not wake");
      },
    );
    assert.equal(result, null, "no explicit run binding means no admission");
    assert.equal(existsSync(join(root, ".work-state", "cto")), false, "no run state is minted by the inbox path");
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
    const runId = writeCtoFixture(root, "run-owner");
    const binding = claimBinding(runId);
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
      binding,
      onTask: (task) => firstReceived.push(task.text),
    });
    secondStop = startDispatcher(root, makeAdapter(() => (secondPolls += 1)), 5, {
      binding,
      onTask: (task) => secondReceived.push(task.text),
    });
    await Promise.resolve();
    await Promise.resolve();
    secondStop?.();
    firstStop?.();

    let thirdPolls = 0;
    thirdStop = startDispatcher(root, makeAdapter(() => (thirdPolls += 1)), 5, { binding });
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

    const runId = writeCtoFixture(root, "run-stale");
    const binding = claimBinding(runId);
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
      { binding },
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

test("adapters: a fresh dispatcher lease retries one proven pre-send rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dispatch-lease-retry-"));
  let firstStop: (() => void) | undefined;
  let secondStop: (() => void) | undefined;
  try {
    const runId = writeCtoFixture(root, "run-lease-retry");
    const binding = claimBinding(runId);
    const answer = { id: `${runId}/team-a/q1`, answer: "yes" };
    let delivered = false;
    let wakeCalls = 0;
    const makeAdapter = () =>
      ({
        kind: "mock",
        send: async () => ({ sent: false }),
        cancel: async () => undefined,
        pollOnce: async () => {
          if (delivered) return [];
          delivered = true;
          return [answer];
        },
      }) as unknown as TelegramEscalationAdapter;

    firstStop = startDispatcher(root, makeAdapter(), 100_000, {
      binding,
      onAnswer: () => {
        wakeCalls += 1;
        throw new InboxWakeRejectedError("pre-send refusal");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    firstStop();
    firstStop = undefined;

    secondStop = startDispatcher(root, makeAdapter(), 100_000, {
      binding,
      onAnswer: () => {
        wakeCalls += 1;
        return "accepted";
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    secondStop();
    secondStop = undefined;

    assert.equal(wakeCalls, 2, "the second lease gets one retry while the first lease remains at-most-once");
    assert.equal(existsSync(join(root, ".omp", "inbox", "processed")), true, "the retry marker is finalized after the fresh lease accepts");
  } finally {
    secondStop?.();
    firstStop?.();
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapters: repeated pre-send refusal reuses an exact retry marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dispatch-marker-collision-"));
  try {
    const runId = writeCtoFixture(root, "run-marker-collision");
    const answer = { id: `${runId}/team-a/q1`, answer: "yes" };
    const binding = claimBinding(runId);
    const adapter = {
      kind: "mock",
      pollOnce: async () => [answer],
    } as unknown as TelegramEscalationAdapter;
    let wakeCalls = 0;
    const rejectWake = () => {
      wakeCalls += 1;
      throw new InboxWakeRejectedError("pre-send refusal");
    };

    await pollInbox(root, adapter, undefined, rejectWake, binding, "lease-one");
    await pollInbox(root, adapter, undefined, rejectWake, binding, "lease-two");

    const drop = join(root, ".omp", "inbox");
    const markers = readdirSync(drop).filter((name) => name.startsWith("answer-retry-") && name.endsWith(".json"));
    assert.equal(wakeCalls, 2, "a fresh lease may retry the proven refusal");
    assert.equal(markers.length, 1, "same answer content does not create duplicate retry markers");
    const marker = JSON.parse(readFileSync(join(drop, markers[0]!), "utf8")) as { id?: string; text?: string; delivery_status?: string };
    assert.equal(marker.id, answer.id);
    assert.equal(marker.text, answer.answer);
    assert.equal(marker.delivery_status, "pre-send-rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cto-safety (br-zps.4, br-zps.6) ──────────────────────────────────────────
import { MockEscalationAdapter } from "../src/adapters/mock.js";

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
    const runId = writeCtoFixture(root, "run-q-dedup");
    const at = new Date().toISOString();
    const first = handleInboxTask(root, { id: "t1", text: "Ship the fix", at, runId }, () => undefined);
    assert.ok(first, "first filing writes the file");
    const second = handleInboxTask(root, { id: "t2", text: "Ship the fix", at, runId }, () => undefined);
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
    const runId = writeCtoFixture(root, "run-q-reject");
    const at = new Date().toISOString();

    const empty = handleInboxTask(root, { id: "t-empty", text: "   ", at, runId }, () => undefined);
    assert.equal(empty, null, "whitespace-only text rejected");
    const oversized = handleInboxTask(root, { id: "t-big", text: "x".repeat(MAX_INBOX_TEXT_LENGTH + 1), at, runId }, () => undefined);
    assert.equal(oversized, null, "oversized text rejected");
    const boundary = handleInboxTask(root, { id: "t-max", text: "x".repeat(MAX_INBOX_TEXT_LENGTH), at, runId }, () => undefined);
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
    const runId = writeCtoFixture(root, "run-q-admit");
    handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString(), runId }, () => undefined);
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string }>;
    };
    const record = state.inbox_quarantine?.[sha256Hex("Do the thing")];
    assert.equal(record?.status, "admitted", "status flips to admitted once the file is durable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine keeps an ambiguous wake durable without retry", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-wake-"));
  try {
    const runId = writeCtoFixture(root, "run-q-wake");
    let calls = 0;
    const onTask = () => {
      calls += 1;
      throw new Error("wake result unknown after host invocation");
    };
    const task = { id: "t1", text: "Do the thing", at: new Date().toISOString(), runId };
    const path = handleInboxTask(root, task, onTask);
    assert.ok(path, "ambiguous wake retains durable work");
    assert.equal(calls, 1, "host wake invoked once");
    assert.equal(existsSync(path!), true, "inbox file remains durable");
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      inbox_quarantine?: Record<string, { status?: string }>;
    };
    assert.equal(state.inbox_quarantine?.[sha256Hex("Do the thing")]?.status, "admitted");

    const retry = handleInboxTask(root, task, onTask);
    assert.equal(retry, null, "ambiguous work is not retried as a new admission");
    assert.equal(calls, 1, "host wake is not repeated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-safety: quarantine keeps inbox text as data — filed JSON is exactly { ...task, runId }", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-q-data-"));
  try {
    const runId = writeCtoFixture(root, "run-q-data");
    const task = { id: "t1", text: "rm -rf / && echo injected", at: new Date().toISOString(), by: "telegram", runId };
    const path = handleInboxTask(root, task, () => undefined);
    assert.ok(path, "task filed");
    const parsed = JSON.parse(readFileSync(path!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      parsed,
      task,
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
