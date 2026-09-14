import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ctoStateDir, ensureSecureStateDirectory } from "../src/cto/state.js";
import { CTO_REGISTRY_LOCK_FILE, CTO_TRANSACTION_LOCK_FILE, assertCtoRunLockHandle, withCtoRegistryLock, withCtoRunLock, withCtoRunLockAsync } from "../src/cto/transaction-lock.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { renameSync, symlinkSync } from "node:fs";

function lockPathFor(root: string, runId: string): string {
  const runDir = ctoStateDir(runId, root);
  ensureSecureStateDirectory(runDir);
  return join(runDir, CTO_TRANSACTION_LOCK_FILE);
}

function oldTimestamp(): Date {
  return new Date(Date.now() - 1_000);
}

test("cto transaction lock recovers a crash-created ownerless legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-ownerless-"));
  const runId = "ownerless-recovery";
  try {
    const lockPath = lockPathFor(root, runId);
    mkdirSync(lockPath, { mode: 0o700 });
    // A stale mtime makes this deterministic without sleeping through the
    // legacy publication grace interval.
    const staleAt = oldTimestamp();
    utimesSync(lockPath, staleAt, staleAt);

    const result = withCtoRunLock(root, runId, () => {
      const lockStat = lstatSync(lockPath);
      assert.equal(lockStat.isFile(), true, "new acquisitions publish a regular owner file");
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "");
      return "recovered";
    }, { timeoutMs: 1_000 });

    assert.equal(result, "recovered");
    assert.equal(existsSync(lockPath), false, "withCtoRunLock releases the recovered lock");
    assert.deepEqual(readdirSync(join(root, ".work-state", "cto", runId)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("legacy transaction lock directories with unknown entries remain authoritative", () => {
  for (const entryCount of [1, 2]) {
    const root = mkdtempSync(join(tmpdir(), `cto-lock-stuffed-${entryCount}-`));
    const runId = `stuffed-${entryCount}`;
    try {
      const lockPath = lockPathFor(root, runId);
      const staleAt = oldTimestamp();
      mkdirSync(lockPath, { mode: 0o700 });
      utimesSync(lockPath, staleAt, staleAt);
      for (let index = 0; index < entryCount; index += 1) {
        writeFileSync(join(lockPath, `unknown-${index}`), "must-survive\n", { flag: "wx", mode: 0o600 });
      }
      assert.throws(
        () => withCtoRunLock(root, runId, () => undefined, { timeoutMs: 1_000 }),
        /CTO transaction lock wait timeout exceeded/,
      );
      assert.equal(lstatSync(lockPath).isDirectory(), true);
      assert.deepEqual(readdirSync(lockPath).sort(), Array.from({ length: entryCount }, (_, index) => `unknown-${index}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("lock acquisition never yields a handle when owner publication read fails", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-publication-gap-"));
  const runId = "publication-gap";
  const lockPath = lockPathFor(root, runId);
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  const prototype = PinnedProjectRoot.prototype as unknown as { readFile: (relativeFile: string, options?: { maxBytes?: number }) => { bytes: Uint8Array; dev: number; ino: number } };
  const originalReadFile = prototype.readFile;
  let failed = false;
  let callbackCalls = 0;
  prototype.readFile = function (relativeFile, options) {
    if (!failed && relativeFile === `.work-state/cto/${runId}/${CTO_TRANSACTION_LOCK_FILE}`) {
      failed = true;
      throw new Error("injected owner publication read failure");
    }
    return originalReadFile.call(this, relativeFile, options);
  };
  try {
    assert.throws(
      () => withCtoRunLock(root, runId, () => { callbackCalls += 1; }, { pinnedRoot: pinned, timeoutMs: 200 }),
      /owner publication could not be verified/u,
    );
    assert.equal(callbackCalls, 0, "an unverified lock must never reach its callback");
    assert.equal(existsSync(lockPath), false, "the exact token is cleaned only after a successful second observation");
  } finally {
    prototype.readFile = originalReadFile;
    pinned.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto registry lock publishes at project scope and cleans the exact path", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-registry-lock-"));
  const lockPath = join(root, ".work-state", "cto", CTO_REGISTRY_LOCK_FILE);
  try {
    const result = withCtoRegistryLock(root, () => {
      assert.equal(lstatSync(lockPath).isFile(), true, "registry owner is a regular file");
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "");
      return "registry";
    });
    assert.equal(result, "registry");
    assert.equal(existsSync(lockPath), false, "registry lock is removed on release");
    assert.deepEqual(readdirSync(join(root, ".work-state", "cto")), [], "registry directory has no stale lock entries");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto registry lock reclaims an ownerless legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-registry-ownerless-"));
  const ctoRoot = join(root, ".work-state", "cto");
  const lockPath = join(ctoRoot, CTO_REGISTRY_LOCK_FILE);
  try {
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    const staleAt = oldTimestamp();
    utimesSync(lockPath, staleAt, staleAt);
    withCtoRegistryLock(root, () => {
      assert.equal(lstatSync(lockPath).isFile(), true, "legacy ownerless directory is replaced by owner file");
    }, { timeoutMs: 1_000 });
    assert.equal(existsSync(lockPath), false, "reclaimed registry lock is released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto transaction lock never steals a live owner", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-live-"));
  const runId = "live-owner";
  try {
    const lockPath = lockPathFor(root, runId);
    const result = withCtoRunLock(root, runId, () => {
      const before = readFileSync(lockPath, "utf8");
      assert.throws(
        () => withCtoRunLock(root, runId, () => "inner", { timeoutMs: 80 }),
        /CTO transaction lock wait timeout exceeded/,
      );
      assert.equal(readFileSync(lockPath, "utf8"), before, "a live PID lock remains authoritative");
      return "outer";
    });

    assert.equal(result, "outer");
    assert.equal(existsSync(lockPath), false, "the outer withCtoRunLock releases its exact token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto transaction lock never reclaims a live legacy PID-only owner", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-live-legacy-"));
  const runId = "live-legacy-owner";
  try {
    const lockPath = lockPathFor(root, runId);
    const owner = JSON.stringify({ pid: process.pid, token: "legacy-live-owner", acquired_at: new Date().toISOString() });
    writeFileSync(lockPath, owner, { mode: 0o600 });
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);
    assert.throws(
      () => withCtoRunLock(root, runId, () => "must-not-acquire", { timeoutMs: 80 }),
      /CTO transaction lock wait timeout exceeded/,
    );
    assert.equal(readFileSync(lockPath, "utf8"), owner, "a live PID-only owner remains authoritative after grace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpinned CTO transaction lock release preserves an interloper replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-unpinned-release-cas-"));
  const runId = "unpinned-release-cas";
  const lockPath = lockPathFor(root, runId);
  const originalOpen = PinnedProjectRoot.open;
  let replaced = false;
  PinnedProjectRoot.open = (projectRoot, hooks = {}) => originalOpen(projectRoot, {
    ...hooks,
    beforeConditionalCommit: (relativePath) => {
      hooks.beforeConditionalCommit?.(relativePath);
      if (!replaced && relativePath === `.work-state/cto/${runId}/${CTO_TRANSACTION_LOCK_FILE}`) {
        replaced = true;
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "interloper", acquired_at: new Date().toISOString() }));
      }
    },
  });
  try {
    withCtoRunLock(root, runId, () => "owned", { timeoutMs: 1_000 });
    assert.equal(replaced, true, "unpinned release must reach the exact conditional removal");
    const replacement = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    assert.equal(replacement.token, "interloper", "unpinned release never removes a replacement lock");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinned CTO transaction lock release preserves an interloper replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-release-cas-"));
  const runId = "release-cas";
  const lockPath = lockPathFor(root, runId);
  let replaced = false;
  const pinned = PinnedProjectRoot.open(root, {
    beforeConditionalCommit: (relativePath) => {
      if (!replaced && relativePath === `.work-state/cto/${runId}/${CTO_TRANSACTION_LOCK_FILE}`) {
        replaced = true;
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "interloper", acquired_at: new Date().toISOString() }));
      }
    },
  });
  assert.ok(pinned);
  try {
    withCtoRunLock(root, runId, () => "owned", { pinnedRoot: pinned, timeoutMs: 1_000 });
    assert.equal(replaced, true, "release hook observed the lock CAS");
    const replacement = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    assert.equal(replacement.token, "interloper", "release never removes a replacement lock");
  } finally {
    pinned.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO run lock handles require active lifetime and exact lock publication", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-handle-authority-"));
  const runId = "handle-authority";
  const lockPath = lockPathFor(root, runId);
  let stale: unknown;
  try {
    withCtoRunLock(root, runId, (handle) => {
      stale = handle;
      assert.doesNotThrow(() => assertCtoRunLockHandle(handle, root, runId));
      assert.throws(() => assertCtoRunLockHandle(handle, root, "foreign-run"), /identity does not match/);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement", acquired_at: new Date().toISOString() }));
      assert.throws(() => assertCtoRunLockHandle(handle, root, runId), /no longer bound to the active lock/);
    }, { timeoutMs: 1_000 });
    assert.throws(() => assertCtoRunLockHandle(stale, root, runId), /missing or was not issued/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("async CTO transaction lock yields while a same-run contender waits", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-async-"));
  const runId = "async-serialization";
  const events: string[] = [];
  try {
    const started = Date.now();
    const first = withCtoRunLockAsync(root, runId, async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      events.push("first:end");
      return "first";
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withCtoRunLockAsync(root, runId, async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    }, { timeoutMs: 1_000 });
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
    assert.ok(Date.now() - started < 1_000, "contender must not stall the event loop until timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto transaction lock reclaims a stale owner record", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-stale-"));
  const runId = "stale-owner";
  try {
    const lockPath = lockPathFor(root, runId);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", acquired_at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    const staleAt = oldTimestamp();
    utimesSync(lockPath, staleAt, staleAt);

    const result = withCtoRunLock(root, runId, () => {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "dead-owner");
      return "reclaimed";
    }, { timeoutMs: 1_000 });

    assert.equal(result, "reclaimed");
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(readdirSync(join(root, ".work-state", "cto", runId)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto transaction lock reclaims a regular owner left by a killed child", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-killed-owner-"));
  const runId = "killed-owner";
  const lockPath = lockPathFor(root, runId);
  const childScript = `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.LOCK_PATH, JSON.stringify({ pid: process.pid, token: "killed-child", acquired_at: new Date().toISOString() }));
    process.stdout.write("ready");
    process.stdin.resume();
  `;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child!.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("ready")) resolve();
      });
      child!.once("error", reject);
      child!.once("exit", (code, signal) => {
        if (!output.includes("ready")) reject(new Error(`child exited before publishing lock (${code ?? signal ?? "unknown"})`));
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    const result = withCtoRunLock(root, runId, () => "reclaimed", { timeoutMs: 1_000 });
    assert.equal(result, "reclaimed");
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});


test("async pinned CTO transaction lock yields while a same-run contender waits", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-pinned-async-"));
  const runId = "pinned-async-serialization";
  const firstPin = PinnedProjectRoot.open(root);
  const secondPin = PinnedProjectRoot.open(root);
  assert.ok(firstPin);
  assert.ok(secondPin);
  const events: string[] = [];
  try {
    const started = Date.now();
    const first = withCtoRunLockAsync(root, runId, async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      events.push("first:end");
      return "first";
    }, { pinnedRoot: firstPin, timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withCtoRunLockAsync(root, runId, async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    }, { pinnedRoot: secondPin, timeoutMs: 1_000 });
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
    assert.ok(Date.now() - started < 5_000, "pinned contender must remain within the bounded Darwin helper budget");
  } finally {
    firstPin.close();
    secondPin.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("async pinned CTO transaction lock rejects a root swap before callback", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lock-pinned-swap-"));
  const outside = mkdtempSync(join(tmpdir(), "cto-lock-pinned-outside-"));
  const moved = root + ".opened";
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    renameSync(root, moved);
    symlinkSync(outside, root, "dir");
    await assert.rejects(
      withCtoRunLockAsync(root, "pinned-root-swap", async () => "unexpected", { pinnedRoot: pinned, timeoutMs: 200 }),
      /pinned project root changed|transaction lock unavailable/i,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    pinned.close();
    rmSync(root, { recursive: true, force: true });
    renameSync(moved, root);
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
