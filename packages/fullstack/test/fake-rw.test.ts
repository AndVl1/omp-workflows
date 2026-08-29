/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapterFactories, createChannelSet, createEscalationAdapter, drainOutbox, handleInboxTask, pollInbox, queueCtoDelivery, registerEscalationAdapterFactory, startChannelDispatcher, startDispatcher, type EscalationAdapterFactories } from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import { createFullstackStorageAuthority, type FullstackStorageAuthority, type FullstackStorageNativeBackend } from "../src/storage-authority.js";
import { channelAdmission, runtimeFixture, type RuntimeFixture } from "./runtime-fixtures.js";
import type { Escalation, EscalationAdapter, EscalationAnswer, EscalationInboundMessage, EscalationReceipt, WorkflowV2Diagnostic } from "@andvl1/omp-workflows-core";

function durableFilenameKey(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function persistedAdapter(fixture: RuntimeFixture, relative_dir: string): MockEscalationAdapter {
  return new MockEscalationAdapter({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    filesystem_authority: fixture.filesystem_authority,
    storage: fixture.storage,
    persisted: { relative_dir },
  });
}

class RecordingAdapter implements EscalationAdapter {
  readonly kind: string;
  readonly calls: string[] = [];

  constructor(
    private readonly label: string,
    private readonly runIdentity: RuntimeFixture["run_identity"],
    private readonly successful: boolean,
    private readonly order: string[],
  ) {
    this.kind = `recording:${label}`;
  }

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    this.calls.push(escalation.id);
    this.order.push(this.label);
    return { sent: this.successful, run_identity: this.runIdentity, channelRef: `${this.kind}:${escalation.id}` };
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    return [];
  }

  setPlainMessageHandler(_handler: (message: EscalationInboundMessage) => Promise<void>): void {}

  async sendPlainText(_target: string, _text: string): Promise<{ sent: boolean; channelRef?: string }> {
    return { sent: this.successful, channelRef: `${this.kind}:plain` };
  }

  async cancel(_id: string): Promise<void> {}
}
type CapabilityShape = Readonly<{
  pollOnce?: boolean;
  setPlainMessageHandler?: boolean;
  sendPlainText?: boolean;
}>;

function capabilityAdapter(
  runIdentity: RuntimeFixture["run_identity"],
  label: string,
  capabilities: CapabilityShape,
): EscalationAdapter {
  const adapter: EscalationAdapter = {
    kind: `capability:${label}`,
    async send(_escalation): Promise<EscalationReceipt> {
      return { sent: true, run_identity: runIdentity, channelRef: `capability:${label}` };
    },
    async cancel(_id): Promise<void> {},
  };
  if (capabilities.pollOnce) adapter.pollOnce = async (): Promise<EscalationAnswer[]> => [];
  if (capabilities.setPlainMessageHandler) adapter.setPlainMessageHandler = (_handler): void => {};
  if (capabilities.sendPlainText) {
    adapter.sendPlainText = async (_target, _text): Promise<{ sent: boolean; channelRef?: string }> => ({
      sent: true,
      channelRef: `capability:${label}:plain`,
    });
  }
  return adapter;
}

function registerCapabilityFactory(
  factories: EscalationAdapterFactories,
  kind: string,
  capabilities: CapabilityShape,
): void {
  const result = registerEscalationAdapterFactory(
    factories,
    kind,
    ({ run_identity }) => capabilityAdapter(run_identity, kind, capabilities),
  );
  assert.equal(result.ok, true);
}

class DispatcherProbeAdapter implements EscalationAdapter {
  readonly kind = "dispatcher-probe";
  pollCalls = 0;
  sendCalls = 0;

  constructor(private readonly runIdentity: RuntimeFixture["run_identity"]) {}

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    this.sendCalls += 1;
    return { sent: true, run_identity: this.runIdentity, channelRef: `probe:${escalation.id}` };
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    this.pollCalls += 1;
    return [];
  }

  setPlainMessageHandler(_handler: (message: EscalationInboundMessage) => Promise<void>): void {}

  async sendPlainText(_target: string, _text: string): Promise<{ sent: boolean; channelRef?: string }> {
    this.sendCalls += 1;
    return { sent: true, channelRef: "probe:plain" };
  }

  async cancel(_id: string): Promise<void> {}
}

interface DispatcherEffectCounters {
  readCalls: number;
  writeCalls: number;
  leaseAcquireCalls: number;
  leaseReleaseCalls: number;
}

function countedStorage(
  fixture: RuntimeFixture,
  counters: DispatcherEffectCounters,
  runIdentity: RuntimeFixture["run_identity"] = fixture.run_identity,
  projectRoot: RuntimeFixture["project_root"] = fixture.project_root,
): FullstackStorageAuthority {
  const native: FullstackStorageNativeBackend = {
    canonical_root: projectRoot,
    run_identity: runIdentity,
    readBounded: (relativePath, maxBytes) => {
      counters.readCalls += 1;
      return fixture.storage.readBounded(relativePath, maxBytes);
    },
    readTextBounded: (relativePath, maxBytes) => {
      counters.readCalls += 1;
      return fixture.storage.readTextBounded(relativePath, maxBytes);
    },
    statBounded: (relativePath) => {
      counters.readCalls += 1;
      return fixture.storage.statBounded(relativePath);
    },
    writeExclusive: (relativePath, bytes) => {
      counters.writeCalls += 1;
      return fixture.storage.writeExclusive(relativePath, bytes, 16 * 1024 * 1024);
    },
    writeAtomic: (relativePath, bytes, maxBytes) => {
      counters.writeCalls += 1;
      return fixture.storage.writeAtomic(relativePath, bytes, maxBytes);
    },
    appendJsonLineBounded: (relativePath, bytes, maxBytes) => {
      counters.writeCalls += 1;
      return fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes);
    },
    listBounded: (relativePath, maxEntries) => {
      counters.readCalls += 1;
      return fixture.storage.listBounded(relativePath, maxEntries);
    },
    moveExclusive: (sourceRelativePath, targetRelativePath) => {
      counters.writeCalls += 1;
      return fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath);
    },
    removeIfOwned: (relativePath, identity) => {
      counters.writeCalls += 1;
      return fixture.storage.removeIfOwned(relativePath, identity);
    },
    acquireLease: (relativePath, identity) => {
      counters.leaseAcquireCalls += 1;
      counters.writeCalls += 1;
      return fixture.storage.acquireLease(relativePath, identity);
    },
    releaseLease: (relativePath, identity) => {
      counters.leaseReleaseCalls += 1;
      counters.writeCalls += 1;
      return fixture.storage.releaseLease(relativePath, identity);
    },
  };
  const result = createFullstackStorageAuthority({
    project_root: projectRoot,
    run_identity: runIdentity,
    filesystem_authority: fixture.filesystem_authority,
    native,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("counting storage should resolve");
  return result.value;
}

function probeChannelSet(fixture: RuntimeFixture) {
  const channels = [{ id: "probe", adapter: "probe", direction: "read-write", primary: true }] as const;
  const admission = channelAdmission(fixture, channels);
  const context = { ...fixture.context, channel_admission: admission };
  const factories = createAdapterFactories();
  let adapter: DispatcherProbeAdapter | undefined;
  const registered = registerEscalationAdapterFactory(factories, "probe", ({ run_identity }) => {
    const created = new DispatcherProbeAdapter(run_identity);
    adapter = created;
    return created;
  });
  assert.equal(registered.ok, true);
  const resolved = createChannelSet({ ...context, factories });
  assert.equal(resolved.ok, true);
  if (!resolved.ok || !adapter) throw new Error("dispatcher probe channel set should resolve");
  return { context, admission, channelSet: resolved.value, adapter };
}

function emptyDispatcherEffectCounters(): DispatcherEffectCounters {
  return { readCalls: 0, writeCalls: 0, leaseAcquireCalls: 0, leaseReleaseCalls: 0 };
}

function assertNoDispatcherEffects(
  root: string,
  adapter: DispatcherProbeAdapter,
  counters: DispatcherEffectCounters,
): void {
  assert.equal(adapter.pollCalls, 0, "foreign channel context must not poll");
  assert.equal(adapter.sendCalls, 0, "foreign channel context must not send");
  assert.deepEqual(counters, emptyDispatcherEffectCounters(), "foreign channel context must not read, write, or acquire/release a lease");
  assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), false, "foreign channel context must not create a dispatcher lease");
}

test("fake-rw: channel dispatcher starts for the exact context and authorities", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-channel-context-exact-"));
  try {
    const fixture = runtimeFixture(root, { runId: "channel-context-exact-run" });
    const probe = probeChannelSet(fixture);
    const started = startChannelDispatcher(probe.context, probe.channelSet, { intervalMs: 1 });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await started.value.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: channel dispatcher rejects a foreign root with the same run before effects", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-channel-context-root-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "fake-rw-channel-context-foreign-root-"));
  try {
    const fixture = runtimeFixture(root, { runId: "channel-context-root-run" });
    const foreignFixture = runtimeFixture(foreignRoot, { runId: "channel-context-root-run" });
    const probe = probeChannelSet(fixture);
    const counters = emptyDispatcherEffectCounters();
    const foreignStorage = countedStorage(foreignFixture, counters, fixture.run_identity, foreignFixture.project_root);
    const foreignContext = {
      ...foreignFixture.context,
      run_identity: fixture.run_identity,
      storage: foreignStorage,
      channel_admission: probe.admission,
    };

    const started = startChannelDispatcher(foreignContext, probe.channelSet, { intervalMs: 1 });
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.diagnostics[0]?.code, "IDENTITY_MISMATCH");
    assertNoDispatcherEffects(foreignRoot, probe.adapter, counters);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test("fake-rw: channel dispatcher rejects a foreign storage authority with the same run before effects", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-channel-context-storage-"));
  try {
    const fixture = runtimeFixture(root, { runId: "channel-context-storage-run" });
    const probe = probeChannelSet(fixture);
    const counters = emptyDispatcherEffectCounters();
    const foreignStorage = countedStorage(fixture, counters);
    const foreignContext = { ...probe.context, storage: foreignStorage };

    const started = startChannelDispatcher(foreignContext, probe.channelSet, { intervalMs: 1 });
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.diagnostics[0]?.code, "IDENTITY_MISMATCH");
    assertNoDispatcherEffects(root, probe.adapter, counters);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: channel dispatcher rejects a missing dispatcher admission before effects", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-channel-context-admission-"));
  try {
    const fixture = runtimeFixture(root, { runId: "channel-context-admission-run" });
    const probe = probeChannelSet(fixture);
    const started = startChannelDispatcher(fixture.context, probe.channelSet, { intervalMs: 1 });
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.diagnostics[0]?.code, "CAPABILITY_MISSING");
    assert.equal(probe.adapter.pollCalls, 0);
    assert.equal(probe.adapter.sendCalls, 0);
    assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: channel dispatcher rejects an equivalent but foreign admission object", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-channel-context-admission-identity-"));
  try {
    const fixture = runtimeFixture(root, { runId: "channel-context-admission-identity-run" });
    const probe = probeChannelSet(fixture);
    const foreignAdmission = channelAdmission(fixture, [{ id: "probe", adapter: "probe", direction: "read-write", primary: true }]);
    const foreignContext = { ...probe.context, channel_admission: foreignAdmission };

    const started = startChannelDispatcher(foreignContext, probe.channelSet, { intervalMs: 1 });
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.diagnostics[0]?.code, "IDENTITY_MISMATCH");
    assert.equal(probe.adapter.pollCalls, 0);
    assert.equal(probe.adapter.sendCalls, 0);
    assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



function explicitMockFactories(): EscalationAdapterFactories {
  const factories = createAdapterFactories();
  const registered = registerEscalationAdapterFactory(
    factories,
    "mock",
    ({ project_root, run_identity, filesystem_authority, storage, channel }) => new MockEscalationAdapter({
      project_root,
      run_identity,
      filesystem_authority,
      storage,
      persisted: { relative_dir: typeof channel.dir === "string" ? channel.dir : "rw" },
    }),
  );
  assert.equal(registered.ok, true);
  return factories;
}

async function waitForDurableFile(root: string, relativePath: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  const path = join(root, ...relativePath.split("/"));
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${relativePath}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function explicitMockChannelSet(
  fixture: RuntimeFixture,
  channels: readonly Readonly<Record<string, unknown>>[],
) {
  const admission = channelAdmission(fixture, channels);
  const resolved = createChannelSet({ ...fixture.context, channel_admission: admission, factories: explicitMockFactories() });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) throw new Error("explicit mock channel set should resolve");
  return resolved.value;
}

test("fake-rw: registry effective RW requires outbound and one inbound surface", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-registry-capabilities-"));
  try {
    const fixture = runtimeFixture(root, { runId: "registry-capability-run" });
    const factories = createAdapterFactories();
    registerCapabilityFactory(factories, "poll-only", { pollOnce: true, sendPlainText: true });
    registerCapabilityFactory(factories, "callback-only", { setPlainMessageHandler: true, sendPlainText: true });
    registerCapabilityFactory(factories, "outbound-only", { sendPlainText: true });
    registerCapabilityFactory(factories, "inbound-only", { pollOnce: true });
    registerCapabilityFactory(factories, "declared-ro", { pollOnce: true, setPlainMessageHandler: true, sendPlainText: true });

    const admission = channelAdmission(fixture, [
      { id: "poll-only", adapter: "poll-only", direction: "read-write", primary: true },
      { id: "callback-only", adapter: "callback-only", direction: "read-write" },
      { id: "outbound-only", adapter: "outbound-only", direction: "read-write" },
      { id: "inbound-only", adapter: "inbound-only", direction: "read-write" },
      { id: "declared-ro", adapter: "declared-ro", direction: "read-only" },
    ]);
    const resolved = createChannelSet({ ...fixture.context, channel_admission: admission, factories });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;

    const directionFor = (id: string): string | undefined => resolved.value.profiles.find((profile) => profile.id === id)?.direction;
    assert.equal(directionFor("poll-only"), "rw");
    assert.equal(directionFor("callback-only"), "rw");
    assert.equal(directionFor("outbound-only"), "ro");
    assert.equal(directionFor("inbound-only"), "ro");
    assert.equal(directionFor("declared-ro"), "ro", "declared read-only entries never upgrade");
    assert.equal(resolved.value.profile.id, "poll-only", "effective RW remains the primary selection");
    assert.equal(resolved.value.primary?.kind, "capability:poll-only");
    assert.equal(resolved.value.roSinks.length, 3, "downgraded entries remain read-only fanout sinks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class DeferredDispatcherAdapter implements EscalationAdapter {
  readonly kind = "deferred-dispatcher";
  readonly pollCalls: number[] = [];
  readonly sendCalls: string[] = [];
  private readonly pendingPoll: Promise<EscalationAnswer[]>;
  private readonly pendingSend: Promise<EscalationReceipt>;
  private resolvePoll!: (answers: EscalationAnswer[]) => void;
  private resolveSend!: (receipt: EscalationReceipt) => void;

  constructor(private readonly runIdentity: RuntimeFixture["run_identity"]) {
    this.pendingPoll = new Promise((resolve) => { this.resolvePoll = resolve; });
    this.pendingSend = new Promise((resolve) => { this.resolveSend = resolve; });
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    this.pollCalls.push(this.pollCalls.length + 1);
    return this.pendingPoll;
  }

  setPlainMessageHandler(_handler: (message: EscalationInboundMessage) => Promise<void>): void {}

  send(escalation: Escalation): Promise<EscalationReceipt> {
    this.sendCalls.push(escalation.id);
    return this.pendingSend;
  }

  releasePoll(answers: EscalationAnswer[] = []): void {
    this.resolvePoll(answers);
  }

  releaseSend(sent = false): void {
    this.resolveSend({ sent, run_identity: this.runIdentity, channelRef: "deferred" });
  }

  async cancel(_id: string): Promise<void> {}
}
class ThrowingDetachAdapter implements EscalationAdapter {
  readonly kind = "throwing-detach";
  private throwOnDetach = false;

  constructor(private readonly runIdentity: RuntimeFixture["run_identity"]) {}

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    return { sent: true, run_identity: this.runIdentity, channelRef: `${this.kind}:${escalation.id}` };
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    return [];
  }

  setPlainMessageHandler(_handler: (message: EscalationInboundMessage) => Promise<void>): void {
    if (this.throwOnDetach) throw new Error("detach failed");
  }

  failNextDetach(): void {
    this.throwOnDetach = true;
  }

  async cancel(_id: string): Promise<void> {}
}
class ConcurrentInboundAdapter implements EscalationAdapter {
  readonly kind = "concurrent-inbound";
  private handler: ((message: EscalationInboundMessage) => Promise<void>) | undefined;

  constructor(private readonly runIdentity: RuntimeFixture["run_identity"]) {}

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    return { sent: true, run_identity: this.runIdentity, channelRef: `${this.kind}:${escalation.id}` };
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    return [];
  }

  setPlainMessageHandler(handler: (message: EscalationInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async emit(...messages: EscalationInboundMessage[]): Promise<PromiseSettledResult<void>[]> {
    if (!this.handler) throw new Error("concurrent inbound handler is not installed");
    return Promise.allSettled(messages.map((message) => this.handler!(message)));
  }

  async cancel(_id: string): Promise<void> {}
}

class QueuedAnswerAdapter implements EscalationAdapter {
  readonly kind = "queued-answer";
  private queued: EscalationAnswer[];

  constructor(
    private readonly runIdentity: RuntimeFixture["run_identity"],
    answer: EscalationAnswer,
  ) {
    this.queued = [answer];
  }

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    return { sent: false, run_identity: this.runIdentity, channelRef: `${this.kind}:${escalation.id}` };
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    const answers = this.queued;
    this.queued = [];
    return answers;
  }

  setPlainMessageHandler(_handler: (message: EscalationInboundMessage) => Promise<void>): void {}

  async cancel(_id: string): Promise<void> {}
}

test("fake-rw: deferred inbound poll does not block an outbound failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dispatcher-deferred-"));
  try {
    const fixture = runtimeFixture(root, { runId: "dispatcher-deferred-run" });
    const adapter = new DeferredDispatcherAdapter(fixture.run_identity);
    const id = "dispatcher-deferred-run/cto/ack/1";
    const queued = queueCtoDelivery(fixture.context, {
      id,
      level: "question",
      title: "Deferred",
      body: "Deferred body",
      intent: "ack",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);
    const started = startDispatcher(fixture.context, adapter, { intervalMs: 1 });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await Promise.resolve();

    assert.deepEqual(adapter.pollCalls, [1], "one unresolved inbound poll owns the inbound flight");
    assert.deepEqual(adapter.sendCalls, [id], "outbound delivery starts while inbound remains unresolved");
    adapter.releaseSend(false);
    await Promise.resolve();
    assert.equal(adapter.pollCalls.length, 1, "an outbound failure does not cancel or overlap the pending inbound poll");
    adapter.releasePoll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await started.value.stop();

    assert.equal(
      readdirSync(join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox")).filter((name) => name.endsWith(".json")).length,
      1,
      "failed outbound delivery remains pending for retry",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fake-rw: stop waits for deferred task callback before releasing the lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dispatcher-task-stop-"));
  try {
    const fixture = runtimeFixture(root, { runId: "dispatcher-task-stop-run" });
    const adapter = persistedAdapter(fixture, "rw");
    let releaseTask!: () => void;
    let markTaskStarted!: () => void;
    const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    const taskStarted = new Promise<void>((resolve) => { markTaskStarted = resolve; });
    let taskCalls = 0;
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 1,
      onTask: async () => {
        taskCalls += 1;
        markTaskStarted();
        await taskGate;
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const taskDispatch = adapter.injectTask("deferred task").catch(() => undefined);
    await taskStarted;
    assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), true);

    const stopping = started.value.stop();
    await Promise.resolve();
    assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), true, "lease remains held while the task callback is unresolved");
    assert.equal(taskCalls, 1, "stop does not start a replacement task callback");

    releaseTask();
    await taskDispatch;
    await stopping;
    assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), false);
    await adapter.injectTask("after stop");
    assert.equal(taskCalls, 1, "replacement handler is a no-op after stop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fake-rw: leased dispatcher coalesces exact concurrent tasks and retries after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dispatcher-claim-retry-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const fixture = runtimeFixture(root, { runId: "dispatcher-claim-retry-run" });
    const adapter = new ConcurrentInboundAdapter(fixture.run_identity);
    let releaseTask!: () => void;
    let markTaskStarted!: () => void;
    const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    const taskStarted = new Promise<void>((resolve) => { markTaskStarted = resolve; });
    let taskCalls = 0;
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 60_000,
      onTask: async () => {
        taskCalls += 1;
        markTaskStarted();
        await taskGate;
        throw new Error("wake failed once");
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    stop = async () => { await started.value.stop(); };

    const task = {
      id: "dispatcher-claim-task",
      text: "retry this exact task",
      at: "2026-08-28T00:00:00.000Z",
      by: "concurrent-transport",
      run_identity: fixture.run_identity,
    } as const;
    const duplicate = adapter.emit(task, task);
    await taskStarted;
    assert.equal(taskCalls, 1, "exact concurrent records share one callback flight");
    releaseTask();
    const firstOutcomes = await duplicate;
    assert.deepEqual(firstOutcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);

    const pendingPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", `${durableFilenameKey(task.id)}.json`);
    const processedPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", "processed", `${durableFilenameKey(task.id)}.json`);
    assert.equal(existsSync(pendingPath), true, "callback rejection retains the exact source for retry");
    assert.equal(existsSync(processedPath), false, "callback rejection does not publish processed evidence");

    await stop();
    stop = undefined;

    const restartedAdapter = new ConcurrentInboundAdapter(fixture.run_identity);
    const restarted = startDispatcher(fixture.context, restartedAdapter, {
      intervalMs: 60_000,
      onTask: async () => { taskCalls += 1; },
    });
    assert.equal(restarted.ok, true);
    if (!restarted.ok) return;
    stop = async () => { await restarted.value.stop(); };
    const retryOutcomes = await restartedAdapter.emit(task);
    assert.deepEqual(retryOutcomes.map((outcome) => outcome.status), ["fulfilled"]);
    assert.equal(taskCalls, 2, "restart retries the pending exact task once");
    assert.equal(existsSync(pendingPath), false);
    assert.equal(existsSync(processedPath), true, "successful retry publishes the processed marker");

    const replayOutcomes = await restartedAdapter.emit(task);
    assert.deepEqual(replayOutcomes.map((outcome) => outcome.status), ["fulfilled"]);
    assert.equal(taskCalls, 2, "exact replay after success is idempotent");
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: leased dispatcher rejects a concurrent same-id conflicting record", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dispatcher-claim-conflict-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const fixture = runtimeFixture(root, { runId: "dispatcher-claim-conflict-run" });
    const adapter = new ConcurrentInboundAdapter(fixture.run_identity);
    let releaseTask!: () => void;
    let markTaskStarted!: () => void;
    const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    const taskStarted = new Promise<void>((resolve) => { markTaskStarted = resolve; });
    let taskCalls = 0;
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 60_000,
      onTask: async () => {
        taskCalls += 1;
        markTaskStarted();
        await taskGate;
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    stop = async () => { await started.value.stop(); };

    const firstTask = {
      id: "dispatcher-conflict-task",
      text: "first exact record",
      at: "2026-08-28T00:00:00.000Z",
      by: "concurrent-transport",
      run_identity: fixture.run_identity,
    } as const;
    const conflictingTask = { ...firstTask, text: "conflicting exact record" };
    const first = adapter.emit(firstTask);
    await taskStarted;
    const conflict = await adapter.emit(conflictingTask);
    assert.deepEqual(conflict.map((outcome) => outcome.status), ["rejected"]);
    assert.equal(taskCalls, 1, "conflicting digest never invokes the callback");
    if (conflict[0]?.status === "rejected") {
      assert.equal(conflict[0].reason?.diagnostic?.code, "IDENTITY_MISMATCH");
    }

    const pendingPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", `${durableFilenameKey(firstTask.id)}.json`);
    assert.equal(existsSync(pendingPath), true, "conflict leaves the first exact source pending while its flight is active");
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).text, firstTask.text);
    releaseTask();
    assert.deepEqual((await first).map((outcome) => outcome.status), ["fulfilled"]);
    assert.equal(taskCalls, 1);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry task active and processed filenames stay bounded for max ASCII and UTF-8 ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-task-filename-hash-"));
  try {
    const fixture = runtimeFixture(root, { runId: "task-filename-hash-run" });
    const adapter = new ConcurrentInboundAdapter(fixture.run_identity);
    const received: string[] = [];
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 60_000,
      onTask: async (task) => { received.push(task.id); },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const ids = ["A".repeat(512), "я".repeat(512)];
    for (const [index, id] of ids.entries()) {
      const task = {
        id,
        text: `bounded task ${index}`,
        at: "2026-08-28T00:00:00.000Z",
        by: "filename-test",
        run_identity: fixture.run_identity,
      } as const;
      const outcomes = await adapter.emit(task);
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled"]);
      const key = durableFilenameKey(id);
      assert.match(key, /^[0-9a-f]{64}$/u);
      const pendingPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", `${key}.json`);
      const processedPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", "processed", `${key}.json`);
      assert.equal(existsSync(pendingPath), false, "successful processing removes the hashed active task file");
      assert.equal(existsSync(processedPath), true, "successful processing publishes the hashed processed task file");
      const stored = JSON.parse(readFileSync(processedPath, "utf8")) as { id?: string };
      assert.equal(stored.id, id, "the full original task id remains in the durable record");
    }
    assert.deepEqual(received, ids);
    await started.value.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry answer pending and processed filenames stay bounded with exact replay and conflict retention", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-answer-filename-hash-"));
  try {
    const fixture = runtimeFixture(root, { runId: "answer-filename-hash-run" });
    const ids = ["B".repeat(512), "ю".repeat(512)];
    const delivered: string[] = [];
    const pollAnswer = async (answer: EscalationAnswer) => {
      const result = await pollInbox(
        fixture.context,
        new QueuedAnswerAdapter(fixture.run_identity, answer),
        undefined,
        (value) => { delivered.push(`${value.id}:${value.answer}`); },
      );
      assert.equal(result.ok, true);
      return result;
    };

    for (const [index, id] of ids.entries()) {
      const answer = {
        id,
        answer: `answer ${index}`,
        at: "2026-08-28T00:00:00.000Z",
        by: "filename-test",
        run_identity: fixture.run_identity,
      } as const;
      await pollAnswer(answer);
      const key = durableFilenameKey(id);
      assert.match(key, /^[0-9a-f]{64}$/u);
      const pendingPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "answers", `answer-${key}.json`);
      const processedPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "answers", "processed", `answer-${key}.json`);
      assert.equal(existsSync(pendingPath), false, "successful answer processing removes the hashed pending file");
      assert.equal(existsSync(processedPath), true, "successful answer processing publishes the hashed processed file");
      const stored = JSON.parse(readFileSync(processedPath, "utf8")) as { id?: string; answer?: string };
      assert.equal(stored.id, id, "the full original answer id remains in the durable record");
      assert.equal(stored.answer, answer.answer);

      const replay = await pollAnswer(answer);
      assert.equal(replay.diagnostics.length, 0, "an exact answer replay is idempotent");
      assert.equal(delivered.filter((value) => value.startsWith(`${id}:`)).length, 1, "an exact answer replay does not invoke the consumer twice");
    }

    const conflictId = ids[0]!;
    const conflict = await pollAnswer({
      id: conflictId,
      answer: "conflicting answer",
      at: "2026-08-28T00:00:00.000Z",
      by: "filename-test",
      run_identity: fixture.run_identity,
    });
    assert.equal(conflict.diagnostics[0]?.code, "IDENTITY_MISMATCH", "a conflicting same-id answer is rejected");
    const conflictKey = durableFilenameKey(conflictId);
    const originalPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "answers", "processed", `answer-${conflictKey}.json`);
    assert.equal((JSON.parse(readFileSync(originalPath, "utf8")) as { answer?: string }).answer, "answer 0", "the original processed answer is retained");
    assert.equal(existsSync(join(root, ".work-state", "cto", fixture.run_identity.run_id, "answers", `answer-${conflictKey}.json`)), false, "the conflicting pending answer is not retained as active");
    const quarantinePath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "answers", "quarantine");
    assert.equal(readdirSync(quarantinePath).filter((name) => name.endsWith(".json")).length, 1, "the conflicting answer is retained in quarantine");
    assert.equal(delivered.filter((value) => value.startsWith(`${conflictId}:`)).length, 1, "a conflicting answer never invokes the consumer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry rejects invalid task timestamps before writing and accepts the valid ISO date boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-task-timestamp-validation-"));
  try {
    const fixture = runtimeFixture(root, { runId: "task-timestamp-validation-run" });
    const validIso = "2026-08-28T00:00:00.000Z";
    const invalidTimestamps = [
      "",
      `${validIso}${" ".repeat(105)}`,
      "not-a-date",
      `\u0009${validIso}`,
      `${validIso}\u000A`,
    ];
    for (const [index, at] of invalidTimestamps.entries()) {
      const result = await handleInboxTask(fixture.context, {
        id: `invalid-task-${index}`,
        text: "reject this timestamp",
        at,
        by: "timestamp-test",
        run_identity: fixture.run_identity,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CONFIG_MALFORMED");
      assert.equal(existsSync(join(root, ".work-state")), false, "invalid timestamps produce no durable task write");
    }

    const boundaryAt = new Date(8_640_000_000_000_000).toISOString();
    const valid = await handleInboxTask(fixture.context, {
      id: "valid-boundary-task",
      text: "accept this timestamp",
      at: boundaryAt,
      by: "timestamp-test",
      run_identity: fixture.run_identity,
    });
    assert.equal(valid.ok, true);
    const activePath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", `${durableFilenameKey("valid-boundary-task")}.json`);
    assert.equal(JSON.parse(readFileSync(activePath, "utf8")).at, boundaryAt, "valid timestamp representation is preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: throwing detach reports after lease release and allows replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dispatcher-detach-"));
  try {
    const fixture = runtimeFixture(root, { runId: "dispatcher-detach-run" });
    const adapter = new ThrowingDetachAdapter(fixture.run_identity);
    const diagnostics: WorkflowV2Diagnostic[] = [];
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 1,
      onDiagnostic: (value) => { diagnostics.push(value); },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    adapter.failNextDetach();

    await assert.rejects(
      () => started.value.stop(),
      (error: unknown) => error instanceof Error && error.name === "DispatcherStopError",
    );
    assert.equal(existsSync(join(root, ".omp", "cto-dispatcher.lock")), false, "detach failure does not strand the dispatcher lease");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "ACTIVATION_FAILED");

    const replacement = startDispatcher(fixture.context, new ThrowingDetachAdapter(fixture.run_identity), { intervalMs: 1 });
    assert.equal(replacement.ok, true, "replacement dispatcher acquires the released lease");
    if (replacement.ok) await replacement.value.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: adapter A persists; adapter B observes the exact run-bound answer and task", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-cross-"));
  try {
    const fixture = runtimeFixture(root, { runId: "run-1" });
    const a = persistedAdapter(fixture, "rw");
    const b = persistedAdapter(fixture, "rw");
    const escalation = { id: "run-1/team-a/q1", level: "question" as const, title: "Q", body: "q", run_identity: fixture.run_identity };
    await a.send(escalation);
    const tasks: Array<{ id: string; text: string; at: string; by?: string }> = [];
    b.setPlainMessageHandler(async (msg) => { tasks.push(msg); });
    a.injectAnswer(escalation.id, "use grpc", "user-1");
    await a.injectTask("Fix the login bug", "telegram");

    const answers = await b.pollOnce();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.id, escalation.id);
    assert.equal(answers[0]?.answer, "use grpc");
    assert.equal(answers[0]?.run_identity.run_id, "run-1");
    assert.equal(answers[0]?.by, "user-1");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.text, "Fix the login bug");
    assert.equal(tasks[0]?.by, "telegram");
    assert.equal(readdirSync(join(root, "rw", "answers", "processed")).filter((n) => n.endsWith(".json")).length, 1);
    assert.equal(readdirSync(join(root, "rw", "inbound", "processed")).filter((n) => n.endsWith(".json")).length, 1);

    const line = JSON.parse(readFileSync(join(root, "rw", "outbound", "messages.jsonl"), "utf8").trim()) as {
      escId: string;
      receipt: { sent: boolean; run_identity?: { run_id?: string } };
    };
    assert.equal(line.escId, escalation.id);
    assert.equal(line.receipt.sent, true);
    assert.equal(line.receipt.run_identity?.run_id, "run-1");
    assert.deepEqual(await b.pollOnce(), [], "durable records are consumed once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: sendPlainText appends plain.jsonl with an exact-run receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-plain-"));
  try {
    const fixture = runtimeFixture(root, { runId: "plain-run" });
    const adapter = persistedAdapter(fixture, "rw");
    const result = await adapter.sendPlainText("user-1", "status reply");
    assert.equal(result.sent, true);
    const line = JSON.parse(readFileSync(join(root, "rw", "outbound", "plain.jsonl"), "utf8").trim()) as {
      target: string;
      text: string;
      receipt: { sent: boolean; run_identity?: { run_id?: string } };
    };
    assert.equal(line.target, "user-1");
    assert.equal(line.text, "status reply");
    assert.equal(line.receipt.sent, true);
    assert.equal(line.receipt.run_identity?.run_id, "plain-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: injectAnswer merges disk and memory copies for one exact answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-dedupe-"));
  try {
    const fixture = runtimeFixture(root);
    const adapter = persistedAdapter(fixture, "rw");
    adapter.injectAnswer("run-1/esc/1", "answer", "u");
    assert.equal(readdirSync(join(root, "rw", "answers")).filter((n) => n.endsWith(".json")).length, 1);
    const answers = await adapter.pollOnce();
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.answer, "answer");
    assert.deepEqual(await adapter.pollOnce(), [], "answer consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: a throwing plain handler leaves the inbound file for retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-retry-"));
  try {
    const fixture = runtimeFixture(root);
    const dir = "rw";
    const a = persistedAdapter(fixture, dir);
    await a.injectTask("do it", "mock");
    const b = persistedAdapter(fixture, dir);
    let calls = 0;
    b.setPlainMessageHandler(async () => {
      calls += 1;
      if (calls === 1) throw new Error("wake failed (transport down)");
    });
    await b.pollOnce();
    assert.equal(calls, 1);
    assert.equal(readdirSync(join(root, dir, "inbound")).filter((n) => n.endsWith(".json")).length, 1);
    await b.pollOnce();
    assert.equal(calls, 2);
    assert.equal(readdirSync(join(root, dir, "inbound")).filter((n) => n.endsWith(".json")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: summary fanout delivers primary and every read-only sink in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-fanout-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-fanout-run" });
    const order: string[] = [];
    const primary = new RecordingAdapter("primary", fixture.run_identity, true, order);
    const roOne = new RecordingAdapter("ro-one", fixture.run_identity, true, order);
    const roTwo = new RecordingAdapter("ro-two", fixture.run_identity, true, order);
    const queued = queueCtoDelivery(fixture.context, {
      id: "summary-fanout-run/cto/summary/1",
      level: "question",
      title: "Summary",
      body: "Summary body",
      intent: "summary",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);
    const results = await drainOutbox(fixture.context, primary, 1, [roOne, roTwo]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.deepEqual(order, ["primary", "ro-one", "ro-two"]);
    assert.equal(primary.calls.length, 1);
    assert.equal(roOne.calls.length, 1);
    assert.equal(roTwo.calls.length, 1);
    assert.equal(readdirSync(join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox")).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: primary success archives after RO failure and does not resend on retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-ro-failure-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-ro-failure-run" });
    const order: string[] = [];
    const primary = new RecordingAdapter("primary", fixture.run_identity, true, order);
    const ro = new RecordingAdapter("ro", fixture.run_identity, false, order);
    const queued = queueCtoDelivery(fixture.context, {
      id: "summary-ro-failure-run/cto/summary/1",
      level: "question",
      title: "Summary",
      body: "Summary body",
      intent: "summary",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);
    const diagnostics: WorkflowV2Diagnostic[] = [];
    const first = await drainOutbox(
      fixture.context,
      primary,
      1,
      [ro],
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.equal(first.length, 1);
    assert.equal(first[0]?.sent, true);
    assert.deepEqual(order, ["primary", "ro"]);
    assert.equal(primary.calls.length, 1);
    assert.equal(ro.calls.length, 1);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "ACTIVATION_FAILED");
    assert.equal(diagnostics[0]?.operation, "runtime.activate");
    assert.deepEqual(diagnostics[0]?.evidence, { profile_id: "ro-0", order: 0, status: "failed" });
    assert.equal(
      diagnostics[0]?.remediation,
      "Read-only sink ro[0] failed to deliver the summary; best-effort fanout was archived.",
    );

    const outbox = join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox");
    assert.equal(readdirSync(outbox).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(readdirSync(join(outbox, "sent")).filter((name) => name.endsWith(".json")).length, 1);

    const retry = await drainOutbox(
      fixture.context,
      primary,
      1,
      [ro],
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.deepEqual(retry, []);
    assert.deepEqual(order, ["primary", "ro"]);
    assert.equal(primary.calls.length, 1);
    assert.equal(ro.calls.length, 1);
    assert.equal(diagnostics.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fake-rw: RO-only all-failed summary remains pending and retries each eligible sink", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-ro-only-failed-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-ro-only-failed-run" });
    const order: string[] = [];
    const roOne = new RecordingAdapter("ro-one", fixture.run_identity, false, order);
    const roTwo = new RecordingAdapter("ro-two", fixture.run_identity, false, order);
    const delivery = {
      id: "summary-ro-only-failed-run/cto/summary/1",
      level: "question" as const,
      title: "RO-only summary",
      body: "Retry this summary.",
      intent: "summary" as const,
      run_identity: fixture.run_identity,
    };
    const queued = queueCtoDelivery(fixture.context, delivery);
    assert.equal(queued.ok, true);

    const filenameKey = durableFilenameKey(delivery.id);
    const outbox = join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox");
    const activePath = join(outbox, `${filenameKey}.json`);
    const pendingBefore = readFileSync(activePath, "utf8");
    const diagnostics: WorkflowV2Diagnostic[] = [];
    const first = await drainOutbox(
      fixture.context,
      null,
      1,
      [roOne, roTwo],
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.deepEqual(first, [{
      escId: delivery.id,
      sent: false,
      error: "ro[0]: delivery failed; ro[1]: delivery failed",
    }]);
    assert.deepEqual(order, ["ro-one", "ro-two"]);
    assert.equal(roOne.calls.length, 1);
    assert.equal(roTwo.calls.length, 1);
    assert.deepEqual(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        operation: diagnostic.operation,
        remediation: diagnostic.remediation,
        evidence: diagnostic.evidence,
      })),
      [
        {
          code: "ACTIVATION_FAILED",
          operation: "runtime.activate",
          remediation: "Read-only sink ro[0] failed to deliver the summary; all eligible read-only sinks failed and the exact outbox record remains pending for retry.",
          evidence: { profile_id: "ro-0", order: 0, status: "failed" },
        },
        {
          code: "ACTIVATION_FAILED",
          operation: "runtime.activate",
          remediation: "Read-only sink ro[1] failed to deliver the summary; all eligible read-only sinks failed and the exact outbox record remains pending for retry.",
          evidence: { profile_id: "ro-1", order: 1, status: "failed" },
        },
      ],
    );
    assert.equal(readdirSync(outbox).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(
      existsSync(join(outbox, "sent"))
        ? readdirSync(join(outbox, "sent")).filter((name) => name.endsWith(".json")).length
        : 0,
      0,
      "all-failed delivery must not create a terminal sent archive",
    );
    assert.equal(readFileSync(activePath, "utf8"), pendingBefore, "all-failed delivery retains the exact pending record");

    const retry = await drainOutbox(
      fixture.context,
      null,
      1,
      [roOne, roTwo],
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.deepEqual(retry, first);
    assert.deepEqual(order, ["ro-one", "ro-two", "ro-one", "ro-two"]);
    assert.equal(roOne.calls.length, 2);
    assert.equal(roTwo.calls.length, 2);
    assert.equal(diagnostics.length, 4);
    assert.equal(readFileSync(activePath, "utf8"), pendingBefore, "retry does not rewrite the exact pending record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: RO-only mixed-success summary archives and does not resend on retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-ro-only-mixed-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-ro-only-mixed-run" });
    const order: string[] = [];
    const roOne = new RecordingAdapter("ro-one", fixture.run_identity, false, order);
    const roTwo = new RecordingAdapter("ro-two", fixture.run_identity, true, order);
    const delivery = {
      id: "summary-ro-only-mixed-run/cto/summary/1",
      level: "question" as const,
      title: "RO-only mixed summary",
      body: "Archive after one sink succeeds.",
      intent: "summary" as const,
      run_identity: fixture.run_identity,
    };
    const queued = queueCtoDelivery(fixture.context, delivery);
    assert.equal(queued.ok, true);
    const outbox = join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox");


    const diagnostics: WorkflowV2Diagnostic[] = [];
    const first = await drainOutbox(
      fixture.context,
      null,
      1,
      [roOne, roTwo],
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.deepEqual(first, [{ escId: delivery.id, sent: true }]);
    assert.deepEqual(order, ["ro-one", "ro-two"]);
    assert.equal(roOne.calls.length, 1);
    assert.equal(roTwo.calls.length, 1);
    assert.deepEqual(diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      operation: diagnostic.operation,
      remediation: diagnostic.remediation,
      evidence: diagnostic.evidence,
    })), [{
      code: "ACTIVATION_FAILED",
      operation: "runtime.activate",
      remediation: "Read-only sink ro[0] failed to deliver the summary; best-effort fanout was archived.",
      evidence: { profile_id: "ro-0", order: 0, status: "failed" },
    }]);
    assert.equal(readdirSync(outbox).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(readdirSync(join(outbox, "sent")).filter((name) => name.endsWith(".json")).length, 1);

    const retry = await drainOutbox(
      fixture.context,
      null,
      1,
      [roOne, roTwo],
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.deepEqual(retry, []);
    assert.deepEqual(order, ["ro-one", "ro-two"]);
    assert.equal(roOne.calls.length, 1, "a successful sink must not be resent");
    assert.equal(roTwo.calls.length, 1, "a failed sink must not be resent after mixed success");
    assert.equal(diagnostics.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("fake-rw: primary failure keeps summary pending without invoking RO and retries primary only", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-failure-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-failure-run" });
    const order: string[] = [];
    const primary = new RecordingAdapter("primary", fixture.run_identity, false, order);
    const ro = new RecordingAdapter("ro", fixture.run_identity, true, order);
    const queued = queueCtoDelivery(fixture.context, {
      id: "summary-failure-run/cto/summary/1",
      level: "question",
      title: "Summary",
      body: "Summary body",
      intent: "summary",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);

    const first = await drainOutbox(fixture.context, primary, 1, [ro]);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.sent, false);
    assert.equal(first[0]?.error, "primary: delivery failed");
    assert.deepEqual(order, ["primary"]);
    assert.equal(primary.calls.length, 1);
    assert.equal(ro.calls.length, 0);

    const retry = await drainOutbox(fixture.context, primary, 1, [ro]);
    assert.equal(retry.length, 1);
    assert.equal(retry[0]?.sent, false);
    assert.equal(retry[0]?.error, "primary: delivery failed");
    assert.deepEqual(order, ["primary", "primary"]);
    assert.equal(primary.calls.length, 2);
    assert.equal(ro.calls.length, 0);
    assert.equal(readdirSync(join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox")).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: summary fanout filters read-only sinks by exact topic subscriptions", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-subscriptions-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-subscriptions-run" });
    const order: string[] = [];
    const adapters = new Map<string, RecordingAdapter>();
    const factories = createAdapterFactories();
    const registered = registerEscalationAdapterFactory(factories, "recording", ({ channel, run_identity }) => {
      const id = typeof channel.id === "string" ? channel.id : "unknown";
      const adapter = new RecordingAdapter(id, run_identity, true, order);
      adapters.set(id, adapter);
      return adapter;
    });
    assert.equal(registered.ok, true);
    const admission = channelAdmission(fixture, [
      { id: "primary", adapter: "recording", direction: "read-write", primary: true, subscriptions: ["bar"] },
      { id: "foo", adapter: "recording", direction: "read-only", subscriptions: ["foo"] },
      { id: "bar", adapter: "recording", direction: "read-only", subscriptions: ["bar"] },
      { id: "none", adapter: "recording", direction: "read-only", subscriptions: [] },
      { id: "all", adapter: "recording", direction: "read-only" },
    ]);
    const resolved = createChannelSet({ ...fixture.context, channel_admission: admission, factories });
    assert.equal(resolved.ok, true);
    if (!resolved.ok || !resolved.value.primary) return;
    const queued = queueCtoDelivery(fixture.context, {
      id: "summary-subscriptions-run/cto/summary/foo",
      level: "question",
      title: "Foo summary",
      body: "Foo body",
      intent: "summary",
      topic: "foo",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);
    const results = await drainOutbox(fixture.context, resolved.value.primary, 1, resolved.value.roSinks);
    assert.equal(results[0]?.sent, true);
    assert.deepEqual(order, ["primary", "foo", "all"]);
    assert.equal(adapters.get("foo")?.calls.length, 1);
    assert.equal(adapters.get("all")?.calls.length, 1);
    assert.equal(adapters.get("bar")?.calls.length, 0, "bar-only sink must not receive foo");
    assert.equal(adapters.get("none")?.calls.length, 0, "an explicit empty subscription list receives no topic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: ineligible RO sinks stay untouched when the primary fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-subscription-failure-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-subscription-failure-run" });
    const order: string[] = [];
    const adapters = new Map<string, RecordingAdapter>();
    const factories = createAdapterFactories();
    const registered = registerEscalationAdapterFactory(factories, "recording", ({ channel, run_identity }) => {
      const id = typeof channel.id === "string" ? channel.id : "unknown";
      const adapter = new RecordingAdapter(id, run_identity, id !== "primary", order);
      adapters.set(id, adapter);
      return adapter;
    });
    assert.equal(registered.ok, true);
    const admission = channelAdmission(fixture, [
      { id: "primary", adapter: "recording", direction: "read-write", primary: true },
      { id: "foo", adapter: "recording", direction: "read-only", subscriptions: ["foo"] },
      { id: "bar", adapter: "recording", direction: "read-only", subscriptions: ["bar"] },
      { id: "none", adapter: "recording", direction: "read-only", subscriptions: [] },
    ]);
    const resolved = createChannelSet({ ...fixture.context, channel_admission: admission, factories });
    assert.equal(resolved.ok, true);
    if (!resolved.ok || !resolved.value.primary) return;
    const queued = queueCtoDelivery(fixture.context, {
      id: "summary-subscription-failure-run/cto/summary/foo",
      level: "question",
      title: "Foo summary",
      body: "Foo body",
      intent: "summary",
      topic: "foo",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);
    const results = await drainOutbox(fixture.context, resolved.value.primary, 1, resolved.value.roSinks);
    assert.equal(results[0]?.sent, false);
    assert.equal(results[0]?.error, "primary: delivery failed");
    assert.deepEqual(order, ["primary"]);
    assert.equal(adapters.get("foo")?.calls.length, 0, "eligible foo sink must wait for primary success");
    assert.equal(adapters.get("bar")?.calls.length, 0, "ineligible bar sink must not affect pending state");
    assert.equal(adapters.get("none")?.calls.length, 0, "empty subscriptions must not affect pending state");
    assert.equal(readdirSync(join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox")).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: summary with no eligible RO subscriber is skipped and archived", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-summary-no-subscriber-"));
  try {
    const fixture = runtimeFixture(root, { runId: "summary-no-subscriber-run" });
    const adapters = new Map<string, RecordingAdapter>();
    const factories = createAdapterFactories();
    const registered = registerEscalationAdapterFactory(factories, "recording", ({ channel, run_identity }) => {
      const id = typeof channel.id === "string" ? channel.id : "unknown";
      const adapter = new RecordingAdapter(id, run_identity, true, []);
      adapters.set(id, adapter);
      return adapter;
    });
    assert.equal(registered.ok, true);
    const admission = channelAdmission(fixture, [
      { id: "bar", adapter: "recording", direction: "read-only", subscriptions: ["bar"] },
      { id: "none", adapter: "recording", direction: "read-only", subscriptions: [] },
    ]);
    const resolved = createChannelSet({ ...fixture.context, channel_admission: admission, factories });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.primary, null);
    const queued = queueCtoDelivery(fixture.context, {
      id: "summary-no-subscriber-run/cto/summary/foo",
      level: "question",
      title: "Foo summary",
      body: "Foo body",
      intent: "summary",
      topic: "foo",
      run_identity: fixture.run_identity,
    });
    assert.equal(queued.ok, true);
    const diagnostics: unknown[] = [];
    const deliveryId = "summary-no-subscriber-run/cto/summary/foo";
    const results = await drainOutbox(
      fixture.context,
      resolved.value.primary,
      1,
      resolved.value.roSinks,
      (diagnostic) => { diagnostics.push(diagnostic); },
    );
    assert.deepEqual(results, [{ escId: deliveryId, sent: false, error: "no eligible subscriber for summary topic" }]);
    assert.equal(adapters.get("bar")?.calls.length, 0);
    assert.equal(adapters.get("none")?.calls.length, 0);
    const outbox = join(root, ".work-state", "cto", fixture.run_identity.run_id, "outbox");
    assert.equal(readdirSync(outbox).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(readdirSync(join(outbox, "skipped")).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(diagnostics.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: restart queue treats sent archive as idempotent and rejects conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-queue-sent-restart-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const runId = "queue-sent-restart-run";
    const fixture = runtimeFixture(root, { runId });
    const channels = [{ id: "mock-channel", adapter: "mock", direction: "read-write", primary: true, persisted: true, dir: "rw" }] as const;
    const firstSet = explicitMockChannelSet(fixture, channels);
    const firstAdapter = firstSet.primary;
    assert.ok(firstAdapter instanceof MockEscalationAdapter);
    const delivery = {
      id: `${runId}/cto/ack/1`,
      level: "question" as const,
      title: "Restart-safe delivery",
      body: "This must be sent once.",
      intent: "ack" as const,
      run_identity: fixture.run_identity,
    };
    const queued = queueCtoDelivery(fixture.context, delivery);
    assert.equal(queued.ok, true);

    const started = startDispatcher(fixture.context, firstSet.primary, { intervalMs: 1 });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("sent archive dispatcher should start");
    stop = started.value.stop;
    const filenameKey = durableFilenameKey(delivery.id);
    const archiveRelative = `.work-state/cto/${runId}/outbox/sent/${filenameKey}.json`;
    await waitForDurableFile(root, archiveRelative);
    await started.value.stop();
    stop = undefined;

    assert.equal(firstAdapter.sentEscalations.length, 1);
    const archivePath = join(root, ...archiveRelative.split("/"));
    const archivedBefore = readFileSync(archivePath, "utf8");
    const activePath = join(root, `.work-state/cto/${runId}/outbox/${filenameKey}.json`);

    const restartedFixture = runtimeFixture(root, { runId });
    const restartedSet = explicitMockChannelSet(restartedFixture, channels);
    const restartedAdapter = restartedSet.primary;
    assert.ok(restartedAdapter instanceof MockEscalationAdapter);
    const restarted = startDispatcher(restartedFixture.context, restartedSet.primary, { intervalMs: 1 });
    assert.equal(restarted.ok, true);
    if (!restarted.ok) throw new Error("restarted sent archive dispatcher should start");
    stop = restarted.value.stop;

    const exact = queueCtoDelivery(restartedFixture.context, delivery);
    assert.equal(exact.ok, true);
    if (exact.ok) assert.equal(exact.value, null, "sent archive replay must not create an active record");
    const conflict = queueCtoDelivery(restartedFixture.context, { ...delivery, body: "Conflicting delivery." });
    assert.equal(conflict.ok, false, "same id with a different archived payload must fail");
    if (!conflict.ok) assert.equal(conflict.diagnostics[0]?.code, "IDENTITY_MISMATCH");

    await restarted.value.stop();
    stop = undefined;
    assert.equal(restartedAdapter.sentEscalations.length, 0, "restart replay and conflict must not send again");
    assert.equal(existsSync(activePath), false, "archived replay must not recreate the active outbox record");
    assert.equal(readFileSync(archivePath, "utf8"), archivedBefore, "conflict must not overwrite the sent archive");
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: restart queue treats skipped archive as idempotent and rejects conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-queue-skipped-restart-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const runId = "queue-skipped-restart-run";
    const fixture = runtimeFixture(root, { runId });
    const channels = [{ id: "mock-channel", adapter: "mock", direction: "read-only", subscriptions: ["other"], persisted: true, dir: "ro" }] as const;
    const firstSet = explicitMockChannelSet(fixture, channels);
    assert.equal(firstSet.primary, null);
    const firstAdapter = firstSet.roSinks[0];
    assert.ok(firstAdapter instanceof MockEscalationAdapter);
    const delivery = {
      id: `${runId}/cto/summary/1`,
      level: "question" as const,
      title: "Restart-safe skipped delivery",
      body: "No eligible subscriber.",
      intent: "summary" as const,
      topic: "foo",
      run_identity: fixture.run_identity,
    };
    const queued = queueCtoDelivery(fixture.context, delivery);
    assert.equal(queued.ok, true);

    const started = startChannelDispatcher({ ...fixture.context, channel_admission: firstSet.channel_admission }, firstSet, { intervalMs: 1 });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("skipped archive dispatcher should start");
    stop = started.value.stop;
    const filenameKey = durableFilenameKey(delivery.id);
    const archiveRelative = `.work-state/cto/${runId}/outbox/skipped/${filenameKey}.json`;
    await waitForDurableFile(root, archiveRelative);
    await started.value.stop();
    stop = undefined;

    assert.equal(firstAdapter.sentEscalations.length, 0);
    const archivePath = join(root, ...archiveRelative.split("/"));
    const archivedBefore = readFileSync(archivePath, "utf8");
    const activePath = join(root, `.work-state/cto/${runId}/outbox/${filenameKey}.json`);

    const restartedFixture = runtimeFixture(root, { runId });
    const restartedSet = explicitMockChannelSet(restartedFixture, channels);
    assert.equal(restartedSet.primary, null);
    const restartedAdapter = restartedSet.roSinks[0];
    assert.ok(restartedAdapter instanceof MockEscalationAdapter);
    const restarted = startChannelDispatcher({ ...restartedFixture.context, channel_admission: restartedSet.channel_admission }, restartedSet, { intervalMs: 1 });
    assert.equal(restarted.ok, true);
    if (!restarted.ok) throw new Error("restarted skipped archive dispatcher should start");
    stop = restarted.value.stop;

    const exact = queueCtoDelivery(restartedFixture.context, delivery);
    assert.equal(exact.ok, true);
    if (exact.ok) assert.equal(exact.value, null, "skipped archive replay must not create an active record");
    const conflict = queueCtoDelivery(restartedFixture.context, { ...delivery, body: "Conflicting delivery." });
    assert.equal(conflict.ok, false, "same id with a different skipped payload must fail");
    if (!conflict.ok) assert.equal(conflict.diagnostics[0]?.code, "IDENTITY_MISMATCH");

    await restarted.value.stop();
    stop = undefined;
    assert.equal(restartedAdapter.sentEscalations.length, 0, "restart replay and conflict must not send again");
    assert.equal(existsSync(activePath), false, "archived replay must not recreate the active outbox record");
    assert.equal(readFileSync(archivePath, "utf8"), archivedBefore, "conflict must not overwrite the skipped archive");
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: injectTask awaits callback rejection and keeps durable source pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-inject-retry-"));
  try {
    const fixture = runtimeFixture(root, { runId: "inject-retry-run" });
    const adapter = persistedAdapter(fixture, "rw");
    adapter.setPlainMessageHandler(async () => {
      throw new Error("wake failed (transport down)");
    });
    await assert.rejects(() => adapter.injectTask("retry me", "mock"), /wake failed/);
    assert.equal(readdirSync(join(root, "rw", "inbound")).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(existsSync(join(root, "rw", "inbound", "processed")), false);

    adapter.setPlainMessageHandler(async () => undefined);
    await adapter.pollOnce();
    assert.equal(readdirSync(join(root, "rw", "inbound")).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal(readdirSync(join(root, "rw", "inbound", "processed")).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: filing-only inbox task remains pending without a callback", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-filing-only-"));
  try {
    const fixture = runtimeFixture(root, { runId: "filing-only-run" });
    const task = {
      id: "filing-only-task",
      text: "retain this task",
      at: "2026-08-28T00:00:00.000Z",
      run_identity: fixture.run_identity,
    } as const;
    const filed = await handleInboxTask(fixture.context, task);
    assert.equal(filed.ok, true);
    if (filed.ok) assert.equal(filed.value, `.work-state/cto/filing-only-run/inbox/${durableFilenameKey(task.id)}.json`);

    const pendingFilename = `${durableFilenameKey(task.id)}.json`;
    const pendingPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", pendingFilename);
    const processedPath = join(root, ".work-state", "cto", fixture.run_identity.run_id, "inbox", "processed", pendingFilename);
    assert.equal(existsSync(pendingPath), true, "filing-only admission must retain the exact pending task");
    assert.equal(existsSync(processedPath), false, "filing-only admission must not move the task to processed");
    assert.deepEqual(JSON.parse(readFileSync(pendingPath, "utf8")), task);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: reset clears in-memory state without deleting durable owner records", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-reset-"));
  try {
    const fixture = runtimeFixture(root, { runId: "reset-run" });
    const adapter = persistedAdapter(fixture, "rw");
    const escalation = { id: "reset-run/x/1", level: "question" as const, title: "t", body: "b", run_identity: fixture.run_identity };
    await adapter.send(escalation);
    await adapter.injectTask("task");
    adapter.injectAnswer(escalation.id, "ans");
    adapter.reset();
    assert.equal(adapter.sentEscalations.length, 0);
    assert.equal(existsSync(join(root, "rw", "inbound")), true);
    assert.equal(existsSync(join(root, "rw", "answers")), true);
    assert.equal(existsSync(join(root, "rw", "outbound")), true);
    assert.equal(adapter.kind, "mock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: mock adapter is available only through explicit test factory injection", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-factory-"));
  try {
    const fixture = runtimeFixture(root, { runId: "factory-run" });
    const channels = [{ id: "control", adapter: "mock", direction: "read-write", primary: true, persisted: true, dir: "my-rw" }] as const;
    const admission = channelAdmission(fixture, channels);
    const factories = createAdapterFactories();
    assert.equal(factories.has("mock"), false, "production builtin registry must not expose mock");
    registerEscalationAdapterFactory(factories, "mock", ({ project_root, run_identity, filesystem_authority, storage, channel }) => new MockEscalationAdapter({ project_root, run_identity, filesystem_authority, storage, persisted: { relative_dir: typeof channel.dir === "string" ? channel.dir : "my-rw" } }));
    const built = createEscalationAdapter({ ...fixture.context, channel_admission: admission }, admission, factories);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.ok(built.value instanceof MockEscalationAdapter);
    await (built.value as MockEscalationAdapter).injectTask("hello");
    assert.ok(existsSync(join(root, "my-rw", "inbound")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-rw: registry rejects missing manager admission", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-rw-admission-"));
  try {
    const fixture = runtimeFixture(root);
    const result = createEscalationAdapter(fixture.context, undefined as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CAPABILITY_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
