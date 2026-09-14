import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CtoRuntimeAccessError } from "../src/cto/runtime-access.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { CtoAuthorityUnavailableError, findActiveCtoRun } from "../src/commands/cto.js";
import { CTO_RUN_DELIVERY_INDEX_FILE, ctoRuntimeRunInitialIdentityDigest, newCtoState, readCtoState } from "../src/cto/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-standby-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function openAccess(root: string) {
  const runtime = openTestCtoRuntime(root, "main-session", "cto-runtime-standby-test");
  return { runtime, access: runtime.access };
}

test("ensureStandbyRun reuses the active standby and serializes concurrent callers", async () => {
  const root = makeProject();
  try {
    const { runtime, access } = openAccess(root);
    const first = access.ensureStandbyRun();
    assert.match(first, /^standby-[0-9]+-[0-9a-f]{8}$/u);
    const second = access.ensureStandbyRun();
    assert.equal(second, first);
    const state = readCtoState(first, root);
    assert.ok(state);
    assert.equal(state!.standby, true);
    assert.equal(state!.autonomous, true);
    assert.deepEqual(state!.pause, { kind: "none", reason: "standby" });
    assert.equal(access.findActiveRun()?.runId, first);

    const concurrent = await Promise.all([
      Promise.resolve().then(() => access.ensureStandbyRun()),
      Promise.resolve().then(() => access.ensureStandbyRun()),
      Promise.resolve().then(() => access.ensureStandbyRun()),
    ]);
    assert.deepEqual(concurrent, [first, first, first]);
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureStandbyRun rolls back candidate directories and rejects a swapped root", () => {
  const root = makeProject();
  try {
    const { runtime, access } = openAccess(root);
    const prototype = PinnedProjectRoot.prototype as unknown as {
      writeExclusive: (relativeFile: string, content: unknown) => void;
    };
    const originalWriteExclusive = prototype.writeExclusive;
    prototype.writeExclusive = function (relativeFile: string, content: unknown) {
      if (relativeFile.endsWith("/state.json")) {
        const error = new Error("injected state publication failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalWriteExclusive.call(this, relativeFile, content as never);
    };
    try {
      assert.throws(() => access.ensureStandbyRun(), /injected state publication failure/u);
    } finally {
      prototype.writeExclusive = originalWriteExclusive;
    }
    const ctoRoot = join(root, ".work-state", "cto");
    const leftovers = readdirSync(ctoRoot, { withFileTypes: true }).filter((entry) => entry.name.startsWith("standby-") && entry.isDirectory());
    assert.equal(leftovers.length, 1, "failed publication retains only the authenticated origin evidence for recovery");
    const orphanDirectory = join(ctoRoot, leftovers[0]!.name);
    assert.equal(existsSync(join(orphanDirectory, ".runtime-origin-proof.json")), true);
    assert.equal(existsSync(join(orphanDirectory, "state.json")), false);
    assert.equal(existsSync(join(orphanDirectory, "inbox")), false);
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const swappedRoot = makeProject();
  const oldRoot = `${swappedRoot}.old`;
  try {
    const { runtime, access } = openAccess(swappedRoot);
    renameSync(swappedRoot, oldRoot);
    mkdirSync(swappedRoot);
    mkdirSync(join(swappedRoot, ".omp"));
    writeFileSync(join(swappedRoot, ".omp", "fullstack.activation.json"), MARKER);
    assert.throws(
      () => access.ensureStandbyRun(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    assert.equal(existsSync(join(oldRoot, ".work-state", "cto")), false);
    runtime.close();
  } finally {
    rmSync(swappedRoot, { recursive: true, force: true });
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

test("ensureStandbyRun rejects marker removal and cannot be used after revocation", () => {
  const root = makeProject();
  try {
    const { runtime, access } = openAccess(root);
    unlinkSync(join(root, ".omp-test-registry-marker"));
    assert.throws(
      () => access.ensureStandbyRun(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    assert.throws(
      () => access.ensureStandbyRun(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("ensureStandbyRun recovers one authenticated orphan and leaves multiple active runs unchanged", () => {
  const root = makeProject();
  try {
    const seed = openAccess(root);
    const createOrphan = (runId: string) => {
      const candidate = newCtoState({
        id: runId,
        task: "standby — awaiting inbox tasks",
        branch: "",
        autonomous: true,
        plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: new Date().toISOString() },
        standby: true,
      });
      candidate.pause = { kind: "none", reason: "standby" };
      const created = seed.access.createRun(candidate, {
        source_id: "runtime-access",
        initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(candidate),
      });
      assert.equal(created.id, runId);
    };
    createOrphan("orphan-one");
    seed.runtime.close();

    const consumer = openAccess(root);
    try {
      const recovered = consumer.access.ensureStandbyRun();
      assert.equal(recovered, "orphan-one");
      assert.equal(readCtoState(recovered, root)?.standby, true);
      assert.equal(existsSync(join(root, ".work-state", "cto", recovered, ".runtime-state-proof.json")), true);
    } finally {
      consumer.runtime.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }

  const multiRoot = makeProject();
  try {
    const seed = openAccess(multiRoot);
    const createOrphan = (runId: string) => {
      const candidate = newCtoState({ id: runId, task: "standby — awaiting inbox tasks", branch: "", autonomous: true, plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: new Date().toISOString() }, standby: true });
      candidate.pause = { kind: "none", reason: "standby" };
      const created = seed.access.createRun(candidate, { source_id: "runtime-access", initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(candidate) });
      assert.equal(created.id, runId);
    };
    createOrphan("orphan-a");
    createOrphan("orphan-b");
    seed.runtime.close();

    const consumer = openAccess(multiRoot);
    try {
      const ctoRoot = join(multiRoot, ".work-state", "cto");
      const before = readdirSync(ctoRoot).sort();
      const beforeIndex = readFileSync(join(ctoRoot, CTO_RUN_DELIVERY_INDEX_FILE));
      assert.equal(consumer.access.ensureStandbyRun(), "orphan-b");
      assert.deepEqual(readdirSync(ctoRoot).sort(), before);
      assert.deepEqual(readFileSync(join(ctoRoot, CTO_RUN_DELIVERY_INDEX_FILE)), beforeIndex);
    } finally {
      consumer.runtime.close();
    }
  } finally { rmSync(multiRoot, { recursive: true, force: true }); }
});

test("ensureStandbyRun fails closed when active discovery is temporarily unavailable", () => {
  const root = makeProject();
  try {
    const active = newCtoState({
      id: "existing-active",
      task: "existing active run",
      branch: "main",
      autonomous: false,
      owner_session: "main-session",
      plan: { id: "existing-active", task: "existing active run", teams: [], created_at: "" },
    });
    const { runtime, access } = openAccess(root);
    access.createRun(active, { source_id: "runtime-standby-test", initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(active) });
    const ctoRoot = join(root, ".work-state", "cto");
    const indexPath = join(ctoRoot, CTO_RUN_DELIVERY_INDEX_FILE);
    const statePath = join(ctoRoot, active.id, "state.json");
    const beforeDirs = readdirSync(ctoRoot).sort();
    const beforeIndex = readFileSync(indexPath);
    const beforeState = readFileSync(statePath);
    const prototype = PinnedProjectRoot.prototype as unknown as { readFile: (relativeFile: string, options?: { maxBytes?: number }) => { bytes: Uint8Array; dev: number; ino: number } };
    const originalReadFile = prototype.readFile;
    let blocked = 0;
    prototype.readFile = function (relativeFile, options) {
      if (relativeFile.endsWith(CTO_RUN_DELIVERY_INDEX_FILE) && blocked < 2) {
        blocked += 1;
        throw new Error("transient delivery authority outage");
      }
      return originalReadFile.call(this, relativeFile, options);
    };
    try {
      assert.throws(() => findActiveCtoRun(root), (error: unknown) => error instanceof CtoAuthorityUnavailableError && error.code === "CTO_AUTHORITY_UNAVAILABLE");
      assert.throws(() => access.ensureStandbyRun(), (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid" && error.message.includes("canonical CTO delivery authority is unavailable"));
      assert.equal(access.ensureStandbyRun(), active.id, "a valid active run is reused after authority recovery");
    } finally {
      prototype.readFile = originalReadFile;
      runtime.close();
      }
    assert.equal(blocked, 2);
    assert.deepEqual(readdirSync(ctoRoot).sort(), beforeDirs, "authority outage must not create a standby directory or rewrite its authenticated index");
    assert.deepEqual(readFileSync(indexPath), beforeIndex, "authority outage must not rewrite the delivery index");
    assert.deepEqual(readFileSync(statePath), beforeState, "authority outage must not rewrite the active state");
    assert.equal(readCtoState(active.id, root)?.id, active.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
