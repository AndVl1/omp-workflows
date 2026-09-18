/**
 * Live persisted-RW inbound delivery (resident control-plane).
 *
 * Reproduces the LIVE session wiring from packages/fullstack/src/index.ts
 * session_start (createChannelSet + startChannelDispatcher with recording
 * callbacks in place of pi.sendUserMessage) against a persisted mock RW
 * channel. Task files are dropped into `<dir>/inbound/` by PLAIN file
 * writes — the durable cross-process path the live PTY harness uses
 * (deliberately NOT injectTask, which fires the in-memory handler and
 * bypasses the transport drain).
 *
 * Scenarios:
 *   A. a live tg-bridge lock must NOT suppress a non-telegram RW adapter's
 *      inbound polling (the live gap — bridge ownership is telegram
 *      specific by contract),
 *   B. exactly-once delivery + admitted-dedup on duplicate normalized text
 *      + durable processed evidence,
 *   C. empty-text inbound moves to inbound/rejected/ with a durable record,
 *   D. answers follow up via the SAME RW channel (delivered once),
 *   E. RO channels are never wired or polled for inbound,
 *   F. legacy single-adapter configs are unchanged and never fan out.
 *
 * Delivery is interval-driven (50ms dispatcher ticks), so assertions use a
 * waitFor polling helper. stop() is always called and the scratch root is
 * always removed (finally).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState, readCtoState } from "../../core/src/cto/state.js";

import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import { openFullstackRuntimeTest, type FullstackRuntimeTestFixture } from "./runtime-access-fixture.js";

const runtimeFixtures = new Map<string, FullstackRuntimeTestFixture>();
function runtimeFixtureFor(root: string): FullstackRuntimeTestFixture {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const fixture = openFullstackRuntimeTest(root, "rw-channel-live-test");
  runtimeFixtures.set(root, fixture);
  return fixture;
}
function runtimeFor(root: string) {
  return runtimeFixtureFor(root).access;
}
function createAuthenticatedRun(root: string, runId: string, task: string): ReturnType<typeof newCtoState> {
  const runtime = runtimeFixtureFor(root);
  const state = newCtoState({
    id: runId,
    task,
    branch: "main",
    autonomous: true,
    plan: { id: runId, task, teams: [], created_at: new Date().toISOString() },
  });
  state.owner_session = runtime.sessionId;
  state.work_identity = {
    run_id: runId,
    wave_id: "rw-channel-live-wave",
    slice_id: "rw-channel-live-slice",
    session_id: runtime.sessionId,
    workflow: "standard",
    stage_id: "execution",
    stage_cursor: "execution",
    capability_id: "rw-channel-live-capability",
    capability_epoch: "rw-channel-live-epoch",
    slot_id: "rw-channel-live-slot",
    task_id: runId,
    dispatch_id: "rw-channel-live-dispatch",
    attempt: 1,
    worker_id: "rw-channel-live-worker",
  };
  assert.ok(runtime.access.createRun(state, { source_id: `rw-channel-live:${runId}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) }));
  return state;
}
test.afterEach(() => {
  for (const fixture of runtimeFixtures.values()) fixture.close();
  runtimeFixtures.clear();
});
import {
  createChannelSet,
  createEscalationAdapter,
  loadEscalationConfig,
  sha256Hex,
  bindEscalationAdapterRouting,
  startChannelDispatcher,
  startDispatcher,
  writeBridgeLock,
  type ChannelSet,
  type InboxTask,
} from "../src/adapters/registry.js";
import { MockEscalationAdapter } from "../src/adapters/mock.js";

function withConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
}

/** Plain durable file write into a transport dir (the second-process path). */
function dropFile(dir: string, name: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(payload));
}

/**
 * Node 20-compatible `Promise.withResolvers` (Node 22+ / ES2024); mirrors the
 * repo convention in channel-policy.test.ts / packages/e2e/src/util.ts.
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

/**
 * Real wall-clock delays are deliberate here (integration-test exception to
 * fake timers): the dispatcher UNDER TEST runs its own real `setInterval`
 * tick and performs async file I/O, and inbound delivery is observable only
 * through those real ticks landing (plain file writes from a "second
 * process"). Deterministic time control cannot drive the dispatcher's own
 * interval, so we poll for the observable effect instead of guessing a
 * duration.
 */
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Poll `predicate` every 25ms until it holds or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${msg}`);
    await sleep(25);
  }
}

/**
 * Mirror index.ts session_start: write `.omp/escalation.json`, resolve the
 * channel set, start the channel dispatcher at 50ms, record onTask/onAnswer
 * in the returned arrays (index.ts routes them to pi.sendUserMessage).
 */
function startLiveDispatcher(
  root: string,
  config: unknown,
  opts: { direction?: "rw" | "ro" } = {},
): { stop: () => void; channelSet: ChannelSet; tasks: InboxTask[]; answers: Array<{ id: string; answer: string }> } {
  const expected = opts.direction ?? "rw";
  withConfig(root, config);
  const channelSet = createChannelSet(root, undefined, undefined, runtimeFor(root), runtimeFixtureFor(root).proofAuthority);
  assert.equal(channelSet.profile.direction, expected, `resolved channel profile direction is ${expected}`);
  if (expected === "rw") {
    assert.ok(channelSet.primary, "rw primary is built");
    assert.ok(channelSet.primary instanceof MockEscalationAdapter, "rw primary is the persisted mock adapter");
  } else {
    assert.equal(channelSet.primary, null, "an ro set has no primary");
  }
  const tasks: InboxTask[] = [];
  const answers: Array<{ id: string; answer: string }> = [];
  const runtime = runtimeFixtureFor(root);
  const stop = startChannelDispatcher(root, channelSet, 50, {
    runtimeAccess: runtime.access,
    proofAuthority: runtime.proofAuthority,
    session_id: runtime.sessionId,
    liveGuard: runtime.liveGuard,
    serviceAuthority: runtime.serviceAuthority,
    onTask: (t) => tasks.push(t),
    onAnswer: (a) => answers.push(a),
  });
  return { stop, channelSet, tasks, answers };
}

const RW_CHANNEL = (dir: string): unknown => ({
  channels: [{ id: "mock-rw", adapter: "mock", direction: "read-write", mock: { persisted: true, dir } }],
});

test("A: persisted mock RW channel delivers inbound despite a live tg-bridge lock (the live gap)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-bridge-"));
  try {
    // A live bridge (alive pid) owns the bot BEFORE the dispatcher starts —
    // resident-session repro: telegram bridge running, persisted RW channel
    // configured alongside.
    writeBridgeLock(root, undefined, runtimeFixtureFor(root).proofAuthority);
    const dir = "rw";
    const { stop, tasks } = startLiveDispatcher(root, RW_CHANNEL(dir));
    try {
      dropFile(join(root, dir, "inbound"), "task-1.json", {
        id: "t1",
        text: "live resident task via persisted RW channel",
        at: new Date().toISOString(),
        by: "second-process",
      });
      await waitFor(
        () => tasks.length === 1,
        3000,
        "onTask fired for the persisted RW channel despite a live bridge lock (bridge gate must not suppress non-telegram adapters)",
      );
      assert.equal(tasks[0]?.text, "live resident task via persisted RW channel");
      // Durable inbox file under the resolved run.
      const runId = tasks[0]?.runId;
      assert.ok(runId, "task callback carries the canonical run id");
      assert.ok(existsSync(join(root, ".work-state", "cto", runId, "inbox", "t1.json")), "task filed durably in the run inbox");
      // Transport file consumed to processed/.
      assert.ok(existsSync(join(root, dir, "inbound", "processed", "task-1.json")), "transport file moved to inbound/processed");
      // One admitted wave in run state.
      const state = readCtoState(runId, root);
      assert.equal(state?.wave_history?.length, 1, "one wave admitted in run state");
      assert.equal(state?.wave_history?.[0]?.source_id, `inbox-${sha256Hex(JSON.stringify({ id: "t1", transport: "second-process" }))}`, "wave keyed on canonical transport and task identity");
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B: inbound delivered exactly once; duplicate normalized text never re-delivered; durable processed evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-dedup-"));
  try {
    const dir = "rw";
    const { stop, tasks } = startLiveDispatcher(root, RW_CHANNEL(dir));
    try {
      const text = "exactly-once duplicate probe";
      dropFile(join(root, dir, "inbound"), "task-1.json", {
        id: "t1",
        text,
        at: new Date().toISOString(),
        by: "second-process",
      });
      await waitFor(() => tasks.length === 1, 3000, "first inbound task delivered once");
      assert.equal(tasks[0]?.text, text);
      // Same normalized text, different transport id — must NOT re-deliver.
      dropFile(join(root, dir, "inbound"), "task-2.json", {
        id: "t2",
        text,
        at: new Date().toISOString(),
        by: "second-process",
      });
      await sleep(1000);
      assert.equal(tasks.length, 1, "duplicate normalized text never re-delivered");
      // Both transport files consumed (durable evidence).
      assert.ok(existsSync(join(root, dir, "inbound", "processed", "task-1.json")), "task-1 consumed to processed/");
      assert.ok(existsSync(join(root, dir, "inbound", "processed", "task-2.json")), "task-2 consumed to processed/");
      // Admitted-dedup quarantine record + one wave in run state.
      const runId = tasks[0]?.runId;
      assert.ok(runId, "task callback carries the canonical run id");
      const state = readCtoState(runId, root);
      const quarantineHash = sha256Hex(JSON.stringify({ id: "t1", text, transport: "second-process" }));
      assert.equal(state?.inbox_quarantine?.[quarantineHash]?.status, "admitted", "quarantine status is admitted");
      assert.equal(state?.wave_history?.length, 1, "exactly one wave admitted");
      assert.equal(state?.wave_history?.[0]?.source_id, `inbox-${sha256Hex(JSON.stringify({ id: "t1", transport: "second-process" }))}`, "wave keyed on canonical transport and task identity");
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C: empty-text inbound moves to inbound/rejected/ with a durable record; no wake", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-reject-"));
  try {
    const dir = "rw";
    const { stop, tasks } = startLiveDispatcher(root, RW_CHANNEL(dir));
    try {
      dropFile(join(root, dir, "inbound"), "bad-1.json", {
        id: "bad1",
        text: "   ",
        at: new Date().toISOString(),
        by: "second-process",
      });
      await waitFor(() => existsSync(join(root, dir, "inbound", "rejected", "bad-1.json")), 3000, "empty inbound moved to rejected/");
      const record = JSON.parse(readFileSync(join(root, dir, "inbound", "rejected", "bad-1.json.json"), "utf8")) as {
        file: string;
        reason: string;
        at: string;
        id?: string;
      };
      assert.equal(record.file, "bad-1.json", "record names the original file");
      assert.equal(record.reason, "empty text");
      assert.equal(record.id, "bad1");
      assert.ok(Number.isFinite(Date.parse(record.at)), "record timestamp is ISO");
      assert.equal(tasks.length, 0, "no onTask for rejected inbound");
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D: answer follow-up delivered via the same RW channel, exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-answer-"));
  try {
    const dir = "rw";
    const runId = "run-x";
    const state = createAuthenticatedRun(root, runId, "live answer follow-up");
    const runtime = runtimeFixtureFor(root);
    assert.equal(runtime.access.markDeliveryPending(runId, state.state_revision, "outbox"), true, "canonical active run index is established");
    assert.equal(readCtoState(runId, root)?.id, runId, "canonical run state is readable before answer polling");
    const { stop, answers } = startLiveDispatcher(root, RW_CHANNEL(dir));
    try {
      dropFile(join(root, dir, "answers"), "ans-1.json", {
        id: `${runId}/team-a/q1`,
        run_id: runId,
        answer: "yes",
        at: new Date().toISOString(),
        by: "user-1",
      });
      await waitFor(() => answers.length === 1, 3000, "onAnswer fired once via the RW channel");
      assert.equal(answers[0]?.id, "run-x/team-a/q1");
      assert.equal(answers[0]?.answer, "yes");
      assert.ok(existsSync(join(root, dir, "answers", "processed", "ans-1.json")), "answer file consumed to answers/processed/");
      await sleep(500);
      assert.equal(answers.length, 1, "answer delivered exactly once");
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E: read-only channels are never wired or polled for inbound", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-ro-"));
  try {
    const dir = "ro";
    const { stop, tasks } = startLiveDispatcher(
      root,
      { channels: [{ id: "mock-ro", adapter: "mock", direction: "read-only", mock: { persisted: true, dir } }] },
      { direction: "ro" },
    );
    try {
      dropFile(join(root, dir, "inbound"), "task-1.json", {
        id: "t1",
        text: "ro task",
        at: new Date().toISOString(),
        by: "second-process",
      });
      await sleep(1000);
      assert.ok(existsSync(join(root, dir, "inbound", "task-1.json")), "ro inbound file untouched");
      assert.equal(existsSync(join(root, dir, "inbound", "processed")), false, "no processed/ dir for ro");
      assert.equal(existsSync(join(root, dir, "inbound", "rejected")), false, "no rejected/ dir for ro");
      assert.equal(tasks.length, 0, "ro never delivers inbound");
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F: legacy single-adapter config unchanged — mock rw preserved, no fan-out", async () => {
  const root = mkdtempSync(join(tmpdir(), "rw-live-legacy-"));
  try {
    // NO channels[]: the pre-channel-set single-adapter shape.
    const legacyState = createAuthenticatedRun(root, "legacy-run", "legacy persisted inbound");
    assert.equal(runtimeFor(root).markDeliveryPending(legacyState.id, legacyState.state_revision, "outbox"), true, "legacy active run index is established");
    const config = { adapter: "mock", mock: { persisted: true, dir: "legacy" } };
    withConfig(root, config);
    const runtime = runtimeFor(root);
    const adapter = createEscalationAdapter(loadEscalationConfig(root, { kind: "mock", runtimeAccess: runtime })!, root, undefined, runtime, runtimeFixtureFor(root).proofAuthority);
    assert.ok(adapter instanceof MockEscalationAdapter, "legacy config builds the mock adapter");
    const adapterPin = PinnedProjectRoot.open(root);
    assert.ok(adapterPin);
    assert.equal(bindEscalationAdapterRouting(adapter!, runtime, adapterPin!), true, "legacy adapter receives the authenticated routing binding");
    adapterPin!.close();
    const tasks: InboxTask[] = [];
    // Legacy single-adapter dispatcher (the adapter-direct path): the mock's
    // rw inbound surface is wired and polled as before — unchanged by the
    // channel-set world.
    const fixture = runtimeFixtureFor(root);
    const stop = startDispatcher(root, adapter, 50, { runtimeAccess: fixture.access, proofAuthority: fixture.proofAuthority, session_id: fixture.sessionId, liveGuard: fixture.liveGuard, serviceAuthority: fixture.serviceAuthority, onTask: (t) => tasks.push(t) });
    try {
      dropFile(join(root, "legacy", "inbound"), "task-1.json", {
        id: "t1",
        text: "legacy task",
        at: new Date().toISOString(),
        by: "second-process",
      });
      await waitFor(() => tasks.length === 1, 3000, "legacy single-adapter dispatcher delivers inbound once");
      await sleep(500);
      assert.equal(tasks.length, 1, "no re-delivery");
      assert.ok(existsSync(join(root, "legacy", "inbound", "processed", "task-1.json")), "legacy transport file consumed");
      // No fan-out: only .omp, .work-state and the legacy persisted dir exist.
      assert.deepEqual(readdirSync(root).sort(), [".omp", ".work-state", "legacy"], "no other adapter dirs created under the root");
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
