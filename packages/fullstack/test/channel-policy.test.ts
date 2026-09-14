/**
 * Profile-aware channel policy + delivery envelope + wave admission tests
 * (resident control-plane, fullstack-dispatch slice).
 *
 * Covers: capability-validated channel sets (legacy telegram rw / legacy
 * http ro / explicit channels[] / downgrade rules), RO inbound prohibition
 * and summary routing, the durable delivery envelope (queueCtoDelivery ->
 * drainOutbox with intent intact), legacy isBidirectionalChannel semantics,
 * wave admission in handleInboxTask (idempotent on source_id), and the
 * capability-validated ask gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedProjectRoot } from "../../core/src/specification/pinned-root.js";
import { EscalationConfigError, type Escalation } from "@andvl1/omp-workflows-core";
import { canonicalDurableIdFileName, safeLegacyDurableIdFileName } from "../../core/src/cto/durable-id.js";
import { buildCtoTerminalSummaryEnvelope, markCtoRunDeliveryPending, newCtoState, readCtoState, setCtoPause, writeCtoState } from "../../core/src/cto/state.js";
import {
  createChannelSet as createChannelSetRaw,
  startChannelDispatcher as startChannelDispatcherRaw,
  drainOutbox as drainOutboxRaw,
  outboxDir,
  queueCtoDelivery as queueCtoDeliveryRaw,
  isBidirectionalChannel as isBidirectionalChannelRaw,
  handleInboxTask as handleInboxTaskRaw,
  inboxDir,
  loadEscalationConfig as loadEscalationConfigRaw,
  createEscalationAdapter as createEscalationAdapterRaw,
  registerEscalationAdapter as registerEscalationAdapterRaw,
  resolveInboxRunId as resolveInboxRunIdRaw,
  sha256Hex,
  type InboxTask,
  type CtoDelivery,
} from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import { beginRegistryRegistration, commitRegistryRegistration, rollbackRegistryRegistration } from "@andvl1/omp-workflows-core/registry";

import { createAskRedirectGate } from "../src/messenger-channel.js";
import { openFullstackRuntimeTest } from "./runtime-access-fixture.js";
import { resolveSessionCwd } from "../src/index.js";
import { bindAuthenticatedAdapterRouting } from "./routing-fixture.js";

type FullstackRuntime = ReturnType<typeof openFullstackRuntimeTest>;
const runtimeFixtures = new Map<string, FullstackRuntime>();
const retryDrainContexts = new Map<string, { retryCursorStore: Map<string, string | null>; retryMatchStateStore: Map<string, any>; retryMatchCursorStore: Map<string, string | null> }>();
function retryDrainContext(root: string) {
  let context = retryDrainContexts.get(root);
  if (!context) {
    context = { retryCursorStore: new Map(), retryMatchStateStore: new Map(), retryMatchCursorStore: new Map() };
    retryDrainContexts.set(root, context);
  }
  return context;
}
function runtimeFor(root: string): FullstackRuntime {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const runtime = openFullstackRuntimeTest(root, "channel-policy-" + runtimeFixtures.size);
  runtimeFixtures.set(root, runtime);
  return runtime;
}
function closeRuntime(root: string): void {
  runtimeFixtures.get(root)?.close();
}
test.after(() => {
  for (const runtime of runtimeFixtures.values()) runtime.close();
  runtimeFixtures.clear();
  retryDrainContexts.clear();
});
type ChannelCapabilities = Parameters<typeof createChannelSetRaw>[1];
type ChannelPinnedRoot = Parameters<typeof createChannelSetRaw>[2];
type DispatcherOptions = Parameters<typeof startChannelDispatcherRaw>[3];
type DrainOptions = NonNullable<Parameters<typeof drainOutboxRaw>[3]>;
type LoadOptions = NonNullable<Parameters<typeof loadEscalationConfigRaw>[1]>;
type HandleOptions = NonNullable<Parameters<typeof handleInboxTaskRaw>[3]>;

function createChannelSet(root: string, capabilities?: ChannelCapabilities, pinnedRoot?: ChannelPinnedRoot) {
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    return createChannelSetRaw(root, capabilities, pin, runtimeFor(root).access);
  } finally {
    if (!pinnedRoot) pin.close();
  }
}
function startChannelDispatcher(root: string, set: Parameters<typeof startChannelDispatcherRaw>[1], intervalMs = 10_000, options: DispatcherOptions = {}) {
  const runtimeAccess = options.runtimeAccess ?? runtimeFor(root).access;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    if (set.primary) assert.equal(bindAuthenticatedAdapterRouting(root, set.primary, runtimeAccess, pinnedRoot), true, "channel-policy primary has authenticated routing");
    for (const sink of options.roSinks ?? set.roSinks) assert.equal(bindAuthenticatedAdapterRouting(root, sink, runtimeAccess, pinnedRoot), true, "channel-policy RO sink has authenticated routing");
    const runtime = runtimeFor(root);
    return startChannelDispatcherRaw(root, set, intervalMs, { ...options, pinnedRoot, runtimeAccess, session_id: options.session_id ?? runtime.sessionId, liveGuard: options.liveGuard ?? runtime.liveGuard });
  } catch (error) {
    if (!options.pinnedRoot) pinnedRoot.close();
    throw error;
  }
}
async function drainOutbox(root: string, adapter: Parameters<typeof drainOutboxRaw>[1], maxRetries = 3, options: DrainOptions = {}) {
  const runtimeAccess = options.runtimeAccess ?? runtimeFor(root).access;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    if (adapter) assert.equal(bindAuthenticatedAdapterRouting(root, adapter, runtimeAccess, pinnedRoot), true, "channel-policy adapter has authenticated routing");
    for (const sink of options.roSinks ?? []) assert.equal(bindAuthenticatedAdapterRouting(root, sink, runtimeAccess, pinnedRoot), true, "channel-policy RO sink has authenticated routing");
    return await drainOutboxRaw(root, adapter, maxRetries, { ...retryDrainContext(root), ...options, pinnedRoot, runtimeAccess });
  } finally {
    if (!options.pinnedRoot) pinnedRoot.close();
  }
}
function queueCtoDelivery(root: string, runId: string, delivery: Parameters<typeof queueCtoDeliveryRaw>[2], pinnedRoot?: Parameters<typeof queueCtoDeliveryRaw>[3], isOwned?: Parameters<typeof queueCtoDeliveryRaw>[4], runtimeAccess?: Parameters<typeof queueCtoDeliveryRaw>[5]) {
  return queueCtoDeliveryRaw(root, runId, delivery, pinnedRoot, isOwned, runtimeAccess ?? runtimeFor(root).access);
}
function isBidirectionalChannel(root: string, capabilities?: Parameters<typeof isBidirectionalChannelRaw>[1], pinnedRoot?: Parameters<typeof isBidirectionalChannelRaw>[2]) {
  return isBidirectionalChannelRaw(root, capabilities, pinnedRoot, runtimeFor(root).access);
}
function handleInboxTask(root: string, task: Parameters<typeof handleInboxTaskRaw>[1], onTask?: Parameters<typeof handleInboxTaskRaw>[2], options: HandleOptions = {}) {
  return handleInboxTaskRaw(root, task, onTask, { ...options, runtimeAccess: options.runtimeAccess ?? runtimeFor(root).access });
}
function resolveInboxRunId(root: string, pinnedRoot?: Parameters<typeof resolveInboxRunIdRaw>[1], runtimeAccess?: Parameters<typeof resolveInboxRunIdRaw>[2]) {
  return resolveInboxRunIdRaw(root, pinnedRoot, runtimeAccess ?? runtimeFor(root).access);
}
function loadEscalationConfig(root: string, options: LoadOptions = {}) {
  return loadEscalationConfigRaw(root, { ...options, runtimeAccess: options.runtimeAccess ?? runtimeFor(root).access });
}
function createEscalationAdapter(config: Parameters<typeof createEscalationAdapterRaw>[0], root: string, pinnedRoot?: Parameters<typeof createEscalationAdapterRaw>[2], runtimeAccess?: Parameters<typeof createEscalationAdapterRaw>[3]) {
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    return createEscalationAdapterRaw(config, root, pin, runtimeAccess ?? runtimeFor(root).access);
  } finally {
    if (!pinnedRoot) pin.close();
  }
}

function registerEscalationAdapter(root: string, kind: string, factory: Parameters<typeof registerEscalationAdapterRaw>[2], capabilities?: Parameters<typeof registerEscalationAdapterRaw>[3]): void {
  const runtime = runtimeFor(root);
  const registration = beginRegistryRegistration(runtime.activation.registry_context, root, ["escalation_adapters"]);
  if (!registration.ok) throw new Error(registration.code + ": " + registration.error);
  try {
    registerEscalationAdapterRaw(registration.token, kind, factory, capabilities as Parameters<typeof registerEscalationAdapterRaw>[3]);
    commitRegistryRegistration(registration.token);
  } catch (error) {
    try { rollbackRegistryRegistration(registration.token); } catch { /* preserve registration failure */ }
    throw error;
  }
}

function inboxWaveSourceId(id: string, by = "local"): string {
  return `inbox-${sha256Hex(JSON.stringify({ id, transport: by }))}`;
}
function withConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}

function withIndexedRun(root: string, runId: string, ackTarget?: string): void {
  const state = newCtoState({
    id: runId,
    task: "channel routing",
    branch: "main",
    autonomous: true,
    plan: { id: runId, task: "channel routing", teams: [], created_at: new Date().toISOString() },
  });
  if (ackTarget) state.channel_profile = { ackTarget };
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
  assert.equal(markCtoRunDeliveryPending(root, runId, undefined, "outbox"), true);
}

function queueTerminalSummary(root: string, runId: string): string {
  const state = newCtoState({
    id: runId,
    task: "terminal summary",
    branch: "main",
    autonomous: true,
    plan: { id: runId, task: "terminal summary", teams: [], created_at: new Date().toISOString() },
  });
  const wave = {
    id: "wave-summary",
    source: "test",
    source_id: runId + "-source",
    task: "terminal summary",
    slice_ids: [],
    status: "done" as const,
    outcome: "pass" as const,
    started_at: new Date(0).toISOString(),
    finished_at: new Date(1_000).toISOString(),
  };
  state.wave_history = [wave];
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
  setCtoPause(state, "done", "terminal");
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
  const current = readCtoState(runId, root);
  assert.ok(current, "canonical terminal CTO state exists");
  const summary = buildCtoTerminalSummaryEnvelope(current, wave);
  const queued = queueCtoDelivery(root, runId, summary);
  assert.ok(queued, "canonical terminal summary publication succeeds");
  return queued;
}

function withActiveRun(root: string): void {
  const state = newCtoState({
    id: "run-one",
    task: "Some task",
    branch: "main",
    autonomous: true,
    plan: { id: "run-one", task: "Some task", teams: [], created_at: new Date().toISOString() },
  });
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
}

/**
 * Node 20-compatible `Promise.withResolvers` (Node 22+ / ES2024);
 * mirrors the repo convention in packages/e2e/src/util.ts and
 * src/adapters/telegram.ts.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Policy / capabilities ──────────────────────────────────────────────────

test("policy: legacy telegram config -> RW primary via createChannelSet", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-tg-"));
  try {
    withConfig(root, { adapter: "telegram", telegram: { token: "t", chatId: "c" } });
    const set = createChannelSet(root);
    assert.equal(set.profiles.length, 1);
    assert.equal(set.profile.direction, "rw");
    assert.equal(set.profiles[0]?.direction, "rw");
    assert.ok(set.primary, "primary adapter built");
    assert.equal(set.primary?.kind, "telegram");
    assert.equal(set.roSinks.length, 0);
    assert.equal(isBidirectionalChannel(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: legacy http is push-only -> RO sink only, no primary", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-http-"));
  try {
    withConfig(root, { adapter: "http", http: { url: "https://ntfy.sh/x" } });
    const set = createChannelSet(root);
    assert.equal(set.profile.direction, "ro");
    assert.equal(set.primary, null, "no validated rw primary for http");
    assert.equal(set.roSinks.length, 1, "http adapter becomes the RO report sink");
    assert.equal(set.roSinks[0]?.kind, "http");
    assert.equal(isBidirectionalChannel(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: explicit channels[] builds RW primary + subscribed RO sink", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-explicit-"));
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
        { id: "audit", adapter: "mock", direction: "read-only", subscriptions: ["progress", "summary"] },
      ],
    });
    const set = createChannelSet(root);
    assert.equal(set.profiles.length, 2);
    assert.equal(set.profile.direction, "rw");
    assert.equal(set.profile.adapter, "mock");
    assert.ok(set.primary, "rw primary built");
    assert.ok(set.primary instanceof MockEscalationAdapter);
    assert.equal(set.roSinks.length, 1);
    assert.ok(set.roSinks[0] instanceof MockEscalationAdapter);
    assert.equal(isBidirectionalChannel(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("policy: duplicate id-less telegram primary blocks custom RW fallback before routing", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-duplicate-idless-primary-"));
  const kind = "custom-rw-after-duplicate-telegram";
  let factoryCalled = false;
  try {
    registerEscalationAdapter(root, kind, () => {
      factoryCalled = true;
      return {
        kind,
        send: async () => ({ sent: true }),
        sendWithIdempotency: async () => ({ sent: true }),
        cancel: async () => undefined,
        pollOnce: async () => [],
        setPlainMessageHandler: () => undefined,
      };
    }, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
    withConfig(root, {
      channels: [
        { adapter: "telegram", direction: "read-write", primary: true, telegram: { token: "token", chatId: "chat" } },
        { adapter: "telegram", direction: "read-write", telegram: { token: "token-2", chatId: "chat-2" } },
        { adapter: kind, direction: "read-write" },
      ],
    });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
    );
    assert.equal(factoryCalled, false, "duplicate primary config must block before custom fallback construction");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("policy: registered custom RW capabilities build the primary and poll inbound", async () => {
  const root = mkdtempSync(join(tmpdir(), "pol-custom-rw-"));
  const polled = deferred<void>();
  let polls = 0;
  let wired = 0;
  const kind = "custom-rw-capability";
  try {
    registerEscalationAdapter(root, kind, () => ({
      kind,
      send: async () => ({ sent: true }),
      sendWithIdempotency: async () => ({ sent: true }),
      cancel: async () => undefined,
      pollOnce: async () => {
        polls += 1;
        polled.resolve();
        return [];
      },
      setPlainMessageHandler: () => {
        wired += 1;
      },
    }), { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
    withConfig(root, { channels: [{ id: "control", adapter: kind, direction: "read-write", primary: true }] });
    const set = createChannelSet(root);
    assert.equal(set.profile.direction, "rw");
    assert.equal(set.profiles[0]?.direction, "rw");
    assert.ok(set.primary, "registered RW adapter becomes the primary");
    const stop = startChannelDispatcher(root, set, 10_000);
    try {
      await polled.promise;
      assert.equal(polls, 1);
      assert.equal(wired, 1, "primary inbound handler is wired");
    } finally {
      await stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: legacy custom bidirectional registration without metadata is typed blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-custom-legacy-no-cap-"));
  const kind = "custom-legacy-no-capability";
  try {
    // Deliberately omit metadata: the token-first API rejects this at registration.
    assert.throws(
      () => registerEscalationAdapter(root, kind, () => ({
        kind,
        send: async () => ({ sent: true }),
        cancel: async () => undefined,
        pollOnce: async () => [],
      }), undefined),
      (error: unknown) => (error as { code?: string }).code === "registry_transaction_invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: custom read-only registration without metadata is typed blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-custom-ro-no-cap-"));
  const kind = "custom-ro-no-capability";
  try {
    assert.throws(
      () => registerEscalationAdapter(root, kind, () => ({
        kind,
        send: async () => ({ sent: true }),
        cancel: async () => undefined,
      }), undefined),
      (error: unknown) => (error as { code?: string }).code === "registry_transaction_invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: same id across adapter kinds binds each factory to its own credentials", () => {
  const kind = "custom-same-id-kind";
  const captured: Array<Record<string, unknown> | undefined> = [];
  for (const [name, channels] of [
    [
      "custom first",
      [
        { id: "shared", adapter: kind, direction: "read-write", primary: true, [kind]: { credential: "custom-secret" } },
        { id: "shared", adapter: "http", direction: "read-only", http: { url: "https://ntfy.sh/http-secret" } },
      ],
    ],
    [
      "http first",
      [
        { id: "shared", adapter: "http", direction: "read-only", http: { url: "https://ntfy.sh/http-secret" } },
        { id: "shared", adapter: kind, direction: "read-write", primary: true, [kind]: { credential: "custom-secret" } },
      ],
    ],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "pol-cross-kind-id-"));
    try {
      registerEscalationAdapter(root, kind, (config) => {
        captured.push(config[kind] as Record<string, unknown> | undefined);
        return {
          kind,
          sendWithIdempotency: async () => ({ sent: true }),
          send: async () => ({ sent: true }),
          cancel: async () => undefined,
          pollOnce: async () => [],
          setPlainMessageHandler: () => undefined,
        };
      }, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
      withConfig(root, { channels });
      const set = createChannelSet(root);
      assert.equal(set.primary?.kind, kind, `${name}: custom RW channel remains primary`);
      assert.deepEqual({ ...(captured.at(-1) ?? {}) }, { credential: "custom-secret" }, `${name}: custom factory receives custom credentials`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("policy: registered RO capabilities never wire or poll inbound", async () => {
  const root = mkdtempSync(join(tmpdir(), "pol-custom-ro-"));
  let polls = 0;
  let wired = 0;
  const kind = "custom-ro-capability";
  try {
    registerEscalationAdapter(root, kind, () => ({
      kind,
      send: async () => ({ sent: true }),
      sendWithIdempotency: async () => ({ sent: true }),
      cancel: async () => undefined,
      pollOnce: async () => {
        polls += 1;
        return [];
      },
      setPlainMessageHandler: () => {
        wired += 1;
      },
    }), { canReceiveInbound: false, canSend: true, canSendWithIdempotency: true });
    withConfig(root, { channels: [{ id: "audit", adapter: kind, direction: "read-only" }] });
    const set = createChannelSet(root);
    assert.equal(set.profile.direction, "ro");
    assert.equal(set.primary, null);
    assert.equal(set.roSinks.length, 1, "registered RO adapter remains an outbound sink");
    const stop = startChannelDispatcher(root, set, 10_000);
    try {
      await Promise.resolve();
      assert.equal(polls, 0, "RO sink is never polled");
      assert.equal(wired, 0, "RO sink is never wired for inbound");
    } finally {
      await stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: declared idempotent custom read-only adapter missing method is typed blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-custom-ro-idempotency-mismatch-"));
  const kind = "custom-ro-idempotency-mismatch";
  try {
    registerEscalationAdapter(root, kind, () => ({
      kind,
      send: async () => ({ sent: true }),
      cancel: async () => undefined,
    }), { canReceiveInbound: false, canSend: true, canSendWithIdempotency: true });
    withConfig(root, { channels: [{ id: "audit", adapter: kind, direction: "read-only" }] });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "declared idempotency support without a sendWithIdempotency method is blocked",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: marked primary that is not RW fails closed with typed blocked configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-downgrade-"));
  try {
    withConfig(root, {
      channels: [
        { id: "web", adapter: "http", direction: "read-write", primary: true, http: { url: "https://ntfy.sh/x" } },
        { id: "backup", adapter: "mock", direction: "read-write" },
      ],
    });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "invalid marked RW primary must be typed blocked configuration",
    );
    assert.throws(
      () => isBidirectionalChannel(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "bidirectional probe must preserve the typed blocked configuration",
    );
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("policy: read-only HTTP primary is blocked, while unmarked HTTP remains an RO sink", () => {
  const primaryRoot = mkdtempSync(join(tmpdir(), "pol-http-ro-primary-"));
  try {
    withConfig(primaryRoot, {
      channels: [{ id: "web", adapter: "http", direction: "read-only", primary: true, http: { url: "https://ntfy.sh/x" } }],
    });
    assert.throws(
      () => createChannelSet(primaryRoot),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "a read-only primary must be typed blocked rather than routed",
    );
  } finally {
    rmSync(primaryRoot, { recursive: true, force: true });
  }

  const sinkRoot = mkdtempSync(join(tmpdir(), "pol-http-ro-sink-"));
  try {
    withConfig(sinkRoot, {
      channels: [{ id: "web", adapter: "http", direction: "read-only", http: { url: "https://ntfy.sh/x" } }],
    });
    const set = createChannelSet(sinkRoot);
    assert.equal(set.profile.direction, "ro");
    assert.equal(set.primary, null);
    assert.equal(set.roSinks.length, 1, "unmarked HTTP remains an outbound RO sink");
  } finally {
    rmSync(sinkRoot, { recursive: true, force: true });
  }
});


test("policy: invalid unmarked RW profile is rejected instead of falling back", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-fallback-"));
  const kind = "custom-rw-mismatch-fallback";
  try {
    registerEscalationAdapter(root, kind, () => ({
      kind,
      send: async () => ({ sent: true }),
      cancel: async () => undefined,
    }), { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
    withConfig(root, {
      channels: [
        { id: "broken", adapter: kind, direction: "read-write" },
        { id: "backup", adapter: "mock", direction: "read-write" },
      ],
    });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "an invalid unmarked RW entry must not silently select a fallback",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("policy: unknown RO channel blocks a valid RW fallback before construction", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-unknown-ro-fallback-"));
  const kind = "custom-rw-after-unknown-ro";
  let factoryCalled = false;
  try {
    registerEscalationAdapter(root, kind, () => {
      factoryCalled = true;
      return {
        kind,
        send: async () => ({ sent: true }),
        sendWithIdempotency: async () => ({ sent: true }),
        cancel: async () => undefined,
        pollOnce: async () => [],
      };
    }, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
    withConfig(root, {
      channels: [
        { id: "unknown", adapter: "unregistered-ro", direction: "read-only" },
        { id: "control", adapter: kind, direction: "read-write" },
      ],
    });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "an unknown RO channel must block the entire explicit channel configuration",
    );
    assert.equal(factoryCalled, false, "invalid RO configuration must not construct or route the valid RW fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("policy: all unavailable RW placement variants are typed blocked", () => {
  const cases = [
    {
      name: "unmarked unavailable alone",
      channels: [{ id: "broken", adapter: "http", direction: "read-write" }],
    },
    {
      name: "unavailable before valid fallback",
      channels: [
        { id: "broken", adapter: "http", direction: "read-write" },
        { id: "backup", adapter: "mock", direction: "read-write" },
      ],
    },
    {
      name: "unavailable after valid fallback",
      channels: [
        { id: "backup", adapter: "mock", direction: "read-write" },
        { id: "broken", adapter: "http", direction: "read-write" },
      ],
    },
    {
      name: "duplicate unavailable entries",
      channels: [
        { id: "broken", adapter: "http", direction: "read-write" },
        { id: "broken", adapter: "http", direction: "read-write" },
      ],
    },
  ];
  for (const fixture of cases) {
    const root = mkdtempSync(join(tmpdir(), "pol-invalid-rw-"));
    try {
      withConfig(root, { channels: fixture.channels });
      assert.throws(
        () => createChannelSet(root),
        (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
        fixture.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("policy: duplicate raw primaries and mixed duplicate channels block before fallback", () => {
  const cases = [
    {
      name: "duplicate read-only primary markers",
      channels: [
        { id: "first", adapter: "custom-ro-capability", direction: "read-only", primary: true },
        { id: "second", adapter: "custom-ro-capability", direction: "read-only", primary: true },
        { id: "backup", adapter: "mock", direction: "read-write" },
      ],
    },
    {
      name: "duplicate read-only/read-write channel id before fallback",
      channels: [
        { id: "shared", adapter: "mock", direction: "read-only", primary: true },
        { id: "shared", adapter: "mock", direction: "read-write" },
        { id: "backup", adapter: "mock", direction: "read-write" },
      ],
    },
  ] as const;
  for (const fixture of cases) {
    const root = mkdtempSync(join(tmpdir(), "pol-duplicate-raw-"));
    try {
      withConfig(root, { channels: fixture.channels });
      assert.throws(
        () => createChannelSet(root),
        (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
        fixture.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("policy: duplicate marked primaries fail closed deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-duplicate-primary-"));
  try {
    withConfig(root, {
      channels: [
        { id: "first", adapter: "mock", direction: "read-write", primary: true },
        { id: "second", adapter: "mock", direction: "read-write", primary: true },
      ],
    });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
    );
    assert.throws(
      () => isBidirectionalChannel(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: second marked RW profile owns inbound and outbound routing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pol-second-primary-"));
  const constructed: string[] = [];
  const wired: string[] = [];
  const received: InboxTask[] = [];
  const polled: string[] = [];
  const delivered: string[] = [];
  const pollStarted = deferred<string>();
  let inboundHandler: ((message: { id: string; text: string; at: string; by?: string; chatId?: string; userId?: string; messageId?: number }) => void | Promise<void>) | undefined;
  const kind = "custom-second-primary";
  try {
    registerEscalationAdapter(root, kind, (config) => {
      const id = String((config as Record<string, unknown>).id ?? "");
      constructed.push(id);
      return {
        kind,
        send: async (esc: Escalation) => {
          delivered.push(`${id}:${esc.id}`);
          return { sent: true };
        },
        sendWithIdempotency: async (esc: Escalation) => {
          delivered.push(`${id}:${esc.id}`);
          return { sent: true };
        },
        cancel: async () => undefined,
        pollOnce: async () => {
          polled.push(id);
          pollStarted.resolve(id);
          return [];
        },
        setPlainMessageHandler: (handler) => {
          wired.push(id);
          inboundHandler = handler;
        },
      };
    }, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
    withConfig(root, {
      channels: [
        { id: "first", adapter: kind, direction: "read-write" },
        { id: "second", adapter: kind, direction: "read-write", primary: true },
      ],
    });
    const set = createChannelSet(root);
    assert.equal(set.profile.id, "second");
    assert.equal(set.primary?.kind, kind);
    const stop = startChannelDispatcher(root, set, 10_000, { onTask: (task) => received.push(task) });
    try {
      assert.equal(await pollStarted.promise, "second", "inbound polling uses the exact resolved primary");
      assert.deepEqual(polled, ["second"]);
      assert.ok(inboundHandler);
      await inboundHandler({
        id: "tg:chat-a:7",
        text: "first chat",
        at: new Date().toISOString(),
        by: "telegram",
        chatId: "chat-a",
        userId: "42",
        messageId: 7,
      });
      await inboundHandler({
        id: "tg:chat-b:7",
        text: "second chat",
        at: new Date().toISOString(),
        by: "telegram",
        chatId: "chat-b",
        userId: "84",
        messageId: 7,
      });
      assert.deepEqual(
        received.map(({ id, chatId, userId, messageId }) => ({ id, chatId, userId, messageId })),
        [{ id: "tg:chat-a:7", chatId: "chat-a", userId: "42", messageId: 7 }],
        "first structured Telegram origin survives registry admission",
      );
      const runId = resolveInboxRunId(root);
      const persisted = readdirSync(inboxDir(runId, root))
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(inboxDir(runId, root), name), "utf8")) as InboxTask)
        .find((task) => task.id === "tg:chat-b:7");
      assert.deepEqual(
        persisted && { id: persisted.id, chatId: persisted.chatId, userId: persisted.userId, messageId: persisted.messageId },
        { id: "tg:chat-b:7", chatId: "chat-b", userId: "84", messageId: 7 },
        "same Telegram message ids from another chat remain distinct in durable inbox",
      );
      assert.deepEqual(wired, ["second"], "inbound handler is wired only on the exact resolved primary");
      withIndexedRun(root, "primary-second");
      const esc: CtoDelivery = {
        id: "primary-second/primary-second-esc",
        level: "blocker",
        title: "primary-second",
        body: "outbound",
        intent: "question",
      };
      const queued = queueCtoDelivery(root, "primary-second", esc);
      assert.ok(queued);
      const results = await drainOutbox(root, set.primary, 1);
      assert.deepEqual(results.map((result) => result.sent), [true], JSON.stringify(results));
      assert.deepEqual(delivered, ["second:primary-second/primary-second-esc"], "exact resolved primary sends the tenant-bound delivery");
      const replay = await drainOutbox(root, set.primary, 1);
      assert.deepEqual(replay, [], "replaying the same outbox cannot resend through another profile");
      assert.deepEqual(delivered, ["second:primary-second/primary-second-esc"]);
    } finally {
      await stop();
    }
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: declared ro never upgrades even with full capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-ro-"));
  try {
    withConfig(root, {
      channels: [{ id: "audit", adapter: "mock", direction: "read-only", subscriptions: ["summary"] }],
    });
    const set = createChannelSet(root);
    assert.equal(set.profiles[0]?.direction, "ro", "declared ro stays ro (mock is rw-capable but never upgrades)");
    assert.equal(set.primary, null);
    assert.equal(set.roSinks.length, 1);
    assert.equal(isBidirectionalChannel(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: no config -> empty channel set with direction none", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-none-"));
  try {
    const set = createChannelSet(root);
    assert.deepEqual(set.profiles, []);
    assert.equal(set.profile.direction, "none");
    assert.equal(set.primary, null);
    assert.deepEqual(set.roSinks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: two same-kind mock channels with distinct ids get distinct per-entry configs (own persisted dirs)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pol-same-kind-"));
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true, mock: { persisted: true, dir: "rw-ctrl" } },
        { id: "audit", adapter: "mock", direction: "read-only", mock: { persisted: true, dir: "rw-audit" } },
      ],
    });
    const set = createChannelSet(root);
    assert.equal(set.profiles.length, 2, "both same-kind profiles survive with distinct ids");
    assert.ok(set.primary instanceof MockEscalationAdapter, "rw primary built");
    assert.equal(set.roSinks.length, 1);
    assert.ok(set.roSinks[0] instanceof MockEscalationAdapter, "ro sink built");

    // Prove each adapter bound to its OWN entry: the primary writes to
    // rw-ctrl, the sink to rw-audit — with the old kind-only entryFor both
    // would have resolved the FIRST mock entry and shared one dir.
    await (set.primary as MockEscalationAdapter).injectTask("hello ctrl");
    await (set.roSinks[0] as MockEscalationAdapter).injectTask("hello audit");
    assert.ok(existsSync(join(root, "rw-ctrl", "inbound")), "primary writes its own dir");
    assert.ok(existsSync(join(root, "rw-audit", "inbound")), "sink writes its own dir");
    assert.equal(readdirSync(join(root, "rw-ctrl", "inbound")).filter((n) => n.endsWith(".json")).length, 1);
    assert.equal(readdirSync(join(root, "rw-audit", "inbound")).filter((n) => n.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: same-kind id-less duplicate channels are typed blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-idless-dup-"));
  try {
    withConfig(root, {
      channels: [
        { adapter: "mock", direction: "read-write", primary: true },
        { adapter: "mock", direction: "read-only" },
      ],
    });
    assert.throws(
      () => createChannelSet(root),
      (error: unknown) => error instanceof EscalationConfigError && error.code === "invalid_primary",
      "ambiguous id-less duplicate declarations are configuration-blocked",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── RO inbound prohibition + report routing ────────────────────────────────

test("RO inbound prohibition: an RO-only channel set is never wired or polled", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-prohib-"));
  try {
    withConfig(root, {
      channels: [{ id: "audit", adapter: "mock", direction: "read-only" }],
    });
    const set = createChannelSet(root);
    assert.equal(set.primary, null);
    const sink = set.roSinks[0];
    assert.ok(sink instanceof MockEscalationAdapter);
    let wired = 0;
    let polled = 0;
    const origSet = sink.setPlainMessageHandler.bind(sink);
    sink.setPlainMessageHandler = ((handler) => {
      wired += 1;
      origSet(handler);
    }) as typeof sink.setPlainMessageHandler;
    const origPoll = sink.pollOnce.bind(sink);
    sink.pollOnce = (async () => {
      polled += 1;
      return origPoll();
    }) as typeof sink.pollOnce;

    const stop = startChannelDispatcher(root, set, 10_000, {});
    // Wiring is synchronous inside startChannelDispatcher; the immediate
    // tick for a primary-less set is a pure-microtask chain (drainOutbox
    // with a null adapter and pollInbox with no drop and no pollable both
    // resolve without timers), so flushing the microtask queue lets the
    // whole first tick run — no wall-clock wait needed.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await stop();
    assert.equal(wired, 0, "RO sink never wired for inbound");
    assert.equal(polled, 0, "RO sink never polled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO inbound prohibition: only the primary is wired; the RO sink is not", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-wire-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
        { id: "audit", adapter: "mock", direction: "read-only" },
      ],
    });
    const set = createChannelSet(root);
    const primary = set.primary as MockEscalationAdapter;
    const sink = set.roSinks[0] as MockEscalationAdapter;
    let sinkWired = 0;
    let sinkPolled = 0;
    const origSet = sink.setPlainMessageHandler.bind(sink);
    sink.setPlainMessageHandler = ((handler) => {
      sinkWired += 1;
      origSet(handler);
    }) as typeof sink.setPlainMessageHandler;
    const origPoll = sink.pollOnce.bind(sink);
    sink.pollOnce = (async () => {
      sinkPolled += 1;
      return origPoll();
    }) as typeof sink.pollOnce;

    // Deterministic completion signal: the immediate first tick polls the
    // PRIMARY — resolve the gate when that poll actually runs, so the
    // assertions below observe a tick that has already been executed
    // (no wall-clock wait).
    const pollGate = deferred<void>();
    const origPrimaryPoll = primary.pollOnce.bind(primary);
    primary.pollOnce = (async () => {
      const result = await origPrimaryPoll();
      pollGate.resolve();
      return result;
    }) as typeof primary.pollOnce;

    stop = startChannelDispatcher(root, set, 10_000, {});
    await pollGate.promise;
    await Promise.resolve();

    // The primary's inbound path IS live while the dispatcher owns the
    // lease: a plain message files a task into the standby run's inbox
    // through the dispatcher's wired handler (wakeTask checks the lease).
    await primary.injectPlainMessage("task via primary");
    const runId = readdirSync(join(root, ".work-state", "cto"), { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.startsWith("standby-"))?.name;
    assert.ok(runId);
    const filed = readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json"));
    assert.equal(filed.length, 1, "primary inbound filed the task");

    await stop();
    assert.equal(sinkWired, 0, "RO sink never wired");
    assert.equal(sinkPolled, 0, "RO sink never polled");
  } finally {
    await stop?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO routing: question intent reaches only the primary, never the RO sink", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-q-"));
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
        { id: "audit", adapter: "mock", direction: "read-only" },
      ],
    });
    const set = createChannelSet(root);
    const primary = set.primary as MockEscalationAdapter;
    const sink = set.roSinks[0] as MockEscalationAdapter;
    const runId = "run-q";
    withIndexedRun(root, runId);
    assert.ok(queueCtoDelivery(root, runId, { id: "run-q/team-a/q1", level: "question", title: "Q", body: "q", intent: "question", topic: "question" }), "question delivery published");
    await drainOutbox(root, primary, 3, { roSinks: [sink] });
    assert.equal(primary.sentEscalations.length, 1, "primary received the question");
    assert.equal(sink.sentEscalations.length, 0, "RO sink must NOT receive a question");
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO routing: summary reports reach a subscribed sink by topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-sum-"));
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
        { id: "audit", adapter: "mock", direction: "read-only", subscriptions: ["summary"] },
        { id: "metrics", adapter: "mock", direction: "read-only", subscriptions: ["metrics"] },
      ],
    });
    const set = createChannelSet(root);
    const primary = set.primary as MockEscalationAdapter;
    const sink = set.roSinks[0] as MockEscalationAdapter;
    const otherSink = set.roSinks[1] as MockEscalationAdapter;
    const runId = "run-sum";
    assert.ok(queueTerminalSummary(root, runId), "canonical summary published");
    const results = await drainOutbox(root, primary, 3, { roSinks: set.roSinks });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.equal(primary.sentEscalations.length, 1);
    assert.equal(sink.sentEscalations.length, 1, "the summary topic reaches the subscribed sink");
    assert.equal(sink.sentEscalations[0]?.topic, "summary");
    assert.equal(otherSink.sentEscalations.length, 0, "a sink subscribed only to another topic is skipped");
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO routing: a sink without subscriptions receives all reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-all-"));
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
        { id: "audit", adapter: "mock", direction: "read-only" },
      ],
    });
    const set = createChannelSet(root);
    const primary = set.primary as MockEscalationAdapter;
    const sink = set.roSinks[0] as MockEscalationAdapter;
    const runId = "run-all";
    assert.ok(queueTerminalSummary(root, runId), "canonical summary published");
    await drainOutbox(root, primary, 3, { roSinks: [sink] });
    assert.equal(sink.sentEscalations.length, 1, "no subscriptions -> canonical summary reaches the sink once");
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO routing: sink idempotency keys use stable profile ids, not array positions", async () => {
  const kind = "stable-sink-key";
  const keys = new Map<string, string[]>();
  const roots = [mkdtempSync(join(tmpdir(), "ro-stable-a-")), mkdtempSync(join(tmpdir(), "ro-stable-b-"))];
  try {
    const configs = [
      [
        { id: "ctrl", adapter: kind, direction: "read-write", primary: true },
        { id: "audit", adapter: kind, direction: "read-only" },
      ],
      [
        { id: "ctrl", adapter: kind, direction: "read-write", primary: true },
        { id: "new", adapter: kind, direction: "read-only" },
        { id: "audit", adapter: kind, direction: "read-only" },
      ],
    ];
    for (const [index, root] of roots.entries()) {
      registerEscalationAdapter(root, kind, (config) => {
        const profileId = String((config as Record<string, unknown>).id ?? "");
        const profileKeys = keys.get(profileId) ?? [];
        keys.set(profileId, profileKeys);
        return {
          kind,
          send: async () => ({ sent: true }),
          sendWithIdempotency: async (_esc: Escalation, key: string) => {
            profileKeys.push(key);
            return { sent: true };
          },
          cancel: async () => undefined,
          pollOnce: async () => [],
          setPlainMessageHandler: () => undefined,
        };
      }, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
      withConfig(root, { channels: configs[index] });
      const set = createChannelSet(root);
      const runId = "run-stable-sink";
      assert.ok(queueTerminalSummary(root, runId), "canonical summary published");
      const results = await drainOutbox(root, set.primary, 1, { roSinks: set.roSinks });
      assert.deepEqual(results.map((result) => result.sent), [true]);
    }
    const auditKeys = keys.get("audit") ?? [];
    const newKeys = keys.get("new") ?? [];
    assert.equal(auditKeys.length, 2);
    assert.equal(auditKeys[0], auditKeys[1], "audit profile keeps the same key when a sink is inserted before it");
    assert.equal(newKeys.length, 1);
    assert.notEqual(newKeys[0], auditKeys[0], "inserted sink receives a distinct key");
  } finally {
    for (const root of roots) closeRuntime(root);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("legacy RO adapter still receives outbox entries via startChannelDispatcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-drain-"));
  try {
    // Deterministic completion: the immediate first tick drains the outbox
    // through the legacy drain target — resolve when its send actually runs.
    const sendGate = deferred<void>();
    const delivered: Escalation[] = [];
    let wireCalls = 0;
    registerEscalationAdapter(root, "spy-legacy", () => ({
      kind: "spy-legacy",
      send: async (esc: Escalation) => {
        delivered.push(esc);
        sendGate.resolve();
        return { sent: true };
      },
      sendWithIdempotency: async (esc: Escalation) => {
        delivered.push(esc);
        sendGate.resolve();
        return { sent: true };
      },
      cancel: async () => undefined,
      // Implements the inbound surface so the assertion is meaningful: the
      // loop must NEVER wire it (a legacy RO adapter is a report sink only).
      setPlainMessageHandler: () => {
        wireCalls += 1;
      },
    }), { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });

    withConfig(root, { adapter: "spy-legacy" });
    const set = createChannelSet(root);
    assert.equal(set.primary, null, "no validated rw primary for the legacy RO adapter");
    assert.equal(set.roSinks.length, 1);
    assert.equal(set.legacySingleAdapter, true, "no channels[] -> legacy single-adapter set");

    const runId = "run-legacy";
    assert.ok(queueTerminalSummary(root, runId), "legacy summary delivery published");

    const stop = startChannelDispatcher(root, set, 10_000, {});
    await Promise.race([sendGate.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("legacy dispatcher did not send")), 3_000))]);
    await Promise.resolve();
    await stop();
    assert.equal(delivered.length, 1, "legacy RO adapter still drains the outbox");
    assert.equal(delivered[0]?.id, "run-legacy/wave/wave-summary/summary");
    assert.equal(wireCalls, 0, "legacy RO adapter is never wired for inbound");
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit RO-only: summary reaches the sink without a primary; questions stay", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-only-drain-"));
  try {
    const delivered: Escalation[] = [];
    registerEscalationAdapter(root, "spy-ro", () => ({
      kind: "spy-ro",
      send: async (esc: Escalation) => {
        delivered.push(esc);
        return { sent: true };
      },
      sendWithIdempotency: async (esc: Escalation) => {
        delivered.push(esc);
        return { sent: true };
      },
      cancel: async () => undefined,
    }), { canReceiveInbound: false, canSend: true, canSendWithIdempotency: true });

    withConfig(root, {
      channels: [{ id: "ro", adapter: "spy-ro", direction: "read-only", subscriptions: ["summary"] }],
    });
    const set = createChannelSet(root);
    assert.equal(set.primary, null);
    assert.equal(set.roSinks.length, 1);
    assert.equal(set.legacySingleAdapter, false);

    const summaryRunId = "run-ro-only-summary";
    assert.ok(queueTerminalSummary(root, summaryRunId), "canonical summary delivery published");
    const questionRunId = "run-ro-only-question";
    withIndexedRun(root, questionRunId);
    assert.ok(queueCtoDelivery(root, questionRunId, { id: "run-ro-only-question/team-a/q1", level: "question", title: "Q", body: "q", intent: "question" }), "question delivery published");

    const results = await drainOutbox(root, null, 3, { roSinks: set.roSinks });
    assert.equal(results.length, 2);
    const summary = results.find((r) => r.runId === summaryRunId);
    const question = results.find((r) => r.runId === questionRunId);
    assert.ok(summary?.sent === true, "summary delivered to the RO sink without a primary");
    assert.equal(delivered.length, 1, "one send to the sink");
    assert.equal(delivered[0]?.topic, "summary");
    assert.ok(question && question.sent === false, "question cannot be delivered without a primary");
    assert.equal(question?.error, "no rw primary to deliver non-report entry");
    assert.equal(readdirSync(join(outboxDir(summaryRunId, root), "sent")).filter((name) => name.endsWith(".json")).length, 1, "summary moved to sent/" );
    const questionInActive = readdirSync(outboxDir(questionRunId, root)).some((name) => name.endsWith(".json"));
    const questionInRetry = readdirSync(join(root, ".work-state", "cto", questionRunId, "outbox-retry"), { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".json"));
    assert.ok(questionInActive || questionInRetry, "question remains in active or retry lane for a later primary");
  } finally {
    closeRuntime(root);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Delivery envelope / legacy compatibility ───────────────────────────────

test("envelope: queueCtoDelivery survives drainOutbox with intent intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-queue-"));
  try {
    const runId = "run-ack";
    withIndexedRun(root, runId, "chat-1");
    const path = queueCtoDelivery(root, runId, {
      id: "run-ack/system/ack/1",
      level: "question",
      title: "CTO online",
      body: "standby",
      intent: "ack",
      target: "chat-1",
    });
    assert.ok(path, "delivery queued");
    assert.ok(existsSync(path!));

    const mock = new MockEscalationAdapter();
    const results = await drainOutbox(root, mock);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.equal(mock.sentEscalations.length, 1);
    const sent: Escalation & { intent?: string; target?: string } = mock.sentEscalations[0]!;
    assert.equal(sent.intent, "ack", "intent intact through sanitize/send");
    assert.equal(sent.target, "chat-1", "target override intact");
    assert.equal(sent.title, "CTO online");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent")), "delivery moved to sent/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("envelope: queueCtoDelivery does not report a publish after runtime revocation", () => {
  const root = mkdtempSync(join(tmpdir(), "env-publish-revoked-"));
  try {
    const runId = "run-publish-revoked";
    withIndexedRun(root, runId);
    const runtime = runtimeFor(root);
    const revokingRuntime = new Proxy(runtime.access, {
      get(target, property, receiver) {
        if (property === "publishOutboxDelivery") {
          return (input: Parameters<typeof runtime.access.publishOutboxDelivery>[0]): string | null => {
            const published = runtime.access.publishOutboxDelivery(input);
            runtime.access.close();
            return published;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = queueCtoDeliveryRaw(root, runId, {
      id: `${runId}/system/ack/1`,
      level: "question",
      title: "CTO online",
      body: "standby",
      intent: "ack",
    }, undefined, undefined, revokingRuntime);
    assert.equal(result, null, "runtime revocation after publish is not reported as a successful queue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("envelope: queueCtoDelivery is idempotent on delivery id", () => {
  const root = mkdtempSync(join(tmpdir(), "env-dedup-"));
  try {
    withIndexedRun(root, "run-a");
    const delivery = { id: "run-a/ack/1", level: "question", title: "t", body: "b", intent: "ack" } as const;
    const first = queueCtoDelivery(root, "run-a", delivery);
    const second = queueCtoDelivery(root, "run-a", delivery);
    assert.ok(first, "first write wins");
    assert.equal(second, null, "duplicate id -> null (idempotent)");
    const files = readdirSync(outboxDir("run-a", root)).filter((n) => n.endsWith(".json"));
    assert.equal(files.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("envelope: queueCtoDelivery rejects unsafe level, id, and option metadata before any outbox write", () => {
  const root = mkdtempSync(join(tmpdir(), "env-invalid-"));
  const runId = "run-invalid";
  try {
    withIndexedRun(root, runId);
    const invalidDeliveries = [
      { id: `${runId}/unsafe/1`, level: "info", title: "bad level", body: "body", intent: "question" },
      { id: `${runId}/../escape`, level: "question", title: "bad id", body: "body", intent: "question" },
      {
        id: `${runId}/unsafe-options/1`,
        level: "question",
        title: "bad options",
        body: "body",
        options: [{ id: "bad:id", label: "bad option", apply: "noop" }],
        intent: "question",
      },
    ] as unknown as CtoDelivery[];
    for (const delivery of invalidDeliveries) {
      assert.equal(queueCtoDelivery(root, runId, delivery), null);
    }
    assert.equal(existsSync(outboxDir(runId, root)), false, "invalid delivery validation must not create an outbox");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("envelope: queueCtoDelivery fails closed on cyclic, BigInt, and inherited extras", () => {
  const root = mkdtempSync(join(tmpdir(), "env-extra-"));
  const runId = "run-extra";
  try {
    withIndexedRun(root, runId);
    const base = { id: `${runId}/extra/1`, level: "question", title: "title", body: "body", intent: "question" };
    const cyclic = { ...base } as Record<string, unknown>;
    cyclic.extra = cyclic;
    const bigint = { ...base, extra: 1n };
    const inherited = Object.assign(Object.create({ extra: 1n }), base);
    for (const delivery of [cyclic, bigint, inherited] as unknown as CtoDelivery[]) {
      assert.equal(queueCtoDelivery(root, runId, delivery), null);
    }
    assert.equal(existsSync(outboxDir(runId, root)), false, "untrusted extras must not create an outbox");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("envelope: colliding delivery IDs stay distinct through sent and replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-collision-"));
  const runId = "run-collision";
  const deliveries = [
    { id: `${runId}/team-a/x/y`, level: "question", title: "first", body: "one", intent: "ack" as const },
    { id: `${runId}/team/a-x/y`, level: "question", title: "second", body: "two", intent: "ack" as const },
  ];
  try {
    withIndexedRun(root, runId);
    const queued = await Promise.all(deliveries.map((delivery) => Promise.resolve(queueCtoDelivery(root, runId, delivery))));
    assert.ok(queued[0] && queued[1] && queued[0] !== queued[1], "colliding legacy names produce distinct canonical files");

    const adapter = new MockEscalationAdapter();
    const idx = JSON.parse(readFileSync(join(root, ".work-state", "cto", "active-run-index.json"), "utf8"));
    const auth = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, ".outbox-publication-authority.json"), "utf8"));
    const results = await drainOutbox(root, adapter);
    assert.equal(results.filter((result) => result.sent).length, 2, "both deliveries are sent");
    assert.deepEqual(adapter.sentEscalations.map((delivery) => delivery.id).sort(), deliveries.map((delivery) => delivery.id).sort());
    assert.equal(readdirSync(join(outboxDir(runId, root), "sent")).filter((name) => name.endsWith(".json")).length, 2);

    const replayed = await Promise.all(deliveries.map((delivery) => Promise.resolve(queueCtoDelivery(root, runId, delivery))));
    assert.ok(replayed[0] && replayed[1] && replayed[0] !== replayed[1], "replaying delivered IDs republishes distinct canonical files");
    assert.equal(adapter.sentEscalations.length, 2, "replay queues durable copies without sending until the next drain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("envelope: 255-byte and longer IDs publish, read, and claim canonical files", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-long-id-"));
  const runId = "run-long-id";
  const runPrefix = `${runId}/`;
  const ids = [
    `${runPrefix}${"a".repeat(255 - Buffer.byteLength(runPrefix, "utf8"))}`,
    `${runPrefix}${"a".repeat(256 - Buffer.byteLength(runPrefix, "utf8"))}`,
    `${runPrefix}${"é".repeat(121)}a`,
    `${runPrefix}${"é".repeat(122)}`,
  ];
  try {
    withIndexedRun(root, runId);
    assert.deepEqual(
      ids.filter((id) => safeLegacyDurableIdFileName(id) === undefined),
      ids.slice(0, 2),
      "aliases that exceed the filename byte limit are omitted",
    );
    const paths = ids.map((id) => queueCtoDelivery(root, runId, {
      id,
      level: "question",
      title: "long id",
      body: id,
      intent: "question",
    }));
    assert.ok(paths.every((path): path is string => path !== null), "every long ID is durably queued");
    assert.equal(new Set(paths).size, ids.length, "canonical names remain collision-free");
    for (const [index, id] of ids.entries()) {
      const path = paths[index]!;
      const name = path.slice(path.lastIndexOf("/") + 1);
      assert.equal(name, canonicalDurableIdFileName(id), "canonical hash name is selected");
      assert.equal(Buffer.byteLength(name, "utf8") <= 255, true, "canonical name fits filesystem component limits");
      const legacyName = safeLegacyDurableIdFileName(id);
      assert.equal(
        legacyName === undefined || Buffer.byteLength(legacyName, "utf8") <= 255,
        true,
        "any legacy alias passed to the publisher fits its path-component limit",
      );
      const payload = JSON.parse(readFileSync(path, "utf8")) as { id: string; idempotency_key: string };
      assert.equal(payload.id, id, "payload retains exact ID identity");
      assert.equal(payload.idempotency_key, id, "idempotency key retains exact ID identity");
    }

    const adapter = new MockEscalationAdapter();
    const results = await drainOutbox(root, adapter);
    assert.equal(results.length, ids.length, "all canonical files are claimed by the drain");
    assert.equal(results.every((result) => result.sent), true);
    assert.deepEqual(adapter.sentEscalations.map((delivery) => delivery.id).sort(), [...ids].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("envelope/legacy: legacy mock config still creates the in-memory mock", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-legacy-mock-"));
  try {
    withConfig(root, { adapter: "mock", bidirectional: true });
    const config = loadEscalationConfig(root, { kind: "mock" });
    assert.equal(config?.adapter, "mock");
    const adapter = createEscalationAdapter(config!, root);
    assert.ok(adapter instanceof MockEscalationAdapter, "legacy mock builds the in-memory adapter");
    await (adapter as MockEscalationAdapter).injectTask("no files should be written");
    assert.equal(existsSync(join(root, ".omp", "fake-rw")), false, "no persisted dir without config.mock.persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("envelope/legacy: isBidirectionalChannel telegram true, http false", () => {
  const root = mkdtempSync(join(tmpdir(), "env-bi-"));
  try {
    withConfig(root, { adapter: "telegram", telegram: { token: "t", chatId: "c" } });
    assert.equal(isBidirectionalChannel(root), true, "legacy telegram is rw");
    withConfig(root, { adapter: "http", http: { url: "https://x" } });
    assert.equal(isBidirectionalChannel(root), false, "legacy http without flag is push-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Wave admission ─────────────────────────────────────────────────────────

test("wave: handleInboxTask admits a deterministically hashed source_id", () => {
  const root = mkdtempSync(join(tmpdir(), "wave-admit-"));
  try {
    const runId = resolveInboxRunId(root);
    const received: InboxTask[] = [];
    const path = handleInboxTask(root, { id: "t1", text: "Ship the fix", at: new Date().toISOString() }, (t) => received.push(t));
    assert.ok(path, "task filed");
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      wave_history: Array<{ id: string; source: string; source_id: string; task: string; status: string }>;
    };
    assert.ok(Array.isArray(state.wave_history), "wave_history present after admission");
    assert.equal(state.wave_history.length, 1);
    assert.equal(state.wave_history[0]?.source_id, inboxWaveSourceId("t1"));
    assert.equal(state.wave_history[0]?.source, "inbox");
    assert.equal(state.wave_history[0]?.task, "Ship the fix");
    assert.equal(state.wave_history[0]?.status, "active");
    assert.equal(received.length, 1);
    assert.equal(received[0]?.waveId, state.wave_history[0]?.id, "onTask receives waveId");
    assert.equal(received[0]?.runId, runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave: duplicate transport id admits exactly one wave", () => {
  const root = mkdtempSync(join(tmpdir(), "wave-dedup-"));
  try {
    const runId = resolveInboxRunId(root);
    const at = new Date().toISOString();
    handleInboxTask(root, { id: "t1", text: "Do the thing", at }, () => undefined);
    const second = handleInboxTask(root, { id: "t1", text: "Do the thing", at }, () => undefined);
    assert.equal(second, null, "duplicate -> no re-file, no re-wake");
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      wave_history: Array<{ source_id: string }>;
    };
    assert.equal(state.wave_history.length, 1, "one wave for the duplicate pair");
    assert.equal(state.wave_history[0]?.source_id, inboxWaveSourceId("t1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave: wake rollback retry re-admits the SAME wave (no duplicate)", () => {
  const root = mkdtempSync(join(tmpdir(), "wave-retry-"));
  try {
    const runId = resolveInboxRunId(root);
    let calls = 0;
    const failing = () => {
      calls += 1;
      if (calls === 1) throw new Error("wake failed (transport down)");
    };
    assert.throws(
      () => handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, failing),
      /wake failed/,
    );
    const received: InboxTask[] = [];
    handleInboxTask(root, { id: "t1", text: "Do the thing", at: new Date().toISOString() }, (t) => received.push(t));
    const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
      wave_history: Array<{ id: string; source_id: string }>;
    };
    assert.equal(state.wave_history.length, 1, "one wave across wake rollback + retry");
    assert.equal(state.wave_history[0]?.source_id, inboxWaveSourceId("t1"));
    assert.equal(received[0]?.waveId, state.wave_history[0]?.id, "retry carries the same wave id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Ask gate (capability-validated) ────────────────────────────────────────

test("ask gate: blocks only with a validated RW primary AND an active run", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-cap-"));
  try {
    const gate = createAskRedirectGate(resolveSessionCwd, (cwd) => runtimeFor(cwd).access);

    // no config -> ask passes
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "no config -> pass");

    // http-only (RO, no validated rw primary) + active run -> ask passes
    withConfig(root, { adapter: "http", http: { url: "https://x" } });
    withActiveRun(root);
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "http-only + active run -> pass (RO fallback)");

    // telegram rw + active run -> blocked with the outbox contract
    withConfig(root, { adapter: "telegram", telegram: { token: "t", chatId: "c" } });
    const blocked = gate({ toolName: "ask" }, { cwd: root });
    assert.ok(blocked?.block === true, "telegram rw + active run -> blocked");
    assert.ok(blocked?.reason.includes("outbox"), "reason names the outbox route");

    // telegram rw but NO active run -> ask passes (normal interactive work)
    rmSync(join(root, ".work-state"), { recursive: true, force: true });
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "rw channel without run -> pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ask gate: explicit validated RW primary blocks; invalid declared-rw kind blocks configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-explicit-"));
  try {
    const gate = createAskRedirectGate(resolveSessionCwd, (cwd) => runtimeFor(cwd).access);

    // explicit validated RW primary (mock: inbound+outbound) + active run -> blocked
    withConfig(root, { channels: [{ id: "control", adapter: "mock", direction: "read-write", primary: true }] });
    withActiveRun(root);
    const blocked = gate({ toolName: "ask" }, { cwd: root });
    assert.ok(blocked?.block === true, "explicit validated RW primary + active run -> blocked");

    // An explicitly declared RW kind without a usable inbound surface is a
    // typed configuration block, not a silent RO fallback.
    withConfig(root, { channels: [{ id: "sink", adapter: "http", direction: "read-write" }] });
    const invalid = gate({ toolName: "ask" }, { cwd: root });
    assert.ok(invalid?.block === true, "invalid declared-rw kind blocks configuration");
    assert.match(invalid?.reason ?? "", /configuration is blocked/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
