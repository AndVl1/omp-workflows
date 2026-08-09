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
import type { Escalation } from "@andvl1/omp-workflows-core";
import {
  createChannelSet,
  startChannelDispatcher,
  drainOutbox,
  outboxDir,
  queueCtoDelivery,
  isBidirectionalChannel,
  handleInboxTask,
  inboxDir,
  loadEscalationConfig,
  createEscalationAdapter,
  registerEscalationAdapter,
  resolveInboxRunId,
  type InboxTask,
} from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import { createAskRedirectGate } from "../src/messenger-channel.js";

function withConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}

function withActiveRun(root: string): void {
  const runDir = join(root, ".work-state", "cto", "run-one");
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schema: 1,
      id: "run-one",
      task: "Some task",
      branch: "main",
      autonomous: true,
      plan: { id: "run-one", task: "Some task", teams: [], created_at: now },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: now,
    }),
  );
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

test("policy: declared rw on an incapable kind downgrades to ro", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-downgrade-"));
  try {
    withConfig(root, {
      channels: [{ id: "web", adapter: "http", direction: "read-write", primary: true, http: { url: "https://ntfy.sh/x" } }],
    });
    const set = createChannelSet(root);
    assert.equal(set.profiles[0]?.direction, "ro", "http has no inbound -> declared rw downgrades to ro");
    assert.equal(set.primary, null);
    assert.equal(set.roSinks.length, 1);
    assert.equal(isBidirectionalChannel(root), false);
  } finally {
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

test("policy: two same-kind mock channels with distinct ids get distinct per-entry configs (own persisted dirs)", () => {
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
    (set.primary as MockEscalationAdapter).injectTask("hello ctrl");
    (set.roSinks[0] as MockEscalationAdapter).injectTask("hello audit");
    assert.ok(existsSync(join(root, "rw-ctrl", "inbound")), "primary writes its own dir");
    assert.ok(existsSync(join(root, "rw-audit", "inbound")), "sink writes its own dir");
    assert.equal(readdirSync(join(root, "rw-ctrl", "inbound")).filter((n) => n.endsWith(".json")).length, 1);
    assert.equal(readdirSync(join(root, "rw-audit", "inbound")).filter((n) => n.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy: same-kind id-less duplicate channels are excluded — neither built", () => {
  const root = mkdtempSync(join(tmpdir(), "pol-idless-dup-"));
  try {
    withConfig(root, {
      channels: [
        { adapter: "mock", direction: "read-write", primary: true },
        { adapter: "mock", direction: "read-only" },
      ],
    });
    const set = createChannelSet(root);
    assert.deepEqual(set.profiles, [], "ambiguous id-less duplicates excluded by the normalizer");
    assert.equal(set.primary, null, "no primary from an ambiguous pair");
    assert.deepEqual(set.roSinks, [], "no sink from an ambiguous pair");
    assert.equal(set.profile.direction, "none");
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
    stop();
    assert.equal(wired, 0, "RO sink never wired for inbound");
    assert.equal(polled, 0, "RO sink never polled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO inbound prohibition: only the primary is wired; the RO sink is not", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-wire-"));
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

    const stop = startChannelDispatcher(root, set, 10_000, {});
    await pollGate.promise;
    await Promise.resolve();

    // The primary's inbound path IS live while the dispatcher owns the
    // lease: a plain message files a task into the standby run's inbox
    // through the dispatcher's wired handler (wakeTask checks the lease).
    primary.injectPlainMessage("task via primary");
    const runId = readdirSync(join(root, ".work-state", "cto"))[0]!;
    const filed = readdirSync(inboxDir(runId, root)).filter((n) => n.endsWith(".json"));
    assert.equal(filed.length, 1, "primary inbound filed the task");

    stop();
    assert.equal(sinkWired, 0, "RO sink never wired");
    assert.equal(sinkPolled, 0, "RO sink never polled");
  } finally {
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
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "q1.json"),
      JSON.stringify({
        id: "run-q/team-a/q1",
        level: "question",
        title: "Q",
        body: "q",
        intent: "question",
        topic: "question",
      }),
    );
    await drainOutbox(root, primary, 3, { roSinks: [sink] });
    assert.equal(primary.sentEscalations.length, 1, "primary received the question");
    assert.equal(sink.sentEscalations.length, 0, "RO sink must NOT receive a question");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RO routing: summary reports reach a subscribed sink by topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-sum-"));
  try {
    withConfig(root, {
      channels: [
        { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
        { id: "audit", adapter: "mock", direction: "read-only", subscriptions: ["progress", "summary"] },
      ],
    });
    const set = createChannelSet(root);
    const primary = set.primary as MockEscalationAdapter;
    const sink = set.roSinks[0] as MockEscalationAdapter;
    const runId = "run-sum";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({
        id: "run-sum/sum/1",
        level: "question",
        title: "Progress",
        body: "done 2/5",
        intent: "summary",
        topic: "progress",
      }),
    );
    writeFileSync(
      join(outboxDir(runId, root), "s2.json"),
      JSON.stringify({
        id: "run-sum/sum/2",
        level: "question",
        title: "Other",
        body: "unrelated",
        intent: "summary",
        topic: "billing",
      }),
    );
    const results = await drainOutbox(root, primary, 3, { roSinks: [sink] });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.sent === true), "both summaries delivered via primary");
    assert.equal(primary.sentEscalations.length, 2);
    assert.equal(sink.sentEscalations.length, 1, "only the subscribed topic reached the sink");
    assert.equal(sink.sentEscalations[0]?.topic, "progress");
  } finally {
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
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({ id: "run-all/sum/1", level: "question", title: "A", body: "a", intent: "summary", topic: "alpha" }),
    );
    writeFileSync(
      join(outboxDir(runId, root), "s2.json"),
      JSON.stringify({ id: "run-all/sum/2", level: "question", title: "B", body: "b", intent: "summary", topic: "beta" }),
    );
    await drainOutbox(root, primary, 3, { roSinks: [sink] });
    assert.equal(sink.sentEscalations.length, 2, "no subscriptions -> all reports");
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    registerEscalationAdapter("spy-legacy", () => ({
      kind: "spy-legacy",
      send: async (esc: Escalation) => {
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
    }));

    withConfig(root, { adapter: "spy-legacy" });
    const set = createChannelSet(root);
    assert.equal(set.primary, null, "no validated rw primary for the legacy RO adapter");
    assert.equal(set.roSinks.length, 1);
    assert.equal(set.legacySingleAdapter, true, "no channels[] -> legacy single-adapter set");

    const runId = "run-legacy";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "q1.json"),
      JSON.stringify({ id: "run-legacy/team-a/q1", level: "question", title: "Q", body: "q" }),
    );

    const stop = startChannelDispatcher(root, set, 10_000, {});
    await sendGate.promise;
    await Promise.resolve();
    stop();
    assert.equal(delivered.length, 1, "legacy RO adapter still drains the outbox");
    assert.equal(delivered[0]?.id, "run-legacy/team-a/q1");
    assert.equal(wireCalls, 0, "legacy RO adapter is never wired for inbound");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit RO-only: summary reaches the sink without a primary; questions stay", async () => {
  const root = mkdtempSync(join(tmpdir(), "ro-only-drain-"));
  try {
    const delivered: Escalation[] = [];
    registerEscalationAdapter("spy-ro", () => ({
      kind: "spy-ro",
      send: async (esc: Escalation) => {
        delivered.push(esc);
        return { sent: true };
      },
      cancel: async () => undefined,
    }));

    withConfig(root, {
      channels: [{ id: "ro", adapter: "spy-ro", direction: "read-only", subscriptions: ["reports"] }],
    });
    const set = createChannelSet(root);
    assert.equal(set.primary, null);
    assert.equal(set.roSinks.length, 1);
    assert.equal(set.legacySingleAdapter, false);

    const runId = "run-ro-only";
    mkdirSync(outboxDir(runId, root), { recursive: true });
    writeFileSync(
      join(outboxDir(runId, root), "s1.json"),
      JSON.stringify({
        id: "run-ro-only/sum/1",
        level: "question",
        title: "Progress",
        body: "done 2/5",
        intent: "summary",
        topic: "reports",
      }),
    );
    writeFileSync(
      join(outboxDir(runId, root), "q1.json"),
      JSON.stringify({ id: "run-ro-only/team-a/q1", level: "question", title: "Q", body: "q", intent: "question" }),
    );

    const results = await drainOutbox(root, null, 3, { roSinks: set.roSinks });
    assert.equal(results.length, 2);
    const summary = results.find((r) => r.escId === "s1");
    const question = results.find((r) => r.escId === "q1");
    assert.ok(summary?.sent === true, "summary delivered to the RO sink without a primary");
    assert.equal(delivered.length, 1, "one send to the sink");
    assert.equal(delivered[0]?.topic, "reports");
    assert.ok(question && question.sent === false, "question cannot be delivered without a primary");
    assert.equal(question?.error, "no rw primary to deliver non-report entry");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent", "s1.json")), "summary moved to sent/");
    assert.ok(existsSync(join(outboxDir(runId, root), "q1.json")), "question left in the outbox for a later primary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Delivery envelope / legacy compatibility ───────────────────────────────

test("envelope: queueCtoDelivery survives drainOutbox with intent intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-queue-"));
  try {
    const runId = "run-ack";
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

test("envelope: queueCtoDelivery is idempotent on delivery id", () => {
  const root = mkdtempSync(join(tmpdir(), "env-dedup-"));
  try {
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

test("envelope/legacy: legacy mock config still creates the in-memory mock", () => {
  const root = mkdtempSync(join(tmpdir(), "env-legacy-mock-"));
  try {
    withConfig(root, { adapter: "mock", bidirectional: true });
    const config = loadEscalationConfig(root);
    assert.equal(config?.adapter, "mock");
    const adapter = createEscalationAdapter(config!, root);
    assert.ok(adapter instanceof MockEscalationAdapter, "legacy mock builds the in-memory adapter");
    (adapter as MockEscalationAdapter).injectTask("no files should be written");
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

test("wave: handleInboxTask admits a wave with source_id == task.id", () => {
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
    assert.equal(state.wave_history[0]?.source_id, "t1");
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
    assert.equal(state.wave_history[0]?.source_id, "t1");
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
    assert.equal(state.wave_history[0]?.source_id, "t1");
    assert.equal(received[0]?.waveId, state.wave_history[0]?.id, "retry carries the same wave id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Ask gate (capability-validated) ────────────────────────────────────────

test("ask gate: blocks only with a validated RW primary AND an active run", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-cap-"));
  try {
    const gate = createAskRedirectGate();

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

test("ask gate: explicit validated RW primary blocks; declared-rw incapable kind passes (explicit channels[])", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-explicit-"));
  try {
    const gate = createAskRedirectGate();

    // explicit validated RW primary (mock: inbound+outbound) + active run -> blocked
    withConfig(root, { channels: [{ id: "control", adapter: "mock", direction: "read-write", primary: true }] });
    withActiveRun(root);
    const blocked = gate({ toolName: "ask" }, { cwd: root });
    assert.ok(blocked?.block === true, "explicit validated RW primary + active run -> blocked");

    // explicit declared-rw incapable kind (http: no inbound -> ro) + active run -> passes
    withConfig(root, { channels: [{ id: "sink", adapter: "http", direction: "read-write" }] });
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "explicit declared-rw http downgrades to ro -> ask passes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
