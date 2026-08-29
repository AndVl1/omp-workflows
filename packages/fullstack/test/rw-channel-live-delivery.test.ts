/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Escalation } from "@andvl1/omp-workflows-core";
import { createAdapterFactories, createChannelSet, registerEscalationAdapterFactory, startChannelDispatcher, startDispatcher, writeBridgeLock, type ChannelSet, type InboxTask } from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import { TelegramEscalationAdapter } from "../src/adapters/telegram.js";
import { createFullstackStorageAuthority, type FullstackStorageNativeBackend } from "../src/storage-authority.js";
import { channelAdmission, runtimeFixture, type RuntimeFixture } from "./runtime-fixtures.js";

function dropFile(dir: string, name: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(payload));
}

interface LiveDispatcher {
  readonly fixture: RuntimeFixture;
  readonly channelSet: ChannelSet;
  readonly stop: () => Promise<void>;
  readonly tasks: InboxTask[];
  readonly answers: Array<{ id: string; answer: string }>;
}
function startLiveDispatcher(
  root: string,
  channels: readonly Readonly<Record<string, unknown>>[],
  direction: "rw" | "ro" = "rw",
  taskHandler?: (task: InboxTask) => Promise<void>,
): LiveDispatcher {
  const fixture = runtimeFixture(root, { runId: direction === "rw" ? "live-run" : "live-ro-run" });
  const admission = channelAdmission(fixture, channels);
  const factories = createAdapterFactories();
  registerEscalationAdapterFactory(factories, "mock", ({ project_root, run_identity, filesystem_authority, storage, channel }) => new MockEscalationAdapter({ project_root, run_identity, filesystem_authority, storage, persisted: { relative_dir: typeof channel.dir === "string" ? channel.dir : "rw" } }));
  const context = { ...fixture.context, channel_admission: admission };
  const resolved = createChannelSet({ ...context, factories });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) throw new Error("live channel set should resolve");
  const channelSet = resolved.value;
  assert.equal(channelSet.profile.direction, direction);
  if (direction === "rw") assert.ok(channelSet.primary instanceof MockEscalationAdapter);
  else assert.equal(channelSet.primary, null);
  const tasks: InboxTask[] = [];
  const answers: Array<{ id: string; answer: string }> = [];
  const started = startChannelDispatcher(context, channelSet, {
    intervalMs: 50,
    onTask: taskHandler ?? (async (task) => { tasks.push(task); }),
    onAnswer: (answer) => answers.push(answer),
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("live dispatcher should start");
  const handle = started.value;
  return { fixture, channelSet, stop: async () => { await handle.stop(); }, tasks, answers };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function persistedConfig(dir: string, direction: "read-write" | "read-only" = "read-write"): readonly Readonly<Record<string, unknown>>[] {
  return [{ id: "mock-channel", adapter: "mock", direction, ...(direction === "read-write" ? { primary: true } : {}), persisted: true, dir }];
}
const TELEGRAM_ENDPOINT_POLICY = {
  telegram: {
    url: "https://api.telegram.org",
    method: "POST",
    headers: { "content-type": "application/json" },
    timeout_ms: 100,
    max_body_bytes: 64 * 1024,
  },

} as const;
function digestString(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function telegramChannelStorageDigest(configDigest: string, channelId = "telegram", chatId = "123"): string {
  return digestString({ channel_id: channelId, chat_id: chatId, config_digest: configDigest });
}

function telegramEscalation(runIdentity: RuntimeFixture["run_identity"], id = `${runIdentity.run_id}/team-a/q1`): Escalation {
  return {
    id,
    level: "question",
    title: "Telegram question",
    body: "Should this retry?",
    run_identity: runIdentity,
  };
}


test("live: Telegram dispatcher retains a failed plain update for offset retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-retry-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const fixture = runtimeFixture(root, { runId: "telegram-retry-run" });
    const channels = [{
      id: "telegram",
      adapter: "telegram",
      direction: "read-write",
      primary: true,
      token: "test-token",
      chatId: "123",
    }] as const;
    const admission = channelAdmission(fixture, channels, {
      allowedChatIds: ["123"],
      allowedSenderIds: ["456"],
      endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
    });
    const offsets: number[] = [];
    const update = {
      update_id: 41,
      message: { message_id: 7, date: 1_700_000_000, text: "telegram retry task", chat: { id: 123 }, from: { id: 456 } },
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (!rawBody || typeof rawBody !== "object" || !("offset" in rawBody) || typeof rawBody.offset !== "number") throw new Error("test getUpdates payload missing offset");
      const offset = rawBody.offset;
      offsets.push(offset);
      return new Response(JSON.stringify({ ok: true, result: offset === 0 ? [update] : [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new TelegramEscalationAdapter({
      token: "test-token",
      chatId: "123",
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      storage: fixture.storage,
      channel_admission: admission,
      allowedChatIds: admission.allowed_chat_ids,
      allowedSenderIds: admission.allowed_sender_ids,
      channel_id: "telegram",
      fetchImpl,
    });
    let calls = 0;
    let allowRetry = false;
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 100,
      onTask: async () => {
        calls += 1;
        if (!allowRetry) throw new Error("wake failed once");
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("telegram dispatcher should start");
    stop = async () => {
      await started.value.stop();
      await adapter.shutdown();
    };

    const inbox = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox");
    await waitFor(() => calls === 1, 1000, "failed Telegram task callback");
    assert.deepEqual(offsets, [0], "failed callback must not advance Telegram getUpdates offset");
    assert.equal(readdirSync(inbox).filter((name) => name.endsWith(".json")).length, 1, "failed task filing remains pending");
    assert.equal(existsSync(join(inbox, "processed")), false, "failed task has no processed marker");

    allowRetry = true;
    await waitFor(() => calls === 2 && existsSync(join(inbox, "processed")), 3000, "successful Telegram task retry");
    assert.deepEqual(offsets.slice(0, 2), [0, 0], "retry requests the exact Telegram update again");
    await waitFor(() => offsets.includes(42), 1000, "Telegram offset advance after success");
    assert.equal(readdirSync(join(inbox, "processed")).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram send retains ambiguous pending after triple failure and blocks duplicate sends", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-send-uncertain-"));
  const fixture = runtimeFixture(root, { runId: "telegram-send-uncertain-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  let sendCalls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || !("chat_id" in rawBody)) throw new Error("test sendMessage payload missing chat_id");
    sendCalls += 1;
    throw new Error("telegram API outcome is unknown");
  };
  const makeAdapter = (): TelegramEscalationAdapter => new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  let adapter = makeAdapter();
  try {
    const escalation = telegramEscalation(fixture.run_identity);
    const pendingDirectory = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest), "pending");
    const pendingPath = join(pendingDirectory, `${digestString(escalation.id)}.json`);

    const first = await adapter.send(escalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1);
    assert.equal(existsSync(pendingPath), true, "ambiguous delivery must retain its durable pending marker");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
    assert.equal(pending.state, "pending");
    assert.equal(pending.esc_id, escalation.id);
    assert.equal(pending.channel_id, "telegram");
    assert.equal(pending.config_digest, admission.config_digest);
    assert.equal(pending.chat_id, "123");

    const second = await adapter.send(escalation);
    assert.equal(second.sent, false);
    assert.equal(second.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1, "retry must not issue a second sendMessage request");

    await adapter.shutdown();
    adapter = makeAdapter();
    const third = await adapter.send(escalation);
    assert.equal(third.sent, false);
    assert.equal(third.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1, "restart retry must fail closed without another sendMessage request");
    assert.equal(existsSync(pendingPath), true);
    const pendingAfterRetry = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
    assert.equal(pendingAfterRetry.state, "pending");
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram definitive HTTP rejection removes pending for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-http-reject-"));
  const fixture = runtimeFixture(root, { runId: "telegram-http-reject-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  let sendCalls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || !("chat_id" in rawBody)) throw new Error("test sendMessage payload missing chat_id");
    sendCalls += 1;
    if (sendCalls === 1) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "bad request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const escalation = telegramEscalation(fixture.run_identity);
    const pendingDirectory = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest), "pending");
    const first = await adapter.send(escalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:sendMessage:http-400");
    assert.equal(sendCalls, 1);
    assert.equal(existsSync(pendingDirectory) ? readdirSync(pendingDirectory).filter((name) => name.endsWith(".json")).length : 0, 0);

    const second = await adapter.send(escalation);
    assert.equal(second.sent, true);
    assert.equal(second.channelRef, "tg:102");
    assert.equal(sendCalls, 2, "a proven HTTP rejection is the only API failure eligible for retry");
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram 5xx response retains pending and blocks automatic resend", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-http-5xx-"));
  const fixture = runtimeFixture(root, { runId: "telegram-http-5xx-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const escalation = telegramEscalation(fixture.run_identity);
  const pendingDirectory = join(fixture.project_root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest), "pending");
  let sendCalls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || !("chat_id" in rawBody)) {
      throw new Error("test sendMessage payload missing chat_id");
    }
    sendCalls += 1;
    return new Response(JSON.stringify({ ok: false, error_code: 502, description: "bad gateway" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const first = await adapter.send(escalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1);
    const pendingPath = join(pendingDirectory, `${digestString(escalation.id)}.json`);
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).state, "pending");

    const second = await adapter.send(escalation);
    assert.equal(second.sent, false);
    assert.equal(second.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1, "a 5xx/proxy response must not trigger an automatic resend");
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).state, "pending");
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram malformed 4xx response retains pending and blocks automatic resend", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-http-malformed-"));
  const fixture = runtimeFixture(root, { runId: "telegram-http-malformed-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const escalation = telegramEscalation(fixture.run_identity);
  const pendingDirectory = join(fixture.project_root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest), "pending");
  let sendCalls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || !("chat_id" in rawBody)) {
      throw new Error("test sendMessage payload missing chat_id");
    }
    sendCalls += 1;
    return new Response("not-json", {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const first = await adapter.send(escalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1);
    const pendingPath = join(pendingDirectory, `${digestString(escalation.id)}.json`);
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).state, "pending");

    const second = await adapter.send(escalation);
    assert.equal(second.sent, false);
    assert.equal(second.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1, "a malformed 4xx response must not trigger an automatic resend");
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).state, "pending");
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram send retains known success when final mapping write fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-mapping-recovery-"));
  const fixture = runtimeFixture(root, { runId: "telegram-mapping-recovery-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const escalation = telegramEscalation(fixture.run_identity);
  const escalationDigest = digestString(escalation.id);
  const relativeMappingDirectory = join(".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest));
  const mappingDirectory = join(fixture.project_root, relativeMappingDirectory);
  const mappingPath = join(mappingDirectory, `${escalationDigest}.json`);
  const relativeMappingPath = join(relativeMappingDirectory, `${escalationDigest}.json`);
  const pendingPath = join(mappingDirectory, "pending", `${escalationDigest}.json`);
  let failFinalMappingWrite = true;
  let sendCalls = 0;
  const native: FullstackStorageNativeBackend = {
    canonical_root: fixture.project_root,
    run_identity: fixture.run_identity,
    readBounded: (relativePath, maxBytes) => fixture.storage.readBounded(relativePath, maxBytes),
    readTextBounded: (relativePath, maxBytes) => fixture.storage.readTextBounded(relativePath, maxBytes),
    statBounded: (relativePath) => fixture.storage.statBounded(relativePath),
    writeExclusive: (relativePath, bytes, _mode = 0o600) => {
      if (failFinalMappingWrite && relativePath === relativeMappingPath) {
        return { ok: false as const, reason: "IO" as const, code: "IO" as const, message: "intentional final mapping failure" };
      }
      return fixture.storage.writeExclusive(relativePath, bytes, 4 * 1024 * 1024);
    },
    writeAtomic: (relativePath, bytes, maxBytes) => fixture.storage.writeAtomic(relativePath, bytes, maxBytes),
    appendJsonLineBounded: (relativePath, bytes, maxBytes) => fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes),
    listBounded: (relativePath, maxEntries) => fixture.storage.listBounded(relativePath, maxEntries),
    moveExclusive: (sourceRelativePath, targetRelativePath) => fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath),
    removeIfOwned: (relativePath, identity) => fixture.storage.removeIfOwned(relativePath, identity),
    acquireLease: (relativePath, identity) => fixture.storage.acquireLease(relativePath, identity),
    releaseLease: (relativePath, identity) => fixture.storage.releaseLease(relativePath, identity),
  };
  const storageResult = createFullstackStorageAuthority({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    filesystem_authority: fixture.context.filesystem_authority,
    native,
  });
  assert.equal(storageResult.ok, true);
  if (!storageResult.ok) throw new Error("recovery storage should be created");
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || !("chat_id" in rawBody)) throw new Error("test sendMessage payload missing chat_id");
    sendCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: storageResult.value,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const first = await adapter.send(escalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:mapping-unavailable");
    assert.equal(sendCalls, 1);
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
    assert.equal(pending.state, "sent");
    assert.equal(pending.esc_id, escalation.id);
    assert.equal(pending.message_id, 501);
    assert.equal(pending.channel_id, "telegram");
    assert.equal(pending.config_digest, admission.config_digest);
    assert.equal(pending.chat_id, "123");
    assert.deepEqual(pending.run_identity, fixture.run_identity);
    assert.equal(typeof pending.escalation_digest, "string");
    assert.match(pending.escalation_digest as string, /^[0-9a-f]{64}$/u);

    failFinalMappingWrite = false;
    const recovered = await adapter.send(escalation);
    assert.equal(recovered.sent, true);
    assert.equal(recovered.channelRef, "tg:501");
    assert.equal(sendCalls, 1, "recovery must promote the durable evidence without a second API call");
    assert.equal(existsSync(pendingPath), false);
    const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as Record<string, unknown>;
    assert.equal(mapping.state, "sent");
    assert.equal(mapping.esc_id, escalation.id);
    assert.equal(mapping.message_id, 501);
    assert.equal(mapping.channel_id, "telegram");
    assert.equal(mapping.config_digest, admission.config_digest);
    assert.equal(mapping.chat_id, "123");
    assert.deepEqual(mapping.run_identity, pending.run_identity);
    assert.equal(mapping.escalation_digest, pending.escalation_digest);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});


test("live: Telegram promotes pending sent mappings before callback and cancel lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-pending-promotion-"));
  const fixture = runtimeFixture(root, { runId: "telegram-pending-promotion-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const callbackEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/callback`);
  const cancelEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/cancel`);
  const relativeMappingDirectory = join(".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest));
  const mappingDirectory = join(fixture.project_root, relativeMappingDirectory);
  const callbackMappingPath = join(mappingDirectory, `${digestString(callbackEscalation.id)}.json`);
  const cancelMappingPath = join(mappingDirectory, `${digestString(cancelEscalation.id)}.json`);
  const pendingDirectory = join(mappingDirectory, "pending");
  const pendingCallbackPath = join(pendingDirectory, `${digestString(callbackEscalation.id)}.json`);
  const pendingCancelPath = join(pendingDirectory, `${digestString(cancelEscalation.id)}.json`);
  const relativeFinalPaths = new Set([
    join(relativeMappingDirectory, `${digestString(callbackEscalation.id)}.json`),
    join(relativeMappingDirectory, `${digestString(cancelEscalation.id)}.json`),
  ]);
  let failFinalMappingWrite = true;
  let sendCalls = 0;
  let deleteCalls = 0;
  let pollCalls = 0;
  const native: FullstackStorageNativeBackend = {
    canonical_root: fixture.project_root,
    run_identity: fixture.run_identity,
    readBounded: (relativePath, maxBytes) => fixture.storage.readBounded(relativePath, maxBytes),
    readTextBounded: (relativePath, maxBytes) => fixture.storage.readTextBounded(relativePath, maxBytes),
    statBounded: (relativePath) => fixture.storage.statBounded(relativePath),
    writeExclusive: (relativePath, bytes, _mode = 0o600) => {
      if (failFinalMappingWrite && relativeFinalPaths.has(relativePath)) {
        return { ok: false as const, reason: "IO" as const, code: "IO" as const, message: "intentional final mapping failure" };
      }
      return fixture.storage.writeExclusive(relativePath, bytes, 4 * 1024 * 1024);
    },
    writeAtomic: (relativePath, bytes, maxBytes) => fixture.storage.writeAtomic(relativePath, bytes, maxBytes),
    appendJsonLineBounded: (relativePath, bytes, maxBytes) => fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes),
    listBounded: (relativePath, maxEntries) => fixture.storage.listBounded(relativePath, maxEntries),
    moveExclusive: (sourceRelativePath, targetRelativePath) => fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath),
    removeIfOwned: (relativePath, identity) => fixture.storage.removeIfOwned(relativePath, identity),
    acquireLease: (relativePath, identity) => fixture.storage.acquireLease(relativePath, identity),
    releaseLease: (relativePath, identity) => fixture.storage.releaseLease(relativePath, identity),
  };
  const storageResult = createFullstackStorageAuthority({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    filesystem_authority: fixture.context.filesystem_authority,
    native,
  });
  assert.equal(storageResult.ok, true);
  if (!storageResult.ok) throw new Error("pending promotion storage should be created");
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) throw new Error("test Telegram payload is malformed");
    if ("offset" in rawBody) {
      if (typeof rawBody.offset !== "number") throw new Error("test Telegram offset is malformed");
      pollCalls += 1;
      const result = pollCalls === 1 ? [{
        update_id: 601,
        callback_query: {
          message: { message_id: 501, chat: { id: 123 } },
          from: { id: 456 },
          data: `${callbackEscalation.id}::approve`,
        },
      }] : [];
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if ("message_id" in rawBody) {
      deleteCalls += 1;
      assert.equal(rawBody.message_id, 502);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!("chat_id" in rawBody)) throw new Error("test Telegram send payload missing chat_id");
    sendCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + sendCalls } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: storageResult.value,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const first = await adapter.send(callbackEscalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:mapping-unavailable");
    const second = await adapter.send(cancelEscalation);
    assert.equal(second.sent, false);
    assert.equal(second.channelRef, "tg:mapping-unavailable");
    assert.equal(sendCalls, 2);
    assert.equal(JSON.parse(readFileSync(pendingCallbackPath, "utf8")).state, "sent");
    assert.equal(JSON.parse(readFileSync(pendingCancelPath, "utf8")).state, "sent");

    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.id, callbackEscalation.id);
    assert.equal(answers[0]?.answer, "approve");
    assert.equal(existsSync(callbackMappingPath), true, "callback lookup must promote pending sent evidence");
    assert.equal(existsSync(pendingCallbackPath), false);

    await adapter.cancel(cancelEscalation.id);
    assert.equal(deleteCalls, 1);
    assert.equal(existsSync(cancelMappingPath), true, "cancel lookup must promote pending sent evidence");
    assert.equal(existsSync(pendingCancelPath), false);
    assert.equal(sendCalls, 2, "lookup promotion must not issue another sendMessage request");
    assert.equal(failFinalMappingWrite, true);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram mapping union cap rejects a new key before network and preserves exact replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-mapping-cap-"));
  const fixture = runtimeFixture(root, { runId: "telegram-mapping-cap-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const existingEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/existing`);
  const newEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/new`);
  const relativeMappingDirectory = join(".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest));
  const mappingDirectory = join(fixture.project_root, relativeMappingDirectory);
  const pendingDirectory = join(mappingDirectory, "pending");
  const existingMappingPath = join(mappingDirectory, `${digestString(existingEscalation.id)}.json`);
  const existingPendingPath = join(pendingDirectory, `${digestString(existingEscalation.id)}.json`);
  const newPendingPath = join(pendingDirectory, `${digestString(newEscalation.id)}.json`);
  const relativeExistingMappingPath = join(relativeMappingDirectory, `${digestString(existingEscalation.id)}.json`);
  let failFinalMappingWrite = true;
  let sendCalls = 0;
  let leaseCalls = 0;
  const native: FullstackStorageNativeBackend = {
    canonical_root: fixture.project_root,
    run_identity: fixture.run_identity,
    readBounded: (relativePath, maxBytes) => fixture.storage.readBounded(relativePath, maxBytes),
    readTextBounded: (relativePath, maxBytes) => fixture.storage.readTextBounded(relativePath, maxBytes),
    statBounded: (relativePath) => fixture.storage.statBounded(relativePath),
    writeExclusive: (relativePath, bytes, _mode = 0o600) => {
      if (failFinalMappingWrite && relativePath === relativeExistingMappingPath) {
        return { ok: false as const, reason: "IO" as const, code: "IO" as const, message: "intentional final mapping failure" };
      }
      return fixture.storage.writeExclusive(relativePath, bytes, 4 * 1024 * 1024);
    },
    writeAtomic: (relativePath, bytes, maxBytes) => fixture.storage.writeAtomic(relativePath, bytes, maxBytes),
    appendJsonLineBounded: (relativePath, bytes, maxBytes) => fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes),
    listBounded: (relativePath, maxEntries) => fixture.storage.listBounded(relativePath, maxEntries),
    moveExclusive: (sourceRelativePath, targetRelativePath) => fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath),
    removeIfOwned: (relativePath, identity) => fixture.storage.removeIfOwned(relativePath, identity),
    acquireLease: (relativePath, identity) => {
      leaseCalls += 1;
      return fixture.storage.acquireLease(relativePath, identity);
    },
    releaseLease: (relativePath, identity) => fixture.storage.releaseLease(relativePath, identity),
  };
  const storageResult = createFullstackStorageAuthority({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    filesystem_authority: fixture.context.filesystem_authority,
    native,
  });
  assert.equal(storageResult.ok, true);
  if (!storageResult.ok) throw new Error("mapping cap storage should be created");
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || !("chat_id" in rawBody)) {
      throw new Error("test Telegram send payload missing chat_id");
    }
    sendCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: storageResult.value,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const first = await adapter.send(existingEscalation);
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:mapping-unavailable");
    assert.equal(sendCalls, 1);
    assert.equal(JSON.parse(readFileSync(existingPendingPath, "utf8")).state, "sent");
    for (let index = 0; index < 1023; index += 1) {
      writeFileSync(join(pendingDirectory, `filler-${index}.json`), "{}");
    }
    assert.equal(readdirSync(pendingDirectory).filter((name) => name.endsWith(".json")).length, 1024);

    const leasesBeforeRejected = leaseCalls;
    const rejected = await adapter.send(newEscalation);
    assert.equal(rejected.sent, false);
    assert.equal(rejected.channelRef, "tg:mapping-limit");
    assert.equal(sendCalls, 1, "a new mapping key at the cap must not reach Telegram");
    assert.equal(leaseCalls, leasesBeforeRejected + 1, "a new mapping key at the cap acquires only the channel capacity lease");
    assert.equal(existsSync(newPendingPath), false);
    assert.equal(readdirSync(pendingDirectory).filter((name) => name.endsWith(".json")).length, 1024);

    const replay = await adapter.send(existingEscalation);
    assert.equal(replay.sent, true);
    assert.equal(replay.channelRef, "tg:901");
    assert.equal(sendCalls, 1, "an exact existing pending key is replayed without another remote send");
    assert.equal(leaseCalls, leasesBeforeRejected + 3, "an exact replay acquires the channel and per-ID leases");
    assert.equal(existsSync(existingMappingPath), true);
    assert.equal(readdirSync(pendingDirectory).filter((name) => name.endsWith(".json")).length, 1023);
    assert.equal(failFinalMappingWrite, true);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram channel capacity lease serializes concurrent distinct sends at the union cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-capacity-race-"));
  const fixture = runtimeFixture(root, { runId: "telegram-capacity-race-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const firstEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/first`);
  const secondEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/second`);
  const relativeMappingDirectory = join(".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest));
  const mappingDirectory = join(fixture.project_root, relativeMappingDirectory);
  const pendingDirectory = join(mappingDirectory, "pending");
  mkdirSync(pendingDirectory, { recursive: true });
  for (let index = 0; index < 1023; index += 1) writeFileSync(join(pendingDirectory, `filler-${index}.json`), "{}");
  const uniqueMappingKeys = (): Set<string> => {
    const finalNames = existsSync(mappingDirectory)
      ? readdirSync(mappingDirectory).filter((name) => name.endsWith(".json"))
      : [];
    const pendingNames = existsSync(pendingDirectory)
      ? readdirSync(pendingDirectory).filter((name) => name.endsWith(".json"))
      : [];
    return new Set([...finalNames, ...pendingNames]);
  };
  const initialUniqueKeys = uniqueMappingKeys().size;
  assert.equal(initialUniqueKeys, 1023);
  let sendCalls = 0;
  let maxUniqueKeys = initialUniqueKeys;
  let networkStartedResolve!: () => void;
  const networkStarted = new Promise<void>((resolve) => { networkStartedResolve = resolve; });
  let releaseNetwork!: () => void;
  const networkGate = new Promise<void>((resolve) => { releaseNetwork = resolve; });
  const leaseEvents: string[] = [];
  let capacityLeaseAcquires = 0;
  let capacityLeaseReleases = 0;
  let activeCapacityLeases = 0;
  let maxActiveCapacityLeases = 0;
  const isCapacityLease = (relativePath: string): boolean => relativePath.endsWith("/.capacity.lock");
  const observeUniqueKeys = (): void => {
    maxUniqueKeys = Math.max(maxUniqueKeys, uniqueMappingKeys().size);
  };
  const native: FullstackStorageNativeBackend = {
    canonical_root: fixture.project_root,
    run_identity: fixture.run_identity,
    readBounded: (relativePath, maxBytes) => fixture.storage.readBounded(relativePath, maxBytes),
    readTextBounded: (relativePath, maxBytes) => fixture.storage.readTextBounded(relativePath, maxBytes),
    statBounded: (relativePath) => fixture.storage.statBounded(relativePath),
    writeExclusive: (relativePath, bytes, _mode = 0o600) => {
      const written = fixture.storage.writeExclusive(relativePath, bytes, 4 * 1024 * 1024);
      observeUniqueKeys();
      return written;
    },
    writeAtomic: (relativePath, bytes, maxBytes) => fixture.storage.writeAtomic(relativePath, bytes, maxBytes),
    appendJsonLineBounded: (relativePath, bytes, maxBytes) => fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes),
    listBounded: (relativePath, maxEntries) => fixture.storage.listBounded(relativePath, maxEntries),
    moveExclusive: (sourceRelativePath, targetRelativePath) => fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath),
    removeIfOwned: (relativePath, identity) => fixture.storage.removeIfOwned(relativePath, identity),
    acquireLease: (relativePath, identity) => {
      const capacity = isCapacityLease(relativePath);
      leaseEvents.push(`acquire:${capacity ? "capacity" : "id"}`);
      if (capacity) {
        capacityLeaseAcquires += 1;
        activeCapacityLeases += 1;
        maxActiveCapacityLeases = Math.max(maxActiveCapacityLeases, activeCapacityLeases);
      }
      return fixture.storage.acquireLease(relativePath, identity);
    },
    releaseLease: (relativePath, identity) => {
      const capacity = isCapacityLease(relativePath);
      leaseEvents.push(`release:${capacity ? "capacity" : "id"}`);
      const released = fixture.storage.releaseLease(relativePath, identity);
      if (capacity && released.ok) {
        capacityLeaseReleases += 1;
        activeCapacityLeases -= 1;
      }
      return released;
    },
  };
  const storageResult = createFullstackStorageAuthority({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    filesystem_authority: fixture.context.filesystem_authority,
    native,
  });
  assert.equal(storageResult.ok, true);
  if (!storageResult.ok) throw new Error("capacity race storage should be created");
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || !("chat_id" in rawBody)) {
      throw new Error("test Telegram send payload missing chat_id");
    }
    sendCalls += 1;
    leaseEvents.push("network:sendMessage");
    networkStartedResolve();
    await networkGate;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 902 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: storageResult.value,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    const firstPromise = adapter.send(firstEscalation);
    await networkStarted;
    assert.equal(sendCalls, 1);
    assert.equal(uniqueMappingKeys().size, 1024, "the first distinct send admits exactly one new key before its network request");

    const secondPromise = adapter.send(secondEscalation);
    const second = await secondPromise;
    assert.equal(second.sent, false);
    assert.equal(second.channelRef, "tg:mapping-limit", "the losing distinct send retains a typed capacity rejection");
    assert.equal(sendCalls, 1, "the capacity loser must not reach Telegram");
    assert.equal(uniqueMappingKeys().size, 1024);

    releaseNetwork();
    const first = await firstPromise;
    assert.equal(first.sent, true);
    assert.equal(first.channelRef, "tg:902");
    assert.equal(sendCalls, 1);
    assert.equal(uniqueMappingKeys().size, 1024);
    assert.equal(maxUniqueKeys, 1024, "the combined final/pending union never exceeds the hard cap");
    assert.equal(capacityLeaseAcquires, 2, "both admissions use the channel-bound capacity lease");
    assert.equal(capacityLeaseReleases, capacityLeaseAcquires);
    assert.equal(maxActiveCapacityLeases, 1, "the admitted capacity lease serializes the channel");
    const networkIndex = leaseEvents.indexOf("network:sendMessage");
    assert.ok(networkIndex > 0);
    assert.ok(leaseEvents.lastIndexOf("release:capacity", networkIndex) >= 0, "capacity lease releases before network");
    assert.deepEqual(leaseEvents.slice(0, 4), ["acquire:capacity", "acquire:id", "release:capacity", "network:sendMessage"]);
  } finally {
    releaseNetwork();
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram send aborts a response-body stall at the admitted deadline and does not resend", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-body-timeout-"));
  const fixture = runtimeFixture(root, { runId: "telegram-body-timeout-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  let sendCalls = 0;
  let headersArrived = false;
  let bodyAborted = false;
  let requestSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) throw new Error("test Telegram request signal is missing");
    sendCalls += 1;
    requestSignal = signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        headersArrived = true;
        controller.enqueue(new TextEncoder().encode('{"ok":true,"result":'));
        signal.addEventListener("abort", () => {
          bodyAborted = true;
          controller.error(new Error("test Telegram response body aborted"));
        }, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  const escalation = telegramEscalation(fixture.run_identity);
  const pendingDirectory = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest), "pending");
  const pendingPath = join(pendingDirectory, `${digestString(escalation.id)}.json`);
  try {
    const first = await adapter.send(escalation);
    assert.equal(headersArrived, true, "Telegram headers must arrive before the response body stalls");
    assert.equal(first.sent, false);
    assert.equal(first.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1);
    assert.equal(requestSignal?.aborted, true, "the request deadline must abort after headers while the body is stalled");
    assert.equal(bodyAborted, true, "the stalled Telegram body must observe the request abort");
    assert.equal(existsSync(pendingPath), true, "an aborted body leaves the pending delivery evidence");

    const second = await adapter.send(escalation);
    assert.equal(second.sent, false);
    assert.equal(second.channelRef, "tg:delivery-uncertain/manual-reconciliation");
    assert.equal(sendCalls, 1, "retry after an aborted body must not issue a second sendMessage request");
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram mappings and callback lookup are isolated by admitted channel identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-channel-identity-"));
  const fixture = runtimeFixture(root, { runId: "telegram-channel-identity-run" });
  const channels = [{
    id: "telegram-a",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token-a",
    chatId: "123",
  }, {
    id: "telegram-b",
    adapter: "telegram",
    direction: "read-write",
    token: "test-token-b",
    chatId: "456",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123", "456"],
    allowedSenderIds: ["789"],
    endpointPolicy: {
      "telegram-a": TELEGRAM_ENDPOINT_POLICY.telegram,
      "telegram-b": TELEGRAM_ENDPOINT_POLICY.telegram,
    },
  });
  const escalationA = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-a/q1`);
  const escalationB = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/team-b/q1`);
  const sharedEscalation = telegramEscalation(fixture.run_identity, `${fixture.run_identity.run_id}/shared/q1`);
  let aSendCalls = 0;
  let bSendCalls = 0;
  let aPolled = false;
  let bPolled = false;
  const fetchA: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object") throw new Error("test Telegram A payload is malformed");
    if ("chat_id" in rawBody) {
      aSendCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 701 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if ("offset" in rawBody) {
      const result = !aPolled ? [{
        update_id: 91,
        callback_query: {
          data: `${escalationA.id}::approve`,
          message: { message_id: 701, chat: { id: 123 } },
          from: { id: 789 },
        },
      }] : [];
      aPolled = true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("test Telegram A payload has no recognized operation");
  };
  const fetchB: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object") throw new Error("test Telegram B payload is malformed");
    if ("chat_id" in rawBody) {
      bSendCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 701 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if ("offset" in rawBody) {
      const result = !bPolled ? [{
        update_id: 92,
        callback_query: {
          data: `${escalationB.id}::reject`,
          message: { message_id: 701, chat: { id: 456 } },
          from: { id: 789 },
        },
      }] : [];
      bPolled = true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("test Telegram B payload has no recognized operation");
  };
  const adapterA = new TelegramEscalationAdapter({
    token: "test-token-a",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram-a",
    fetchImpl: fetchA,
  });
  const adapterB = new TelegramEscalationAdapter({
    token: "test-token-b",
    chatId: "456",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram-b",
    fetchImpl: fetchB,
  });
  try {
    assert.equal((await adapterA.send(escalationA)).sent, true);
    assert.equal((await adapterB.send(escalationB)).sent, true);
    assert.equal(aSendCalls, 1);
    assert.equal(bSendCalls, 1);
    const answersA = await adapterA.pollOnce();
    const answersB = await adapterB.pollOnce();
    assert.equal(answersA.length, 1);
    assert.equal(answersB.length, 1);
    assert.equal(answersA[0]?.id, escalationA.id);
    assert.equal(answersA[0]?.answer, "approve");
    assert.equal(answersA[0]?.by, "telegram:sender=789;chat=123;kind=callback");
    assert.equal(answersB[0]?.id, escalationB.id);
    assert.equal(answersB[0]?.answer, "reject");
    assert.equal(answersB[0]?.by, "telegram:sender=789;chat=456;kind=callback");
    const sendsBeforeShared = { a: aSendCalls, b: bSendCalls };
    assert.equal((await adapterA.send(sharedEscalation)).sent, true);
    assert.equal((await adapterB.send(sharedEscalation)).sent, true);
    assert.equal(aSendCalls, sendsBeforeShared.a + 1, "channel A sends the shared escalation once");
    assert.equal(bSendCalls, sendsBeforeShared.b + 1, "channel B sends the shared escalation once");
    const mappingRoot = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map");
    const channelADirectory = join(mappingRoot, telegramChannelStorageDigest(admission.config_digest, "telegram-a", "123"));
    const channelBDirectory = join(mappingRoot, telegramChannelStorageDigest(admission.config_digest, "telegram-b", "456"));
    const mappingA = JSON.parse(readFileSync(join(channelADirectory, `${digestString(escalationA.id)}.json`), "utf8")) as Record<string, unknown>;
    const mappingB = JSON.parse(readFileSync(join(channelBDirectory, `${digestString(escalationB.id)}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(mappingA.esc_id, escalationA.id);
    assert.equal(mappingA.channel_id, "telegram-a");
    assert.equal(mappingA.config_digest, admission.config_digest);
    assert.equal(mappingA.chat_id, "123");
    assert.equal(mappingA.message_id, 701);
    assert.equal(mappingB.esc_id, escalationB.id);
    assert.equal(mappingB.channel_id, "telegram-b");
    assert.equal(mappingB.config_digest, admission.config_digest);
    assert.equal(mappingB.chat_id, "456");
    assert.equal(mappingB.message_id, 701);
    const sharedMappingA = JSON.parse(readFileSync(join(channelADirectory, `${digestString(sharedEscalation.id)}.json`), "utf8")) as Record<string, unknown>;
    const sharedMappingB = JSON.parse(readFileSync(join(channelBDirectory, `${digestString(sharedEscalation.id)}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(sharedMappingA.esc_id, sharedEscalation.id);
    assert.equal(sharedMappingA.channel_id, "telegram-a");
    assert.equal(sharedMappingA.config_digest, admission.config_digest);
    assert.equal(sharedMappingA.chat_id, "123");
    assert.equal(sharedMappingA.message_id, 701);
    assert.equal(sharedMappingB.esc_id, sharedEscalation.id);
    assert.equal(sharedMappingB.channel_id, "telegram-b");
    assert.equal(sharedMappingB.config_digest, admission.config_digest);
    assert.equal(sharedMappingB.chat_id, "456");
    assert.equal(sharedMappingB.message_id, 701);
  } finally {
    await adapterA.shutdown();
    await adapterB.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram callback_data enforces its UTF-8 byte bound before mapping or network effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-callback-bytes-"));
  const fixture = runtimeFixture(root, { runId: "telegram-callback-byte-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const sendBodies: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("test Telegram payload is missing");
    sendBodies.push(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 300 + sendBodies.length } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  const mappingDirectory = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-map", telegramChannelStorageDigest(admission.config_digest));
  const pendingDirectory = join(mappingDirectory, "pending");
  const durableSnapshot = (): { readonly mapping: string[]; readonly pending: string[] } => ({
    mapping: existsSync(mappingDirectory) ? readdirSync(mappingDirectory).sort() : [],
    pending: existsSync(pendingDirectory) ? readdirSync(pendingDirectory).sort() : [],
  });
  try {
    const acceptedId = `${fixture.run_identity.run_id}/team-a/q1`;
    const acceptedPrefix = `${acceptedId}::`;
    const acceptedOptionId = "a".repeat(64 - new TextEncoder().encode(acceptedPrefix).byteLength);
    const accepted: Escalation = {
      ...telegramEscalation(fixture.run_identity, acceptedId),
      options: [{ id: acceptedOptionId, label: "Accept", apply: "now" }],
    };
    const acceptedReceipt = await adapter.send(accepted);
    assert.equal(acceptedReceipt.sent, true);
    assert.equal(sendBodies.length, 1);
    const acceptedPayload = JSON.parse(sendBodies[0]!) as {
      readonly reply_markup?: {
        readonly inline_keyboard?: ReadonlyArray<ReadonlyArray<{ readonly callback_data?: unknown }>>;
      };
    };
    const acceptedCallbackData = acceptedPayload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    assert.equal(typeof acceptedCallbackData, "string");
    if (typeof acceptedCallbackData !== "string") throw new Error("accepted Telegram callback_data is missing");
    assert.equal(new TextEncoder().encode(acceptedCallbackData).byteLength, 64);

    const overlongId = `${fixture.run_identity.run_id}/team-a/q65`;
    const overlongPrefix = `${overlongId}::`;
    const overlongOptionId = "b".repeat(65 - new TextEncoder().encode(overlongPrefix).byteLength);
    const beforeOverlong = durableSnapshot();
    const overlongReceipt = await adapter.send({
      ...telegramEscalation(fixture.run_identity, overlongId),
      options: [{ id: overlongOptionId, label: "Reject", apply: "now" }],
    });
    assert.equal(overlongReceipt.sent, false);
    assert.equal(overlongReceipt.channelRef, "tg:callback-data-limit");
    assert.deepEqual(durableSnapshot(), beforeOverlong);
    assert.equal(sendBodies.length, 1);

    const multibyteId = `${fixture.run_identity.run_id}/team-a/q-multibyte`;
    const multibyteOptionId = "é".repeat(32);
    assert.ok(new TextEncoder().encode(`${multibyteId}::${multibyteOptionId}`).byteLength > 64);
    const beforeMultibyte = durableSnapshot();
    const multibyteReceipt = await adapter.send({
      ...telegramEscalation(fixture.run_identity, multibyteId),
      options: [{ id: multibyteOptionId, label: "Reject", apply: "now" }],
    });
    assert.equal(multibyteReceipt.sent, false);
    assert.equal(multibyteReceipt.channelRef, "tg:callback-data-limit");
    assert.deepEqual(durableSnapshot(), beforeMultibyte);
    assert.equal(sendBodies.length, 1);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram dispatcher quarantines a malformed plain-message date before advancing offset", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-date-quarantine-"));
  const fixture = runtimeFixture(root, { runId: "telegram-date-quarantine-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const offsets: number[] = [];
  const update = {
    update_id: 73,
    message: { message_id: 9, text: "telegram malformed date", chat: { id: 123 }, from: { id: 456 } },
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || !("offset" in rawBody) || typeof rawBody.offset !== "number") throw new Error("test getUpdates payload missing offset");
    const offset = rawBody.offset;
    offsets.push(offset);
    return new Response(JSON.stringify({ ok: true, result: offset === 0 ? [update] : [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let callbackCalls = 0;
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
    onPlainMessage: async () => {
      callbackCalls += 1;
    },
  });
  try {
    assert.deepEqual(await adapter.pollOnce(), []);
    assert.equal(callbackCalls, 0, "malformed Telegram dates must not invoke the plain callback");
    assert.deepEqual(offsets, [0], "the first poll must use the initial Telegram offset");

    const quarantineDirectory = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-quarantine");
    const markerNames = readdirSync(quarantineDirectory).filter((name) => name.endsWith(".json"));
    assert.equal(markerNames.length, 1, "malformed Telegram date must create exactly one quarantine marker");
    const marker = JSON.parse(readFileSync(join(quarantineDirectory, markerNames[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(marker.schema_version, 1);
    assert.equal(marker.kind, "telegram-quarantine");
    assert.equal(marker.reason, "update-date");

    assert.deepEqual(await adapter.pollOnce(), []);
    assert.deepEqual(offsets, [0, 74], "a quarantined malformed update must advance the next Telegram offset");
    assert.equal(callbackCalls, 0);
    assert.equal(readdirSync(quarantineDirectory).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram quarantine cap preserves full-target replay and retains new malformed updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-quarantine-cap-"));
  const fixture = runtimeFixture(root, { runId: "telegram-quarantine-cap-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const firstUpdate = {
    update_id: 73,
    message: { message_id: 9, text: "telegram malformed date", chat: { id: 123 }, from: { id: 456 } },
  };
  const secondUpdate = {
    update_id: 74,
    message: { message_id: 10, text: "telegram second malformed date", chat: { id: 123 }, from: { id: 456 } },
  };
  const offsets: number[] = [];
  let pollCalls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody) || !("offset" in rawBody) || typeof rawBody.offset !== "number") {
      throw new Error("test getUpdates payload missing offset");
    }
    offsets.push(rawBody.offset);
    pollCalls += 1;
    const result = pollCalls === 1 ? [firstUpdate] : pollCalls === 2 ? [firstUpdate] : pollCalls === 3 ? [secondUpdate] : [];
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  try {
    assert.deepEqual(await adapter.pollOnce(), []);
    const quarantineDirectory = join(root, ".work-state", "cto", fixture.run_identity.run_id, "telegram-quarantine");
    assert.equal(readdirSync(quarantineDirectory).filter((name) => name.endsWith(".json")).length, 1);
    for (let index = 0; index < 1023; index += 1) {
      writeFileSync(join(quarantineDirectory, `filler-${index}.json`), "{}");
    }
    assert.equal(readdirSync(quarantineDirectory).filter((name) => name.endsWith(".json")).length, 1024);

    assert.deepEqual(await adapter.pollOnce(), [], "an existing quarantine target must replay deterministically at the full cap");
    assert.deepEqual(offsets, [0, 74]);
    assert.equal(readdirSync(quarantineDirectory).filter((name) => name.endsWith(".json")).length, 1024);

    await assert.rejects(() => adapter.pollOnce(), /telegram plain message date is missing or invalid/);
    assert.deepEqual(offsets, [0, 74, 74], "a new quarantine target must retain its source offset when the cap is full");
    assert.equal(readdirSync(quarantineDirectory).filter((name) => name.endsWith(".json")).length, 1024);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: Telegram answer storage failure retains the update offset", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-telegram-answer-retry-"));
  const fixture = runtimeFixture(root, { runId: "telegram-answer-retry-run" });
  const channels = [{
    id: "telegram",
    adapter: "telegram",
    direction: "read-write",
    primary: true,
    token: "test-token",
    chatId: "123",
  }] as const;
  const admission = channelAdmission(fixture, channels, {
    allowedChatIds: ["123"],
    allowedSenderIds: ["456"],
    endpointPolicy: TELEGRAM_ENDPOINT_POLICY,
  });
  const escalation = telegramEscalation(fixture.run_identity);
  const update = {
    update_id: 83,
    message: {
      message_id: 11,
      date: 1_700_000_000,
      text: "yes",
      chat: { id: 123 },
      from: { id: 456 },
      reply_to_message: { message_id: 202 },
    },
  };
  const offsets: number[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) throw new Error("test Telegram payload is malformed");
    if ("offset" in rawBody) {
      if (typeof rawBody.offset !== "number") throw new Error("test getUpdates payload has malformed offset");
      offsets.push(rawBody.offset);
      return new Response(JSON.stringify({ ok: true, result: rawBody.offset === 0 ? [update] : [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if ("chat_id" in rawBody) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 202 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("test Telegram payload has no recognized operation");
  };
  const adapter = new TelegramEscalationAdapter({
    token: "test-token",
    chatId: "123",
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    storage: fixture.storage,
    channel_admission: admission,
    allowedChatIds: admission.allowed_chat_ids,
    allowedSenderIds: admission.allowed_sender_ids,
    channel_id: "telegram",
    fetchImpl,
  });
  const answerPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "answers", `${digestString(escalation.id)}.json`);
  try {
    const sent = await adapter.send(escalation);
    assert.equal(sent.sent, true);
    mkdirSync(answerPath, { recursive: true });
    await assert.rejects(() => adapter.pollOnce(), /telegram inbound task callback failed|storage/i);
    assert.deepEqual(offsets, [0], "answer storage failure must retain the source Telegram offset");

    rmSync(answerPath, { recursive: true, force: true });
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.id, escalation.id);
    assert.equal(answers[0]?.answer, "yes");
    assert.deepEqual(offsets, [0, 0]);

    assert.deepEqual(await adapter.pollOnce(), []);
    assert.deepEqual(offsets, [0, 0, 84]);
  } finally {
    await adapter.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: persisted mock dispatcher retains a rejected wake for source retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-mock-retry-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    let calls = 0;
    let allowRetry = false;
    const live = startLiveDispatcher(root, persistedConfig("rw"), "rw", async () => {
      calls += 1;
      if (!allowRetry) throw new Error("mock wake rejected once");
    });
    stop = live.stop;
    dropFile(join(root, "rw", "inbound"), "task-retry.json", {
      id: "mock-retry-task",
      text: "persisted mock retry task",
      at: new Date().toISOString(),
      by: "mock",
      run_identity: live.fixture.run_identity,
    });

    await waitFor(() => calls === 1, 1000, "failed persisted mock callback");
    assert.ok(existsSync(join(root, "rw", "inbound", "task-retry.json")), "failed source remains retryable");
    assert.equal(existsSync(join(root, "rw", "inbound", "processed", "task-retry.json")), false, "failed source is not moved to processed");

    allowRetry = true;
    await waitFor(() => calls === 2 && existsSync(join(root, "rw", "inbound", "processed", "task-retry.json")), 3000, "successful persisted mock retry");
    assert.equal(existsSync(join(root, "rw", "inbound", "task-retry.json")), false);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: persisted mock RW delivery remains live while a bridge lease exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-bridge-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const live = startLiveDispatcher(root, persistedConfig("rw"));
    stop = live.stop;
    assert.equal(writeBridgeLock(live.fixture.context).ok, true);
    dropFile(join(root, "rw", "inbound"), "task-1.json", {
      id: "t1",
      text: "live resident task via persisted RW channel",
      at: new Date().toISOString(),
      by: "second-process",
      run_identity: live.fixture.run_identity,
    });
    await waitFor(() => live.tasks.length === 1, 3000, "persisted RW task delivery");
    assert.equal(live.tasks[0]?.text, "live resident task via persisted RW channel");
    const processedTaskKey = createHash("sha256").update("t1", "utf8").digest("hex");
    assert.ok(existsSync(join(root, ".work-state", "cto", live.fixture.run_identity.run_id, "inbox", "processed", `${processedTaskKey}.json`)));
    assert.ok(existsSync(join(root, "rw", "inbound", "processed", "task-1.json")));
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("B: inbound delivered exactly once; duplicate normalized text never re-delivered; durable processed evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-dedup-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const live = startLiveDispatcher(root, persistedConfig("rw"));
    stop = live.stop;
    const payload = { id: "t1", text: "exactly-once duplicate probe", at: new Date().toISOString(), by: "second-process", run_identity: live.fixture.run_identity };
    dropFile(join(root, "rw", "inbound"), "task-1.json", payload);
    await waitFor(() => live.tasks.length === 1, 3000, "first inbound task");
    dropFile(join(root, "rw", "inbound"), "task-1.json", payload);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(live.tasks.length, 1, "duplicate transport id does not wake twice");
    assert.ok(existsSync(join(root, "rw", "inbound", "processed", "task-1.json")));
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: answer follow-up is delivered through the same RW channel with its run identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-answer-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const live = startLiveDispatcher(root, persistedConfig("rw"));
    stop = live.stop;
    dropFile(join(root, "rw", "answers"), "ans-1.json", {
      id: `${live.fixture.run_identity.run_id}/team-a/q1`,
      answer: "yes",
      at: new Date().toISOString(),
      by: "user-1",
      run_identity: live.fixture.run_identity,
    });
    await waitFor(() => live.answers.length === 1, 3000, "RW answer delivery");
    assert.equal(live.answers[0]?.answer, "yes");
    assert.equal(live.answers[0]?.id, `${live.fixture.run_identity.run_id}/team-a/q1`);
    assert.ok(existsSync(join(root, "rw", "answers", "processed", "ans-1.json")));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(live.answers.length, 1);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: read-only channels are never wired or polled for inbound", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-ro-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const live = startLiveDispatcher(root, persistedConfig("ro", "read-only"), "ro");
    stop = live.stop;
    dropFile(join(root, "ro", "inbound"), "task-1.json", {
      id: "t1",
      text: "ro task",
      at: new Date().toISOString(),
      run_identity: live.fixture.run_identity,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(existsSync(join(root, "ro", "inbound", "task-1.json")), "RO inbound file remains untouched");
    assert.equal(existsSync(join(root, "ro", "inbound", "processed")), false);
    assert.equal(live.tasks.length, 0);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
