import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, renameSync, symlinkSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState, writeCtoState, type CtoState } from "../../core/src/cto/state.js";
import { openFullstackRuntimeTest, type FullstackRuntimeTestFixture } from "./runtime-access-fixture.js";
import {
  classifyIncoming as classifyIncomingRaw,
  buildStatusReply,
  findCompletedSummary as findCompletedSummaryRaw,
  sendTelegramText,
  writeTaskDrop as writeTaskDropRaw,
  writeAnswerMarker as writeAnswerMarkerRaw,
  BridgeRetryableError,
} from "../src/telegram-bridge.js";
import { inboxMessageFileName } from "../src/adapters/registry.js";

const runtimeFixtures = new Map<string, FullstackRuntimeTestFixture>();
function runtimeFixtureFor(root: string): FullstackRuntimeTestFixture {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const fixture = openFullstackRuntimeTest(root, "telegram-bridge-test");
  runtimeFixtures.set(root, fixture);
  return fixture;
}
function runtimeFor(root: string) { return runtimeFixtureFor(root).access; }
function authenticatedState(root: string, id: string, task: string): CtoState {
  const fixture = runtimeFixtureFor(root);
  const state = newCtoState({ id, task, branch: "main", autonomous: true, plan: { id, task, teams: [], created_at: new Date().toISOString() } });
  state.owner_session = fixture.sessionId;
  state.work_identity = { run_id: id, wave_id: "telegram-bridge-wave", slice_id: "telegram-bridge-slice", session_id: fixture.sessionId, workflow: "standard", stage_id: "execution", stage_cursor: "execution", capability_id: "telegram-bridge-capability", capability_epoch: "telegram-bridge-epoch", slot_id: "telegram-bridge-slot", task_id: id, dispatch_id: "telegram-bridge-dispatch", attempt: 1, worker_id: "telegram-bridge-worker" };
  assert.ok(fixture.access.createRun(state, { source_id: `telegram-bridge:${id}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) }));
  return state;
}
test.afterEach(() => {
  for (const fixture of runtimeFixtures.values()) fixture.close();
  runtimeFixtures.clear();
});

function classifyIncoming(...args: Parameters<typeof classifyIncomingRaw>): ReturnType<typeof classifyIncomingRaw> {
  const [cwd, message, suppliedPin] = args;
  const fixture = runtimeFixtureFor(cwd);
  return classifyIncomingRaw(cwd, message, suppliedPin, fixture.access, fixture.proofAuthority);
}
function findCompletedSummary(...args: Parameters<typeof findCompletedSummaryRaw>): ReturnType<typeof findCompletedSummaryRaw> {
  const [cwd, suppliedPin] = args;
  return findCompletedSummaryRaw(cwd, suppliedPin, runtimeFor(cwd));
}
function writeTaskDrop(...args: Parameters<typeof writeTaskDropRaw>): ReturnType<typeof writeTaskDropRaw> {
  const [cwd, message, runId, suppliedPin] = args;
  const fixture = runtimeFixtureFor(cwd);
  return writeTaskDropRaw(cwd, message, runId, suppliedPin, fixture.access, fixture.proofAuthority);
}
function writeAnswerMarker(...args: Parameters<typeof writeAnswerMarkerRaw>): ReturnType<typeof writeAnswerMarkerRaw> {
  const [cwd, answer, suppliedPin] = args;
  const fixture = runtimeFixtureFor(cwd);
  return writeAnswerMarkerRaw(cwd, answer, suppliedPin, fixture.access, fixture.proofAuthority);
}

function activeRun(root: string): void {
  const state = authenticatedState(root, "run-one", "Active task");
  assert.equal(runtimeFor(root).markDeliveryPending(state.id, state.state_revision, "outbox"), true);
}

function finishedRun(root: string): void {
  const state = authenticatedState(root, "run-done", "Done task");
  const runDir = join(root, ".work-state", "cto", "run-done");
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify({
      runId: "run-done",
      verdict: "APPROVE",
      first_sweep: {
        "#348": { action: "r5 fixes pushed", state: "awaiting next review" },
        "#355": { action: "r2 fixes pushed", state: "awaiting next review" },
      },
    }),
  );
  state.integration.status = "done";
  state.pause = { kind: "done", reason: "" };
  state.updated_at = now;
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
}

function finishedRunWithWave(root: string): void {
  finishedRun(root);
  const statePath = join(root, ".work-state", "cto", "run-done", "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as CtoState;
  const now = new Date().toISOString();
  state.updated_at = now;
  state.wave_history = [{
    id: "wave-one", source: "run-done", source_id: "wave-source", task: "canonical task", slice_ids: [],
    status: "done", outcome: "pass", started_at: now, finished_at: now,
  }];
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
}

const MSG = { id: "tg:11", text: "Какой статус?", at: new Date().toISOString(), by: "telegram" };

test("bridge: active run -> task filed in the local drop, no reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-active-"));
  try {
    activeRun(root);
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "active-task");
    assert.equal(result.reply, undefined, "no reply — the session owns the conversation");
    assert.ok(result.filedPath?.startsWith(join(root, ".omp", "inbox")), "filed in the local drop");
    assert.equal(existsSync(result.filedPath!), true);
    assert.equal(result.runId, "run-one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("bridge: pinned active task drop rejects root, ancestor, and symlink replacement", () => {
  for (const replacementKind of ["root", "ancestor", "symlink"] as const) {
    const container = mkdtempSync(join(tmpdir(), `bridge-pinned-${replacementKind}-`));
    const parent = replacementKind === "ancestor" ? join(container, "parent") : null;
    const root = parent ? join(parent, "project") : container;
    if (parent) mkdirSync(root, { recursive: true });
    activeRun(root);
    const displaced = `${root}.opened`;
    const displacedParent = parent ? `${parent}.opened` : null;
    const outside = replacementKind === "symlink" ? mkdtempSync(join(tmpdir(), "bridge-pinned-outside-")) : null;
    let swapped = false;
    const pin = PinnedProjectRoot.open(root, {
      beforeRename: (relativePath) => {
        if (swapped || relativePath.endsWith("/bridge.lock")) return;
        swapped = true;
        if (replacementKind === "ancestor" && parent && displacedParent) {
          renameSync(parent, displacedParent);
          mkdirSync(root, { recursive: true });
        } else {
          renameSync(root, displaced);
          if (replacementKind === "symlink" && outside) symlinkSync(outside, root);
          else mkdirSync(root);
        }
      },
    });
    try {
      assert.ok(pin);
      assert.throws(
        () => writeTaskDrop(root, { ...MSG, id: `tg-pinned-${replacementKind}` }, undefined, pin),
        /changed|unsafe|unavailable|failed|not found/i,
      );
      assert.equal(existsSync(join(root, ".omp")), false);
      if (outside) assert.equal(existsSync(join(outside, ".omp")), false);
    } finally {
      pin?.close();
      if (replacementKind === "symlink" && swapped) {
        unlinkSync(root);
        renameSync(displaced, root);
      } else if (replacementKind === "ancestor" && swapped && displacedParent && parent) {
        rmSync(parent, { recursive: true, force: true });
        renameSync(displacedParent, parent);
      } else if (swapped) {
        rmSync(root, { recursive: true, force: true });
        renameSync(displaced, root);
      }
      rmSync(parent ?? root, { recursive: true, force: true });
      rmSync(container, { recursive: true, force: true });
      if (outside) rmSync(outside, { recursive: true, force: true });
    }
  }
});



test("bridge: pinned answer marker rejects root, ancestor, and symlink replacement", () => {
  for (const replacementKind of ["root", "ancestor", "symlink"] as const) {
    const container = mkdtempSync(join(tmpdir(), `bridge-answer-${replacementKind}-`));
    const parent = replacementKind === "ancestor" ? join(container, "parent") : null;
    const root = parent ? join(parent, "project") : container;
    if (parent) mkdirSync(root, { recursive: true });
    activeRun(root);
    const displaced = `${root}.opened`;
    const displacedParent = parent ? `${parent}.opened` : null;
    const outside = replacementKind === "symlink" ? mkdtempSync(join(tmpdir(), "bridge-answer-outside-")) : null;
    let swapped = false;
    const swapAfterLease = (relativePath: string): void => {
      if (swapped || relativePath.endsWith("/bridge.lock")) return;
      swapped = true;
      if (replacementKind === "ancestor" && parent && displacedParent) {
        renameSync(parent, displacedParent);
        mkdirSync(root, { recursive: true });
      } else {
        renameSync(root, displaced);
        if (replacementKind === "symlink" && outside) symlinkSync(outside, root);
        else mkdirSync(root);
      }
    };
    const pin = PinnedProjectRoot.open(root, { beforeTempOpen: swapAfterLease, beforeRename: swapAfterLease });
    try {
      assert.ok(pin);
      assert.throws(
        () => writeAnswerMarker(root, { id: "run-one/escalation-0", run_id: "run-one", answer: "seed" }, pin),
        BridgeRetryableError,
      );
      assert.equal(swapped, true, "answer seam must reject the supplied unstable pin");
      assert.throws(
        () => writeAnswerMarker(root, { id: "run-one/escalation-1", run_id: "run-one", answer: "answer" }, pin),
        BridgeRetryableError,
      );
    } finally {
      pin?.close();
      if (replacementKind === "symlink" && swapped) {
        unlinkSync(root);
        renameSync(displaced, root);
      } else if (replacementKind === "ancestor" && swapped && displacedParent && parent) {
        rmSync(parent, { recursive: true, force: true });
        renameSync(displacedParent, parent);
      } else if (swapped) {
        rmSync(root, { recursive: true, force: true });
        renameSync(displaced, root);
      }
      rmSync(parent ?? root, { recursive: true, force: true });
      rmSync(container, { recursive: true, force: true });
      if (outside) rmSync(outside, { recursive: true, force: true });
    }
  }
});
test("bridge: answer marker requires an active run and canonical bounded identity", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-answer-validation-"));
  try {
    activeRun(root);
    assert.equal(writeAnswerMarker(root, { id: "run-one//malformed", run_id: "run-one", answer: "no" }), null);
    assert.equal(writeAnswerMarker(root, { id: "run-other/team-a/q1", run_id: "run-other", answer: "foreign" }), null);
    assert.equal(writeAnswerMarker(root, { id: "run-one/team-a/q1", run_id: "run-one", answer: "ok", by: "x".repeat(257) }), null);
    assert.equal(existsSync(join(root, ".omp", "inbox")), false, "rejected markers do not create the local drop");
    const path = writeAnswerMarker(root, { id: "run-one/team-a/q1", run_id: "run-one", answer: "approved", by: "telegram:reply" });
    assert.ok(path);
    const marker = JSON.parse(readFileSync(path!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(marker).sort(), ["at", "auth", "by", "id", "kind", "run_id", "schema", "text"]);
    assert.equal(marker.id, "run-one/team-a/q1");
    assert.equal(marker.run_id, "run-one");
    assert.equal(marker.text, "approved");
    assert.equal(marker.by, "telegram:reply");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: finished run -> status reply + standby task filed", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-done-"));
  try {
    finishedRun(root);
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "completed-status");
    assert.ok(result.reply!.includes("run-done"), "reply names the run");
    assert.ok(result.reply!.includes("status: done"), "reply carries canonical run status");
    assert.equal(result.reply!.includes("APPROVE"), false, "summary verdict is not authoritative");
    assert.equal(result.reply!.includes("#348"), false, "summary details are not authoritative");
    assert.ok(result.filedPath, "message still filed (user may have meant a task)");
    assert.equal(result.runId, "run-done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("bridge: completed status replies target each originating chat", async () => {
  const roots = [mkdtempSync(join(tmpdir(), "bridge-chat-one-")), mkdtempSync(join(tmpdir(), "bridge-chat-two-"))];
  const payloads: Array<{ chat_id?: string; text?: string }> = [];
  try {
    const messages = [
      { ...MSG, id: "tg-chat-one", chatId: "12345", messageId: 77 },
      { ...MSG, id: "tg-chat-two", chatId: "67890", messageId: 77 },
    ];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { chat_id?: string; text?: string };
      payloads.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
    for (const [index, root] of roots.entries()) {
      finishedRun(root);
      const result = classifyIncoming(root, messages[index]!);
      assert.equal(result.action, "completed-status");
      assert.equal(result.chatId, messages[index]!.chatId);
      assert.ok(result.reply?.includes("status: done"));
      assert.ok(result.filedPath, "plain task remains filed alongside the status response");
      assert.equal(await sendTelegramText("token", result.chatId!, result.reply!, fetchImpl), true);
    }
    assert.deepEqual(payloads.map((payload) => payload.chat_id), ["12345", "67890"], "responses never cross chats");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});


test("bridge: nothing -> standby run + saved reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-empty-"));
  try {
    const result = classifyIncoming(root, MSG);
    assert.equal(result.action, "standby-task");
    assert.ok(result.reply!.includes("saved"), "reply says the message was saved");
    assert.ok(result.runId!.startsWith("standby-"), "standby run created");
    const inboxFiles = readdirSync(join(root, ".work-state", "cto", result.runId!, "inbox")).filter((f) => f.endsWith(".json"));
    assert.equal(inboxFiles.length, 1, "task filed in the standby inbox");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: buildStatusReply + findCompletedSummary agree", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-summary-"));
  try {
    finishedRun(root);
    const found = findCompletedSummary(root);
    assert.equal(found?.runId, "run-done");
    const reply = buildStatusReply(found!.runId, found!.summary);
    assert.ok(reply.includes("status: done"));
    assert.equal(reply.includes("#355"), false);
    assert.equal(reply.includes("r2 fixes pushed"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: forged summary verdict and future timestamp have zero influence", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-forged-summary-"));
  try {
    finishedRun(root);
    const summaryPath = join(root, ".work-state", "cto", "run-done", "summary.json");
    const forged = JSON.stringify({ verdict: "REJECT", updated_at: "2999-01-01T00:00:00.000Z", first_sweep: { forged: { action: "must not appear" } } });
    writeFileSync(summaryPath, forged);
    const found = findCompletedSummary(root);
    assert.equal(found?.runId, "run-done");
    const reply = buildStatusReply(found!.runId, found!.summary);
    assert.match(reply, /status: done/);
    assert.equal(reply.includes("REJECT"), false);
    assert.equal(reply.includes("must not appear"), false);
    assert.equal(readFileSync(summaryPath, "utf8"), forged, "forged summary remains untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: copied cross-run summary has zero influence", () => {
  const roots = [mkdtempSync(join(tmpdir(), "bridge-summary-source-")), mkdtempSync(join(tmpdir(), "bridge-summary-target-"))];
  try {
    finishedRun(roots[0]!);
    finishedRun(roots[1]!);
    const sourceSummary = readFileSync(join(roots[0]!, ".work-state", "cto", "run-done", "summary.json"));
    const targetSummary = join(roots[1]!, ".work-state", "cto", "run-done", "summary.json");
    writeFileSync(targetSummary, sourceSummary);
    const found = findCompletedSummary(roots[1]!);
    assert.equal(found?.runId, "run-done");
    const reply = buildStatusReply(found!.runId, found!.summary);
    assert.match(reply, /status: done/);
    assert.equal(reply.includes("#348"), false);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: canonical state status works without summary.json", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-no-summary-"));
  try {
    finishedRun(root);
    unlinkSync(join(root, ".work-state", "cto", "run-done", "summary.json"));
    const found = findCompletedSummary(root);
    assert.equal(found?.runId, "run-done");
    assert.match(buildStatusReply(found!.runId, found!.summary), /status: done/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: status reply uses authenticated wave outcome and timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-wave-status-"));
  try {
    finishedRunWithWave(root);
    const found = findCompletedSummary(root);
    assert.equal(found?.runId, "run-done");
    const reply = buildStatusReply(found!.runId, found!.summary);
    assert.match(reply, /Status per wave:/);
    assert.match(reply, /wave-one: done/);
    assert.match(reply, /outcome: pass/);
    assert.match(reply, /2026|20/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: canonical status reply is bounded, Unicode-safe, and does not mutate state", () => {
  for (const count of [4096, 4097]) {
    const waves: Array<Record<string, unknown>> = [];
    for (let index = 0; index < count; index += 1) {
      waves.push({ id: `wave-${index}`, status: "done", started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:01.000Z", outcome: "pass" });
    }
    const summary = { status: "done", updated_at: "2026-01-01T00:00:01.000Z", waves };
    const before = JSON.stringify(summary);
    const reply = buildStatusReply("run-😀", summary);
    if (count === 4097) assert.match(reply, /status unavailable: malformed summary/);
    assert.ok(Array.from(reply).length <= 4096);
    assert.equal(reply.includes("\u0000"), false);
    assert.equal(JSON.stringify(summary), before);
  }
});


test("bridge: zero-byte predictable task collision is retryable", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-zero-byte-collision-"));
  try {
    const message = { ...MSG, id: "tg-zero-byte" };
    const path = join(root, ".omp", "inbox", inboxMessageFileName(message.id));
    activeRun(root);
    mkdirSync(join(root, ".omp", "inbox"), { recursive: true });
    writeFileSync(path, Buffer.alloc(0));
    assert.throws(() => writeTaskDrop(root, message, "run-one"), BridgeRetryableError);
    assert.equal(readFileSync(path).byteLength, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: authenticated task collision binds exact text and run", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-collision-binding-"));
  try {
    const message = { ...MSG, id: "tg-binding" };
    activeRun(root);
    const first = writeTaskDrop(root, message, "run-one");
    assert.ok(first);
    const forged = JSON.parse(readFileSync(first!, "utf8")) as Record<string, unknown>;
    forged.text = "different text";
    writeFileSync(first!, JSON.stringify(forged));
    assert.throws(() => writeTaskDrop(root, message, "run-one"), BridgeRetryableError);

    const foreignMessage = { ...MSG, id: "tg-foreign-route" };
    const foreignPath = writeTaskDrop(root, foreignMessage, "run-two");
    assert.ok(foreignPath);
    assert.throws(() => writeTaskDrop(root, foreignMessage, "run-one"), BridgeRetryableError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: exact genuine task redelivery remains idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-genuine-redelivery-"));
  try {
    const message = { ...MSG, id: "tg-genuine-redelivery" };
    activeRun(root);
    assert.ok(writeTaskDrop(root, message, "run-one"));
    assert.equal(writeTaskDrop(root, message, "run-one"), null);
    assert.equal(readdirSync(join(root, ".omp", "inbox")).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: task writes are wx-idempotent (duplicate delivery skipped)", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-idem-"));
  try {
    const first = writeTaskDrop(root, MSG);
    assert.ok(first, "first write succeeds");
    // Same message redelivered (bridge restart) -> deterministic file name by
    // message id -> wx collision -> null, no duplicate task on disk.
    const second = writeTaskDrop(root, MSG);
    assert.equal(second, null, "duplicate delivery skipped");
    const files = readdirSync(join(root, ".omp", "inbox")).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "exactly one task file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: persistence failures propagate instead of looking like duplicate delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-write-error-"));
  try {
    const drop = join(root, ".omp", "inbox");
    mkdirSync(drop, { recursive: true });
    // A directory at the deterministic task path proves the write was not
    mkdirSync(join(drop, inboxMessageFileName(MSG.id)));
    assert.throws(() => writeTaskDrop(root, MSG), /EEXIST|EISDIR|directory|is a directory|already exists|regular file|anchored target/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: sendTelegramText posts to the bot API and reports ok", async () => {
  let payload: Record<string, unknown> | null = null;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const method = String(url).split("/").pop();
    if (method === "sendMessage") {
      payload = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected method: ${method}`);
  }) as typeof fetch;

  const ok = await sendTelegramText("t", "c", "hello", fetchImpl);
  assert.equal(ok, true);
  assert.equal(payload?.chat_id, "c");
  assert.equal(payload?.text, "hello");
  assert.equal("reply_markup" in (payload ?? {}), false, "plain text, no reply markup");
});
test("bridge: sendTelegramText rejects oversized or malformed response bodies", async () => {
  const oversized = await sendTelegramText("t", "c", "hello", (async () => new Response("x".repeat(70_000), { status: 200 })) as typeof fetch);
  assert.equal(oversized, false);
  const malformed = await sendTelegramText("t", "c", "hello", (async () => new Response(JSON.stringify({ ok: "yes" }), { status: 200 })) as typeof fetch);
  assert.equal(malformed, false);
});
