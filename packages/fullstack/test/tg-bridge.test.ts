import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFullstackActivationMarker, FULLSTACK_ACTIVATION_MARKER_PATH } from "../src/activation-marker.js";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState } from "../../core/src/cto/state.js";
import { TelegramEscalationAdapter } from "../src/adapters/telegram.js";
import { openFullstackRuntimeTest, type FullstackRuntimeTestFixture } from "./runtime-access-fixture.js";

const runtimeFixtures = new Map<string, FullstackRuntimeTestFixture>();
function runtimeFor(root: string): FullstackRuntimeTestFixture {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const fixture = openFullstackRuntimeTest(root, "tg-bridge-test-" + String(runtimeFixtures.size));
  runtimeFixtures.set(root, fixture);
  return fixture;
}
function closeRuntimeFixtures(): void {
  for (const fixture of runtimeFixtures.values()) fixture.close();
  runtimeFixtures.clear();
}
test.afterEach(closeRuntimeFixtures);
test.after(closeRuntimeFixtures);

const here = dirname(fileURLToPath(import.meta.url));
const bridge = resolve(here, "../bin/tg-bridge.mjs");
const support = resolve(here, "tg-bridge-child-support.mjs");
const CHECKPOINT_PATH = ".omp/tg-bridge.checkpoint.json";

function project(token = "test-token", chatId = "123"): string {
  const root = mkdtempSync(join(tmpdir(), "omp-tg-bridge-child-"));
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
    channels: [{ adapter: "telegram", primary: true, direction: "read-write", chatId, telegram: { token, chatId, pollIntervalMs: 60_000 } }],
  }));
  return root;
}

function writeConfig(root: string, token: string, chatId: string): void {
  writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
    channels: [{ adapter: "telegram", primary: true, direction: "read-write", chatId, telegram: { token, chatId, pollIntervalMs: 60_000 } }],
  }));
}

function writeOwnerRoute(root: string, runId: string, ownerSession: string, chatId: string): void {
  const state = newCtoState({
    id: runId,
    task: `active route ${chatId}`,
    branch: "main",
    autonomous: true,
    owner_session: runtimeFor(root).sessionId,
    plan: { id: runId, task: `active route ${chatId}`, teams: [], created_at: new Date().toISOString() },
  });
  state.channel_profile = { direction: "rw", transport: "telegram", adapter: "telegram", ackTarget: chatId, primary: true };
  const runtime = runtimeFor(root);
  assert.ok(runtime.access.createRun(state, { source_id: `tg-bridge:${runId}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) }));
  assert.equal(runtime.access.markDeliveryPending(runId, state.state_revision, "outbox"), true);
}

function inboxFileCount(root: string): number {
  const cto = join(root, ".work-state", "cto");
  if (!existsSync(cto)) return 0;
  let count = 0;
  for (const entry of readdirSync(cto, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inbox = join(cto, entry.name, "inbox");
    if (!existsSync(inbox)) continue;
    count += readdirSync(inbox).filter((name) => name.endsWith(".json")).length;
  }
  return count;
}

type BridgeOptions = {
  deferred?: boolean;
  log?: string;
  updateCount?: number;
  updateId?: number;
  updateChat?: string;
  updateText?: string;
  holdSend?: boolean;
  crash?: "before-core" | "after-core" | "after-checkpoint";
  waitFor?: string;
  replyTo?: number;
};

function runBridge(root: string, options: BridgeOptions = {}): ChildProcessWithoutNullStreams {
  const env = {
    ...process.env,
    ...(options.log ? { TG_BRIDGE_FETCH_LOG: options.log } : {}),
    ...(options.deferred ? { TG_BRIDGE_DEFER: "1" } : {}),
    ...(options.updateCount === undefined ? {} : { TG_BRIDGE_UPDATE_COUNT: String(options.updateCount) }),
    ...(options.updateId === undefined ? {} : { TG_BRIDGE_UPDATE_ID: String(options.updateId) }),
    ...(options.updateChat === undefined ? {} : { TG_BRIDGE_UPDATE_CHAT: options.updateChat }),
    ...(options.updateText === undefined ? {} : { TG_BRIDGE_UPDATE_TEXT: options.updateText }),
    ...(options.holdSend ? { TG_BRIDGE_HOLD_SEND: "1" } : {}),
    ...(options.crash ? { TG_BRIDGE_TEST_CRASH: options.crash } : {}),
    ...(options.waitFor ? { TG_BRIDGE_WAIT_FOR: options.waitFor } : {}),
    ...(options.replyTo === undefined ? {} : { TG_BRIDGE_REPLY_TO: String(options.replyTo) }),
    NODE_ENV: "test",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=tsx", `--import=${support}`].filter(Boolean).join(" "),
    ...(runtimeFixtures.has(root) ? { TG_BRIDGE_CLAIM_GENERATION: String(runtimeFixtures.get(root).activationSnapshot.claim_generation) } : {}),
    TG_BRIDGE_CWD: root,
  };
  return spawn(process.execPath, [bridge, "--cwd", root], { cwd: resolve(here, "../.."), env });
}

function outputUntil(child: ChildProcessWithoutNullStreams, text: string, timeoutMs = 30_000): Promise<string> {
  // This integration helper waits on a real child process; fake timers cannot drive its stdout.
  const { promise, resolve: resolveOutput, reject } = Promise.withResolvers<string>();
  let output = "";
  let errorOutput = "";
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onStderr = (chunk: Buffer): void => { errorOutput += chunk.toString(); };
  const onData = (chunk: Buffer): void => {
    output += chunk.toString();
    if (output.includes(text)) finish();
  };
  function finish(error?: Error): void {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    child.stdout.off("data", onData);
    child.stderr.off("data", onStderr);
    child.off("error", onError);
    child.off("close", onClose);
    if (error) reject(error);
    else resolveOutput(output);
  }
  function onError(error: Error): void { finish(error); }
  function onClose(code: number | null): void {
    if (!output.includes(text)) finish(new Error(`bridge exited ${code} before '${text}': ${output}${errorOutput}`));
  }
  child.stderr.on("data", onStderr);
  child.stdout.on("data", onData);
  child.once("error", onError);
  child.once("close", onClose);
  timeout = setTimeout(() => {
    child.kill("SIGTERM");
    finish(new Error(`timed out after ${timeoutMs}ms waiting for '${text}': ${output}${errorOutput}`));
  }, timeoutMs);
  timeout.unref?.();
  return promise;
}

function waitClose(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  const { promise, resolve: resolveClose, reject } = Promise.withResolvers<number | null>();
  child.once("error", reject);
  child.once("close", (code) => resolveClose(code));
  return promise;
}

function waitForLog(path: string, text: string, timeoutMs = 5_000): Promise<string> {
  const { promise, resolve: resolveLog, reject } = Promise.withResolvers<string>();
  const started = Date.now();
  const check = () => {
    if (existsSync(path)) {
      const contents = readFileSync(path, "utf8");
      if (contents.includes(text)) {
        resolveLog(contents);
        return;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      reject(new Error(`timed out waiting for '${text}' in ${path}`));
      return;
    }
    // Child writes are observed through a filesystem log; fs.watch can coalesce or miss events, so bounded polling is the deterministic signal here.
    setTimeout(check, 10);
  };
  check();
  return promise;
}

async function assertActivationRejected(root: string, marker: string, log: string): Promise<void> {
  writeFileSync(join(root, FULLSTACK_ACTIVATION_MARKER_PATH), marker);
  const child = runBridge(root, { log });
  const stderr = new Promise<string>((resolveStderr) => {
    let text = "";
    child.stderr.on("data", (chunk) => { text += chunk.toString(); });
    child.stderr.on("end", () => resolveStderr(text));
  });
  assert.equal(await waitClose(child), 1);
  assert.match(await stderr, /project activation unavailable/);
  assert.equal(existsSync(join(root, ".omp", "bridge.lock")), false);
  assert.equal(existsSync(log), false);
}

test("tg-bridge fails closed before config, lease, or network without exact marker", async () => {
  const root = project();
  try {
    const child = runBridge(root);
    const stderr = new Promise<string>((resolveStderr) => {
      let text = "";
      child.stderr.on("data", (chunk) => { text += chunk.toString(); });
      child.stderr.on("end", () => resolveStderr(text));
    });
    assert.equal(await waitClose(child), 1);
    assert.match(await stderr, /project activation unavailable/);
    assert.equal(existsSync(join(root, ".omp", "bridge.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge rejects a wrong marker before config, lease, or network", async () => {
  const root = project();
  const log = join(root, "fetch.log");
  try {
    await assertActivationRejected(root, "{}\n", log);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge reaches ready only with marker and cleans owned lease on SIGTERM", async () => {
  const root = project();
  const log = join(root, "fetch.log");
  try {
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { log });
    await outputUntil(child, "tg-bridge: ready;");
    assert.equal(existsSync(join(root, ".omp", "bridge.lock")), true);
    child.kill("SIGTERM");
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    assert.equal(existsSync(join(root, ".omp", "bridge.lock")), false);
    assert.equal(readFileSync(log, "utf8").split("\n").filter(Boolean).length >= 1, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge revokes deferred poll after marker removal without a second network call", async () => {
  const root = project();
  const log = join(root, "fetch.log");
  try {
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { deferred: true, log });
    await outputUntil(child, "tg-bridge: ready;");
    rmSync(join(root, FULLSTACK_ACTIVATION_MARKER_PATH));
    assert.equal(await waitClose(child), 1);
    assert.equal(existsSync(join(root, ".omp", "bridge.lock")), true, "revoked marker leaves the unauthenticated lease untouched");
    assert.equal(readFileSync(log, "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge revokes a deferred poll when the anchored Telegram config is replaced", async () => {
  const root = project("old-token", "111");
  const log = join(root, "fetch.log");
  try {
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { deferred: true, log });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await outputUntil(child, "tg-bridge: ready;");
    writeConfig(root, "new-token", "222");
    assert.equal(await waitClose(child), 1);
    assert.match(stderr, /config_revoked/);
    assert.equal(existsSync(join(root, ".omp", "bridge.lock")), false);
    const requests = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(requests.length, 1, "config replacement must not trigger another poll");
    assert.match(requests[0]!, /old-token/);
    assert.doesNotMatch(requests.join("\n"), /new-token|chat=222/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge persists one bounded high-water checkpoint for a parser-sized batch", async () => {
  const root = project("bounded-token", "111");
  const log = join(root, "fetch.log");
  const updateCount = 32;
  try {
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { log, updateCount, updateChat: "999" });
    await outputUntil(child, "tg-bridge: ready;");
    await waitForLog(join(root, CHECKPOINT_PATH), "high_water_update_id");
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    const checkpointBytes = readFileSync(join(root, CHECKPOINT_PATH), "utf8");
    const checkpoint = JSON.parse(checkpointBytes) as Record<string, unknown>;
    assert.deepEqual(Object.keys(checkpoint).sort(), ["bot_sha256", "canonical_root", "channel", "format_version", "high_water_update_id", "projection_sha256", "route_profile_sha256", "signature", "target"]);
    assert.equal(checkpoint.high_water_update_id, updateCount);
    assert.ok(Buffer.byteLength(checkpointBytes, "utf8") < 2_048, "checkpoint stays constant-size rather than retaining every update id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge fresh process redelivers an old checkpoint without duplicating the core task", async () => {
  const root = project("replay-token", "111");
  const firstLog = join(root, "first.log");
  const secondLog = join(root, "second.log");
  const options = { updateCount: 1, updateId: 31, updateChat: "111", updateText: "status question" };
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { ...options, log: firstLog });
    await outputUntil(first, "tg-bridge: replied to");
    first.kill("SIGTERM");
    assert.equal(await waitClose(first), 0);
    const before = inboxFileCount(root);

    const second = runBridge(root, { ...options, log: secondLog });
    await outputUntil(second, "tg-bridge: filed");
    const requests = readFileSync(secondLog, "utf8");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.match(requests, /offset=0/, "a fresh process cannot authenticate an old process-private MAC");
    assert.doesNotMatch(requests, /sendMessage/, "duplicate core tasks do not require a duplicate acknowledgement");
    assert.equal(inboxFileCount(root), before, "the canonical task write is idempotent across redelivery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge crash after checkpoint before ack redelivers without duplicating core task", async () => {
  const root = project("crash-token", "111");
  const firstLog = join(root, "crash-first.log");
  const secondLog = join(root, "crash-second.log");
  const options = { updateCount: 1, updateId: 41, updateChat: "111", updateText: "crash question" };
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { ...options, log: firstLog, crash: "after-checkpoint" });
    assert.equal(await waitClose(first), null);
    const before = inboxFileCount(root);

    const second = runBridge(root, { ...options, log: secondLog });
    await outputUntil(second, "tg-bridge: filed");
    const requests = readFileSync(secondLog, "utf8");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.match(requests, /offset=0/);
    assert.doesNotMatch(requests, /sendMessage/);
    assert.equal(inboxFileCount(root), before, "the checkpoint crash replays one idempotent core task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge crash before core write redelivers and preserves the task", async () => {
  const root = project("crash-before-core", "111");
  const firstLog = join(root, "before-first.log");
  const secondLog = join(root, "before-second.log");
  const options = { updateCount: 1, updateId: 51, updateChat: "111", updateText: "before core" };
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { ...options, log: firstLog, crash: "before-core" });
    assert.equal(await waitClose(first), null);
    assert.equal(inboxFileCount(root), 0, "pre-core crash writes no task");
    const second = runBridge(root, { ...options, log: secondLog });
    await outputUntil(second, "tg-bridge: replied to");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.equal(inboxFileCount(root), 1, "redelivery files the task once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge crash after core write before checkpoint replays one idempotent task", async () => {
  const root = project("crash-after-core", "111");
  const firstLog = join(root, "after-first.log");
  const secondLog = join(root, "after-second.log");
  const options = { updateCount: 1, updateId: 61, updateChat: "111", updateText: "after core" };
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { ...options, log: firstLog, crash: "after-core" });
    assert.equal(await waitClose(first), null);
    assert.equal(inboxFileCount(root), 1, "post-core crash leaves the durable task");
    const second = runBridge(root, { ...options, log: secondLog });
    await outputUntil(second, "tg-bridge: filed");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.equal(inboxFileCount(root), 1, "redelivery does not duplicate the durable task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("tg-bridge isolates a route change from the prior checkpoint offset", async () => {
  const root = project("old-token", "111");
  const firstLog = join(root, "route-first.log");
  const secondLog = join(root, "route-second.log");
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { log: firstLog, updateCount: 1, updateId: 100, updateChat: "111", updateText: "old route" });
    await outputUntil(first, "tg-bridge: replied to");
    first.kill("SIGTERM");
    assert.equal(await waitClose(first), 0);

    writeConfig(root, "new-token", "222");
    const second = runBridge(root, { log: secondLog, updateCount: 1, updateId: 1, updateChat: "222", updateText: "new route" });
    await outputUntil(second, "tg-bridge: replied to");
    const requests = readFileSync(secondLog, "utf8");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.match(requests, /new-token/);
    assert.match(requests, /offset=0/);
    assert.match(requests, /sendMessage.*chat=222/);
    assert.doesNotMatch(requests, /old-token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("tg-bridge routes configured Telegram target to only its authenticated active owner", async () => {
  const root = project("owner-token", "111");
  const log = join(root, "owner.log");
  try {
    writeOwnerRoute(root, "run-owner-111", "owner-session-111", "111");
    writeOwnerRoute(root, "run-owner-222", "owner-session-222", "222");
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { log, updateCount: 1, updateId: 71, updateChat: "111", updateText: "owner task" });
    await outputUntil(child, "active-task");
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    const inbox = join(root, ".omp", "inbox");
    const files = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const task = JSON.parse(readFileSync(join(inbox, files[0]!), "utf8")) as { run_id?: string };
    assert.equal(task.run_id, "run-owner-111");
    assert.equal(inboxFileCount(root), 0, "the configured active route does not create a standby task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge fails closed for mismatched or ambiguous active Telegram routes", async () => {
  for (const [name, chatId, routes] of [
    ["mismatch", "999", [["run-mismatch", "owner-mismatch", "111"]]],
    ["ambiguous", "111", [["run-ambiguous-a", "owner-a", "111"], ["run-ambiguous-b", "owner-b", "111"]]],
  ] as const) {
    const root = project("route-token", chatId);
    const log = join(root, `${name}.log`);
    try {
      for (const [runId, ownerSession, target] of routes) writeOwnerRoute(root, runId, ownerSession, target);
      writeFullstackActivationMarker(root);
      const child = runBridge(root, { log, updateCount: 1, updateId: 81, updateChat: chatId, updateText: name });
      await outputUntil(child, "tg-bridge: ready;");
      // A mismatched or ambiguous route is rejected without filing a task or
      // creating a standby run; the bridge remains available for shutdown.
      await new Promise((resolve) => setTimeout(resolve, 250));
      child.kill("SIGTERM");
      assert.equal(await waitClose(child), 0);
      assert.equal(inboxFileCount(root), 0);
      assert.equal(existsSync(join(root, ".omp", "inbox")), false);
      assert.equal(readdirSync(join(root, ".work-state", "cto"), { withFileTypes: true }).some((entry) => entry.name.startsWith("standby-")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test("tg-bridge does not create standby or commit updates for corrupt or unavailable active indexes", async () => {
  for (const mode of ["corrupt", "unavailable"] as const) {
    const root = project(`active-index-${mode}`, "111");
    const log = join(root, `${mode}.log`);
    try {
      const runId = `run-index-${mode}`;
      writeOwnerRoute(root, runId, `owner-${mode}`, "111");
      const indexPath = join(root, ".work-state", "cto", "active-run-index.json");
      if (mode === "corrupt") {
        writeFileSync(indexPath, "{not-json");
      } else {
        const statePath = join(root, ".work-state", "cto", runId, "state.json");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
        state.updated_at = new Date(Date.now() + 1_000).toISOString();
        writeFileSync(statePath, JSON.stringify(state));
      }
      writeFullstackActivationMarker(root);
      const child = runBridge(root, { log, updateCount: 1, updateId: 101, updateChat: "111", updateText: mode });
      await outputUntil(child, "tg-bridge: ready;");
      await waitForLog(log, "offset=0");
      await new Promise((resolve) => setTimeout(resolve, 250));
      child.kill("SIGTERM");
      assert.equal(await waitClose(child), 0);
      assert.equal(existsSync(join(root, CHECKPOINT_PATH)), false, `${mode} active-index failure must not commit the Telegram offset`);
      assert.equal(inboxFileCount(root), 0, `${mode} active-index failure must not file a task`);
      assert.equal(readdirSync(join(root, ".work-state", "cto"), { withFileTypes: true }).some((entry) => entry.name.startsWith("standby-")), false, `${mode} active-index failure must not create standby`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("tg-bridge rebinds a later owner-tagged run after starting without an active run", async () => {
  const root = project("takeover-token", "111");
  const log = join(root, "takeover.log");
  const gate = join(root, ".omp", "release-update");
  try {
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { log, waitFor: gate, updateCount: 1, updateId: 91, updateChat: "111", updateText: "takeover task" });
    await outputUntil(child, "tg-bridge: ready;");
    writeOwnerRoute(root, "run-takeover", "owner-takeover", "111");
    writeFileSync(gate, "ready");
    await outputUntil(child, "active-task");
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    const inbox = join(root, ".omp", "inbox");
    const files = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const task = JSON.parse(readFileSync(join(inbox, files[0]!), "utf8")) as { run_id?: string };
    assert.equal(task.run_id, "run-takeover");
    assert.equal(inboxFileCount(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("tg-bridge ignores a token-derived forged high-water checkpoint", async () => {
  const root = project("forge-token", "111");
  const firstLog = join(root, "forge-first.log");
  const secondLog = join(root, "forge-second.log");
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { log: firstLog, updateCount: 1, updateId: 7, updateChat: "999", updateText: "unauthorized" });
    await waitForLog(join(root, CHECKPOINT_PATH), "high_water_update_id");
    first.kill("SIGTERM");
    assert.equal(await waitClose(first), 0);
    const checkpoint = JSON.parse(readFileSync(join(root, CHECKPOINT_PATH), "utf8")) as Record<string, unknown>;
    const forged = { ...checkpoint, high_water_update_id: 9_999_999 };
    delete forged.signature;
    const tokenDerivedSignature = createHmac("sha256", "forge-token")
      .update(`omp-tg-bridge-checkpoint-v1\\u0000${JSON.stringify(forged)}`, "utf8")
      .digest("hex");
    const forgedPath = join(root, "forged-checkpoint.json");
    writeFileSync(forgedPath, JSON.stringify({ ...forged, signature: tokenDerivedSignature }));
    unlinkSync(join(root, CHECKPOINT_PATH));
    linkSync(forgedPath, join(root, CHECKPOINT_PATH));

    const second = runBridge(root, { log: secondLog, updateCount: 1, updateId: 1, updateChat: "111", updateText: "forged replay" });
    await outputUntil(second, "tg-bridge: replied to");
    const requests = readFileSync(secondLog, "utf8");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.match(requests, /offset=0/, "token-derived MAC cannot authorize a forged offset");
    assert.equal(inboxFileCount(root), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("tg-bridge ignores a symlinked checkpoint instead of trusting its target", async () => {
  const root = project("symlink-token", "111");
  const firstLog = join(root, "symlink-first.log");
  const secondLog = join(root, "symlink-second.log");
  try {
    writeFullstackActivationMarker(root);
    const first = runBridge(root, { log: firstLog, updateCount: 1, updateId: 7, updateChat: "999", updateText: "unauthorized" });
    await waitForLog(join(root, CHECKPOINT_PATH), "high_water_update_id");
    first.kill("SIGTERM");
    assert.equal(await waitClose(first), 0);
    const target = join(root, "foreign-checkpoint.json");
    writeFileSync(target, JSON.stringify({ schema: 1, high_water_update_id: 9_999_999 }));
    unlinkSync(join(root, CHECKPOINT_PATH));
    symlinkSync(target, join(root, CHECKPOINT_PATH));

    const second = runBridge(root, { log: secondLog, updateCount: 1, updateId: 1, updateChat: "111", updateText: "symlink replay" });
    await outputUntil(second, "tg-bridge: replied to");
    const requests = readFileSync(secondLog, "utf8");
    second.kill("SIGTERM");
    assert.equal(await waitClose(second), 0);
    assert.match(requests, /offset=0/);
    assert.equal(inboxFileCount(root), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("tg-bridge writes an answer marker for the exact configured active owner", async () => {
  const root = project("owner-token", "111");
  const log = join(root, "answer-owner.log");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    writeOwnerRoute(root, "run-answer-111", "owner-answer-111", "111");
    const fixtureAdapter = new TelegramEscalationAdapter({
      token: "owner-token",
      chatId: "111",
      cwd: root,
      runtimeAccess: runtimeFor(root).access,
      proofAuthority: runtimeFor(root).proofAuthority,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 })) as typeof fetch,
    });
    const sent = await fixtureAdapter.send({ id: "run-answer-111/escalation", level: "question", title: "Question", body: "Choose" });
    assert.equal(sent.sent, true);
    writeFullstackActivationMarker(root);
    child = runBridge(root, { log, updateCount: 1, updateId: 101, updateChat: "111", updateText: "approved", replyTo: 555 });
    await outputUntil(child, "tg-bridge: answer");
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    const inbox = join(root, ".omp", "inbox");
    const markerFiles = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    assert.equal(markerFiles.length, 1);
    const marker = JSON.parse(readFileSync(join(inbox, markerFiles[0]!), "utf8")) as { kind?: string; run_id?: string; text?: string };
    assert.equal(marker.kind, "answer");
    assert.equal(marker.run_id, "run-answer-111");
    assert.equal(marker.text, "approved");
    const answers = readdirSync(join(root, ".work-state", "cto", "run-answer-111", "answers")).filter((name) => name.endsWith(".json"));
    assert.equal(answers.length, 1);
    assert.equal(inboxFileCount(root), 0, "answer routing does not create a standby task");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child && child.exitCode === null) await waitClose(child);
    rmSync(root, { recursive: true, force: true });
  }
});


test("tg-bridge refuses an answer marker when the configured route is foreign", async () => {
  const root = project("foreign-answer-token", "111");
  const log = join(root, "foreign-answer.log");
  try {
    writeOwnerRoute(root, "run-foreign-answer", "owner-foreign-answer", "222");
    const fixtureAdapter = new TelegramEscalationAdapter({
      token: "foreign-answer-token",
      chatId: "111",
      cwd: root,
      runtimeAccess: runtimeFor(root).access,
      proofAuthority: runtimeFor(root).proofAuthority,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 })) as typeof fetch,
    });
    const sent = await fixtureAdapter.send({ id: "run-foreign-answer/escalation", level: "question", title: "Question", body: "Choose" });
    assert.equal(sent.sent, true);
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { log, updateCount: 1, updateId: 111, updateChat: "111", updateText: "foreign answer", replyTo: 555 });
    await outputUntil(child, "tg-bridge: ready;");
    await waitForLog(log, "getUpdates");
    await new Promise((resolve) => setTimeout(resolve, 250));
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    assert.equal(existsSync(join(root, ".omp", "inbox")), false, "foreign answer does not wake any run");
    assert.equal(inboxFileCount(root), 0, "foreign answer does not create a standby task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tg-bridge refuses answer markers for an ambiguous dual-owner route", async () => {
  const root = project("ambiguous-answer-token", "111");
  const log = join(root, "ambiguous-answer.log");
  try {
    writeOwnerRoute(root, "run-ambiguous-answer-a", "owner-ambiguous-a", "111");
    writeOwnerRoute(root, "run-ambiguous-answer-b", "owner-ambiguous-b", "111");
    const fixtureAdapter = new TelegramEscalationAdapter({
      token: "ambiguous-answer-token",
      chatId: "111",
      cwd: root,
      runtimeAccess: runtimeFor(root).access,
      proofAuthority: runtimeFor(root).proofAuthority,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 556 } }), { status: 200 })) as typeof fetch,
    });
    const sent = await fixtureAdapter.send({ id: "run-ambiguous-answer-a/escalation", level: "question", title: "Question", body: "Choose" });
    assert.equal(sent.sent, true);
    writeFullstackActivationMarker(root);
    const child = runBridge(root, { log, updateCount: 1, updateId: 112, updateChat: "111", updateText: "ambiguous answer", replyTo: 556 });
    await outputUntil(child, "tg-bridge: ready;");
    await waitForLog(log, "getUpdates");
    await new Promise((resolve) => setTimeout(resolve, 250));
    child.kill("SIGTERM");
    assert.equal(await waitClose(child), 0);
    assert.equal(existsSync(join(root, ".omp", "inbox")), false, "ambiguous answer does not wake a guessed run");
    assert.equal(inboxFileCount(root), 0, "ambiguous answer does not create a standby task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
