/**
 * SEC-1 regression: Telegram inbound must authorize the configured chat/sender
 * before accepting escalation answers (callback / reply) or plain CTO task
 * messages. Unauthorized updates are dropped at the boundary — no answer file,
 * no onPlainMessage wake — while the getUpdates offset still advances.
 *
 * Conventions follow telegram-bridge.test.ts: node:test, assert/strict,
 * mkdtempSync fixtures, injectable fetchImpl, rmSync in finally. No network,
 * no sleeps, no globalThis mutation outside try/finally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramEscalationAdapter } from "../src/adapters/telegram.js";
import { createEscalationAdapter } from "../src/adapters/registry.js";
import type { Escalation, EscalationAnswer } from "@andvl1/omp-workflows-core";

/** Absolute path of the answer file the adapter writes for an escId. */
function answerPath(root: string, escId: string): string {
  const runId = escId.split("/")[0] ?? escId;
  const fileName = escId.replace(/[^a-zA-Z0-9-_]/g, "-");
  return join(root, ".work-state", "cto", runId, "answers", `${fileName}.json`);
}

/** Response-shaped object the adapter's api() accepts (checks ok + json()). */
function okResponse(result: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as unknown as Response;
}

/**
 * Mock fetch: `updates` may be a static array (returned on every call) or a
 * function producing the next round. `onGetUpdates` receives the offset sent
 * in each getUpdates payload — used to prove offset advancement.
 */
function mockFetch(updates: unknown[] | (() => unknown[]), onGetUpdates?: (offset: number) => void): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (onGetUpdates && String(url).endsWith("/getUpdates") && init?.body) {
      onGetUpdates((JSON.parse(String(init.body)) as { offset: number }).offset);
    }
    const result = typeof updates === "function" ? updates() : updates;
    return okResponse(result);
  }) as typeof fetch;
}

const CONFIGURED_CHAT = "12345";

// 1. Unauthorized callback dropped, offset still advances, authorized
//    follow-up in the same round is processed.
test("auth: unauthorized callback is dropped (no file, no handler) and the offset advances past it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-1-"));
  const calls: string[] = [];
  try {
    let round = 0;
    const rounds = () => (round++ === 0 ? [
      {
        update_id: 1,
        callback_query: { id: "cq1", from: { id: 111 }, message: { message_id: 10, chat: { id: 999 } }, data: "run-sec1/esc-1::yes" },
      },
      {
        update_id: 2,
        callback_query: { id: "cq2", from: { id: 111 }, message: { message_id: 11, chat: { id: Number(CONFIGURED_CHAT) } }, data: "run-sec1/esc-1::no" },
      },
    ] : []);
    const offsets: number[] = [];
    const adapter = new TelegramEscalationAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: mockFetch(rounds, (offset) => offsets.push(offset)),
      onPlainMessage: (m) => calls.push(m.text),
    });
    await adapter.pollOnce();
    assert.equal(calls.length, 0, "callback path never wakes onPlainMessage");
    const file = answerPath(root, "run-sec1/esc-1");
    assert.equal(existsSync(file), true, "authorized follow-up in the same round was still processed");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { id: string; answer: string };
    assert.equal(saved.id, "run-sec1/esc-1");
    assert.equal(saved.answer, "no", "only the authorized callback's answer was written");
    // Second round: the getUpdates payload must request offset 3
    // (max(1+1, 2+1)) — the rejected update 1 was consumed, not stuck.
    await adapter.pollOnce();
    assert.deepEqual(offsets, [0, 3], "offset advanced past the rejected update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2. Legacy preserved: callback from the configured chatId, no allowlist.
test("auth: callback answer from the configured chatId writes the answer file exactly as before", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-2-"));
  try {
    const updates = [
      {
        update_id: 5,
        callback_query: { id: "cq1", from: { id: 111 }, message: { message_id: 20, chat: { id: Number(CONFIGURED_CHAT) } }, data: "run-sec1/esc-1::yes" },
      },
    ];
    const adapter = new TelegramEscalationAdapter({ token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch(updates) });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 1);
    const file = answerPath(root, "run-sec1/esc-1");
    assert.equal(existsSync(file), true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { id: string; answer: string; by: string; at: string };
    assert.equal(saved.id, "run-sec1/esc-1", "escId/answer mapping preserved");
    assert.equal(saved.answer, "yes");
    assert.equal(saved.by, "telegram:callback");
    assert.equal(typeof saved.at, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 3. Plain task from an unauthorized chat -> no CTO wake.
test("auth: plain task from an unauthorized chat does not call onPlainMessage", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-3-"));
  const calls: string[] = [];
  try {
    const updates = [
      { update_id: 7, message: { message_id: 1, text: "run the deploy", chat: { id: 999 }, from: { id: 111 } } },
    ];
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch(updates),
      onPlainMessage: (m) => calls.push(m.text),
    });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 0);
    assert.equal(calls.length, 0, "no CTO wake for an unauthorized chat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 4. Plain task from the configured chat -> legacy wake preserved.
test("auth: plain task from the configured chat calls onPlainMessage with { id, text, at }", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-4-"));
  const calls: Array<{ id: string; text: string; at: string }> = [];
  try {
    const updates = [
      { update_id: 8, message: { message_id: 3, text: "run the deploy", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
    ];
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch(updates),
      onPlainMessage: (m) => calls.push(m),
    });
    await adapter.pollOnce();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "tg:3");
    assert.equal(calls[0].text, "run the deploy");
    assert.equal(typeof calls[0].at, "string");
    assert.ok(!Number.isNaN(Date.parse(calls[0].at)), "at is an ISO timestamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 5. Reply-to-escalation answers gated by chat (unauthorized -> no file,
//    configured -> file with the reply text). Map file crafted like recordMapping.
test("auth: reply-to-escalation answers are gated by chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-5-"));
  try {
    const mapDir = join(root, ".work-state", "cto", "run-sec1");
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, "tg-map.jsonl"), `${JSON.stringify({ escId: "run-sec1/esc-1", messageId: 100 })}\n`);

    const unauthorized = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      fetchImpl: mockFetch([
        { update_id: 1, message: { message_id: 11, text: "no", reply_to_message: { message_id: 100 }, chat: { id: 999 }, from: { id: 111 } } },
      ]),
    });
    await unauthorized.pollOnce();
    assert.equal(existsSync(answerPath(root, "run-sec1/esc-1")), false, "unauthorized chat reply produces no answer file");

    const authorized = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      fetchImpl: mockFetch([
        { update_id: 1, message: { message_id: 11, text: "yes, approved", reply_to_message: { message_id: 100 }, chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
      ]),
    });
    await authorized.pollOnce();
    const saved = JSON.parse(readFileSync(answerPath(root, "run-sec1/esc-1"), "utf8")) as { id: string; answer: string; by: string };
    assert.equal(saved.id, "run-sec1/esc-1");
    assert.equal(saved.answer, "yes, approved", "configured-chat reply written with the reply text");
    assert.equal(saved.by, "telegram:reply");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 6. allowedSenderIds: non-listed sender rejected, listed sender accepted
//    inside the allowed chat.
test("auth: allowedSenderIds restricts senders inside the allowed chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-6-"));
  const calls: Array<{ id: string; text: string; at: string }> = [];
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, allowedSenderIds: ["42"],
      fetchImpl: mockFetch([
        { update_id: 1, message: { message_id: 1, text: "hi", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 7 } } },
        { update_id: 2, message: { message_id: 2, text: "hi", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 42 } } },
      ]),
      onPlainMessage: (m) => calls.push(m),
    });
    await adapter.pollOnce();
    assert.equal(calls.length, 1, "only the listed sender's message is accepted");
    assert.equal(calls[0].id, "tg:2");
    assert.equal(calls[0].text, "hi");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 7. allowedChatIds extends (never replaces) the configured chatId.
test("auth: allowedChatIds extends the allowlist; configured chatId stays allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-7-"));
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, allowedChatIds: ["999"],
      fetchImpl: mockFetch([
        { update_id: 1, callback_query: { id: "cq1", from: { id: 111 }, message: { message_id: 30, chat: { id: 555 } }, data: "run-sec1/esc-1::no" } },
        { update_id: 2, callback_query: { id: "cq2", from: { id: 111 }, message: { message_id: 31, chat: { id: 999 } }, data: "run-sec1/esc-2::yes" } },
        { update_id: 3, callback_query: { id: "cq3", from: { id: 111 }, message: { message_id: 32, chat: { id: Number(CONFIGURED_CHAT) } }, data: "run-sec1/esc-3::no" } },
      ]),
    });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 2, "only the allowlisted extra chat and the configured chat are accepted");
    assert.equal(existsSync(answerPath(root, "run-sec1/esc-1")), false, "chat outside the allowlist rejected");
    const esc2 = JSON.parse(readFileSync(answerPath(root, "run-sec1/esc-2"), "utf8")) as { answer: string };
    const esc3 = JSON.parse(readFileSync(answerPath(root, "run-sec1/esc-3"), "utf8")) as { answer: string };
    assert.equal(esc2.answer, "yes", "extra allowlisted chat accepted");
    assert.equal(esc3.answer, "no", "configured chat still accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 8. Fail closed: no chat.id, or no sender under a sender allowlist, rejects.
test("auth: fail closed on missing chat.id / missing sender with allowedSenderIds set", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-8-"));
  const calls: Array<{ id: string; text: string; at: string }> = [];
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, allowedSenderIds: ["42"],
      fetchImpl: mockFetch([
        // message with text + from but NO chat.id -> rejected
        { update_id: 1, message: { message_id: 1, text: "hi", from: { id: 42 } } },
        // callback with data + message but NO chat.id -> rejected
        { update_id: 2, callback_query: { id: "cq1", from: { id: 42 }, message: { message_id: 2 }, data: "run-sec1/esc-1::yes" } },
        // plain message with chat but NO from.id while allowedSenderIds is set -> rejected
        { update_id: 3, message: { message_id: 3, text: "hi", chat: { id: Number(CONFIGURED_CHAT) } } },
        // fully-shaped control: listed sender in configured chat -> accepted
        { update_id: 4, message: { message_id: 4, text: "ok", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 42 } } },
      ]),
      onPlainMessage: (m) => calls.push(m),
    });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 0, "no answer written for provenance-less updates");
    assert.equal(calls.length, 1, "only the fully-shaped control message wakes the handler");
    assert.equal(calls[0].id, "tg:4");
    assert.equal(existsSync(answerPath(root, "run-sec1/esc-1")), false, "no answer file from the chat-less callback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 9. Registry seam: allowedSenderIds flows from EscalationConfig into the
//    telegram adapter factory.
test("auth: registry passes allowedSenderIds through to the telegram adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-9-"));
  const calls: Array<{ id: string; text: string; at: string }> = [];
  const realFetch = globalThis.fetch;
  try {
    // The telegram factory omits fetchImpl, so the adapter resolves `fetch`
    // at construction — the stub must be in place before createEscalationAdapter.
    const updates = [
      { update_id: 1, message: { message_id: 1, text: "hi", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 7 } } },
      { update_id: 2, message: { message_id: 2, text: "hi", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 42 } } },
    ];
    (globalThis as { fetch: typeof fetch }).fetch = mockFetch(updates);
    const adapter = createEscalationAdapter(
      { adapter: "telegram", telegram: { token: "t", chatId: CONFIGURED_CHAT, allowedSenderIds: ["42"] } },
      root,
    );
    assert.ok(adapter, "registry builds a non-null telegram adapter");
    // The telegram factory returns TelegramEscalationAdapter; narrow to the
    // concrete type to reach the optional inbound surface.
    const tg = adapter as TelegramEscalationAdapter;
    tg.setPlainMessageHandler((m) => calls.push(m));
    await tg.pollOnce();
    assert.equal(calls.length, 1, "sender 7 rejected, sender 42 accepted through the registry seam");
    assert.equal(calls[0].id, "tg:2");
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

// 10. SEC-001: malformed callback escIds (path traversal shapes) are dropped
//     before any write — no file outside the run answers dir — the offset
//     still advances, and a valid callback in the same round writes exactly
//     as before. Fails on the original code: the traversal shapes wrote files
//     (e.g. <root>/.work-state/answers/------.json from "../../::yes").
test("sec001: malformed callback escIds are dropped (no file outside the run answers dir), offset advances, valid callback still writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec001-10-"));
  try {
    const malformed = ["../../::yes", "..\\..::yes", "C:\\evil::yes", "/abs/path::yes", "a//b::yes", "...::yes"];
    const updates = [
      ...malformed.map((data, i) => ({
        update_id: i + 1,
        callback_query: {
          id: `cq-m${i}`,
          from: { id: 111 },
          message: { message_id: 10 + i, chat: { id: Number(CONFIGURED_CHAT) } },
          data,
        },
      })),
      {
        update_id: 7,
        callback_query: {
          id: "cq-ok",
          from: { id: 111 },
          message: { message_id: 20, chat: { id: Number(CONFIGURED_CHAT) } },
          data: "run-sec1/esc-1::no",
        },
      },
    ];
    let round = 0;
    const rounds = () => (round++ === 0 ? updates : []);
    const offsets: number[] = [];
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      fetchImpl: mockFetch(rounds, (offset) => offsets.push(offset)),
    });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 1, "only the valid callback produced an answer");
    const file = answerPath(root, "run-sec1/esc-1");
    assert.equal(existsSync(file), true, "valid callback in the same round still writes");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { id: string; answer: string; by: string; at: string };
    assert.equal(saved.id, "run-sec1/esc-1");
    assert.equal(saved.answer, "no");
    assert.equal(saved.by, "telegram:callback");
    assert.equal(typeof saved.at, "string");
    // No write escaped the run answers dir (each assertion fails on the
    // original code, which created these paths):
    assert.equal(existsSync(join(root, ".work-state", "answers")), false, "no ../.. escape to .work-state/answers");
    assert.equal(existsSync(join(root, ".work-state", "cto", "answers")), false, "no empty-runId write to cto/answers");
    assert.equal(existsSync(join(root, ".work-state", "cto", "a")), false, "no a//b runId write");
    assert.equal(existsSync(join(root, ".work-state", "cto", "...")), false, "no ... runId write");
    assert.equal(existsSync(join(root, ".work-state", "cto", "..\\..")), false, "no backslash runId write");
    assert.equal(existsSync(join(root, ".work-state", "cto", "C:\\evil")), false, "no drive-path runId write");
    // Second round: getUpdates asks for offset 8 (max(1..7)+1) — the dropped
    // updates were consumed, not stuck.
    await adapter.pollOnce();
    assert.deepEqual(offsets, [0, 8], "offset advanced past every dropped callback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 11. SEC-001: a poisoned tg-map.jsonl escId on the reply path cannot write
//     outside the cto root (fail-closed throw at the write boundary); a valid
//     map entry in the same test still writes, mapping preserved. Fails on the
//     original code: the poisoned reply wrote <root>/.work-state/answers/ and
//     pollOnce resolved instead of rejecting.
test("sec001: poisoned tg-map.jsonl escId on the reply path cannot write outside the cto root; valid map entry still writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec001-11-"));
  try {
    const mapDir = join(root, ".work-state", "cto", "run-sec1");
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, "tg-map.jsonl"), [
      JSON.stringify({ escId: "../../poison", messageId: 100 }),
      JSON.stringify({ escId: "run-sec1/esc-2", messageId: 101 }),
      "",
    ].join("\n"));
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      fetchImpl: mockFetch([
        // valid entry first — written before the poisoned one throws
        { update_id: 1, message: { message_id: 12, text: "approved", reply_to_message: { message_id: 101 }, chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
        { update_id: 2, message: { message_id: 13, text: "evil", reply_to_message: { message_id: 100 }, chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
      ]),
    });
    await assert.rejects(
      () => adapter.pollOnce(),
      /writeAnswer rejected unsafe runId/,
      "poisoned map escId fails closed at the write boundary",
    );
    // Valid map entry still wrote with the reply text, mapping preserved:
    const saved = JSON.parse(readFileSync(answerPath(root, "run-sec1/esc-2"), "utf8")) as { id: string; answer: string; by: string };
    assert.equal(saved.id, "run-sec1/esc-2");
    assert.equal(saved.answer, "approved");
    assert.equal(saved.by, "telegram:reply");
    // No write outside the cto root:
    assert.equal(existsSync(join(root, ".work-state", "answers")), false, "no ../.. escape on the reply path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 12. SEC-001: the writeAnswer boundary rejects traversal ids directly and
//     creates NOTHING (no mkdir side effect). Fails on the original code:
//     "../.." resolved to <root>/.work-state/answers and wrote a file.
test("sec001: writeAnswer rejects traversal ids and creates nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec001-12-"));
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch([]),
    });
    const writer = adapter as unknown as { writeAnswer(a: EscalationAnswer): EscalationAnswer };
    for (const id of ["../..", "..\\..", "C:\\x", "..", "/abs"]) {
      assert.throws(
        () => writer.writeAnswer({ id, answer: "x", at: new Date().toISOString(), by: "test" }),
        /writeAnswer rejected unsafe runId/,
        `writeAnswer must reject id ${JSON.stringify(id)}`,
      );
    }
    // Nothing created anywhere under the fixture root:
    assert.equal(existsSync(join(root, ".work-state")), false, "no mkdir side effect on malformed input");
    assert.equal(existsSync(join(root, ".work-state", "answers")), false, "no traversal escape target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 13. SEC-002: send() failure must never leak the bot token into channelRef.
//     node-fetch v2 style TypeErrors embed the request URL (incl. bot<TOKEN>).
//     Fails on the original code: channelRef was the raw error message.
test("sec002: send failure channelRef never leaks the bot token (fetch rejection)", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec002-13-"));
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "123456:SUPERSECRETTOKEN",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: (async () => {
        throw new TypeError("request to https://api.telegram.org/bot123456:SUPERSECRETTOKEN/sendMessage failed, reason: connect ECONNREFUSED");
      }) as typeof fetch,
    });
    const esc: Escalation = { id: "run-sec1/esc-1", level: "decision", title: "Approve?", body: "Please approve" };
    const receipt = await adapter.send(esc);
    assert.equal(receipt.sent, false);
    assert.equal(receipt.channelRef, "tg:sendMessage:failed", "safe marker replaces the raw fetch error");
    assert.ok(!(receipt.channelRef ?? "").includes("SUPERSECRETTOKEN"), "bot token must not appear in channelRef");
    assert.equal(existsSync(join(root, ".work-state", "cto", "run-sec1", "tg-map.jsonl")), false, "no mapping recorded for a failed send");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 14. SEC-002: non-ok HTTP response -> token-free http-<status> failure ref.
//     Fails on the original code: channelRef was "telegram sendMessage -> 500".
test("sec002: non-ok response yields a token-free http-status failure ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec002-14-"));
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "123456:SUPERSECRETTOKEN",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch,
    });
    const esc: Escalation = { id: "run-sec1/esc-1", level: "decision", title: "Approve?", body: "Please approve" };
    const receipt = await adapter.send(esc);
    assert.equal(receipt.sent, false);
    assert.equal(receipt.channelRef, "tg:sendMessage:http-500", "adapter-constructed HTTP error becomes a token-free status ref");
    assert.ok(!(receipt.channelRef ?? "").includes("SUPERSECRETTOKEN"), "bot token must not appear in channelRef");
    assert.equal(existsSync(join(root, ".work-state", "cto", "run-sec1", "tg-map.jsonl")), false, "no mapping recorded for a failed send");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 15. SEC-002: sendPlainText failure is token-free too (same leak shape, same
//     helper). Fails on the original code: channelRef was the raw error message.
test("sec002: sendPlainText rejection channelRef is token-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec002-15-"));
  try {
    const adapter = new TelegramEscalationAdapter({
      token: "123456:SUPERSECRETTOKEN",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: (async () => {
        throw new TypeError("request to https://api.telegram.org/bot123456:SUPERSECRETTOKEN/sendMessage failed, reason: connect ECONNREFUSED");
      }) as typeof fetch,
    });
    const receipt = await adapter.sendPlainText(CONFIGURED_CHAT, "hi");
    assert.equal(receipt.sent, false);
    assert.equal(receipt.channelRef, "tg:sendMessage:failed", "safe marker replaces the raw fetch error");
    assert.ok(!(receipt.channelRef ?? "").includes("SUPERSECRETTOKEN"), "bot token must not appear in channelRef");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
