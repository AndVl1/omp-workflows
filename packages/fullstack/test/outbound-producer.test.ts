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
 *   (e) exactly-once across ticks/restart — after queued+drained, neither
 *       the producer nor a direct queueCtoDelivery re-queues the id
 *       (outbox/ wx + sent/ dedupe).
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

const {
  createChannelSet,
  drainOutbox,
  outboxDir,
  inboxDir,
  queueCtoDelivery,
  handleInboxTask,
  resolveInboxRunId,
  produceWaveDeliveries,
} = registry;

function withConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}

/** Deterministic outbox file name queueCtoDelivery derives from a delivery id. */
function fileNameOf(deliveryId: string): string {
  return `${deliveryId.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
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
 * Write a canonical run state directly (authoritative source for the
 * summary producer — same shape readCtoState/migrateCtoState produce).
 */
function withRunState(
  root: string,
  runId: string,
  opts: {
    teams?: Array<{ id: string; status: string }>;
    integration?: string;
    waves: Array<{
      id: string;
      source_id: string;
      task: string;
      status: string;
      started_at?: string;
      finished_at?: string;
    }>;
  },
): void {
  const now = new Date().toISOString();
  const runDir = join(root, ".work-state", "cto", runId);
  mkdirSync(runDir, { recursive: true });
  const state = {
    schema: 2,
    id: runId,
    task: "Run task",
    branch: "main",
    autonomous: true,
    plan: { id: runId, task: "Run task", teams: [], created_at: now },
    teams: (opts.teams ?? []).map((t) => ({ id: t.id, status: t.status, escalations: {} })),
    integration: { status: opts.integration ?? "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: now,
    wave_history: opts.waves.map((w) => ({
      id: w.id,
      source: "inbox",
      source_id: w.source_id,
      task: w.task,
      slice_ids: [],
      status: w.status,
      started_at: w.started_at ?? now,
      ...(w.finished_at ? { finished_at: w.finished_at } : {}),
    })),
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
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
      const set = createChannelSet(root);
      assert.equal(set.profile.direction, "rw", "resolved profile declares rw");
      assert.equal(set.primary, null, "…but the adapter is unbuildable (primary null) — the misconfiguration");
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

// ── (e) Exactly-once across ticks/restart ──────────────────────────────────

test("outbound: queued+drained summary is NEVER re-queued (same id, across ticks and direct queue)", async () => {
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
    const results = await drainOutbox(root, primary, 3, { roSinks: [] });
    assert.equal(results.length, 1);
    assert.equal(primary.sentEscalations.length, 1, "mock log has exactly one line after drain");

    // Producer re-runs (next ticks / dispatcher restart): nothing re-queued.
    assert.equal(produceWaveDeliveries(root), 0, "second tick queues nothing");
    assert.equal(produceWaveDeliveries(root), 0, "third tick queues nothing");
    // Even a DIRECT queueCtoDelivery with the same id is deduped (sent/).
    const direct = queueCtoDelivery(root, runId, {
      id: `${runId}/wave/wave-1/summary`,
      level: "question",
      title: "CTO wave complete",
      body: "duplicate attempt",
      intent: "summary",
      topic: "summary",
    });
    assert.equal(direct, null, "sent/ dedupe -> direct re-queue returns null");
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
    const runId = resolveInboxRunId(root);
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

// ── (h) Malformed wave_history records NEVER abort the scan ────────────────

test("outbound: malformed wave_history records are skipped deterministically; valid finished waves still summarize; dedupe unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "ob-badwave-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const runId = "run-badwave";
    const now = new Date().toISOString();
    // The typed withRunState helper cannot express agent-written corruption;
    // write state.json directly, mirroring the canonical shape but with a
    // null entry and a malformed wave record (intentionally NO task field,
    // finished_at set so it reaches the summary path).
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    const state = {
      schema: 2,
      id: runId,
      task: "Run task",
      branch: "main",
      autonomous: true,
      plan: { id: runId, task: "Run task", teams: [], created_at: now },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: now,
      wave_history: [
        null, // corrupt entry: pre-fix throws at wave.finished_at
        { id: "wave-bad", source: "inbox", source_id: "t-bad", slice_ids: [], status: "done", started_at: now, finished_at: now }, // NO task field
        { id: "wave-good", source: "inbox", source_id: "t-good", slice_ids: [], task: "Valid wave", status: "done", started_at: now, finished_at: now },
      ],
    };
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));

    const queued = produceWaveDeliveries(root);
    assert.equal(
      queued,
      1,
      "malformed records skipped; exactly one summary for the valid wave (pre-fix: 0 — the TypeError aborts the whole scan)",
    );
    const summaryFile = fileNameOf(`${runId}/wave/wave-good/summary`);
    assert.ok(existsSync(join(outboxDir(runId, root), summaryFile)), "summary for the valid wave queued");
    const summary = JSON.parse(readFileSync(join(outboxDir(runId, root), summaryFile), "utf8")) as { body: string };
    assert.match(summary.body, /Valid wave/, "body carries the trimmed task excerpt of the valid wave");
    assert.equal(
      existsSync(join(outboxDir(runId, root), fileNameOf(`${runId}/wave/wave-bad/summary`))),
      false,
      "no summary for the malformed record",
    );
    assert.equal(produceWaveDeliveries(root), 0, "second tick queues nothing (dedupe unchanged)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (i) Non-array wave_history container NEVER aborts the scan ─────────────

test("outbound: non-array wave_history container (corrupt persisted state) never aborts the scan; later valid runs still summarize; dedupe unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "ob-badcontainer-"));
  try {
    withConfig(root, { channels: [{ id: "ctrl", adapter: "mock", direction: "read-write", primary: true }] });
    const now = new Date().toISOString();
    // CREATE THE CORRUPT RUN DIRECTORY BEFORE THE VALID ONE: the producer
    // iterates readdirSync(runsDir) in OS order; on macOS APFS small
    // directories return creation order, and the RED run below empirically
    // proves the corrupt run scans first (pre-fix the TypeError aborts the
    // whole scan before the valid run is ever reached).
    const corruptRunId = "run-corrupt-container";
    const corruptDir = join(root, ".work-state", "cto", corruptRunId);
    mkdirSync(corruptDir, { recursive: true });
    // The typed withRunState helper CANNOT express a non-array wave_history;
    // write state.json directly, mirroring the canonical schema-2 shape but
    // with wave_history as a plain OBJECT — the corrupt container from the
    // finding (a persisted non-array value that pre-fix throws on).
    const corruptState = {
      schema: 2,
      id: corruptRunId,
      task: "Run task",
      branch: "main",
      autonomous: true,
      plan: { id: corruptRunId, task: "Run task", teams: [], created_at: now },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: now,
      wave_history: {}, // non-array container: for..of throws TypeError pre-fix
    };
    writeFileSync(join(corruptDir, "state.json"), JSON.stringify(corruptState, null, 2));

    // Valid run created AFTER the corrupt one: its summary must survive the
    // corrupt run's scan no matter what order readdirSync returns.
    const validRunId = "run-valid";
    withRunState(root, validRunId, {
      waves: [
        { id: "wave-good", source_id: "t-good", task: "Valid wave", status: "done", finished_at: now },
        { id: "wave-active", source_id: "t-active", task: "Active wave", status: "done" }, // NO finished_at — active waves stay unsummarized
      ],
    });

    assert.equal(
      produceWaveDeliveries(root),
      1,
      "non-array container skipped; exactly one summary for the valid later run (pre-fix: 0 — the TypeError aborts the whole scan)",
    );
    const summaryFile = fileNameOf(`${validRunId}/wave/wave-good/summary`);
    assert.ok(existsSync(join(outboxDir(validRunId, root), summaryFile)), "summary for the valid later run queued");
    const summary = JSON.parse(readFileSync(join(outboxDir(validRunId, root), summaryFile), "utf8")) as { body: string };
    assert.match(summary.body, /Valid wave/, "body carries the trimmed task excerpt of the valid wave");
    assert.equal(
      existsSync(join(outboxDir(validRunId, root), fileNameOf(`${validRunId}/wave/wave-active/summary`))),
      false,
      "no summary for the still-active wave",
    );
    assert.equal(produceWaveDeliveries(root), 0, "second tick queues nothing (dedupe unchanged)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
