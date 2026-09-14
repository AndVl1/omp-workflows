import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedProjectRoot } from "../../core/src/specification/pinned-root.js";
import { realpathSync } from "node:fs";
import {
  buildCtoTerminalSummaryEnvelope,
  canonicalDurableIdFileName,
  type Escalation,
} from "@andvl1/omp-workflows-core";
import {
  bridgeLockPath,
  clearBridgeLock,
  createAuthenticatedInboxEnvelope,
  drainOutbox as drainOutboxRaw,
  outboxDir,
  queueCtoDelivery,
  createChannelSet,
  pollInbox as pollInboxRaw,
  refreshBridgeLock,
  resolveInboxRunId as resolveInboxRunIdRaw,
  startDispatcher as startDispatcherRaw,
  writeBridgeLock,
} from "../src/adapters/registry.js";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState, readCtoState, setCtoPause } from "../../core/src/cto/state.js";
import { openFullstackRuntimeTest, type FullstackRuntimeTestFixture } from "./runtime-access-fixture.js";
import { bindAuthenticatedAdapterRouting } from "./routing-fixture.js";
import { BoundedQueue, type BoundedQueueEntryExpectation } from "@andvl1/omp-workflows-core/queue";

const runtimeFixtures = new Map<string, FullstackRuntimeTestFixture>();
const retryDrainContexts = new Map<string, { retryCursorStore: Map<string, string | null>; retryMatchStateStore: Map<string, any>; retryMatchCursorStore: Map<string, string | null> }>();
function retryDrainContext(root: string) {
  let context = retryDrainContexts.get(root);
  if (!context) {
    context = { retryCursorStore: new Map(), retryMatchStateStore: new Map(), retryMatchCursorStore: new Map() };
    retryDrainContexts.set(root, context);
  }
  return context;
}
function runtimeFixtureFor(root: string) {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const fixture = openFullstackRuntimeTest(root, "retry-lane-test");
  runtimeFixtures.set(root, fixture);
  return fixture;
}
function runtimeFor(root: string) { return runtimeFixtureFor(root).access; }
function proofFor(root: string) { return runtimeFixtureFor(root).proofAuthority; }
test.afterEach(() => {
  for (const fixture of runtimeFixtures.values()) fixture.close();
  runtimeFixtures.clear();
  retryDrainContexts.clear();
});

function resolveInboxRunId(...args: Parameters<typeof resolveInboxRunIdRaw>): ReturnType<typeof resolveInboxRunIdRaw> {
  const [root, pinnedRoot] = args;
  return resolveInboxRunIdRaw(root, pinnedRoot, runtimeFor(root));
}
async function drainOutbox(...args: Parameters<typeof drainOutboxRaw>): ReturnType<typeof drainOutboxRaw> {
  const [root, adapter, maxRetries, options] = args;
  const runtimeAccess = runtimeFor(root);
  const pinnedRoot = options?.pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    if (adapter) assert.equal(bindAuthenticatedAdapterRouting(root, adapter, runtimeAccess, pinnedRoot), true, "retry test adapter has authenticated routing");
    return await drainOutboxRaw(root, adapter, maxRetries, { ...retryDrainContext(root), ...options, proofAuthority: proofFor(root), pinnedRoot, runtimeAccess });
  } finally {
    if (!options?.pinnedRoot) pinnedRoot.close();
  }
}
function pollInbox(...args: Parameters<typeof pollInboxRaw>): ReturnType<typeof pollInboxRaw> {
  const [root, adapter, onTask, onAnswer, options] = args;
  return pollInboxRaw(root, adapter, onTask, onAnswer, { ...options, proofAuthority: proofFor(root), runtimeAccess: runtimeFor(root), serviceAuthority: runtimeFixtures.get(root)?.serviceAuthority });
}
function startDispatcher(...args: Parameters<typeof startDispatcherRaw>): ReturnType<typeof startDispatcherRaw> {
  const [root, adapter, intervalMs, options] = args;
  const runtimeAccess = runtimeFor(root);
  const pinnedRoot = options?.pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    if (adapter) assert.equal(bindAuthenticatedAdapterRouting(root, adapter, runtimeAccess, pinnedRoot), true, "retry dispatcher adapter has authenticated routing");
    const fixture = runtimeFixtures.get(root) ?? openFullstackRuntimeTest(root, "retry-lane-test");
    runtimeFixtures.set(root, fixture);
    return startDispatcherRaw(root, adapter, intervalMs, { ...options, proofAuthority: fixture.proofAuthority, pinnedRoot, runtimeAccess, session_id: options?.session_id ?? fixture.sessionId, liveGuard: options?.liveGuard ?? fixture.liveGuard, serviceAuthority: options?.serviceAuthority ?? fixture.serviceAuthority });
  } catch (error) {
    if (!options?.pinnedRoot) pinnedRoot.close();
    throw error;
  }
}

function persistRuntimeState(root: string, state: ReturnType<typeof newCtoState>): void {
  const access = runtimeFor(root);
  const existing = readCtoState(state.id, root);
  if (!existing) {
    state.owner_session = "retry-lane-test";
    access.createRun(state, { source_id: "retry-fixture:" + state.id, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) });
    return;
  }
  access.withRunTransaction(state.id, (transaction) => {
    const current = transaction.readState();
    const revision = current.state_revision;
    Object.assign(current, state);
    current.state_revision = revision;
    transaction.writeState(current);
  });
}

function createIndexedPendingRun(root: string, runId: string): void {
  const state = newCtoState({
    id: runId,
    task: "retry lane test",
    branch: "main",
    autonomous: true,
    plan: { id: runId, task: "retry lane test", teams: [], created_at: new Date().toISOString() },
  });
  persistRuntimeState(root, state);
  assert.equal(runtimeFor(root).markDeliveryPending(runId), true);
}
function publishCurrentDelivery(root: string, runId: string, delivery: Record<string, unknown>): Record<string, unknown> {
  const state = readCtoState(runId, root);
  assert.ok(state, `retry fixture state ${runId} is persisted`);
  const payload = {
    ...delivery,
    intent: delivery.intent ?? "question",
    at: delivery.at ?? new Date().toISOString(),
    by: delivery.by ?? "retry-test",
    run_id: runId,
    state_revision: state.state_revision,
    idempotency_key: delivery.idempotency_key ?? delivery.id,
  };
  const entryName = canonicalDurableIdFileName(String(payload.id));
  const published = queueCtoDelivery(root, runId, payload as Escalation, undefined, undefined, runtimeFor(root));
  assert.ok(published, `retry fixture publication ${runId}/${entryName} is canonical`);
  return payload;
}

function jsonEntries(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".json"));
}

function jsonCount(directory: string): number {
  return existsSync(directory) ? jsonEntries(directory).length : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function readDeliveryEntry(root: string, runId: string): { pending_outbox?: boolean; pending_retry?: boolean; pending_summary?: boolean } | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".work-state", "cto", "active-run-index.json"), "utf8")) as { entries?: Array<{ run_id?: unknown; pending_outbox?: unknown; pending_retry?: unknown; pending_summary?: unknown }> };
    const entry = raw.entries?.find((candidate) => candidate.run_id === runId);
    return entry
      ? {
          pending_outbox: entry.pending_outbox === true,
          pending_retry: entry.pending_retry === true,
          pending_summary: entry.pending_summary === true,
        }
      : null;
  } catch {
    return null;
  }
}

test("routing config replacement blocks redirect until trusted republish", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-routing-redirect-"));
  const runId = "routing-redirect";
  const calls: Array<{ url: string; body: string; idempotency?: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({ url, body, ...(headers.get("idempotency-key") === null ? {} : { idempotency: headers.get("idempotency-key")! }) });
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "idempotency-key": headers.get("idempotency-key") ?? "" } });
  };
  const writeRoutingConfig = (telegramToken: string, httpUrl: string): void => {
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ channels: [
      { id: " primary ", adapter: "telegram", direction: "read-write", primary: true, ackTarget: "chat-expected", telegram: { token: telegramToken, chatId: "chat-expected" } },
      { id: "audit", adapter: "http", direction: "read-only", subscriptions: ["summary"], http: { url: httpUrl } },
    ] }) + "\n");
  };
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeRoutingConfig("123:old-token", "https://old-audit.example/topic");
    createIndexedPendingRun(root, runId);
    const routedState = readCtoState(runId, root);
    assert.ok(routedState);
    routedState.channel_profile = { direction: "rw", adapter: "telegram", transport: "telegram", ackTarget: "chat-expected", primary: true };
    persistRuntimeState(root, routedState);
    const delivery = {
      id: `${runId}/question`, level: "question", title: "route guard", body: "route guard", intent: "ack", target: "chat-expected",
      at: new Date().toISOString(), by: "routing-test", run_id: runId, idempotency_key: `${runId}/question`,
    };
    const oldSet = createChannelSet(root, undefined, undefined, runtimeFor(root), proofFor(root));
    assert.ok(oldSet.primary, "old endpoint adapter is constructed");
    assert.ok(queueCtoDelivery(root, runId, delivery, undefined, undefined, runtimeFor(root)));
    writeRoutingConfig("456:new-token", "https://new-audit.example/topic");
    const blocked = await drainOutbox(root, oldSet.primary, 1);
    assert.equal(blocked.some((entry) => entry.sent), false, "a config redirect must not send through the stale old endpoint adapter");
    assert.equal(calls.length, 0, "stale config sends zero requests");
    assert.equal(existsSync(join(root, ".work-state", "cto", runId, "outbox", canonicalDurableIdFileName(delivery.id))), true);
    assert.equal(queueCtoDelivery(root, runId, delivery, undefined, undefined, runtimeFor(root)), null, "trusted republish is idempotent while rebinding the new routing receipt");
    const newSet = createChannelSet(root, undefined, undefined, runtimeFor(root), proofFor(root));
    assert.ok(newSet.primary, "new endpoint adapter is constructed after explicit rebind");
    const delivered = await drainOutbox(root, newSet.primary, 1);
    assert.equal(delivered.some((entry) => entry.sent), true, "the exact republish under the replacement config may send once");
    assert.equal(calls.length, 1, "new primary receives the targeted ACK once");
    assert.match(calls[0]!.url, /bot456:new-token\/sendMessage/u);
    const noTarget = { ...delivery, id: `${runId}/no-target`, target: undefined, intent: "question", idempotency_key: `${runId}/no-target` };
    assert.ok(queueCtoDelivery(root, runId, noTarget, undefined, undefined, runtimeFor(root)));
    const noTargetResult = await drainOutbox(root, newSet.primary, 1);
    assert.equal(noTargetResult.some((entry) => entry.sent), true, "an unaddressed ACK resolves through the bound primary profile");
    assert.equal(calls.length, 2, "unaddressed ACK sends through primary only");
    const summaryRunId = `${runId}-summary`;
    createIndexedPendingRun(root, summaryRunId);
    const summaryState = readCtoState(summaryRunId, root);
    assert.ok(summaryState);
    summaryState!.channel_profile = { direction: "rw", adapter: "telegram", transport: "telegram", ackTarget: "chat-expected", primary: true };
    const summaryWave = {
      id: "wave-summary",
      source: "retry-test",
      source_id: `${summaryRunId}-source`,
      task: "route summary",
      slice_ids: [],
      status: "done" as const,
      outcome: "pass" as const,
      started_at: new Date(0).toISOString(),
      finished_at: new Date(1_000).toISOString(),
    };
    summaryState!.wave_history = [summaryWave];
    persistRuntimeState(root, summaryState!);
    runtimeFor(root).withRunTransaction(summaryRunId, (transaction) => { const current = transaction.readState(); setCtoPause(current, "done", "summary"); transaction.writeState(current); });
    const summaryCurrent = readCtoState(summaryRunId, root);
    assert.ok(summaryCurrent);
    const summary = buildCtoTerminalSummaryEnvelope(summaryCurrent!, summaryWave);
    assert.ok(queueCtoDelivery(root, summaryRunId, summary, undefined, undefined, runtimeFor(root)));
    const summaryResult = await drainOutbox(root, newSet.primary, 1, { roSinks: newSet.roSinks });
    assert.equal(summaryResult.some((entry) => entry.sent), true, "summary is delivered by the primary");
    assert.equal(calls.length, 4, "summary primary and sink sends are observable");
    assert.match(calls[2]!.url, /bot456:new-token\/sendMessage/u);
    assert.equal(calls.filter((call) => call.url === "https://new-audit.example/topic").length, 1, "the subscribed HTTP RO sink receives the summary");
    const wrongTarget = { ...delivery, id: `${runId}/wrong-target`, target: "chat-wrong", idempotency_key: `${runId}/wrong-target` };
    assert.equal(queueCtoDelivery(root, runId, wrongTarget, undefined, undefined, runtimeFor(root)), null, "a wrong ACK target is rejected before publication");
    const wrongTargetResult = await drainOutbox(root, newSet.primary, 1);
    assert.equal(wrongTargetResult.some((entry) => entry.sent), false, "a wrong ACK target remains blocked even on the replacement adapter");
    assert.equal(calls.length, 4, "wrong target causes zero additional primary sends");
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane acknowledges an active retry-only marker after promotion drains", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-active-retry-only-"));
  const runId = "active-retry-only";
  const active = outboxDir(runId, root);
  const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
  const deliveryName = canonicalDurableIdFileName(`${runId}/question`);
  try {
    createIndexedPendingRun(root, runId);
    publishCurrentDelivery(root, runId, {
      id: `${runId}/question`,
      level: "question",
      title: "retry-only",
      body: "retry-only",
    });
    let now = Date.now();
    const failed = await drainOutbox(root, {
      kind: "retry-only-failed",
      send: async () => ({ sent: false }),
      cancel: async () => undefined,
    }, 1, { now: () => now });
    assert.equal(failed[0]?.sent, false);
    assert.deepEqual(readDeliveryEntry(root, runId), { pending_outbox: true, pending_retry: true, pending_summary: false });
    assert.equal(jsonCount(retryDirectory), 1);

    now += 60_000;
    let sends = 0;
    const stop = startDispatcher(root, {
      kind: "retry-only-success",
      send: async () => ({ sent: true }),
      sendWithIdempotency: async () => {
        sends += 1;
        return { sent: true };
      },
      cancel: async () => undefined,
    }, 5, { now: () => now });
    let cleared = false;
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const entry = readDeliveryEntry(root, runId);
        if (entry && !entry.pending_outbox && !entry.pending_retry && !entry.pending_summary) {
          cleared = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      stop();
    }
    assert.equal(cleared, true, "active retry-only marker is acknowledged once the retry lane drains");
    assert.equal(sends, 1);
    assert.equal(jsonCount(retryDirectory), 0);
    assert.equal(existsSync(join(active, "sent", deliveryName)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("retry lane clears a crash-left duplicate after canonical send", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-retry-crash-left-"));
  const runId = "retry-crash-left";
  const active = outboxDir(runId, root);
  const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
  const deliveryName = canonicalDurableIdFileName(`${runId}/question`);
  const envelope = {
    id: `${runId}/question`,
    level: "question",
    title: "crash-left",
    body: "same delivery",
  };
  try {
    createIndexedPendingRun(root, runId);
    let canonicalEnvelope = publishCurrentDelivery(root, runId, envelope);
    // queueCtoDelivery rebinds the payload to the obligation CAS revision;
    // seed the simulated crash-left retry from those exact durable bytes.
    canonicalEnvelope = JSON.parse(readFileSync(join(active, deliveryName), "utf8")) as Record<string, unknown>;
    mkdirSync(retryDirectory, { recursive: true });
    const dueAt = Date.now() - 1;
    const originalNameHash = createHash("sha256").update(deliveryName, "utf8").digest("hex");
    const retryName = `r2.1.${dueAt}.${originalNameHash}.${randomUUID()}.json`;
    writeFileSync(join(retryDirectory, retryName), JSON.stringify(canonicalEnvelope));
    assert.equal(runtimeFor(root).markDeliveryPending(runId, canonicalEnvelope.state_revision as number, "retry"), true, "seeded crash-left retry preserves the retry pending marker");

    let sends = 0;
    const idempotencyKeys: string[] = [];
    const adapter: EscalationAdapter & { sendWithIdempotency: (delivery: Escalation, key: string) => Promise<{ sent: true }> } = {
      kind: "crash-left",
      send: async () => { throw new Error("non-idempotent path was used"); },
      sendWithIdempotency: async (_delivery, key) => {
        sends += 1;
        idempotencyKeys.push(key);
        return { sent: true };
      },
      cancel: async () => undefined,
    };
    const first = await drainOutbox(root, adapter, 1, { now: () => Date.now(), requireIdempotency: true });
    assert.equal(first[0]?.sent, true);
    assert.equal(sends, 1);
    assert.deepEqual(idempotencyKeys, [String(canonicalEnvelope.id)]);
    assert.equal(existsSync(join(active, "sent", deliveryName)), true);
    const sentDirectory = join(active, "sent");
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(sentDirectory, `aaa-${String(index).padStart(2, "0")}.json`), JSON.stringify({
        id: `${runId}/unrelated/${index}`,
        level: "question",
        title: "unrelated",
        body: "unrelated",
      }));
    }
    assert.equal(jsonCount(retryDirectory), 0, "exact canonical duplicate is removed after the first transport success");
    assert.equal(sends, 1, "the duplicate does not trigger a second transport send");
    assert.deepEqual(idempotencyKeys, [String(canonicalEnvelope.id)], "the canonical send keeps its stable idempotency key");
    assert.equal(existsSync(join(active, "sent", deliveryName)), true, "canonical send is archived exactly once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("retry lane quarantines legacy r1 wrappers without external delivery", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-retry-crash-left-"));
  const runId = "legacy-retry-crash-left";
  const active = outboxDir(runId, root);
  const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
  const envelope = {
    id: `${runId}/question`,
    level: "question",
    title: "legacy crash-left",
    body: "same legacy delivery",
  };
  try {
    createIndexedPendingRun(root, runId);
    mkdirSync(active, { recursive: true });
    mkdirSync(retryDirectory, { recursive: true });
    const legacyOriginalName = "legacy-source.json";
    const legacyActiveName = `r1a.1.${randomUUID()}.${Buffer.from(legacyOriginalName, "utf8").toString("base64url")}.json`;
    writeFileSync(join(active, legacyActiveName), JSON.stringify(envelope));
    assert.equal(runtimeFor(root).markDeliveryPending(runId, undefined, "retry"), true);
    const encodedOriginalName = Buffer.from(legacyActiveName, "utf8").toString("base64url");
    const retryName = `r1.1.${Date.now() - 1}.${randomUUID()}.${encodedOriginalName}.json`;
    writeFileSync(join(retryDirectory, retryName), JSON.stringify(envelope));

    let sends = 0;
    const adapter: EscalationAdapter = {
      kind: "legacy-crash-left",
      send: async () => {
        sends += 1;
        return { sent: true };
      },
      cancel: async () => undefined,
    };
    const first = await drainOutbox(root, adapter, 1, { now: () => Date.now() });
    const second = await drainOutbox(root, adapter, 1, { now: () => Date.now() });
    assert.ok(first.length + second.length > 0);
    assert.equal(first.some((entry) => entry.sent) || second.some((entry) => entry.sent), false);
    assert.equal(sends, 0, "legacy wrappers never authorize an external send");
    assert.equal(jsonCount(retryDirectory), 0, "legacy retry wrappers are removed from the active retry lane");
    assert.ok((first.some((entry) => typeof entry.error === "string") || second.some((entry) => typeof entry.error === "string")), "legacy wrappers expose a quarantine reason");
    assert.equal(existsSync(join(active, "sent", legacyOriginalName)), false);
    assert.equal(existsSync(join(active, "sent", legacyActiveName)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("retry lane quarantines malformed legacy retries until authoritative recovery", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-retry-malformed-"));
  const runId = "legacy-retry-malformed";
  const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
  const rejectedDirectory = join(root, ".work-state", "cto", runId, "outbox-rejected");
  const rejectedEntries = (): string[] => existsSync(rejectedDirectory) ? readdirSync(rejectedDirectory) : [];
  try {
    createIndexedPendingRun(root, runId);
    assert.equal(runtimeFor(root).markDeliveryPending(runId, undefined, "retry"), true);
    mkdirSync(retryDirectory, { recursive: true });
    const encodedName = (name: string): string => Buffer.from(name, "utf8").toString("base64url");
    const malformedName = "legacy-malformed.json";
    const primitiveName = "legacy-primitive.json";
    const legacyRetryName = (originalName: string): string =>
      "r1.1." + String(Date.now() - 1) + "." + randomUUID() + "." + encodedName(originalName) + ".json";
    writeFileSync(join(retryDirectory, legacyRetryName(malformedName)), "{");
    writeFileSync(join(retryDirectory, legacyRetryName(primitiveName)), JSON.stringify(42));
    let sends = 0;
    let polls = 0;
    const adapter: EscalationAdapter & { pollOnce: () => Promise<unknown[]> } = {
      kind: "legacy-malformed",
      send: async () => {
        sends += 1;
        return { sent: true };
      },
      sendWithIdempotency: async () => {
        sends += 1;
        return { sent: true };
      },
      cancel: async () => undefined,
      pollOnce: async () => { polls += 1; return []; },
    };
    await drainOutbox(root, adapter, 1, { now: () => Date.now() });
    assert.equal(sends, 0);
    assert.equal(jsonCount(retryDirectory), 0);
    assert.equal(rejectedEntries().length, 2, "malformed legacy retries leave durable rejected evidence");
    assert.deepEqual(readDeliveryEntry(root, runId), { pending_outbox: true, pending_retry: true, pending_summary: false });
    await drainOutbox(root, adapter, 1, { now: () => Date.now() });
    assert.equal(sends, 0);
    assert.equal(rejectedEntries().length, 2);
    assert.deepEqual(readDeliveryEntry(root, runId), { pending_outbox: true, pending_retry: true, pending_summary: false });

    const stopBeforeRecovery = startDispatcher(root, adapter, 5);
    try {
      for (let attempt = 0; attempt < 200 && polls < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await stopBeforeRecovery();
    }
    assert.ok(polls >= 1, "dispatcher observes malformed retry evidence");
    assert.equal(sends, 0, "malformed retries never reach transport");
    assert.deepEqual(readDeliveryEntry(root, runId), { pending_outbox: true, pending_retry: true, pending_summary: false });
    assert.equal(rejectedEntries().length, 2, "dispatcher does not clear rejected evidence without recovery");

    const recoveredEnvelope = publishCurrentDelivery(root, runId, {
      id: runId + "/question/recovered",
      level: "question",
      title: "recovered",
      body: "authoritative recovery",
    });
    polls = 0;
    const stopAfterRecovery = startDispatcher(root, adapter, 5);
    let recovered = false;
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entry = readDeliveryEntry(root, runId);
        if (sends >= 1 && entry && !entry.pending_outbox && !entry.pending_retry && !entry.pending_summary) {
          recovered = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await stopAfterRecovery();
    }
    assert.equal(recovered, true, "dispatcher sends, archives, and acknowledges authoritative recovery");
    assert.equal(sends, 1, "authoritative recovery sends exactly once");
    assert.equal(rejectedEntries().length, 0, "rejected evidence clears only after successful archive");
    assert.equal(existsSync(join(outboxDir(runId, root), "sent", canonicalDurableIdFileName(String(recoveredEnvelope.id)))), true);
    assert.deepEqual(readDeliveryEntry(root, runId), { pending_outbox: false, pending_retry: false, pending_summary: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("retry lane promotes and delivers a terminal retry-only summary", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-terminal-retry-only-"));
  const runId = "terminal-retry-only";
  const active = outboxDir(runId, root);
  const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
  try {
    const now = new Date().toISOString();
    const state = newCtoState({
      id: runId,
      task: "terminal retry-only test",
      branch: "main",
      autonomous: true,
      plan: { id: runId, task: "terminal retry-only test", teams: [], created_at: now },
    });
    state.integration.status = "done";
    state.pause = { kind: "done", reason: "terminal retry-only test" };
    state.wave_history = [{
      id: "wave-1",
      source: "inbox",
      source_id: `${runId}-source`,
      task: "terminal retry-only summary",
      slice_ids: [],
      status: "done",
      started_at: now,
      finished_at: now,
    }];
    persistRuntimeState(root, state);
    const wave = state.wave_history[0];
    assert.ok(wave);
    const summary = buildCtoTerminalSummaryEnvelope(state, wave);
    assert.equal(runtimeFor(root).markDeliveryPending(runId, state.state_revision, "summary"), true);
    const publishedSummary = publishCurrentDelivery(root, runId, summary as unknown as Record<string, unknown>);
    assert.deepEqual(publishedSummary, summary);

    const failed = await drainOutbox(root, {
      kind: "terminal-retry-failed",
      send: async () => ({ sent: false }),
      cancel: async () => undefined,
    }, 1, { now: () => Date.now() });
    assert.equal(failed[0]?.sent, false);
    assert.deepEqual(readDeliveryEntry(root, runId), { pending_outbox: true, pending_retry: true, pending_summary: true });
    assert.equal(jsonCount(retryDirectory), 1);

    let sends = 0;
    const recovered = await drainOutbox(root, {
      kind: "terminal-retry-success",
      send: async () => {
        sends += 1;
        return { sent: true };
      },
      cancel: async () => undefined,
    }, 1, { now: () => Date.now() });
    assert.equal(recovered[0]?.sent, true);
    assert.equal(sends, 1);
    assert.equal(existsSync(join(active, "sent", canonicalDurableIdFileName(summary.id))), true);
    await drainOutbox(root, {
      kind: "terminal-retry-cleanup",
      send: async () => ({ sent: true }),
      cancel: async () => undefined,
    }, 1);
    assert.equal(jsonCount(retryDirectory), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("retry lane drains a preexisting direct entry before a completed wave summary in one tick", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-direct-summary-same-tick-"));
  const runId = "direct-summary-same-tick";
  const active = outboxDir(runId, root);
  try {
    const now = new Date().toISOString();
    const state = newCtoState({
      id: runId,
      task: "direct plus summary test",
      branch: "main",
      autonomous: true,
      plan: { id: runId, task: "direct plus summary test", teams: [], created_at: now },
    });
    state.wave_history = [{
      id: "wave-1",
      source: "inbox",
      source_id: `${runId}-source`,
      task: "completed wave",
      slice_ids: [],
      status: "done",
      started_at: now,
      finished_at: now,
    }];
    persistRuntimeState(root, state);
    const direct = {
      id: `${runId}/question/direct`,
      level: "question",
      title: "direct delivery",
      body: "deliver the direct entry",
    };
    const wave = state.wave_history[0];
    assert.ok(wave);
    const summary = buildCtoTerminalSummaryEnvelope(state, wave);
    assert.equal(runtimeFor(root).markDeliveryPending(runId, state.state_revision, "outbox"), true);
    const publishedDirect = publishCurrentDelivery(root, runId, direct);
    const publishedSummary = publishCurrentDelivery(root, runId, summary as unknown as Record<string, unknown>);
    const directName = canonicalDurableIdFileName(String(publishedDirect.id));
    const summaryName = canonicalDurableIdFileName(String(publishedSummary.id));

    const sent: string[] = [];
    const adapter = {
      kind: "direct-plus-summary",
      send: async (envelope: { id: string }) => {
        sent.push(envelope.id);
        return { sent: true };
      },
      cancel: async () => undefined,
    };
    const results = await drainOutbox(root, adapter, 1, { outboxEntry: { runId, name: directName } });
    assert.equal(results.length, 2, "direct and newly produced summary drain in one tick");
    assert.deepEqual(sent, [direct.id, summary.id], "direct entry retains priority while the summary is not dropped");
    assert.equal(existsSync(join(active, "sent", directName)), true);
    assert.equal(existsSync(join(active, "sent", summaryName)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane preserves active attempt metadata across three failures and archives the original summary name", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-retry-backoff-metadata-"));
  const runId = "retry-backoff-metadata";
  const active = outboxDir(runId, root);
  const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
  const nowState = new Date().toISOString();
  let now = 1_000_000;
  try {
    const state = newCtoState({
      id: runId,
      task: "retry backoff metadata test",
      branch: "main",
      autonomous: true,
      plan: { id: runId, task: "retry backoff metadata test", teams: [], created_at: nowState },
    });
    state.integration.status = "done";
    state.pause = { kind: "done", reason: "retry backoff metadata test" };
    state.wave_history = [{
      id: "wave-1",
      source: "inbox",
      source_id: `${runId}-source`,
      task: "retry backoff summary",
      slice_ids: [],
      status: "done",
      started_at: nowState,
      finished_at: nowState,
    }];
    persistRuntimeState(root, state);
    const wave = state.wave_history[0];
    assert.ok(wave);
    const summary = buildCtoTerminalSummaryEnvelope(state, wave);
    assert.equal(runtimeFor(root).markDeliveryPending(runId, state.state_revision, "summary"), true);
    const publishedSummary = publishCurrentDelivery(root, runId, summary as unknown as Record<string, unknown>);
    const summaryName = canonicalDurableIdFileName(String(publishedSummary.id));

    let sends = 0;
    const adapter: EscalationAdapter = {
      kind: "retry-backoff-metadata",
      send: async () => {
        sends += 1;
        return { sent: sends === 4 };
      },
      cancel: async () => undefined,
    };
    const retryMetadata = (): { name: string; attempt: number; dueAt: number } => {
      const name = jsonEntries(retryDirectory).find((entry) => entry.startsWith("r2."));
      assert.ok(name);
      const fields = name.split(".");
      assert.equal(fields[0], "r2");
      return { name, attempt: Number(fields[1]), dueAt: Number(fields[2]) };
    };

    const first = await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(first[0]?.sent, false);
    const retry1 = retryMetadata();
    assert.equal(retry1.attempt, 1);
    assert.equal(retry1.dueAt, now, "terminal summary gets one immediate retry");

    const second = await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(second[0]?.sent, false);
    const retry2 = retryMetadata();
    assert.equal(retry2.attempt, 2);
    assert.ok(retry2.dueAt > now, "attempt two backs off instead of retrying in a tight loop");
    assert.equal(jsonEntries(active).length, 0, "failed promoted active wrapper is removed before retry retention");
    const retained = await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(retained.length, 0, "restart-style tick retains an undued retry");
    assert.equal(sends, 2);

    now = retry2.dueAt;
    const third = await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(third[0]?.sent, false);
    const retry3 = retryMetadata();
    assert.equal(retry3.attempt, 3);
    assert.ok(retry3.dueAt > now, "attempt three retains exponential backoff");
    assert.equal(sends, 3);
    now = retry3.dueAt;
    const fourth = await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(fourth[0]?.sent, true);
    assert.equal(sends, 4, "the summary is sent exactly once after three failures");
    assert.equal(existsSync(join(active, "sent", summaryName)), true, "success archives under the original durable filename");
    await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(jsonCount(retryDirectory), 0);
    const after = await drainOutbox(root, adapter, 1, { now: () => now });
    assert.equal(after.length, 0);
    assert.equal(sends, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane direct API without persistent context defers without resetting", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-retry-context-required-"));
  const runId = "retry-context-required";
  try {
    createIndexedPendingRun(root, runId);
    const delivery = publishCurrentDelivery(root, runId, { id: `${runId}/target`, level: "question", title: "target", body: "target" });
    const adapter: EscalationAdapter = { kind: "retry-context-required", send: async () => ({ sent: false }), cancel: async () => undefined };
    const access = runtimeFor(root);
    assert.equal(bindAuthenticatedAdapterRouting(root, adapter, access), true);
    const options = { runtimeAccess: access, proofAuthority: proofFor(root), now: () => 1_000_000 };
    const first = await drainOutboxRaw(root, adapter, 1, options);
    assert.equal(first[0]?.sent, false);
    const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
    assert.equal(jsonCount(retryDirectory), 0, "without a persistent scan context no retry wrapper is created");
    assert.equal(existsSync(join(outboxDir(runId, root), canonicalDurableIdFileName(String(delivery.id)))), true, "authenticated active source remains durable");
    const second = await drainOutboxRaw(root, adapter, 1, options);
    assert.equal(second[0]?.sent, false);
    assert.equal(jsonCount(retryDirectory), 0, "repeated context-less ticks cannot reset or duplicate attempts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane fair rotation preserves one delivery attempt across restart", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-retry-fair-identity-"));
  const runId = "retry-fair-identity";
  const now = 1_000_000;
  const future = now + 60_000;
  try {
    createIndexedPendingRun(root, runId);
    const target = publishCurrentDelivery(root, runId, { id: `${runId}/target`, level: "question", title: "target", body: "target" });
    const targetName = canonicalDurableIdFileName(String(target.id));
    let sends = 0;
    const adapter: EscalationAdapter = {
      kind: "retry-fair-identity",
      send: async (delivery) => {
        if (delivery.id !== target.id) return { sent: true };
        sends += 1;
        return { sent: false };
      },
      cancel: async () => undefined,
    };
    const cursorStore = new Map<string, string | null>();
    const matchStateStore = new Map();
    const matchCursorStore = new Map<string, string | null>();
    const first = await drainOutbox(root, adapter, 1, { now: () => now, retryCursorStore: cursorStore, retryMatchStateStore: matchStateStore, retryMatchCursorStore: matchCursorStore });
    assert.equal(first[0]?.sent, false);
    const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
    const targetRetryName = (): string => {
      const names = jsonEntries(retryDirectory).filter((name) => name.includes(createHash("sha256").update(targetName, "utf8").digest("hex")));
      assert.equal(names.length, 1, "exactly one target retry wrapper exists");
      return names[0]!;
    };
    const firstRetry = targetRetryName();
    assert.equal(Number(firstRetry.split(".")[1]), 1);

    // Seed two pages of authenticated foreign wrappers whose names sort
    // before the target. They are due in the same tick and are acknowledged
    // by the adapter, so the target must still be reached by fair rotation.
    const targetHash = createHash("sha256").update(targetName, "utf8").digest("hex");
    const targetDueAt = Number(firstRetry.split(".")[2]);
    let seeded = 0;
    let candidate = 0;
    while (seeded < 16) {
      const id = `${runId}/foreign-${String(candidate++).padStart(3, "0")}`;
      const name = canonicalDurableIdFileName(id);
      const hash = createHash("sha256").update(name, "utf8").digest("hex");
      if (hash >= targetHash) continue;
      publishCurrentDelivery(root, runId, { id, level: "question", title: id, body: id });
      const activePath = join(outboxDir(runId, root), name);
      const retryName = `r2.1.${targetDueAt}.${hash}.${randomUUID()}.json`;
      renameSync(activePath, join(retryDirectory, retryName));
      // The runtime marker is run-scoped; publishCurrentDelivery already
      // committed the obligation, so only the retry lane transition is needed.
      const latest = readCtoState(runId, root);
      assert.ok(latest);
      assert.equal(runtimeFor(root).markDeliveryPending(runId, latest!.state_revision as number, "retry"), true);
      seeded += 1;
    }
    assert.equal(jsonEntries(retryDirectory).filter((name) => name.startsWith("r2.")).length, 17);

    // The first retry pages contain only foreign entries. Fair continuation
    // reaches the target on a later page without materializing the directory.
    await drainOutbox(root, adapter, 1, { now: () => targetDueAt, retryCursorStore: cursorStore, retryMatchStateStore: matchStateStore, retryMatchCursorStore: matchCursorStore });
    await drainOutbox(root, adapter, 1, { now: () => targetDueAt, retryCursorStore: cursorStore, retryMatchStateStore: matchStateStore, retryMatchCursorStore: matchCursorStore });
    await drainOutbox(root, adapter, 1, { now: () => targetDueAt, retryCursorStore: cursorStore, retryMatchStateStore: matchStateStore, retryMatchCursorStore: matchCursorStore });
    const secondRetry = targetRetryName();
    assert.equal(Number(secondRetry.split(".")[1]), 2);
    assert.equal(jsonEntries(retryDirectory).filter((name) => name.includes(targetHash)).length, 1, "target has one wrapper after attempt two");

    // A restart resets only the in-memory cursor; it must defer on the first
    // page rather than creating another attempt-1 wrapper, then continue to
    // attempt three once the target page is reached.
    const restartedCursorStore = new Map<string, string | null>();
    const dueAt = Number(secondRetry.split(".")[2]);
    await drainOutbox(root, adapter, 1, { now: () => dueAt, retryCursorStore: restartedCursorStore });
    await drainOutbox(root, adapter, 1, { now: () => dueAt, retryCursorStore: restartedCursorStore });
    await drainOutbox(root, adapter, 1, { now: () => dueAt, retryCursorStore: restartedCursorStore });
    const thirdRetry = targetRetryName();
    assert.equal(Number(thirdRetry.split(".")[1]), 3);
    assert.equal(jsonEntries(retryDirectory).filter((name) => name.includes(targetHash)).length, 1, "restart preserves one monotonically increasing wrapper");
    assert.ok(sends >= 3, "target was retried only after fair promotion rotations");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Rotate the bridge lease while retaining durable-authenticated ingress. */
function rotateBridgeForDurableRetry(root: string): void {
  clearBridgeLock(root, undefined, undefined, proofFor(root));
  const bridge = writeBridgeLock(root, undefined, proofFor(root));
  assert.equal(bridge.owned, true, "retry fixture bridge rotation succeeds");
}

test("retry lane keeps 64 retryable outbox entries from starving later work", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-retry-lane-"));
  try {
    const runId = "retry-lane";
    createIndexedPendingRun(root, runId);
    const active = outboxDir(runId, root);
    for (let index = 0; index < 64; index += 1) {
      publishCurrentDelivery(root, runId, { id: `${runId}/retry/${index}`, level: "question", title: "retry", body: "retry" });
    }
    const later = publishCurrentDelivery(root, runId, { id: `${runId}/later`, level: "question", title: "later", body: "later" });
    const laterName = canonicalDurableIdFileName(String(later.id));
    const attempts = new Map<string, number>();
    const delivered = new Set<string>();
    const adapter: EscalationAdapter = {
      kind: "mock",
      send: async (escalation: Escalation) => {
        const attempt = (attempts.get(escalation.id) ?? 0) + 1;
        attempts.set(escalation.id, attempt);
        const sent = escalation.title === "later" || attempt > 1;
        if (sent) delivered.add(escalation.id);
        return { sent };
      },
      cancel: async () => undefined,
    };
    let now = Date.now();
    const clock = () => now;
    const first = await drainOutbox(root, adapter, 1, { now: clock });
    assert.ok(first.length > 0 && first.length <= 8, "first tick consumes one eight-entry active page");
    const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
    const retryEntries = jsonEntries(retryDirectory).filter((entry) => entry.startsWith("r2."));
    assert.ok(retryEntries.length <= 8, "retryable failures leave at most one bounded active page in the retry lane");
    let laterSent = false;
    for (let tick = 1; tick < 10; tick += 1) {
      now += 60_000;
      const results = await drainOutbox(root, adapter, 1, { now: clock });
      assert.ok(results.length <= 8, "each active outbox page is bounded");
      laterSent ||= existsSync(join(active, "sent", laterName));
    }
    assert.equal(laterSent || existsSync(join(active, "sent", laterName)), true, "later valid work is not starved by retryables");
    let recoveryTick = 0;
    for (let tick = 0; tick < 128; tick += 1) {
      now += 60_000;
      await drainOutbox(root, adapter, 1, { now: clock });
      if (jsonCount(active) + jsonCount(retryDirectory) === 0) { recoveryTick = tick + 1; break; }
    }
    assert.ok(recoveryTick > 0 && recoveryTick <= 128, "retry outbox recovery converges within the bounded tick budget");
    assert.equal([...delivered].filter((id) => id.includes("/retry/")).length, 64, "every retryable eventually delivers exactly once after promotion");
    assert.equal(jsonEntries(join(active, "sent")).length, 65, "later and every retryable are archived exactly once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane promotes a transient outbox failure after its due time", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-transient-retry-"));
  try {
    const runId = "transient-retry";
    createIndexedPendingRun(root, runId);
    const active = outboxDir(runId, root);
    const envelope = publishCurrentDelivery(root, runId, { id: `${runId}/one`, level: "question", title: "one", body: "one" });
    let attempts = 0;
    const adapter: EscalationAdapter = {
      kind: "mock",
      send: async () => ({ sent: ++attempts > 1 }),
      cancel: async () => undefined,
    };
    let now = Date.now();
    const clock = () => now;
    const first = await drainOutbox(root, adapter, 1, { now: clock });
    assert.equal(first[0]?.sent, false);
    assert.equal(jsonEntries(join(root, ".work-state", "cto", runId, "outbox-retry")).filter((entry) => entry.startsWith("r2.")).length, 1);
    now += 60_000;
    const second = await drainOutbox(root, adapter, 1, { now: clock });
    assert.equal(attempts, 2);
    assert.equal(second.filter((result) => result.sent).length, 1);
    assert.equal(jsonEntries(join(active, "sent")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane bounds long active names and promotes the raw envelope", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-long-name-retry-"));
  try {
    const runId = "long-name-retry";
    createIndexedPendingRun(root, runId);
    const active = outboxDir(runId, root);
    const source = { id: `${runId}/long`, level: "question", title: "long", body: "long" };
    const envelope = publishCurrentDelivery(root, runId, source);
    const originalName = canonicalDurableIdFileName(String(envelope.id));
    assert.ok(Buffer.byteLength(originalName, "utf8") <= 255);
    let attempts = 0;
    const adapter: EscalationAdapter = {
      kind: "mock",
      send: async () => ({ sent: ++attempts > 1 }),
      cancel: async () => undefined,
    };
    let now = Date.now();
    const clock = () => now;
    const first = await drainOutbox(root, adapter, 1, { now: clock });
    assert.equal(first[0]?.sent, false);
    assert.equal(existsSync(join(active, originalName)), false);
    const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
    const retryNames = jsonEntries(retryDirectory).filter((entry) => entry.startsWith("r2."));
    assert.equal(retryNames.length, 1);
    const [retryName] = retryNames;
    assert.ok(retryName.startsWith("r2."));
    assert.ok(Buffer.byteLength(retryName, "utf8") <= 255);
    const retryRecord = JSON.parse(readFileSync(join(retryDirectory, retryName), "utf8")) as Record<string, unknown>;
    const { state_revision: retryRevision, ...retryPayload } = retryRecord;
    const { state_revision: sourceRevision, ...sourcePayload } = envelope;
    assert.deepEqual(retryPayload, sourcePayload, "retry retains the authenticated delivery payload");
    assert.notEqual(retryRevision, undefined, "retry carries the current obligation revision");
    assert.notEqual(sourceRevision, undefined, "published source carries its publication revision");
    assert.ok(retryName.includes(createHash("sha256").update(originalName, "utf8").digest("hex")), "retry filename retains the original-name hash");
    now += 60_000;
    const second = await drainOutbox(root, adapter, 1, { now: clock });
    assert.equal(second.filter((result) => result.sent).length, 1);
    assert.equal(attempts, 2);
    const sentPath = join(active, "sent", originalName);
    const sentRecord = JSON.parse(readFileSync(sentPath, "utf8")) as Record<string, unknown>;
    const { state_revision: sentRevision, ...sentPayload } = sentRecord;
    assert.deepEqual(sentPayload, sourcePayload, "sent archive retains the authenticated delivery payload");
    assert.equal(sentRevision, retryRevision, "retry and sent archive preserve one obligation revision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("retry lane accepts spaces and unicode without starving later work", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-name-policy-retry-"));
  try {
    const runId = "name-policy-retry";
    createIndexedPendingRun(root, runId);
    const active = outboxDir(runId, root);
    const sourceNames = ["late space.json", "échec.json"];
    for (const [index, name] of sourceNames.entries()) {
      publishCurrentDelivery(root, runId, { id: `${runId}/retry-${index}`, level: "question", title: name, body: name });
    }
    const later = publishCurrentDelivery(root, runId, { id: `${runId}/later`, level: "question", title: "later", body: "later" });
    const laterName = canonicalDurableIdFileName(String(later.id));
    const attempts = new Map<string, number>();
    const adapter: EscalationAdapter = {
      kind: "mock",
      send: async (escalation: Escalation) => {
        const attempt = (attempts.get(escalation.id) ?? 0) + 1;
        attempts.set(escalation.id, attempt);
        return { sent: escalation.title === "later" || attempt > 1 };
      },
      cancel: async () => undefined,
    };
    let now = Date.now();
    const clock = () => now;
    const files = jsonEntries(active).map((name) => ({ name, status: runtimeFor(root).currentOutboxDeliveryStatus({ run_id: runId, state_revision: readDeliveryEntry(root, runId)?.state_revision ?? 0, entry_name: name, json: readFileSync(join(active, name), "utf8"), lane: "outbox" }) }));
    const first = await drainOutbox(root, adapter, 1, { now: clock });
    assert.equal(first.length, 3);
    const retryDirectory = join(root, ".work-state", "cto", runId, "outbox-retry");
    const laneEntries = jsonEntries(retryDirectory).filter((entry) => entry.startsWith("r2."));
    assert.ok(laneEntries.length > 0 && laneEntries.length <= sourceNames.length);
    let laterDelivered = existsSync(join(active, "sent", laterName));
    for (let tick = 0; tick < 32 && (!laterDelivered || jsonEntries(join(active, "sent")).length < 3); tick += 1) {
      now += 60_000;
      await drainOutbox(root, adapter, 1, { now: clock });
      laterDelivered = existsSync(join(active, "sent", laterName));
    }
    assert.equal(laterDelivered, true, "canonical hashed names still converge without lexical-name priority");
    assert.equal(jsonEntries(join(active, "sent")).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("inbox retry persistence preserves a replacement after source CAS", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-retry-cas-race-"));
  try {
    const bridge = writeBridgeLock(root, undefined, proofFor(root));
    assert.equal(bridge.owned, true);
    const runId = resolveInboxRunId(root);
    const active = join(root, ".omp", "inbox");
    mkdirSync(active, { recursive: true });
    const envelope = createAuthenticatedInboxEnvelope(root, "answer", {
      id: runId + "/cas-race",
      text: "cas-race",
      at: new Date().toISOString(),
      by: "bridge",
      run_id: runId,
    });
    writeFileSync(join(active, "cas-race.json"), JSON.stringify(envelope));
    let attempts = 0;
    const originalMove = BoundedQueue.prototype.moveToIfMatches;
    let replaced = false;
    BoundedQueue.prototype.moveToIfMatches = function(name: string, expected: BoundedQueueEntryExpectation, destination: string): void {
      if (!replaced && this.relativeDirectory === ".omp/inbox") {
        const current = this.read(name);
        this.writeAtomic(name, current.bytes);
        replaced = true;
      }
      return originalMove.call(this, name, expected, destination);
    };
    try {
      await pollInbox(root, null, undefined, () => {
        attempts += 1;
        throw new Error("transient wake failure");
      }, { now: () => Date.now() });
    } finally {
      BoundedQueue.prototype.moveToIfMatches = originalMove;
    }
    assert.equal(replaced, true, "the replacement was injected after retry-wrapper CAS");
    assert.equal(attempts, 1);
    assert.equal(jsonCount(active), 1, "the replaced active source remains durable");
    assert.equal(jsonCount(join(root, ".omp", "inbox-retry")), 0, "no retry move occurs for a replaced post-CAS source");
  } finally {
    clearBridgeLock(root, undefined, undefined, proofFor(root));
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox retry promotion preserves a concurrent replacement after its receipt is classified", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-retry-receipt-race-"));
  try {
    const bridge = writeBridgeLock(root, undefined, proofFor(root));
    assert.equal(bridge.owned, true);
    const runId = resolveInboxRunId(root);
    const active = join(root, ".omp", "inbox");
    mkdirSync(active, { recursive: true });
    const envelope = createAuthenticatedInboxEnvelope(root, "answer", {
      id: runId + "/receipt-race",
      text: "receipt-race",
      at: new Date().toISOString(),
      by: "bridge",
      run_id: runId,
    });
    writeFileSync(join(active, "receipt-race.json"), JSON.stringify(envelope));
    let attempts = 0;
    const firstNow = Date.now();
    await pollInbox(root, null, undefined, () => {
      attempts += 1;
      throw new Error("transient wake failure");
    }, { now: () => firstNow });
    assert.equal(attempts, 1);
    const retryDirectory = join(root, ".omp", "inbox-retry");
    const retryNames = jsonEntries(retryDirectory);
    const retryName = retryNames[0];
    assert.ok(retryName);
    const originalMove = BoundedQueue.prototype.moveToIfMatches;
    let replaced = false;
    BoundedQueue.prototype.moveToIfMatches = function(name: string, expected: BoundedQueueEntryExpectation, destination: string): void {
      if (this.relativeDirectory === ".omp/inbox-retry") {
        const current = this.read(name);
        this.writeAtomic(name, current.bytes);
        replaced = true;
      }
      return originalMove.call(this, name, expected, destination);
    };
    try {
      await pollInbox(root, null, undefined, () => { throw new Error("must not wake replaced source"); }, { now: () => firstNow + 60_000 });
    } finally {
      BoundedQueue.prototype.moveToIfMatches = originalMove;
    }
    assert.equal(replaced, true, "the adversarial replacement was injected at the promotion boundary");
    assert.equal(attempts, 1, "a replaced retry source is not delivered");
    assert.equal(jsonCount(retryDirectory), 1, "the concurrent replacement remains in the retry lane");
    assert.equal(jsonCount(join(root, ".omp", "inbox")), 0, "the replacement is not blindly promoted into active ingress");
  } finally {
    clearBridgeLock(root, undefined, undefined, proofFor(root));
    rmSync(root, { recursive: true, force: true });
  }
});

test("signed inbox retries survive lease expiry and forged wrappers are discarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-retry-auth-"));
  try {
    writeBridgeLock(root, undefined, proofFor(root));
    const runId = resolveInboxRunId(root);
    const active = join(root, ".omp", "inbox");
    mkdirSync(active, { recursive: true });
    const envelope = createAuthenticatedInboxEnvelope(root, "answer", { id: `${runId}/lease-recovery`, text: "retry", at: new Date().toISOString(), by: "bridge", run_id: runId }, undefined, proofFor(root));
    writeFileSync(join(active, "lease-recovery.json"), JSON.stringify(envelope));
    let attempts = 0;
    const wake = (answer: { id: string; answer: string }): void => {
      assert.equal(answer.id, `${runId}/lease-recovery`);
      attempts += 1;
      if (attempts === 1) throw new Error("transient wake failure");
    };
    let now = Date.now();
    const clock = () => now;
    await pollInbox(root, null, undefined, wake, { now: clock });
    const retryDirectory = join(root, ".omp", "inbox-retry");
    const [retryName] = jsonEntries(retryDirectory);
    assert.ok(retryName, "verified ingress is wrapped into the retry lane");
    const validPath = join(retryDirectory, retryName);
    const forgedPath = join(retryDirectory, retryName.replace(/[0-9a-f-]{36}/u, randomUUID()));
    const forged = JSON.parse(readFileSync(validPath, "utf8")) as { mac?: string };
    forged.mac = "0".repeat(64);
    writeFileSync(forgedPath, JSON.stringify(forged), { flag: "wx" });
    const staleLock = JSON.parse(readFileSync(bridgeLockPath(root), "utf8")) as { heartbeatAt?: string };
    staleLock.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(bridgeLockPath(root), JSON.stringify(staleLock));
    now += 60_000;
    await pollInbox(root, null, undefined, wake, { now: clock });
    assert.equal(attempts, 2, "internal wrapper retries after external lease expiry");
    assert.equal(existsSync(forgedPath), false, "project-forged wrapper is discarded before wake");
    assert.equal(jsonEntries(join(active, "processed")).length, 1, "recovered answer is archived exactly once");
  } finally {
    clearBridgeLock(root, undefined, undefined, proofFor(root));
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane rotates a legacy path-only secret before accepting new retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-retry-legacy-secret-"));
  let legacyPath: string | null = null;
  let previousLegacy: string | null = null;
  try {
    const runId = resolveInboxRunId(root);
    writeBridgeLock(root, undefined, proofFor(root));
    const canonical = realpathSync(root);
    legacyPath = join(homedir(), ".omp", "runtime-secrets", createHash("sha256").update(canonical, "utf8").digest("hex") + ".inbox-retry.json");
    previousLegacy = existsSync(legacyPath) ? readFileSync(legacyPath, "utf8") : null;
    mkdirSync(join(homedir(), ".omp", "runtime-secrets"), { recursive: true });
    const legacySecret = "L".repeat(43);
    writeFileSync(legacyPath, JSON.stringify({ schema: 1, root_identity: canonical, domain: "omp-inbox-retry-v1", secret: legacySecret }));

    const source = createAuthenticatedInboxEnvelope(root, "answer", { id: `${runId}/legacy`, text: "legacy", at: new Date().toISOString(), by: "bridge", run_id: runId }, undefined, proofFor(root));
    const sourceDigest = createHash("sha256").update(canonicalJson(source), "utf8").digest("hex");
    const body = { schema: 1 as const, kind: "inbox-retry" as const, attempt: 1, due_at: 0, original_name: "legacy-answer.json", source, source_digest: sourceDigest, auth_evidence: source.auth };
    const mac = createHmac("sha256", legacySecret).update("omp-inbox-retry-v1\0", "utf8").update(canonical, "utf8").update("\0", "utf8").update(sourceDigest, "utf8").update("\0", "utf8").update(canonicalJson(body), "utf8").digest("hex");
    const retryDirectory = join(root, ".omp", "inbox-retry");
    mkdirSync(retryDirectory, { recursive: true });
    const retryName = `r2.1.0.${createHash("sha256").update(body.original_name, "utf8").digest("hex")}.${randomUUID()}.json`;
    writeFileSync(join(retryDirectory, retryName), JSON.stringify({ ...body, mac }));

    await pollInbox(root, null, undefined, undefined, { now: () => Date.now() + 60_000 });
    assert.equal(jsonCount(retryDirectory), 0, "legacy wrapper is not accepted with a path-only secret");

    const fresh = createAuthenticatedInboxEnvelope(root, "task", { id: `${runId}/fresh`, text: "fresh", at: new Date().toISOString(), by: "bridge", run_id: runId }, undefined, proofFor(root));
    mkdirSync(join(root, ".omp", "inbox"), { recursive: true });
    writeFileSync(join(root, ".omp", "inbox", "fresh.json"), JSON.stringify(fresh));
    const now = Date.now();
    let callbacks = 0;
    await pollInbox(root, null, () => { callbacks += 1; throw new Error("transient"); }, undefined, { now: () => now });
    assert.equal(callbacks, 1);
    assert.equal(jsonCount(retryDirectory), 1, "new identity-bound retry is created after legacy rejection");
    await pollInbox(root, null, () => { callbacks += 1; }, undefined, { now: () => now + 60_000 });
    assert.equal(callbacks, 2, "new identity-bound retry verifies and delivers");
  } finally {
    clearBridgeLock(root, undefined, undefined, proofFor(root));
    if (legacyPath) {
      if (previousLegacy !== null) writeFileSync(legacyPath, previousLegacy);
      else rmSync(legacyPath, { force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry lane rejects a copied same-lexical-root retry wrapper", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-retry-root-replacement-"));
  const displacedParent = mkdtempSync(join(tmpdir(), "cto-inbox-retry-root-old-"));
  const displaced = join(displacedParent, "old");
  const replacement = mkdtempSync(join(tmpdir(), "cto-inbox-retry-root-new-"));
  try {
    const runId = resolveInboxRunId(root);
    writeBridgeLock(root, undefined, proofFor(root));
    const envelope = createAuthenticatedInboxEnvelope(root, "task", {
      id: `${runId}/replacement-retry`,
      text: "retry me",
      at: new Date().toISOString(),
      by: "bridge",
      run_id: runId,
    });
    const active = join(root, ".omp", "inbox");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "replacement-retry.json"), JSON.stringify(envelope));
    const firstNow = Date.now();
    await pollInbox(root, null, () => { throw new Error("transient wake failure"); }, undefined, { now: () => firstNow });
    const retryDirectory = join(root, ".omp", "inbox-retry");
    assert.equal(jsonCount(retryDirectory), 1, "failed wake is represented by a signed retry wrapper");
    const lockBefore = readFileSync(bridgeLockPath(root), "utf8");
    const statePath = join(root, ".work-state", "cto", runId, "state.json");
    const indexPath = join(root, ".work-state", "cto", "active-run-index.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const indexBefore = readFileSync(indexPath, "utf8");

    renameSync(root, displaced);
    renameSync(replacement, root);
    cpSync(join(displaced, ".omp"), join(root, ".omp"), { recursive: true });
    cpSync(join(displaced, ".work-state"), join(root, ".work-state"), { recursive: true });
    const wakes: unknown[] = [];
    await assert.rejects(
      () => pollInbox(root, null, (task) => wakes.push(task), undefined, { now: () => Date.now() + 60_000 }),
      /registration root identity|activation_revoked/,
      "copied retry delivery fails closed when its pinned root identity is replaced",
    );
    assert.equal(wakes.length, 0, "a retry wrapper from the displaced inode cannot deliver in the replacement root");
    assert.equal(jsonCount(join(root, ".omp", "inbox-retry")), 1, "copied retry wrapper remains untouched when replacement-root authority rejects it");
    assert.equal(readFileSync(bridgeLockPath(root), "utf8"), lockBefore, "copied bridge lock remains untouched");
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "copied state remains untouched");
    assert.equal(readFileSync(indexPath, "utf8"), indexBefore, "copied active-run index remains untouched");
    clearBridgeLock(root, undefined, undefined, proofFor(root));
    assert.equal(readFileSync(bridgeLockPath(root), "utf8"), lockBefore, "clear cannot remove a lease from the displaced inode");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
    rmSync(displacedParent, { recursive: true, force: true });
  }
});

test("retry lane keeps 64 failed inbox wakes from starving a later answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-inbox-retry-lane-"));
  try {
    const bridge = writeBridgeLock(root, undefined, proofFor(root));
    assert.equal(bridge.owned, true, "retry fixture owns the bridge lease");
    const runId = resolveInboxRunId(root);
    const active = join(root, ".omp", "inbox");
    mkdirSync(active, { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      // Durable auth setup is deliberately filesystem-bound and can approach
      // the 30s lease TTL on slower hosts. Heartbeat the same owned lease
      // instead of bypassing the production auth creator in this 65-entry
      // starvation fixture.
      if (index % 8 === 0) {
        assert.equal(refreshBridgeLock(root, bridge, undefined, proofFor(root)), true, "retry fixture bridge lease remains current");
      }
      const envelope = createAuthenticatedInboxEnvelope(root, "answer", { id: `${runId}/retry/${index}`, text: "retry", at: new Date().toISOString(), by: "bridge", run_id: runId }, undefined, proofFor(root));
      writeFileSync(join(active, `000-retry-${String(index).padStart(3, "0")}.json`), JSON.stringify(envelope));
    }
    assert.equal(refreshBridgeLock(root, bridge, undefined, proofFor(root)), true, "retry fixture bridge lease remains current for later answer");
    const later = createAuthenticatedInboxEnvelope(root, "answer", { id: `${runId}/later`, text: "later", at: new Date().toISOString(), by: "bridge", run_id: runId }, undefined, proofFor(root));
    writeFileSync(join(active, "zzz-later.json"), JSON.stringify(later));
    let laterCalls = 0;
    const attempts = new Map<string, number>();
    const successful = new Set<string>();
    const wake = (answer: { id: string; answer: string }): void => {
      attempts.set(answer.id, (attempts.get(answer.id) ?? 0) + 1);
      if (answer.answer === "retry") throw new Error("transient wake failure");
      successful.add(answer.id);
      laterCalls += 1;
    };
    let now = Date.now();
    const clock = () => now;
    let callbackAttempts = 0;
    for (let tick = 0; tick < 10; tick += 1) {
      if (tick > 0) rotateBridgeForDurableRetry(root);
      now += 60_000;
      await pollInbox(root, null, undefined, wake, { now: clock });
      const currentAttempts = [...attempts.values()].reduce((total, count) => total + count, 0);
      assert.ok(currentAttempts - callbackAttempts <= 8, "each active inbox page is bounded (" + (currentAttempts - callbackAttempts) + ")");
      callbackAttempts = currentAttempts;
    }
    assert.equal(laterCalls, 1, "later active answer wakes before retry backlog drains");
    assert.equal(existsSync(join(active, "processed", "zzz-later.json")), true);
    now += 24 * 60 * 60 * 1000;
    let recoveryTick = 0;
    for (let tick = 0; tick < 32; tick += 1) {
      now += 60_000;
      await pollInbox(root, null, undefined, (answer) => {
        attempts.set(answer.id, (attempts.get(answer.id) ?? 0) + 1);
        successful.add(answer.id);
      }, { now: clock });
      if (jsonCount(active) + jsonCount(join(root, ".omp", "inbox-retry")) === 0) { recoveryTick = tick + 1; break; }
    }
    assert.ok(recoveryTick > 0 && recoveryTick <= 32, "retry inbox recovery converges within the bounded tick budget");
    assert.equal(successful.size, 65, "later and every retryable wake successfully deliver exactly once");
    assert.equal([...attempts.keys()].filter((id) => id.includes("/retry/")).length, 64, "all retryable wakes remain accounted for");
    assert.equal(jsonEntries(join(active, "processed")).length, 65, "later and every retryable answer are processed exactly once");
  } finally {
    clearBridgeLock(root, undefined, undefined, proofFor(root));
    rmSync(root, { recursive: true, force: true });
  }
});
