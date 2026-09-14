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
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramEscalationAdapter, TelegramMappingRecoveryRequiredError } from "../src/adapters/telegram.js";
import { createEscalationAdapter as createEscalationAdapterRaw, createChannelSet as createChannelSetRaw } from "../src/adapters/registry.js";
import { openFullstackRuntimeTest, type FullstackRuntimeTestFixture } from "./runtime-access-fixture.js";

const runtimeFixtures = new Map<string, FullstackRuntimeTestFixture>();
function runtimeFixtureFor(root: string): FullstackRuntimeTestFixture {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const fixture = openFullstackRuntimeTest(root, "telegram-auth-test");
  runtimeFixtures.set(root, fixture);
  return fixture;
}
function runtimeFor(root: string) { return runtimeFixtureFor(root).access; }
test.afterEach(() => {
  for (const fixture of runtimeFixtures.values()) fixture.close();
  runtimeFixtures.clear();
});

function createEscalationAdapter(...args: Parameters<typeof createEscalationAdapterRaw>): ReturnType<typeof createEscalationAdapterRaw> {
  const [config, root, pinnedRoot] = args;
  const fixture = runtimeFixtureFor(root);
  return createEscalationAdapterRaw(config, root, pinnedRoot, fixture.access, fixture.proofAuthority);
}
function telegramAdapter(options: ConstructorParameters<typeof TelegramEscalationAdapter>[0]): TelegramEscalationAdapter {
  const fixture = runtimeFixtureFor(options.cwd);
  return new TelegramEscalationAdapter({ ...options, runtimeAccess: options.runtimeAccess ?? fixture.access, proofAuthority: fixture.proofAuthority });
}
import { canonicalDurableIdFileName, PinnedProjectRoot, type Escalation, type EscalationAnswer, type EscalationReceipt } from "@andvl1/omp-workflows-core";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState, setCtoPause, writeCtoState, type CtoState } from "../../core/src/cto/state.js";

/** Absolute path of the answer file the adapter writes for an escId. */
function answerPath(root: string, escId: string): string {
  const runId = escId.split("/")[0] ?? escId;
  const fileName = canonicalDurableIdFileName(escId);
  return join(root, ".work-state", "cto", runId, "answers", fileName);
}
function withIndexedRun(root: string, runId: string): void {
  const fixture = runtimeFixtureFor(root);
  const runtime = fixture.access;
  const state = newCtoState({
    id: runId,
    task: "telegram auth",
    branch: "main",
    autonomous: true,
    owner_session: fixture.sessionId,
    plan: { id: runId, task: "telegram auth", teams: [], created_at: new Date().toISOString() },
  });
  assert.ok(runtime.createRun(state, { source_id: `telegram-auth:${runId}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) }));
  assert.equal(runtime.markDeliveryPending(runId, state.state_revision, "outbox"), true);
}
function migrateLegacy(adapter: TelegramEscalationAdapter, root: string, runId: string, chatId: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "fixture-token", chatId } }));
  const pin = PinnedProjectRoot.open(root);
  assert.ok(pin, "migration fixture root is pinnable");
  try { adapter.migrateLegacyMappings(runId, chatId, pin); } finally { pin.close(); }
}
function withIndexedMapping(root: string, runId: string, escId: string, messageId: number, chatId = CONFIGURED_CHAT): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  const configPath = join(root, ".omp", "escalation.json");
  if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ adapter: "telegram", telegram: { token: "fixture-token", chatId, allowedChatIds: [chatId, "999"] } }));
  if (!existsSync(join(root, ".work-state", "cto", runId, "state.json"))) withIndexedRun(root, runId);
  const adapter = telegramAdapter({ token: "fixture-token", chatId, cwd: root });
  const recordMapping = (adapter as unknown as {
    recordMapping(escId: string, messageId: number, esc: Escalation, receipt: EscalationReceipt): void;
  }).recordMapping;
  recordMapping.call(adapter, escId, messageId, {
    id: escId,
    level: "question",
    title: "Fixture escalation",
    body: "Fixture body",
  }, { sent: true, channelRef: `tg:${messageId}` });
}
function mappingShardPath(root: string, runId: string, chatId: string): string {
  const partition = createHash("sha256").update("telegram-chat-mapping\u0000", "utf8").update(chatId, "utf8").digest("hex");
  const directory = join(root, ".work-state", "cto", runId, "telegram-callbacks", partition);
  const shard = readdirSync(directory).find((name) => name.startsWith("tg-map") && name.endsWith(".jsonl"));
  assert.ok(shard, "mapping shard exists");
  return join(directory, shard);
}
function writeLegacyMappingLock(root: string, tenant: string, chatId: string, owner: string, expiresAt: number): string {
  const path = join(root, ".work-state", "cto", tenant, "tg-map.lock.json");
  mkdirSync(join(root, ".work-state", "cto", tenant), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, tenant, chatId, owner, expiresAt }));
  return path;
}

/** Real streamed Response used by the adapter's bounded API reader. */
function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
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
    withIndexedMapping(root, "run-sec1", "run-sec1/esc-1", 11);
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
    const adapter = telegramAdapter({
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
    withIndexedMapping(root, "run-sec1", "run-sec1/esc-1", 20);
    const updates = [
      {
        update_id: 5,
        callback_query: { id: "cq1", from: { id: 111 }, message: { message_id: 20, chat: { id: Number(CONFIGURED_CHAT) } }, data: "run-sec1/esc-1::yes" },
      },
    ];
    const adapter = telegramAdapter({ token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch(updates) });
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
    const adapter = telegramAdapter({
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
    const adapter = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch(updates),
      onPlainMessage: (m) => calls.push(m),
    });
    await adapter.pollOnce();
    assert.equal(calls.length, 1);
    assert.match(calls[0].id, /^tg-[0-9a-f]{64}$/u, "plain task id is a chat-scoped canonical token");
    assert.equal(calls[0].text, "run the deploy");
    assert.equal(typeof calls[0].at, "string");
    assert.ok(!Number.isNaN(Date.parse(calls[0].at)), "at is an ISO timestamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth: plain task context preserves source chat and separates chat-scoped message IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-chat-context-"));
  const calls: Array<{ id: string; text: string; chatId: string; userId?: string; messageId: number }> = [];
  try {
    const updates = [
      { update_id: 80, message: { message_id: 7, text: "from primary", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
      { update_id: 81, message: { message_id: 7, text: "from allowed", chat: { id: 67890 }, from: { id: 222 } } },
    ];
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      allowedChatIds: ["67890"],
      cwd: root,
      fetchImpl: mockFetch(updates),
      onPlainMessage: (m) => calls.push(m),
    });
    await adapter.pollOnce();
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id, "same Telegram message_id in different chats has distinct task identity");
    assert.deepEqual(
      calls.map(({ chatId, userId, messageId }) => ({ chatId, userId, messageId })),
      [
        { chatId: CONFIGURED_CHAT, userId: "111", messageId: 7 },
        { chatId: "67890", userId: "222", messageId: 7 },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth: plain handler rejection leaves update unconfirmed for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-retry-"));
  const offsets: number[] = [];
  let rounds = 0;
  let fail = true;
  try {
    const update = { update_id: 19, message: { message_id: 4, text: "wake", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } };
    const adapter = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      fetchImpl: mockFetch(() => (rounds++ < 2 ? [update] : []), (offset) => offsets.push(offset)),
      onPlainMessage: async () => { if (fail) { fail = false; throw new Error("wake admission failed"); } },
    });
    await assert.rejects(adapter.pollOnce(), /wake admission failed/);
    await adapter.pollOnce();
    assert.deepEqual(offsets, [0, 0], "failed plain admission must not advance Telegram offset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 5. Reply-to-escalation answers gated by chat (unauthorized -> no file,
//    configured -> file with the reply text). Map file crafted like recordMapping.
test("auth: reply-to-escalation answers are gated by chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-5-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: CONFIGURED_CHAT } }));
    withIndexedRun(root, "run-sec1");
    const mapDir = join(root, ".work-state", "cto", "run-sec1");
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, "tg-map.jsonl"), `${JSON.stringify({ escId: "run-sec1/esc-1", messageId: 100 })}\n`);

    const unauthorized = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      fetchImpl: mockFetch([
        { update_id: 1, message: { message_id: 11, text: "no", reply_to_message: { message_id: 100 }, chat: { id: 999 }, from: { id: 111 } } },
      ]),
    });
    await unauthorized.pollOnce();
    assert.equal(existsSync(answerPath(root, "run-sec1/esc-1")), false, "unauthorized chat reply produces no answer file");

    const authorized = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      legacyMappingMigration: { tenant: "run-sec1", chatId: CONFIGURED_CHAT },
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
// A reply-shaped message with no routable target is not a plain CTO task.
// It surfaces retryable recovery and keeps the Telegram offset unconfirmed.
test("auth: stale or foreign replies require recovery instead of waking the plain handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-reply-target-"));
  const calls: Array<{ id: string; text: string; at: string }> = [];
  try {
    withIndexedRun(root, "run-sec2");
    const foreignPartition = createHash("sha256")
      .update("telegram-chat-mapping\u0000", "utf8")
      .update("999", "utf8")
      .digest("hex");
    const foreignMapDir = join(root, ".work-state", "cto", "run-sec2", "telegram-callbacks", foreignPartition);
    mkdirSync(foreignMapDir, { recursive: true });
    writeFileSync(join(foreignMapDir, "tg-map.meta.json"), JSON.stringify({ schema: 2, tenant: "run-sec2", chatId: "999" }));
    appendFileSync(join(foreignMapDir, "tg-map.jsonl"), `${JSON.stringify({ escId: "run-sec2/esc-foreign", messageId: 100, chatId: "999" })}\n`);
    const updates = [
      {
        update_id: 20,
        message: {
          message_id: 20,
          text: "stale reply",
          reply_to_message: { message_id: 999 },
          chat: { id: Number(CONFIGURED_CHAT) },
          from: { id: 111 },
        },
      },
      {
        update_id: 21,
        message: {
          message_id: 21,
          text: "foreign reply",
          reply_to_message: { message_id: 100 },
          chat: { id: Number(CONFIGURED_CHAT) },
          from: { id: 111 },
        },
      },
      {
        update_id: 22,
        message: { message_id: 22, text: "true plain task", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } },
      },
    ];
    const offsets: number[] = [];
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: mockFetch(updates, (offset) => offsets.push(offset)),
      onPlainMessage: (m) => calls.push(m),
    });
    await assert.rejects(adapter.pollOnce(), (error: unknown) => error instanceof TelegramMappingRecoveryRequiredError
      && error.code === "telegram_mapping_recovery_required" && error.messageId === 999);
    assert.deepEqual(offsets, [0], "recovery leaves the Telegram update offset unconfirmed");
    assert.equal(existsSync(answerPath(root, "run-sec2/esc-foreign")), false, "foreign reply produces no answer file");
    assert.equal(calls.length, 0, "unresolved reply never wakes the plain handler");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping proof: separate sender and poller instances share the opaque authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-shared-map-key-"));
  const runId = "run-shared-map";
  const escId = `${runId}/team/check/1`;
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "fixture-token", chatId: CONFIGURED_CHAT } }));
    withIndexedRun(root, runId);
    let outbound: Record<string, unknown> | null = null;
    const sender = telegramAdapter({
      token: "sender-token",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okResponse({ message_id: 77 });
      }) as typeof fetch,
    });
    const escalation = { id: escId, level: "question" as const, title: "Shared", body: "Key" };
    assert.equal((await sender.send(escalation)).sent, true);
    assert.ok(typeof outbound?.text === "string" && outbound.text.includes("omp-escalation-ref"), "outbound text carries canonical marker");

    const reply = (text: string) => [{
      update_id: 1,
      message: {
        message_id: 78,
        text,
        reply_to_message: { message_id: 77, text: String(outbound?.text) },
        chat: { id: Number(CONFIGURED_CHAT) },
        from: { id: 111 },
      },
    }];
    const accepted = telegramAdapter({
      token: "poller-token",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: mockFetch(reply("approved")),
    });
    const answers = await accepted.pollOnce();
    assert.equal(answers[0]?.id, escId, "shared key authorizes the persisted mapping in a separate adapter instance");
    assert.equal(answers[0]?.answer, "approved");

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
    const adapter = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, allowedSenderIds: ["42"],
      fetchImpl: mockFetch([
        { update_id: 1, message: { message_id: 1, text: "hi", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 7 } } },
        { update_id: 2, message: { message_id: 2, text: "hi", chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 42 } } },
      ]),
      onPlainMessage: (m) => calls.push(m),
    });
    await adapter.pollOnce();
    assert.equal(calls.length, 1, "only the listed sender's message is accepted");
    assert.match(calls[0].id, /^tg-[0-9a-f]{64}$/u);
    assert.equal(calls[0].text, "hi");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 7. allowedChatIds extends (never replaces) the configured chatId.
test("auth: allowedChatIds extends the allowlist; configured chatId stays allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-7-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "fixture-token", chatId: CONFIGURED_CHAT, allowedChatIds: [999] } }));
    withIndexedMapping(root, "run-sec1", "run-sec1/esc-2", 31, "999");
    withIndexedMapping(root, "run-sec1", "run-sec1/esc-3", 32, CONFIGURED_CHAT);
    const adapter = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, allowedChatIds: [999],
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

test("auth: terminal callback and reply redelivery advances offset without answer or marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-terminal-"));
  const runId = "run-sec-terminal";
  const callbackEscId = `${runId}/team-a/callback`;
  const replyEscId = `${runId}/team-a/reply`;
  const offsets: number[] = [];
  let round = 0;
  try {
    withIndexedMapping(root, runId, callbackEscId, 41);
    withIndexedMapping(root, runId, replyEscId, 42);
    const statePath = join(root, ".work-state", "cto", runId, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as CtoState;
    assert.ok(state);
    setCtoPause(state, "done", "terminal before Telegram redelivery");
    writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: mockFetch(() => round++ === 0 ? [
        { update_id: 1, callback_query: { id: "cq-terminal", from: { id: 111 }, message: { message_id: 41, chat: { id: Number(CONFIGURED_CHAT) } }, data: `${callbackEscId}::yes` } },
        { update_id: 2, message: { message_id: 43, text: "late reply", chat: { id: Number(CONFIGURED_CHAT) }, reply_to_message: { message_id: 42, chat: { id: Number(CONFIGURED_CHAT) } } } },
      ] : [], (offset) => offsets.push(offset)),
    });
    const answers = await adapter.pollOnce();
    assert.deepEqual(answers, [], "terminal callback/reply must be handled without answer wakes");
    assert.equal(existsSync(answerPath(root, callbackEscId)), false, "terminal callback must not create an answer");
    assert.equal(existsSync(answerPath(root, replyEscId)), false, "terminal reply must not create an answer");
    await adapter.pollOnce();
    assert.deepEqual(offsets, [0, 3], "handled terminal redeliveries advance the Telegram offset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth: standby mapping is stale and later Telegram update still commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-standby-"));
  const offsets: number[] = [];
  const tasks: string[] = [];
  let round = 0;
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "fixture-token", chatId: CONFIGURED_CHAT } }));
    const standbyRun = runtimeFor(root).ensureStandbyRun();
    const escId = `${standbyRun}/team-a/standby`;
    withIndexedMapping(root, standbyRun, escId, 51);
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: mockFetch(() => round++ === 0 ? [
        { update_id: 1, callback_query: { id: "cq-standby", from: { id: 111 }, message: { message_id: 51, chat: { id: Number(CONFIGURED_CHAT) } }, data: `${escId}::yes` } },
        { update_id: 2, message: { message_id: 52, text: "later task", chat: { id: Number(CONFIGURED_CHAT) } } },
      ] : [], (offset) => offsets.push(offset)),
      onPlainMessage: (message) => tasks.push(message.text),
    });
    const answers = await adapter.pollOnce();
    assert.deepEqual(answers, [], "standby mapping cannot wake a checkpoint");
    assert.equal(existsSync(answerPath(root, escId)), false, "standby mapping must not create an answer");
    assert.deepEqual(tasks, ["later task"], "the later update is processed after stale standby callback");
    await adapter.pollOnce();
    assert.deepEqual(offsets, [0, 3], "stale standby callback is committed before later update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 8. Fail closed: no chat.id, or no sender under a sender allowlist, rejects.
test("auth: fail closed on missing chat.id / missing sender with allowedSenderIds set", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-8-"));
  const calls: Array<{ id: string; text: string; at: string }> = [];
  try {
    const adapter = telegramAdapter({
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
    assert.match(calls[0].id, /^tg-[0-9a-f]{64}$/u);
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
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
      adapter: "telegram",
      telegram: { token: "t", chatId: CONFIGURED_CHAT, allowedSenderIds: ["42"] },
    }));
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
    assert.match(calls[0].id, /^tg-[0-9a-f]{64}$/u);
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
test("auth: factory Telegram adapter revokes polling after config rotation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-rotation-"));
  const configPath = join(root, ".omp", "escalation.json");
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ adapter: "telegram", telegram: { token: "old-token", chatId: CONFIGURED_CHAT } }));
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: unknown) => {
      fetchCalls += 1;
      assert.match(String(url), /botold-token\/getUpdates/u);
      return okResponse([]);
    }) as typeof fetch;
    const adapter = createEscalationAdapter({ adapter: "telegram", telegram: { token: "old-token", chatId: CONFIGURED_CHAT } }, root);
    assert.ok(adapter, "factory creates the resident Telegram adapter");
    const telegram = adapter as TelegramEscalationAdapter;
    await telegram.pollOnce();
    assert.equal(fetchCalls, 1, "unchanged authenticated config remains live");

    writeFileSync(configPath, JSON.stringify({ adapter: "telegram", telegram: { token: "new-token", chatId: "67890" } }));
    await assert.rejects(telegram.pollOnce(), /activation|routing|changed|live/i, "rotated config revokes the old adapter before its next fetch");
    assert.equal(fetchCalls, 1, "rotated config must not fetch with the old token");
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth: registry rejects Telegram construction when routing rotates during factory access", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-construction-race-"));
  const configPath = join(root, ".omp", "escalation.json");
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let tokenReads = 0;
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const oldConfig = { adapter: "telegram", telegram: { token: "old-token", chatId: CONFIGURED_CHAT } };
    const newConfig = { adapter: "telegram", telegram: { token: "new-token", chatId: "67890" } };
    writeFileSync(configPath, JSON.stringify(oldConfig));
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      fetchCalls += 1;
      return okResponse([]);
    }) as typeof fetch;
    const fixture = runtimeFixtureFor(root);
    const config = {
      adapter: "telegram",
      telegram: {
        chatId: CONFIGURED_CHAT,
        get token(): string {
          tokenReads += 1;
          if (tokenReads === 2) writeFileSync(configPath, JSON.stringify(newConfig));
          return "old-token";
        },
      },
    } as Parameters<typeof createEscalationAdapterRaw>[0];
    const adapter = createEscalationAdapterRaw(config, root, undefined, fixture.access, fixture.proofAuthority);
    assert.equal(adapter, null, "construction must fail closed when routing rotates during factory access");
    assert.ok(tokenReads >= 2, "factory must read the supplied credential after guard capture");
    assert.equal(fetchCalls, 0, "a rejected construction must not expose an adapter that can fetch with old credentials");
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth: explicit Telegram channel IDs normalize whitespace consistently", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-channel-id-whitespace-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const config = {
      channels: [{
        id: " primary ",
        adapter: "telegram",
        direction: "read-write",
        primary: true,
        telegram: { token: "t", chatId: CONFIGURED_CHAT },
      }],
    };
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
    const fixture = runtimeFixtureFor(root);
    const set = createChannelSetRaw(root, undefined, undefined, fixture.access, fixture.proofAuthority);
    assert.ok(set.primary, "whitespace-padded explicit Telegram ID still constructs its guarded primary");
    assert.equal(set.profile.id, "primary", "normalized profile identity is used for selection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth: registry rejects malformed Telegram allowlists", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-auth-9b-"));
  try {
    const malformedConfigs: unknown[] = [
      { adapter: "telegram", telegram: { token: "t", chatId: CONFIGURED_CHAT, allowedSenderIds: [true] } },
      { adapter: "telegram", telegram: { token: "t", chatId: CONFIGURED_CHAT, allowedSenderIds: ["42", "42"] } },
      { adapter: "telegram", telegram: { token: "t", chatId: CONFIGURED_CHAT, allowedChatIds: ["7", "7"] } },
    ];
    mkdirSync(join(root, ".omp"), { recursive: true });
    for (const raw of malformedConfigs) {
      const config = raw as Parameters<typeof createEscalationAdapter>[0];
      writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(raw));
      assert.equal(createEscalationAdapter(config, root), null, "malformed allowlist fails closed");
    }
  } finally {
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
    withIndexedMapping(root, "run-sec1", "run-sec1/esc-1", 20);
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
    const adapter = telegramAdapter({
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
// outside the cto root. The complete mapping snapshot fails closed, so even a
// valid entry in the same corrupted shard is not trusted.
test("sec001: poisoned tg-map.jsonl escId on the reply path fails closed without writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec001-11-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: CONFIGURED_CHAT } }));
    withIndexedRun(root, "run-sec1");
    const mapDir = join(root, ".work-state", "cto", "run-sec1");
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, "tg-map.jsonl"), [
      JSON.stringify({ escId: "../../poison", messageId: 100 }),
      JSON.stringify({ escId: "run-sec1/esc-2", messageId: 101 }),
      "",
    ].join("\n"));
    const adapter = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root,
      legacyMappingMigration: { tenant: "run-sec1", chatId: CONFIGURED_CHAT },
      fetchImpl: mockFetch([
        { update_id: 1, message: { message_id: 12, text: "approved", reply_to_message: { message_id: 101 }, chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
        { update_id: 2, message: { message_id: 13, text: "evil", reply_to_message: { message_id: 100 }, chat: { id: Number(CONFIGURED_CHAT) }, from: { id: 111 } } },
      ]),
    });
    await assert.rejects(adapter.pollOnce(), (error: unknown) => error instanceof TelegramMappingRecoveryRequiredError
      && error.code === "telegram_mapping_recovery_required" && error.messageId === 101, "poisoned mapping requires retryable recovery");
    assert.equal(existsSync(answerPath(root, "run-sec1/esc-2")), false, "valid records in a poisoned shard are not trusted");
    assert.equal(existsSync(answerPath(root, "run-sec1/../../poison")), false, "poisoned mapping cannot escape the run answers dir");
    assert.equal(existsSync(join(root, ".work-state", "answers")), false, "no ../.. escape on the reply path");
    assert.equal(existsSync(join(root, ".work-state", "cto", "answers")), false, "no empty-runId write on the reply path");
    assert.equal(existsSync(join(root, ".work-state", "cto", "run-sec1", "answers")), false, "no answer is written from a corrupted mapping");
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
    const adapter = telegramAdapter({
      token: "t", chatId: CONFIGURED_CHAT, cwd: root, fetchImpl: mockFetch([]),
    });
    const writer = adapter as unknown as { writeAnswer(a: EscalationAnswer): EscalationAnswer };
    for (const id of ["../..", "..\\..", "C:\\x", "..", "/abs"]) {
      assert.throws(
        () => writer.writeAnswer({ id, run_id: "run-sec1", answer: "x", at: new Date().toISOString(), by: "test" }),
        /writeAnswer rejected unsafe answer id/,
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
    const adapter = telegramAdapter({
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
    const adapter = telegramAdapter({
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
    const adapter = telegramAdapter({
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

test("sec002: API error codes classify HTTP-200 Telegram failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "tg-sec002-api-code-"));
  try {
    let mode: "forbidden" | "rate-limit" = "forbidden";
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      fetchImpl: (async () => new Response(JSON.stringify(mode === "forbidden" ? { ok: false, error_code: 403, description: "blocked" } : { ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 200 })) as typeof fetch,
    });
    const permanent = await adapter.sendPlainText(CONFIGURED_CHAT, "blocked");
    assert.deepEqual(permanent, { sent: false, status: "permanent", channelRef: "tg:sendMessage:api-403", httpStatus: 403, reason: "Telegram rejected the reply (HTTP 403)" });
    mode = "rate-limit";
    const retryable = await adapter.sendPlainText(CONFIGURED_CHAT, "retry");
    assert.equal(retryable.sent, false);
    assert.equal(retryable.status, "retryable");
    assert.equal(retryable.channelRef, "tg:sendMessage:api-429");
    assert.equal(retryable.httpStatus, 429);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping migration: metadata-free legacy source is scoped and retryable after partial cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-map-migration-"));
  const runId = "run-migration";
  const escId = `${runId}/esc-1`;
  const legacyDir = join(root, ".work-state", "cto", runId);
  try {
    withIndexedRun(root, runId);
    mkdirSync(legacyDir, { recursive: true });
    const legacyLine = `${JSON.stringify({ escId, messageId: 73 })}\n`;
    writeFileSync(join(legacyDir, "tg-map.jsonl"), legacyLine);
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      legacyMappingMigration: { tenant: runId, chatId: CONFIGURED_CHAT },
      fetchImpl: mockFetch([]),
    });
    migrateLegacy(adapter, root, runId, CONFIGURED_CHAT);
    const partition = createHash("sha256")
      .update("telegram-chat-mapping\u0000", "utf8")
      .update(CONFIGURED_CHAT, "utf8")
      .digest("hex");
    const partitionDir = join(legacyDir, "telegram-callbacks", partition);
    const markerPath = join(partitionDir, "tg-map.migration.json");
    assert.equal(existsSync(markerPath), true);
    assert.equal(existsSync(join(legacyDir, "tg-map.jsonl")), false);

    // Reintroduce an exact source file to model a crash after the first
    // source-file removal. Marker recovery must verify it against its
    // manifest and remove it without rewriting destination state.
    writeFileSync(join(legacyDir, "tg-map.jsonl"), legacyLine);
    migrateLegacy(adapter, root, runId, CONFIGURED_CHAT);
    assert.equal(existsSync(join(legacyDir, "tg-map.jsonl")), false);
    const internals = adapter as unknown as { escIdOfMessage(messageId: number, chatId: string): string | null };
    assert.equal(internals.escIdOfMessage(73, CONFIGURED_CHAT), escId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping lock: expired legacy chat lock is reclaimed by another chat", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-map-lock-expired-"));
  const runId = "run-lock-expired";
  const legacyDir = join(root, ".work-state", "cto", runId);
  const escId = `${runId}/esc-1`;
  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "tg-map.jsonl"), `${JSON.stringify({ escId, messageId: 73 })}\n`);
    const lockPath = writeLegacyMappingLock(root, runId, "chat-a", "owner-a", Date.now() - 1);
    const adapter = telegramAdapter({
      token: "t",
      chatId: "chat-b",
      cwd: root,
      legacyMappingMigration: { tenant: runId, chatId: "chat-b" },
      fetchImpl: mockFetch([]),
    });

    migrateLegacy(adapter, root, runId, "chat-b");

    assert.equal(existsSync(join(legacyDir, "tg-map.jsonl")), false, "reclaimed source lock permits migration");
    assert.equal(existsSync(lockPath), false, "reclaimed lock is released after migration");
    const partition = createHash("sha256")
      .update("telegram-chat-mapping\u0000", "utf8")
      .update("chat-b", "utf8")
      .digest("hex");
    assert.equal(existsSync(join(legacyDir, "telegram-callbacks", partition, "tg-map.meta.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping lock: live legacy chat lock blocks a different chat", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-map-lock-live-"));
  const runId = "run-lock-live";
  const legacyDir = join(root, ".work-state", "cto", runId);
  const escId = `${runId}/esc-1`;
  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "tg-map.jsonl"), `${JSON.stringify({ escId, messageId: 73 })}\n`);
    const lockPath = writeLegacyMappingLock(root, runId, "chat-a", "owner-a", Date.now() + 60_000);
    const adapter = telegramAdapter({
      token: "t",
      chatId: "chat-b",
      cwd: root,
      legacyMappingMigration: { tenant: runId, chatId: "chat-b" },
      fetchImpl: mockFetch([]),
    });

    assert.throws(
      () => migrateLegacy(adapter, root, runId, "chat-b"),
      /tenant\/chat identity conflicts/,
    );
    assert.equal(existsSync(join(legacyDir, "tg-map.jsonl")), true, "live foreign lock preserves source");
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), {
      schema: 1,
      tenant: runId,
      chatId: "chat-a",
      owner: "owner-a",
      expiresAt: JSON.parse(readFileSync(lockPath, "utf8")).expiresAt,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping lock: stale owner release cannot remove a newer chat lease", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-map-lock-fenced-release-"));
  const runId = "run-lock-fenced";
  const legacyDir = join(root, ".work-state", "cto", runId);
  const escId = `${runId}/esc-1`;
  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "tg-map.jsonl"), `${JSON.stringify({ escId, messageId: 73 })}\n`);
    const adapter = telegramAdapter({
      token: "t",
      chatId: "chat-a",
      cwd: root,
      legacyMappingMigration: { tenant: runId, chatId: "chat-a" },
      fetchImpl: mockFetch([]),
    });
    const internals = adapter as unknown as {
      openUnpartitionedMappingQueue: (tenant: string, createDirectory?: boolean) => unknown;
    };
    const openSource = internals.openUnpartitionedMappingQueue.bind(adapter);
    let injected = false;
    internals.openUnpartitionedMappingQueue = (tenant, createDirectory = false) => {
      const queue = openSource(tenant, createDirectory);
      if (!queue || injected) return queue;
      const queueLike = queue as {
        removeIfMatches: (name: string, expected: unknown) => void;
      };
      const removeSourceFile = queueLike.removeIfMatches.bind(queueLike);
      queueLike.removeIfMatches = (name, expected) => {
        removeSourceFile(name, expected);
        if (name === "tg-map.jsonl" && !injected) {
          injected = true;
          writeLegacyMappingLock(root, runId, "chat-b", "owner-b", Date.now() + 60_000);
        }
      };
      return queue;
    };

    migrateLegacy(adapter, root, runId, "chat-a");

    assert.equal(injected, true, "test installs a newer lease before stale release");
    const lock = JSON.parse(readFileSync(join(legacyDir, "tg-map.lock.json"), "utf8")) as {
      schema?: number;
      tenant?: string;
      chatId?: string;
      owner?: string;
      expiresAt?: number;
    };
    assert.equal(lock.schema, 1);
    assert.equal(lock.tenant, runId);
    assert.equal(lock.chatId, "chat-b");
    assert.equal(lock.owner, "owner-b");
    assert.ok(typeof lock.expiresAt === "number" && lock.expiresAt > Date.now());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping lookup: identical message IDs remain partitioned by Telegram chat", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-map-chat-partition-"));
  const runId = "run-chat-partition";
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "fixture-token", chatId: CONFIGURED_CHAT, allowedChatIds: [CONFIGURED_CHAT, "999"] } }));
    withIndexedMapping(root, runId, `${runId}/primary`, 88, CONFIGURED_CHAT);
    withIndexedMapping(root, runId, `${runId}/readonly`, 88, "999");
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      allowedChatIds: ["999"],
      cwd: root,
      fetchImpl: mockFetch([]),
    });
    const internals = adapter as unknown as { escIdOfMessage(messageId: number, chatId: string): string | null };
    assert.equal(internals.escIdOfMessage(88, CONFIGURED_CHAT), `${runId}/primary`);
    assert.equal(internals.escIdOfMessage(88, "999"), `${runId}/readonly`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping migration: foreign run rows fail closed before partition publication", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-map-migration-foreign-"));
  const runId = "run-migration-foreign";
  const legacyDir = join(root, ".work-state", "cto", runId);
  try {
    withIndexedRun(root, runId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "tg-map.jsonl"), [
      JSON.stringify({ escId: `${runId}/esc-1`, messageId: 73 }),
      JSON.stringify({ escId: "other-run/esc-foreign", messageId: 74 }),
      "",
    ].join("\n"));
    const adapter = telegramAdapter({
      token: "t",
      chatId: CONFIGURED_CHAT,
      cwd: root,
      legacyMappingMigration: { tenant: runId, chatId: CONFIGURED_CHAT },
      fetchImpl: mockFetch([]),
    });
    assert.throws(() => migrateLegacy(adapter, root, runId, CONFIGURED_CHAT), /foreign escalation/);
    assert.equal(existsSync(join(legacyDir, "tg-map.jsonl")), true);
    const partition = createHash("sha256")
      .update("telegram-chat-mapping\u0000", "utf8")
      .update(CONFIGURED_CHAT, "utf8")
      .digest("hex");
    assert.equal(existsSync(join(legacyDir, "telegram-callbacks", partition, "tg-map.meta.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
