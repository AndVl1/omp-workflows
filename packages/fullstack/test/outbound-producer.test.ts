/**
 * RW outbound producer tests (resident control-plane, fullstack-dispatch).
 *
 * Covers the dispatcher-side producers that close the outbound gap:
 *   (a) task-admission ACK — handleInboxTask on an RW primary queues ONE
 *       deterministic `<runId>/wave/<taskId>/ack` (intent "ack", target =
 *       profile ackTarget when set); drain sends it exactly once; a
 *       transport retry with the same task id queues nothing new.
 *   (b) no ACK without an RW primary — RO-only configs queue no ack (the
 *       producer never queues non-report entries without a primary).
 *   (c) wave-completion summary — a finished wave queues one deterministic
 *       `<runId>/wave/<waveId>/summary` (intent "summary", body synthesized
 *       ONLY from authoritative state.json); drain sends it to the primary
 *       AND fans out to an unsubscribed RO sink; archived to sent/.
 *   (d) no summary while a wave is active; a failed wave WITH finished_at
 *       IS summarized.
 *   (e) at-least-once across a stale sent replay — a renewed pending
 *       summary obligation republishes the canonical id; receiver idempotency
 *       suppresses duplicate transport delivery and sent/ never becomes authority.
 *   (f) legacy telegram RW config still produces the ACK (with ackTarget =
 *       chatId); no .omp/escalation.json -> handleInboxTask unchanged.
 *
 * Namespace import is deliberate: the file must LOAD and each test must
 * fail on its own assertion pre-fix (a missing named export would fail the
 * whole file at link time instead of producing per-test evidence).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registry from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import { openFullstackRuntimeTest, type FullstackRuntimeTestFixture } from "./runtime-access-fixture.js";
import { canonicalDurableIdFileName } from "../../core/src/cto/durable-id.js";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState } from "../../core/src/cto/state.js";

type FullstackRuntime = FullstackRuntimeTestFixture;
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
  const fixture = openFullstackRuntimeTest(root, "outbound-producer-test-" + runtimeFixtures.size);
  runtimeFixtures.set(root, fixture);
  return fixture;
}
test.afterEach(() => {
  for (const fixture of runtimeFixtures.values()) fixture.close();
  runtimeFixtures.clear();
  retryDrainContexts.clear();
});

type ChannelCapabilities = Parameters<typeof registry.createChannelSet>[1];
type ChannelPinnedRoot = Parameters<typeof registry.createChannelSet>[2];
type DrainOptions = NonNullable<Parameters<typeof registry.drainOutbox>[3]>;
type DeliveryPinnedRoot = Parameters<typeof registry.queueCtoDelivery>[3];
type DeliveryOwner = Parameters<typeof registry.queueCtoDelivery>[4];
type HandleOptions = NonNullable<Parameters<typeof registry.handleInboxTask>[3]>;
type RunOptions = NonNullable<Parameters<typeof registry.produceWaveDeliveries>[1]>;

function createChannelSet(root: string, capabilities?: ChannelCapabilities, pinnedRoot?: ChannelPinnedRoot) {
  return registry.createChannelSet(root, capabilities, pinnedRoot, runtimeFor(root).access, runtimeFor(root).proofAuthority);
}
function drainOutbox(root: string, adapter: Parameters<typeof registry.drainOutbox>[1], maxRetries = 3, options: DrainOptions = {}) {
  return registry.drainOutbox(root, adapter, maxRetries, { ...retryDrainContext(root), ...options, runtimeAccess: options.runtimeAccess ?? runtimeFor(root).access, serviceAuthority: options.serviceAuthority ?? runtimeFor(root).serviceAuthority, proofAuthority: runtimeFor(root).proofAuthority });
}
function queueCtoDelivery(root: string, runId: string, delivery: Parameters<typeof registry.queueCtoDelivery>[2], pinnedRoot?: DeliveryPinnedRoot, isOwned?: DeliveryOwner, runtimeAccess?: Parameters<typeof registry.queueCtoDelivery>[5]) {
  return registry.queueCtoDelivery(root, runId, delivery, pinnedRoot, isOwned, runtimeAccess ?? runtimeFor(root).access);
}
function handleInboxTask(root: string, task: Parameters<typeof registry.handleInboxTask>[1], onTask?: Parameters<typeof registry.handleInboxTask>[2], options: HandleOptions = {}) {
  return registry.handleInboxTask(root, task, onTask, { ...options, runtimeAccess: options.runtimeAccess ?? runtimeFor(root).access, serviceAuthority: options.serviceAuthority ?? runtimeFor(root).serviceAuthority, proofAuthority: runtimeFor(root).proofAuthority });
}
function resolveInboxRunId(root: string, pinnedRoot?: Parameters<typeof registry.resolveInboxRunId>[1], runtimeAccess?: Parameters<typeof registry.resolveInboxRunId>[2]) {
  return registry.resolveInboxRunId(root, pinnedRoot, runtimeAccess ?? runtimeFor(root).access);
}
function produceWaveDeliveries(root: string, options: RunOptions = {}) {
  return registry.produceWaveDeliveries(root, { ...options, runtimeAccess: options.runtimeAccess ?? runtimeFor(root).access, proofAuthority: runtimeFor(root).proofAuthority });
}

const { outboxDir, inboxDir } = registry;

function withConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}

/** Deterministic outbox file name queueCtoDelivery derives from a delivery id. */
function fileNameOf(deliveryId: string): string {
  return canonicalDurableIdFileName(deliveryId);
}

/** Outbox entries (not sent/) for a run, sorted. */
function outboxEntries(root: string, runId: string): string[] {
  const dir = outboxDir(runId, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
}

/** Sent archive entries for a run, sorted. */
function sentEntries(root: string, runId: string): string[] {
  const dir = join(outboxDir(runId, root), "sent");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
}

/**
 * Write a canonical run state through the core writer so the runtime access
 * facade can prove the persisted state and its delivery-index publication.
 */
function withRunState(
  root: string,
  runId: string,
  opts: {
    teams?: Array<{ id: string; status: "pending" | "in_progress" | "parked" | "done" | "failed" }>;
    integration?: "pending" | "in_progress" | "done" | "failed";
    waves: Array<{
      id: string;
      source_id: string;
      task: string;
      status: "active" | "done" | "failed";
      started_at?: string;
      finished_at?: string;
    }>;
    ackTarget?: string;
  },
): void {
  const now = new Date().toISOString();
  const state = newCtoState({
    id: runId,
    task: "Run task",
    branch: "main",
    autonomous: true,
    plan: { id: runId, task: "Run task", teams: [], created_at: now },
  });
  state.teams = (opts.teams ?? []).map((t) => ({ id: t.id, status: t.status, escalations: {} })) as typeof state.teams;
  state.integration = { status: opts.integration ?? "pending" };
  state.wave_history = opts.waves.map((w) => ({
    id: w.id,
    source: "inbox",
    source_id: w.source_id,
    task: w.task,
    slice_ids: [],
    status: w.status,
    started_at: w.started_at ?? now,
    ...(w.finished_at ? { finished_at: w.finished_at } : {}),
  })) as NonNullable<typeof state.wave_history>;
  const activeWave = opts.waves.find((wave) => wave.status === "active");
  if (activeWave) state.active_wave_id = activeWave.id;
  if (opts.ackTarget) {
    state.channel_profile = { direction: "rw", transport: "telegram", adapter: "telegram", primary: true, ackTarget: opts.ackTarget };
  }
  const runtime = runtimeFor(root);
  state.owner_session = runtime.sessionId;
  state.work_identity = { run_id: runId, wave_id: "outbound-producer-wave", slice_id: "outbound-producer-slice", session_id: runtime.sessionId, workflow: "standard", stage_id: "execution", stage_cursor: "execution", capability_id: "outbound-producer-capability", capability_epoch: "outbound-producer-epoch", slot_id: "outbound-producer-slot", task_id: runId, dispatch_id: "outbound-producer-dispatch", attempt: 1, worker_id: "outbound-producer-worker" };
  assert.ok(runtime.access.createRun(state, { source_id: `outbound-producer:${runId}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) }));
  if (opts.waves.some((wave) => (wave.status === "done" || wave.status === "failed") && wave.finished_at)) {
    assert.equal(runtime.access.markDeliveryPending(runId, state.state_revision, "summary"), true, "completed wave summary obligation is indexed");
  }
}

// ── (a) Task-admission ACK ─────────────────────────────────────────────────

test("outbound: RW primary + active run -> handleInboxTask queues ONE deterministic ACK; drain sends it; retry queues none", async () => {
  const root = mkdtempSync(join(tmpdir(), "ob-ack-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const set = createChannelSet(root);
    assert.equal(set.profile.direction, "rw", "explicit mock channels[] rw profile");
    const primary = set.primary as MockEscalationAdapter;
    const runId = resolveInboxRunId(root);
    const at = new Date().toISOString();
    const received: Array<{ id: string; runId?: string; waveId?: string }> = [];
    const path = handleInboxTask(root, { id: "t1", text: "Ship the fix", at }, (t) => received.push(t));
    assert.ok(path, "task filed");
    assert.equal(received.length, 1);

    // Deterministic ACK entry with the contract id.
    const ackId = `${runId}/wave/t1/ack`;
    const ackFile = fileNameOf(ackId);
    assert.ok(existsSync(join(outboxDir(runId, root), ackFile)), "ack queued with deterministic id <runId>/wave/<taskId>/ack");
    const ack = JSON.parse(readFileSync(join(outboxDir(runId, root), ackFile), "utf8")) as {
      id: string;
      intent: string;
      title: string;
      body: string;
      target?: string;
    };
    assert.equal(ack.id, ackId);
    assert.equal(ack.intent, "ack");
    assert.equal(ack.title, "CTO task admitted");
    assert.match(ack.body, new RegExp(runId), "body names the run id");
    assert.match(ack.body, /Ship the fix/, "body carries the task excerpt");
    assert.equal(ack.target, undefined, "no ackTarget on an explicit mock profile -> target unset");

    // Drain -> exactly one ACK on the primary; archived to sent/.
    const results = await drainOutbox(root, primary, 3, { roSinks: [] });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.equal(primary.sentEscalations.length, 1, "mock outbound log received exactly one ACK");
    assert.equal(primary.sentEscalations[0]?.intent, "ack");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent", ackFile)), "ack archived to sent/");

    // Simulated transport retry with the SAME task id -> no re-file, no new ack.
    const retry = handleInboxTask(root, { id: "t1", text: "Ship the fix", at }, () => undefined);
    assert.equal(retry, null, "duplicate transport id -> no re-file");
    assert.equal(outboxEntries(root, runId).length, 0, "no new ack queued after retry");
    assert.equal(sentEntries(root, runId).length, 1, "still exactly one archived ack");

    // A second drain sends nothing new.
    const second = await drainOutbox(root, primary, 3, { roSinks: [] });
    assert.equal(second.length, 0, "second drain sends nothing");
    assert.equal(primary.sentEscalations.length, 1, "mock outbound log still exactly one ACK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) No ACK without an RW primary ───────────────────────────────────────

test("outbound: RO-only configs queue NO ack (producer never queues non-report entries without a primary)", () => {
  for (const config of [
    { adapter: "http", http: { url: "https://ntfy.sh/x" } }, // legacy http -> ro
    { channels: [{ id: "audit", adapter: "mock", direction: "read-only" }] }, // explicit ro mock
  ]) {
    const root = mkdtempSync(join(tmpdir(), "ob-ro-"));
    try {
      withConfig(root, config);
      const set = createChannelSet(root);
      assert.equal(set.profile.direction, "ro", "resolved profile is ro");
      const runId = resolveInboxRunId(root);
      handleInboxTask(root, { id: "t1", text: "Ship the fix", at: new Date().toISOString() }, () => undefined);
      assert.equal(existsSync(outboxDir(runId, root)), false, "no outbox dir created — no ack queued for an RO-only config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ── (b2) No ACK when the RW profile is unbuildable ─────────────────────────

test("outbound: misconfigured RW profile (declared rw, adapter factory returns null) admits+wakes but queues NO ack", () => {
  // A profile that NORMALIZES to rw (telegram is the only built-in kind with
  // inbound+outbound capability; declared rw on http downgrades to ro by the
  // capability rule) yet whose adapter factory returns null (missing token /
  // missing telegram object) is a misconfigured RW channel: direction "rw"
  // with primary null. The admission ACK must NOT be queued for such a
  // profile — drainOutbox routes through channelSet.primary, so an ACK here
  // could never be drained (a permanently stuck outbox entry).
  for (const config of [
    // legacy telegram single-adapter, no token -> factory null
    { adapter: "telegram", telegram: { chatId: "c" } },
    // explicit channels[] rw entry, no token -> factory null
    { channels: [{ id: "ctrl", adapter: "telegram", direction: "read-write", primary: true, telegram: { chatId: "c" } }] },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "ob-misrw-"));
    try {
      withConfig(root, config);
      assert.throws(
        () => createChannelSet(root),
        /invalid|capabilit|construct/i,
        "an unbuildable RW declaration is rejected before it can become a delivery source",
      );
      const runId = resolveInboxRunId(root);
      const received: Array<{ id: string }> = [];
      const path = handleInboxTask(root, { id: "t1", text: "Misconfigured RW", at: new Date().toISOString() }, (t) => received.push(t));
      assert.ok(typeof path === "string" && path.length > 0, "task admitted (inbox file written)");
      assert.equal(received.length, 1, "wake callback fired exactly once");
      assert.equal(existsSync(outboxDir(runId, root)), false, "no outbox dir created — no ack queued for an unbuildable RW profile");
      assert.equal(sentEntries(root, runId).length, 0, "no sent archive either");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ── (c) Wave-completion summary ────────────────────────────────────────────

test("outbound: finished wave -> producer queues deterministic summary; drain sends to primary AND unsubscribed RO sink", async () => {
  const root = mkdtempSync(join(tmpdir(), "ob-sum-"));
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
    assert.ok(sink instanceof MockEscalationAdapter, "unsubscribed RO sink built");
    const runId = "run-sum";
    const now = new Date().toISOString();
    withRunState(root, runId, {
      teams: [
        { id: "alpha", status: "done" },
        { id: "beta", status: "failed" },
      ],
      integration: "done",
      waves: [
        { id: "wave-1", source_id: "t1", task: "Ship the fix", status: "done", started_at: now, finished_at: now },
      ],
    });

    const queued = produceWaveDeliveries(root);
    assert.equal(queued, 1, "one summary queued");
    const summaryId = `${runId}/wave/wave-1/summary`;
    const summaryFile = fileNameOf(summaryId);
    assert.ok(existsSync(join(outboxDir(runId, root), summaryFile)), "summary queued with deterministic id");
    const summary = JSON.parse(readFileSync(join(outboxDir(runId, root), summaryFile), "utf8")) as {
      id: string;
      intent: string;
      title: string;
      body: string;
    };
    assert.equal(summary.id, summaryId);
    assert.equal(summary.intent, "summary");
    assert.equal(summary.title, "CTO wave complete");
    // Body synthesized ONLY from authoritative state.
    assert.match(summary.body, /wave-1/, "body names the wave id");
    assert.match(summary.body, /done/, "body carries the wave status");
    assert.match(summary.body, /Ship the fix/, "body carries the trimmed task excerpt");
    assert.match(summary.body, /1 done/, "team status counts from state.teams");
    assert.match(summary.body, /1 failed/, "team status counts from state.teams");
    assert.match(summary.body, /done/, "integration status present");

    const results = await drainOutbox(root, primary, 3, { roSinks: set.roSinks });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.equal(primary.sentEscalations.length, 1, "primary mock received the summary");
    assert.equal(sink.sentEscalations.length, 1, "no-subscription RO sink received it too (fan-out)");
    assert.equal(sink.sentEscalations[0]?.intent, "summary");
    assert.ok(existsSync(join(outboxDir(runId, root), "sent", summaryFile)), "summary archived to sent/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) NO summary while active; failed wave WITH finished_at IS summarized ─

test("outbound: active wave (no finished_at) is NEVER summarized; failed+finished IS summarized", () => {
  const root = mkdtempSync(join(tmpdir(), "ob-active-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const now = new Date().toISOString();
    withRunState(root, "run-mixed", {
      waves: [
        { id: "wave-1", source_id: "t1", task: "Still running", status: "active", started_at: now },
        { id: "wave-2", source_id: "t2", task: "Failed wave", status: "failed", started_at: now, finished_at: now },
        { id: "wave-3", source_id: "t3", task: "Done wave", status: "done", started_at: now, finished_at: now },
      ],
    });
    const queued = produceWaveDeliveries(root);
    assert.equal(queued, 2, "active wave skipped; failed and done waves summarized");
    assert.ok(
      !existsSync(join(outboxDir("run-mixed", root), fileNameOf("run-mixed/wave/wave-1/summary"))),
      "no delivery while a wave is active",
    );
    assert.ok(
      existsSync(join(outboxDir("run-mixed", root), fileNameOf("run-mixed/wave/wave-2/summary"))),
      "failed wave WITH finished_at IS summarized",
    );
    assert.ok(
      existsSync(join(outboxDir("run-mixed", root), fileNameOf("run-mixed/wave/wave-3/summary"))),
      "done wave WITH finished_at IS summarized",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (e) At-least-once across stale sent replay ──────────────────────────────────

test("outbound: confirmed archive clears obligation; stale sent never grants renewed authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "ob-once-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const set = createChannelSet(root);
    const primary = set.primary as MockEscalationAdapter;
    const runId = "run-once";
    const now = new Date().toISOString();
    withRunState(root, runId, {
      waves: [{ id: "wave-1", source_id: "t1", task: "One shot", status: "done", started_at: now, finished_at: now }],
    });

    assert.equal(produceWaveDeliveries(root), 1, "first tick queues the summary");
    const summaryName = fileNameOf(`${runId}/wave/wave-1/summary`);
    const activeSummaryPath = join(outboxDir(runId, root), summaryName);
    const expectedSentBytes = readFileSync(activeSummaryPath);
    const results = await drainOutbox(root, primary, 3, { roSinks: [] });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sent, true);
    assert.equal(primary.sentEscalations.length, 1, "mock log has exactly one line after drain");
    assert.equal(runtimeFor(root).access.readOutboxDeliveryObligations(runId).length, 0, "confirmed send clears the state obligation");

    // Archive-first completion clears the obligation and reconciles the
    // active index immediately. A subsequent producer tick has nothing to
    // republish, while sent/ remains transport evidence rather than authority.
    assert.equal(produceWaveDeliveries(root), 0, "confirmed archive leaves no pending summary replay");
    assert.equal(outboxEntries(root, runId).length, 0, "no active summary is recreated from sent evidence");
    assert.equal(sentEntries(root, runId).length, 1, "sent archive remains one stable record");
    const sentPath = join(outboxDir(runId, root), "sent", summaryName);
    assert.deepEqual(readFileSync(sentPath), expectedSentBytes, "sent evidence preserves the exact accepted envelope bytes");
    const index = JSON.parse(readFileSync(join(root, ".work-state", "cto", "active-run-index.json"), "utf8")) as { entries: Array<{ run_id: string; pending_summary?: boolean; pending_outbox?: boolean; pending_retry?: boolean }> };
    const indexEntry = index.entries.find((entry) => entry.run_id === runId);
    assert.ok(indexEntry);
    assert.equal(indexEntry?.pending_summary, false, "post-clear index has no summary obligation");
    assert.equal(indexEntry?.pending_outbox, false, "post-clear index has no active queue evidence");
    assert.equal(indexEntry?.pending_retry, false, "post-clear index has no retry evidence");
    assert.equal(primary.sentEscalations.length, 1, "producer renewal does not invoke the adapter again");

    // A direct queue attempt is rejected by the canonical pending gate;
    // sent/ is never authority.
    const direct = queueCtoDelivery(root, runId, {
      id: `${runId}/wave/wave-1/summary`,
      level: "question",
      title: "CTO wave complete",
      body: "duplicate attempt",
      intent: "summary",
      topic: "summary",
    });
    assert.equal(direct, null, "sent/ never grants authority for a direct re-queue");
    assert.equal(outboxEntries(root, runId).length, 0, "outbox file count unchanged");
    assert.equal(sentEntries(root, runId).length, 1, "sent count unchanged");
    assert.equal(primary.sentEscalations.length, 1, "mock log still exactly one line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) Legacy telegram RW config + no config ──────────────────────────────

test("outbound: legacy telegram RW config still produces the ACK with ackTarget=chatId; no config -> nothing", () => {
  // Legacy telegram RW -> ACK queued with ackTarget from the telegram profile.
  const root = mkdtempSync(join(tmpdir(), "ob-legacy-"));
  try {
    withConfig(root, { adapter: "telegram", telegram: { token: "t", chatId: "c" } });
    const set = createChannelSet(root);
    assert.equal(set.profile.direction, "rw", "legacy telegram is rw");
    assert.equal(set.profile.ackTarget, "c", "telegram profile carries chatId as ackTarget");
    const runId = "run-legacy";
    withRunState(root, runId, { waves: [], ackTarget: "c" });
    assert.equal(resolveInboxRunId(root), runId, "legacy ACK binds to the genuine active persisted CTO run");
    handleInboxTask(root, { id: "t1", text: "Legacy task", at: new Date().toISOString() }, () => undefined);
    const ackFile = fileNameOf(`${runId}/wave/t1/ack`);
    assert.ok(existsSync(join(outboxDir(runId, root), ackFile)), "legacy telegram RW config still queues the ACK");
    const ack = JSON.parse(readFileSync(join(outboxDir(runId, root), ackFile), "utf8")) as { target?: string };
    assert.equal(ack.target, "c", "ack target = profile ackTarget (telegram chatId)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // No .omp/escalation.json -> handleInboxTask unchanged: no ack, no summary.
  const bare = mkdtempSync(join(tmpdir(), "ob-none-"));
  try {
    const runId = resolveInboxRunId(bare);
    handleInboxTask(bare, { id: "t1", text: "No channel", at: new Date().toISOString() }, () => undefined);
    assert.equal(existsSync(outboxDir(runId, bare)), false, "no ack without a configured channel");
    assert.equal(produceWaveDeliveries(bare), 0, "no config -> producer queues nothing");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// ── (g) Throwing wake -> NO admission ACK ─────────────────────────────────

test("outbound: throwing wake rolls back the inbox file AND queues NO ACK (ack only after successful wake)", () => {
  const root = mkdtempSync(join(tmpdir(), "ob-ackroll-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const runId = resolveInboxRunId(root);
    assert.throws(
      () =>
        handleInboxTask(
          root,
          { id: "t-throw", text: "Wake must fail", at: new Date().toISOString() },
          () => {
            throw new Error("wake failed");
          },
        ),
      /wake failed/,
    );
    // The task was NOT admitted (the wake threw): no deterministic ACK may
    // remain — neither in the outbox nor archived to sent/.
    const ackFile = fileNameOf(`${runId}/wave/t-throw/ack`);
    assert.equal(outboxEntries(root, runId).includes(ackFile), false, "no ack queued after a throwing wake");
    assert.equal(sentEntries(root, runId).includes(ackFile), false, "no ack archived after a throwing wake");
    // The rollback still removed the just-filed inbox task (rmSync force).
    assert.equal(existsSync(join(inboxDir(runId, root), "t-throw.json")), false, "inbox file rolled back on wake failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (h) Malformed wave_history state fails closed ─────────────────────────

test("outbound: malformed wave_history state fails closed with no summary or outbox publication", () => {
  const root = mkdtempSync(join(tmpdir(), "ob-badwave-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const runId = "run-badwave";
    const now = new Date().toISOString();
    // The typed withRunState helper cannot express agent-written corruption;
    // preserve the canonical index identity, then tamper state.json directly
    // with a null entry and a malformed wave record.
    const runDir = join(root, ".work-state", "cto", runId);
    // Start from a valid completed wave so the authenticated index carries
    // a pending summary obligation before state.json is corrupted.
    withRunState(root, runId, {
      waves: [{ id: "wave-bad", source_id: "t-bad", task: "Valid before corruption", status: "done", started_at: now, finished_at: now }],
    });
    assert.equal(runtimeFor(root).access.markDeliveryPending(runId, runtimeFor(root).access.readState(runId)?.state_revision, "summary"), true, "valid run is indexed with a pending summary obligation");
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as Record<string, unknown>;
    state.wave_history = [
      null, // corrupt entry: malformed records must not be summarized
      { id: "wave-bad", source: "inbox", source_id: "t-bad", slice_ids: [], status: "done", started_at: now, finished_at: now }, // NO task field
    ];
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
    const corruptStateBytes = readFileSync(join(runDir, "state.json"));

    const queued = produceWaveDeliveries(root);
    assert.equal(queued, 0, "pending malformed run publishes no summary for itself");
    assert.equal(existsSync(outboxDir(runId, root)), false, "pending malformed state cannot publish an outbox entry");
    assert.equal(existsSync(join(outboxDir(runId, root), "sent")), false, "pending malformed state cannot create a sent archive");
    assert.deepEqual(readFileSync(join(runDir, "state.json")), corruptStateBytes, "malformed state bytes remain untouched");
    const index = JSON.parse(readFileSync(join(root, ".work-state", "cto", "active-run-index.json"), "utf8")) as { entries?: Array<{ run_id?: string; pending_summary?: boolean }> };
    const indexed = index.entries?.find((entry) => entry.run_id === runId);
    assert.equal(indexed?.run_id, runId, "pending evidence remains scoped to the malformed tenant");
    assert.equal(indexed?.pending_summary, true, "pending summary evidence remains set for retry");
    assert.equal(existsSync(join(root, ".work-state", "cto", runId, "outbox-rejected")), false, "malformed publication is not quarantined");
    assert.equal(produceWaveDeliveries(root), 0, "second tick still queues nothing");
    assert.deepEqual(readFileSync(join(runDir, "state.json")), corruptStateBytes, "second tick also preserves malformed state bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (i) Non-array wave_history state is isolated ─────────────────────────

test("outbound: non-array wave_history state publishes nothing for itself and does not starve a valid pending run", () => {
  const root = mkdtempSync(join(tmpdir(), "ob-badcontainer-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const now = new Date().toISOString();

    const validRunId = "run-valid";
    withRunState(root, validRunId, {
      waves: [
        { id: "wave-good", source_id: "t-good", task: "Valid wave", status: "done", finished_at: now },
        { id: "wave-active", source_id: "t-active", task: "Active wave", status: "active" }, // NO finished_at — active waves stay unsummarized
      ],
    });
    const validEntry = runtimeFor(root).access.readDeliveryIndexPage().entries.find((entry) => entry.run_id === validRunId);
    assert.ok(validEntry, "valid run is present in the authenticated delivery page");
    const corruptRunId = "run-corrupt-container";
    const corruptDir = join(root, ".work-state", "cto", corruptRunId);
    mkdirSync(corruptDir, { recursive: true });
    // This tenant is intentionally unindexed: an agent-written malformed
    // state must not be able to invalidate the authenticated delivery index.
    // The explicit runEntries page below still exercises producer isolation.
    const corruptState = { schema: 2, id: corruptRunId, wave_history: {} };
    writeFileSync(join(corruptDir, "state.json"), JSON.stringify(corruptState, null, 2));
    const corruptEntry = {
      run_id: corruptRunId,
      state_revision: 0,
      status: "active",
      updated_at: now,
      pending_summary: true,
      pending_outbox: false,
      pending_retry: false,
      summary_digest: "",
    } as NonNullable<typeof validEntry>;

    const corruptStateBytes = readFileSync(join(corruptDir, "state.json"));
    const queued = produceWaveDeliveries(root, { runEntries: [corruptEntry, validEntry] });
    assert.equal(queued, 1, "corrupt run is isolated while the valid pending run publishes one summary");
    assert.equal(existsSync(outboxDir(corruptRunId, root)), false, "malformed run publishes no corrupt-tenant outbox");
    assert.equal(existsSync(join(outboxDir(corruptRunId, root), "sent")), false, "malformed run has no sent archive");
    assert.deepEqual(readFileSync(join(corruptDir, "state.json")), corruptStateBytes, "malformed run state remains untouched");
    const validSummaryId = validRunId + "/wave/wave-good/summary";
    const validSummaryFile = fileNameOf(validSummaryId);
    const validSummaryPath = join(outboxDir(validRunId, root), validSummaryFile);
    assert.equal(existsSync(validSummaryPath), true, "valid run publishes its canonical summary");
    const validSummary = JSON.parse(readFileSync(validSummaryPath, "utf8")) as { id?: string; run_id?: string };
    assert.equal(validSummary.id, validSummaryId, "summary id remains tenant/run scoped");
    assert.equal(validSummary.run_id, validRunId, "summary envelope carries the valid tenant run id");
    assert.equal(produceWaveDeliveries(root, { runEntries: [corruptEntry, validEntry] }), 0, "active canonical publication is stable on the next tick");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
