import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import childProcess, { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { PinnedProjectRoot, PinnedRootError, processStartIdentity } from "../src/specification/pinned-root.js";
import { setStateTransactionTestHooks, updateStateAtomically } from "../src/engine/state.js";
import { captureWorkspaceRoot, createFeatureWorkspace } from "../src/specification/workspace.js";

type MigrationApi = {
  migrateLegacySpecificationWorkspace(input: Record<string, unknown>): {
    status: string;
    receipt: { diagnostics: Array<{ code: string }> };
  };
  setMigrationTestHooks(hooks: Record<string, (path: string, root: unknown) => void> | null): void;
};

const seams = ["beforeDirectoryCreate", "beforeTempOpen", "beforeRename", "beforeCleanup"] as const;
const ENSURE_CHILD_SCRIPT = String.raw`
const fs = await import("node:fs");
const { join, basename, dirname } = await import("node:path");
const { PinnedProjectRoot } = await import("./src/specification/pinned-root.js");
const [root, barrier, mode, outside] = process.argv.slice(1);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const marker = (name) => barrier + "." + name;
const waitFor = (predicate) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("ensure-directory child barrier timed out");
    Atomics.wait(waitCell, 0, 0, 5);
  }
};
const ownMarker = barrier + "." + mode + "." + process.pid;
if (mode === "attacker") {
  fs.writeFileSync(ownMarker, "");
  waitFor(() => fs.existsSync(marker("ensure-ready")));
  fs.symlinkSync(outside, join(root, "shared", "dir"), "dir");
  fs.writeFileSync(marker("attacker-done"), "");
  process.exit(0);
}
const hooks = mode === "race"
  ? {
      beforeDirectoryCreate: () => {
        fs.writeFileSync(ownMarker, "");
        waitFor(() => fs.readdirSync(dirname(barrier)).filter((name) => name.startsWith(basename(barrier) + ".race.")).length >= 2);
      },
    }
  : {
      beforeDirectoryCreate: () => {
        fs.writeFileSync(marker("ensure-ready"), "");
        waitFor(() => fs.existsSync(marker("attacker-done")));
      },
    };
const pinned = PinnedProjectRoot.open(root, hooks);
if (!pinned) throw new Error("child could not open pinned root");
try {
  try {
    pinned.ensureDirectory("shared/dir");
    if (mode === "symlink") process.exit(11);
  } catch (error) {
    if (mode === "symlink" && error && error.code === "path_unauthorized") process.exit(0);
    throw error;
  }
} finally {
  pinned.close();
}
`;

function runEnsureChild(root: string, barrier: string, mode: "race" | "symlink" | "attacker", outside?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", ENSURE_CHILD_SCRIPT, root, barrier, mode, outside ?? ""], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ensure-directory child ${mode} exited ${code ?? signal}: ${stderr}`));
    });
  });
}

const STARTUP_CHILD_SCRIPT = String.raw`
const { PinnedProjectRoot } = await import("./src/specification/pinned-root.js");
const [root, roundsText] = process.argv.slice(1);
const rounds = Number(roundsText);
for (let index = 0; index < rounds; index += 1) {
  const pinned = PinnedProjectRoot.open(root);
  if (!pinned) throw new Error("startup child could not open pinned root");
  try {
    if (!pinned.pathEntryExists("startup-marker")) throw new Error("startup marker missing");
  } finally {
    pinned.close();
  }
}
`;

function runStartupChild(root: string, rounds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", STARTUP_CHILD_SCRIPT, root, String(rounds)], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`startup child exited ${code ?? signal}: ${stderr}`));
    });
  });
}

function legacyBody(): string {
  return JSON.stringify({
    schema: 1,
    feature_id: "pinned-race",
    run_key: "run-pinned-race",
    workflow: "spec-preparation",
    branch: "feature/pinned-race",
    status: "done",
    stages: [
      { id: "specify", status: "done" },
      { id: "plan", status: "done" },
      { id: "tasks", status: "done" },
    ],
    artifacts: {
      specify: "artifacts/specify.json",
      plan: "artifacts/plan.json",
      tasks: "artifacts/tasks.json",
    },
  }, null, 2) + "\n";
}

async function migrationApi(query: string): Promise<MigrationApi> {
  return (await import("../src/specification/migration.js?" + query)) as unknown as MigrationApi;
}

async function runMigration(api: MigrationApi, root: string, sourcePath: string) {
  return api.migrateLegacySpecificationWorkspace({
    project_root: root,
    legacy_state_path: sourcePath,
    current_constitution_binding: { version: "1.0.0", fingerprint: "0".repeat(64) },
  });
}

function restoreMoved(path: string, moved: string): void {
  try { fs.unlinkSync(path); } catch { }
  try { fs.renameSync(moved, path); } catch { }
}

test("Darwin helper startup publishes ready before concurrent multi-root requests", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "pinned-helper-startup-"));
  fs.writeFileSync(join(root, "startup-marker"), "ready\n");
  try {
    await Promise.all(Array.from({ length: 8 }, () => runStartupChild(root, 12)));
    let replacementReader: number | null = null;
    let replaced = false;
    const pinned = PinnedProjectRoot.open(root, {
      beforeDarwinHelperOpen: (channel, path) => {
        if (channel !== "request" || replaced) return;
        replaced = true;
        fs.renameSync(path, `${path}.original`);
        execFileSync("/usr/bin/mkfifo", [path]);
        fs.chmodSync(path, 0o600);
        replacementReader = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      },
    });
    assert.ok(pinned);
    try {
      assert.throws(() => pinned.pathEntryExists("missing.txt"), (error: unknown) => error instanceof PinnedRootError && error.code === "changed");
      assert.equal(replaced, true);
    } finally {
      await pinned.closeAsync();
      if (replacementReader !== null) fs.closeSync(replacementReader);
    }
    const writer = PinnedProjectRoot.open(root);
    assert.ok(writer);
    try {
      writer.writeAtomic("startup-load-large.bin", Buffer.alloc(7 * 1024 * 1024, 0x61));
      assert.equal(writer.pathEntryExists("startup-load-large.bin"), true);
    } finally {
      await writer.closeAsync();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned migration root swaps at every write seam never write outside", async () => {
  for (const seam of seams) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-seam-"));
    const outside = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-seam-outside-"));
    const sourcePath = join(root, "legacy.json");
    const movedRoot = root + ".opened";
    let swapped = false;
    try {
      await fsPromises.writeFile(sourcePath, legacyBody(), "utf8");
      const api = await migrationApi("pinned-root-" + seam);
      api.setMigrationTestHooks({
        [seam]: () => {
          if (swapped) return;
          swapped = true;
          fs.renameSync(root, movedRoot);
          fs.symlinkSync(outside, root, "dir");
        },
      });
      const result = await runMigration(api, root, sourcePath);
      assert.ok(result.status === "blocked" || result.status === "current");
      assert.deepEqual(fs.readdirSync(outside), [], seam + " must not write through a rebound root");
      api.setMigrationTestHooks(null);
    } finally {
      if (swapped) restoreMoved(root, movedRoot);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(movedRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("pinned migration rejects ancestor symlink swaps at every write seam", async () => {
  for (const seam of seams) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-ancestor-"));
    const outside = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-ancestor-outside-"));
    const sourcePath = join(root, "legacy.json");
    const specs = join(root, "specs");
    const specsMoved = join(root, "specs.opened");
    const state = join(root, ".work-state");
    const stateMoved = join(root, ".work-state.opened");
    let swapped = false;
    try {
      fs.mkdirSync(specs);
      await fsPromises.writeFile(sourcePath, legacyBody(), "utf8");
      const api = await migrationApi("pinned-ancestor-" + seam);
      api.setMigrationTestHooks({
        [seam]: () => {
          if (swapped) return;
          swapped = true;
          const path = seam === "beforeDirectoryCreate" ? specs : state;
          const moved = seam === "beforeDirectoryCreate" ? specsMoved : stateMoved;
          fs.renameSync(path, moved);
          fs.symlinkSync(outside, path, "dir");
        },
      });
      const result = await runMigration(api, root, sourcePath);
      assert.ok(result.status === "blocked" || result.status === "current");
      assert.deepEqual(fs.readdirSync(outside), [], seam + " must not write through a rebound ancestor");
      api.setMigrationTestHooks(null);
    } finally {
      if (swapped) {
        const path = seam === "beforeDirectoryCreate" ? specs : state;
        const moved = seam === "beforeDirectoryCreate" ? specsMoved : stateMoved;
        restoreMoved(path, moved);
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});


test("pinned state accepts a lexical project-root alias when identity matches", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-alias-"));
  try {
    const featureId = "pinned-alias";
    const created = createFeatureWorkspace(root, {
      feature_id: featureId,
      display_name: "Pinned alias",
      run_key: "run-pinned-alias",
      profile_name: "spec-preparation",
      profile_hash: "a".repeat(64),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { specification: { project_root: string } };
    // Keep the lexical spelling in the aggregate; on Darwin this is the
    // /var alias while the descriptor's canonical spelling is /private/var.
    persisted.specification.project_root = root;
    fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2) + "\n", "utf8");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try {
      const result = updateStateAtomically(
        root,
        (snapshot) => ({ op: "discard" as const, value: snapshot.state }),
        { selector: { feature_id: featureId, run_key: "run-pinned-alias" }, pinnedRoot: pinned, rootGuard: pinned },
      );
      assert.equal(result.ok, true, result.ok ? "alias accepted" : result.error);
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned state rejects a project-root path replaced by another inode", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-inode-"));
  const moved = root + ".moved";
  const replacement = root + ".replacement";
  try {
    const featureId = "pinned-inode";
    const created = createFeatureWorkspace(root, {
      feature_id: featureId,
      display_name: "Pinned inode",
      run_key: "run-pinned-inode",
      profile_name: "spec-preparation",
      profile_hash: "b".repeat(64),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { specification: { project_root: string } };
    // Point the aggregate at a separate path whose inode can be replaced
    // while the original pinned descriptor remains stable.
    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    fs.writeFileSync(join(root, "marker"), "replacement\n", "utf8");
    persisted.specification.project_root = root;
    fs.mkdirSync(join(moved, ".work-state", "features", featureId), { recursive: true });
    fs.writeFileSync(join(moved, ".work-state", "features", featureId, "state.json"), JSON.stringify(persisted, null, 2) + "\n", "utf8");
    const pinned = PinnedProjectRoot.open(moved);
    assert.ok(pinned);
    try {
      // The cwd points at the replacement path; the borrowed pin still names
      // the original inode, so the aggregate root must be rejected.
      const result = updateStateAtomically(
        root,
        (snapshot) => ({ op: "discard" as const, value: snapshot.state }),
        { selector: { feature_id: featureId, run_key: "run-pinned-inode" }, pinnedRoot: pinned, rootGuard: pinned },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "state_invalid");
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(replacement, { recursive: true, force: true });
  }
});

test("pinned state batches validate every target and roll back before commit", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-batch-"));
  const outside = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-batch-outside-"));
  try {
    const outsideTarget = join(outside, "outside.txt");
    const linkedTarget = join(root, "unsafe-link");
    await fsPromises.writeFile(outsideTarget, "outside bytes\n", "utf8");
    fs.symlinkSync(outsideTarget, linkedTarget, "file");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try {
      assert.throws(
        () => pinned.writeAtomicFiles([
          { path: "first.txt", content: "first bytes\n" },
          { path: "unsafe-link", content: "must not follow\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "path_unauthorized",
      );
      assert.equal(fs.existsSync(join(root, "first.txt")), false, "a later validation failure must not leave an earlier target committed");
      assert.equal(fs.readFileSync(outsideTarget, "utf8"), "outside bytes\n", "a failed batch never follows the unsafe target");
      assert.throws(
        () => pinned.writeAtomicFiles([{ path: "../escape.txt", content: "escape\n" }]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "path_unauthorized",
      );
      assert.equal(fs.existsSync(join(root, "escape.txt")), false);
      assert.throws(
        () => pinned.writeAtomicFiles(Array.from({ length: 9 }, (_, index) => ({ path: `too-many-${index}.txt`, content: "bounded\n" }))),
        (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
      );
      assert.equal(fs.existsSync(join(root, "too-many-0.txt")), false, "over-budget operation batches fail before mutation");
      assert.throws(
        () => pinned.writeAtomicFiles([{ path: "too-large.txt", content: "x".repeat(8 * 1024 * 1024 + 1) }]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
      );
      assert.equal(fs.existsSync(join(root, "too-large.txt")), false, "over-budget byte batches fail before mutation");
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("pinned state batches roll back existing and newly created targets at every commit failure", async () => {
  for (const failureIndex of [0, 1, 2]) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-batch-rollback-${failureIndex}-`));
    try {
      await fsPromises.writeFile(join(root, "a.txt"), "old-a\n", "utf8");
      await fsPromises.writeFile(join(root, "b.txt"), "old-b\n", "utf8");
      const pinned = PinnedProjectRoot.open(root, { batchFailureIndex: failureIndex });
      assert.ok(pinned);
      try {
        assert.throws(
          () => pinned.writeAtomicFiles([
            { path: "a.txt", content: "new-a\n" },
            { path: "b.txt", content: "new-b\n" },
            { path: "c.txt", content: "new-c\n" },
          ]),
          (error: unknown) => error instanceof PinnedRootError && error.code === "write_failed",
        );
      } finally {
        pinned.close();
      }
      assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "old-a\n", `failure ${failureIndex} must restore the first existing target`);
      assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "old-b\n", `failure ${failureIndex} must restore the second existing target`);
      assert.equal(fs.existsSync(join(root, "c.txt")), false, `failure ${failureIndex} must delete a newly created target`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("portable atomic batches preserve an interloper and roll back earlier commits", async () => {
  if (process.platform === "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-batch-race-"));
  try {
    await fsPromises.writeFile(join(root, "a.txt"), "old-a\n", "utf8");
    await fsPromises.writeFile(join(root, "b.txt"), "old-b\n", "utf8");
    let raced = false;
    const pinned = PinnedProjectRoot.open(root, {
      beforeRename: (path) => {
        if (path === "b.txt" && !raced) {
          raced = true;
          fs.writeFileSync(join(root, "b.txt"), "concurrent winner\n", "utf8");
        }
      },
    });
    assert.ok(pinned);
    try {
      assert.throws(
        () => pinned.writeAtomicFiles([
          { path: "a.txt", content: "new-a\n" },
          { path: "b.txt", content: "new-b\n" },
          { path: "c.txt", content: "new-c\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "old-a\n", "earlier commits must roll back");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "concurrent winner\n", "rollback must not overwrite an interloper");
    assert.equal(fs.existsSync(join(root, "c.txt")), false, "later targets must remain absent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portable batch-create rollback quarantines an owned postimage without deleting a winner", () => {
  const originalPlatform = process.platform;
  const root =  fs.mkdtempSync(join(tmpdir(), "spec-pinned-portable-quarantine-"));
  let raced = false;
  try {
    const pinned = PinnedProjectRoot.open(root, {
      beforeRename: (path) => {
        if (path === "b.txt" && !raced) {
          raced = true;
          fs.writeFileSync(join(root, "b.txt"), "concurrent winner\n", "utf8");
        }
      },
    });
    assert.ok(pinned);
    if (!pinned) return;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const portable = pinned as unknown as {
      writeAtomicFilesPortable: (entries: readonly { path: string; content: string }[]) => unknown;
      parentDirectoryPath: (fd: number, relativeDirectory: string) => string;
    };
    portable.parentDirectoryPath = () => root;
    try {
      assert.throws(
        () => portable.writeAtomicFilesPortable([
          { path: "a.txt", content: "new-a\n" },
          { path: "b.txt", content: "new-b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "concurrent winner\n");
    assert.equal(fs.existsSync(join(root, "a.txt")), false, "the raced rollback target must not remain canonical");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-batch-quarantine-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 1, "the owned postimage must be retained in one quarantine entry");
    assert.equal(fs.readFileSync(join(root, quarantined[0]!), "utf8"), "new-a\n");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic batches retain the caller's state authority order", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-batch-order-"));
  try {
    const renameOrder: string[] = [];
    const pinned = PinnedProjectRoot.open(root, {
      beforeRename: (path) => renameOrder.push(path),
    });
    assert.ok(pinned);
    try {
      pinned.writeAtomicFiles([
        { path: "state.json", content: "state\n" },
        { path: "state.md", content: "mirror\n" },
        { path: "active-feature", content: "feature\n" },
      ]);
    } finally {
      pinned.close();
    }
    assert.deepEqual(renameOrder, ["state.json", "state.md", "active-feature"]);
    assert.equal(fs.readFileSync(join(root, "state.json"), "utf8"), "state\n");
    assert.equal(fs.readFileSync(join(root, "state.md"), "utf8"), "mirror\n");
    assert.equal(fs.readFileSync(join(root, "active-feature"), "utf8"), "feature\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned state batches fail closed when the Darwin helper is unavailable", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-batch-disabled-"));
  try {
    const pinned = PinnedProjectRoot.open(root, { disableDarwinHelper: true });
    assert.ok(pinned);
    try {
      if (process.platform === "darwin") {
        assert.throws(
          () => pinned.writeAtomicFiles([{ path: "state.json", content: "must not write\n" }]),
          (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported",
        );
        assert.equal(fs.existsSync(join(root, "state.json")), false);
      }
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin helper timeout kills a sleeping child without leaving it behind", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-helper-timeout-"));
  try {
    fs.writeFileSync(join(root, "target.txt"), "real target\n", "utf8");
    const pinned = PinnedProjectRoot.open(root, { helperSleepMs: 250, helperTimeoutMs: 50 });
    assert.ok(pinned);
    const started = Date.now();
    try {
      assert.throws(
        () => pinned.readFile("target.txt"),
        (error: unknown) => error instanceof PinnedRootError
          && error.code === "unsupported"
          && /descriptor helper 'read' timed out/u.test(error.message),
      );
    } finally {
      await pinned.closeAsync();
    }
    assert.ok(Date.now() - started < 1000, "helper timeout must not wait for the injected sleep");
    let lingering = "";
    try {
      lingering = execFileSync("pgrep", ["-P", String(process.pid), "-f", "python3.*-c"], "utf8").trim();
    } catch {
      // pgrep exits 1 when no matching child remains.
    }
    assert.equal(lingering, "", "timed-out helper must not remain as a child process");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("descriptor-anchored ensureDirectory is idempotent across two processes", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-ensure-race-"));
  const barrier = join(root, "ensure-barrier");
  try {
    await Promise.all([
      runEnsureChild(root, barrier, "race"),
      runEnsureChild(root, barrier, "race"),
    ]);
    assert.equal(fs.lstatSync(join(root, "shared", "dir")).isDirectory(), true);
    assert.equal(fs.lstatSync(join(root, "shared", "dir")).isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor-anchored ensureDirectory rejects a concurrent hostile symlink", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-ensure-symlink-"));
  const outside = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-ensure-symlink-outside-"));
  const barrier = join(root, "ensure-barrier");
  try {
    fs.mkdirSync(join(root, "shared"));
    await Promise.all([
      runEnsureChild(root, barrier, "symlink", outside),
      runEnsureChild(root, barrier, "attacker", outside),
    ]);
    assert.equal(fs.lstatSync(join(root, "shared", "dir")).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});


test("conditional pinned CAS preserves a concurrent winner", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-cas-winner-"));
  const displaced = join(root, "document.old");
  try {
    const target = join(root, "document.md");
    await fsPromises.writeFile(target, "old bytes\n", "utf8");
    const observed = PinnedProjectRoot.open(root);
    assert.ok(observed);
    let read = observed.readFile("document.md");
    const expected = {
      dev: read.dev,
      ino: read.ino,
      sha256: createHash("sha256").update(read.bytes).digest("hex"),
    };
    observed.close();

    const raced = PinnedProjectRoot.open(root, {
      beforeConditionalCommit: () => {
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, "concurrent winner\n", "utf8");
      },
    });
    assert.ok(raced);
    try {
      assert.throws(
        () => raced.replaceFileIfMatches("document.md", expected, "replacement\n"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      raced.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), "concurrent winner\n");
    assert.equal(fs.readFileSync(displaced, "utf8"), "old bytes\n");

    await fsPromises.writeFile(target, "old remove bytes\n", "utf8");
    const removeObserved = PinnedProjectRoot.open(root);
    assert.ok(removeObserved);
    read = removeObserved.readFile("document.md");
    const removeExpected = {
      dev: read.dev,
      ino: read.ino,
      sha256: createHash("sha256").update(read.bytes).digest("hex"),
    };
    removeObserved.close();
    const removeRaced = PinnedProjectRoot.open(root, {
      beforeConditionalCommit: () => {
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, "remove winner\n", "utf8");
      },
    });
    assert.ok(removeRaced);
    try {
      assert.throws(
        () => removeRaced.removeFileIfMatches("document.md", removeExpected),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      removeRaced.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), "remove winner\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional replacement quarantines a post-exchange mismatch and releases the same-session lease", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-recovery-"));
  const hooks: { conditionalPostExchangeMutation?: boolean } = { conditionalPostExchangeMutation: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old postimage content\n";
    const newContent = "new postimage content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.replaceFileIfMatches("document.md", expected, newContent),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required"
      );
      hooks.conditionalPostExchangeMutation = false;
      pinned.replaceFileIfMatches("document.md", expected, newContent);
    } finally {
      pinned.close();
    }
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release only its own conditional lease");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 1, "the displaced preimage must have one operation-unique recovery artifact");
    assert.equal(fs.readFileSync(target, "utf8"), newContent, "a clean same-session retry must republish the desired target");
    assert.notEqual(fs.readFileSync(join(root, quarantined[0]!), "utf8"), oldContent, "the mutated postimage must remain in quarantine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional replacement quarantines a stage-only mismatch without replacing the desired target", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-stage-recovery-"));
  const hooks: { conditionalPostExchangeStageMutation?: boolean } = { conditionalPostExchangeStageMutation: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old stage content\n";
    const newContent = "new stage content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.replaceFileIfMatches("document.md", expected, newContent),
        (error: unknown) => error instanceof PinnedRootError
          && error.code === "recovery_required"
      );
      hooks.conditionalPostExchangeStageMutation = false;
      assert.throws(
        () => pinned.replaceFileIfMatches("document.md", expected, newContent),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
        "a same-session retry must reach the target comparison instead of a stale helper lease",
      );
    } finally {
      pinned.close();
    }
    assert.notEqual(fs.readFileSync(target, "utf8"), newContent, "the mutated displaced preimage must be restored canonically");
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release its own lease");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 1, "the desired bytes must have one recovery artifact");
    const artifact = fs.readFileSync(join(root, quarantined[0]!), "utf8");
    assert.equal(artifact, newContent, "the desired bytes must be quarantined rather than overwrite a changed preimage");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("conditional replacement restores a target mutated before atomic exchange", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-preimage-recovery-"));
  const hooks: { conditionalPreExchangeMutation?: boolean } = { conditionalPreExchangeMutation: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old pre-exchange content\n";
    const newContent = "new pre-exchange content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.replaceFileIfMatches("document.md", expected, newContent),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
      hooks.conditionalPreExchangeMutation = false;
      assert.throws(
        () => pinned.replaceFileIfMatches("document.md", expected, newContent),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
        "a retry must observe the canonically restored mutated preimage",
      );
    } finally {
      pinned.close();
    }
    assert.notEqual(fs.readFileSync(target, "utf8"), oldContent, "the target mutation must not be discarded");
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release its lease");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 1, "the exchanged desired postimage must be quarantined");
    assert.equal(fs.readFileSync(join(root, quarantined[0]!), "utf8"), newContent);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional replacement restores a stage mutated before atomic exchange", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-stage-pre-recovery-"));
  const hooks: { conditionalStagePreExchangeMutation?: boolean } = { conditionalStagePreExchangeMutation: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old stage pre-exchange content\n";
    const newContent = "new stage pre-exchange content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.replaceFileIfMatches("document.md", expected, newContent),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
      hooks.conditionalStagePreExchangeMutation = false;
      pinned.replaceFileIfMatches("document.md", expected, newContent);
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), newContent, "a clean retry must publish the requested bytes");
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release its lease");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 1, "the mutated stage must be quarantined");
    assert.notEqual(fs.readFileSync(join(root, quarantined[0]!), "utf8"), newContent);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional removal quarantines a stage-only mismatch without restoring the target", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-remove-stage-recovery-"));
  const hooks: { conditionalPostExchangeStageMutation?: boolean } = { conditionalPostExchangeStageMutation: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old remove stage content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.removeFileIfMatches("document.md", expected),
        (error: unknown) => error instanceof PinnedRootError
          && error.code === "recovery_required"
      );
      hooks.conditionalPostExchangeStageMutation = false;
      assert.throws(
        () => pinned.removeFileIfMatches("document.md", expected),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
        "a same-session retry must observe the canonical mutated winner",
      );
    } finally {
      pinned.close();
    }
    assert.notEqual(fs.readFileSync(target, "utf8"), oldContent, "the mutated winner must be restored canonically");
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release its own lease");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 0, "an uncontended moved winner needs no quarantine artifact");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace creation rolls back owned directories after a stable state publication failure", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-workspace-create-rollback-"));
  const featureId = "stable-create-failure";
  const runKey = "run-stable-create-failure";
  const input = {
    feature_id: featureId,
    display_name: "Stable create failure",
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: "f".repeat(64),
  };
  try {
    setStateTransactionTestHooks({ afterTargetResolution: () => { throw new Error("injected stable publication failure"); } }, root);
    const failed = createFeatureWorkspace(root, input);
    assert.equal(failed.ok, false, failed.ok ? "injected publication failure must reject creation" : failed.error);
    setStateTransactionTestHooks(null, root);
    assert.equal(fs.existsSync(join(root, "specs", featureId)), false, "failed creation must remove the owned workspace directory");
    assert.equal(fs.existsSync(join(root, ".work-state", "features", featureId)), false, "failed creation must remove the owned feature state directory");
    assert.equal(fs.existsSync(join(root, ".work-state", ".active-feature")), false, "failed creation must not publish an active-feature pointer");
    assert.equal(fs.existsSync(join(root, ".work-state", "features", featureId, "state.json")), false, "failed creation must not leave state authority behind");
    const retried = createFeatureWorkspace(root, input);
    assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
    assert.equal(fs.existsSync(join(root, ".work-state", "features", featureId, "state.json")), true, "a clean retry must create canonical state");
  } finally {
    setStateTransactionTestHooks(null, root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state batch failures roll back authority as a unit", async () => {
  for (const failureIndex of [0, 1, 2]) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-batch-crash-${failureIndex}-`));
    try {
      const featureId = `batch-crash-${failureIndex}`;
      const runKey = `run-batch-crash-${failureIndex}`;
      const created = createFeatureWorkspace(root, {
        feature_id: featureId,
        display_name: "Before batch failure",
        run_key: runKey,
        profile_name: "spec-preparation",
        profile_hash: "c".repeat(64),
      });
      assert.equal(created.ok, true);
      if (!created.ok) continue;
      const statePath = join(root, ".work-state", "features", featureId, "state.json");
      const mirrorPath = join(root, ".work-state", "features", featureId, "team-state.md");
      const pointerPath = join(root, ".work-state", ".active-feature");
      const oldState = fs.readFileSync(statePath, "utf8");
      const oldMirror = fs.readFileSync(mirrorPath, "utf8");
      const oldPointer = fs.readFileSync(pointerPath, "utf8");
      const pinned = PinnedProjectRoot.open(root, { batchFailureIndex: failureIndex });
      assert.ok(pinned);
      try {
        const result = updateStateAtomically(
          root,
          (snapshot) => {
            if (!snapshot.state?.specification) {
              return { op: "fail" as const, code: "state_invalid" as const, error: "specification is missing" };
            }
            const next = structuredClone(snapshot.state);
            next.specification.display_name = "After batch failure";
            return { op: "commit" as const, state: next, value: failureIndex };
          },
          { selector: { feature_id: featureId, run_key: runKey }, pinnedRoot: pinned, rootGuard: pinned },
        );
        assert.equal(result.ok, false, `batch failure ${failureIndex} must reject the transaction`);
        if (!result.ok) assert.equal(result.code, "state_invalid");
      } finally {
        pinned.close();
      }
      assert.equal(fs.readFileSync(statePath, "utf8"), oldState, `failure ${failureIndex} must restore state.json`);
      assert.equal(fs.readFileSync(mirrorPath, "utf8"), oldMirror, `failure ${failureIndex} must restore team-state.md`);
      assert.equal(fs.readFileSync(pointerPath, "utf8"), oldPointer, `failure ${failureIndex} must restore active-feature`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("legacy state publication removes only the captured active pointer", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-active-pointer-cas-"));
  try {
    const created = createFeatureWorkspace(root, {
      feature_id: "pointer-source",
      display_name: "Pointer source",
      run_key: "pointer-source-run",
      profile_name: "spec-preparation",
      profile_hash: "e".repeat(64),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const featureStatePath = join(root, ".work-state", "features", "pointer-source", "state.json");
    const legacyStatePath = join(root, ".work-state", "team-state.json");
    const legacyMirrorPath = join(root, ".work-state", "team-state.md");
    const pointerPath = join(root, ".work-state", ".active-feature");
    fs.copyFileSync(featureStatePath, legacyStatePath);
    fs.copyFileSync(join(root, ".work-state", "features", "pointer-source", "team-state.md"), legacyMirrorPath);
    let interposed = false;
    const pinned = PinnedProjectRoot.open(root, {
      beforeCleanup: (relativePath) => {
        if (interposed || !relativePath.endsWith("team-state.md")) return;
        interposed = true;
        fs.unlinkSync(pointerPath);
        fs.writeFileSync(pointerPath, "replacement-pointer\n", "utf8");
      },
    });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const target = {
        state: null,
        statePath: legacyStatePath,
        stateDir: join(root, ".work-state"),
        artifactsDir: join(root, ".work-state", "artifacts"),
        isLegacy: true,
        isStale: false,
      };
      const result = updateStateAtomically(
        root,
        (snapshot) => {
          const next = structuredClone(snapshot.state) as any;
          next.specification.display_name = "Legacy pointer update";
          return { op: "commit" as const, state: next, value: null };
        },
        { target, pinnedRoot: pinned, rootGuard: pinned },
      );
      assert.equal(result.ok, true);
    } finally {
      pinned.close();
    }
    assert.equal(interposed, true);
    assert.equal(fs.readFileSync(pointerPath, "utf8"), "replacement-pointer\n", "a concurrent pointer replacement must survive cleanup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state batch failure before state.json leaves authority untouched", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-batch-prestate-"));
  try {
    const featureId = "batch-prestate";
    const runKey = "run-batch-prestate";
    const created = createFeatureWorkspace(root, {
      feature_id: featureId,
      display_name: "Before pre-state failure",
      run_key: runKey,
      profile_name: "spec-preparation",
      profile_hash: "d".repeat(64),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const mirrorPath = join(root, ".work-state", "features", featureId, "team-state.md");
    const oldState = fs.readFileSync(statePath, "utf8");
    const oldMirror = fs.readFileSync(mirrorPath, "utf8");
    const pinned = PinnedProjectRoot.open(root, { beforeTempOpen: () => { throw new Error("injected pre-state batch failure"); } });
    assert.ok(pinned);
    try {
      const result = updateStateAtomically(
        root,
        (snapshot) => {
          const next = structuredClone(snapshot.state) as any;
          next.specification.display_name = "must not commit";
          return { op: "commit" as const, state: next, value: null };
        },
        { selector: { feature_id: featureId, run_key: runKey }, pinnedRoot: pinned, rootGuard: pinned },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "state_invalid");
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(statePath, "utf8"), oldState);
    assert.equal(fs.readFileSync(mirrorPath, "utf8"), oldMirror);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional CAS crash phases leave canonical old-or-new and replay", async () => {
  const phases = ["after_lock", "after_verification", "after_stage", "after_replace", "before_cleanup"] as const;
  for (const phase of phases) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-cas-crash-${phase}-`));
    try {
      const target = join(root, "document.md");
      const oldContent = "old conditional content\n";
      const newContent = "new conditional content\n";
      fs.writeFileSync(target, oldContent, "utf8");
      const before = fs.statSync(target);
      const expected = { dev: before.dev, ino: before.ino, sha256: createHash("sha256").update(oldContent).digest("hex") };
      const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: phase });
      assert.ok(failing);
      try {
        assert.throws(
          () => failing.replaceFileIfMatches("document.md", expected, newContent),
          (error: unknown) => error instanceof PinnedRootError,
        );
      } finally {
        failing.close();
      }
      assert.equal(fs.existsSync(target), true, `${phase} must not leave canonical target missing`);
      assert.equal(fs.readFileSync(target, "utf8"), phase === "after_replace" || phase === "before_cleanup" ? newContent : oldContent);

      const retry = PinnedProjectRoot.open(root);
      assert.ok(retry);
      try {
        retry.replaceFileIfMatches("document.md", expected, newContent);
      } finally {
        retry.close();
      }
      assert.equal(fs.readFileSync(target, "utf8"), newContent, `${phase} retry must converge to replacement`);
      assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false);
      assert.equal(fs.existsSync(join(root, ".document.md.cas.tmp")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("conditional removal crash phases leave canonical old-or-new and replay", async () => {
  const phases = ["after_lock", "after_verification", "after_stage", "after_replace", "before_cleanup"] as const;
  for (const phase of phases) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-remove-crash-${phase}-`));
    try {
      const target = join(root, "document.md");
      const oldContent = "old removable content\n";
      fs.writeFileSync(target, oldContent, "utf8");
      const before = fs.statSync(target);
      const expected = { dev: before.dev, ino: before.ino, sha256: createHash("sha256").update(oldContent).digest("hex") };
      const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: phase });
      assert.ok(failing);
      try {
        assert.throws(
          () => failing.removeFileIfMatches("document.md", expected),
          (error: unknown) => error instanceof PinnedRootError,
        );
      } finally {
        failing.close();
      }
      const removed = phase === "after_replace" || phase === "before_cleanup";
      assert.equal(fs.existsSync(target), !removed, `${phase} must leave canonical target in its old-or-new state`);
      assert.equal(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "", removed ? "" : oldContent);

      const retry = PinnedProjectRoot.open(root);
      assert.ok(retry);
      try {
        retry.removeFileIfMatches("document.md", expected);
      } finally {
        retry.close();
      }
      assert.equal(fs.existsSync(target), false, `${phase} retry must converge to removal`);
      assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("near-NAME_MAX multibyte names use bounded CAS and write siblings", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-near-name-max-"));
  const targetName = "界".repeat(84);
  assert.equal(Buffer.byteLength(targetName, "utf8"), 252);
  const target = join(root, targetName);
  const oldContent = "old near-name-max content\n";
  const replacedContent = "replaced near-name-max content\n";
  try {
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try {
      pinned.replaceFileIfMatches(targetName, expected, replacedContent);
      assert.equal(fs.readFileSync(target, "utf8"), replacedContent);
      const replaced = fs.statSync(target);
      pinned.removeFileIfMatches(targetName, {
        dev: replaced.dev,
        ino: replaced.ino,
        sha256: createHash("sha256").update(replacedContent).digest("hex"),
      });
      assert.equal(fs.existsSync(target), false);
      pinned.writeExclusive(targetName, "exclusive near-name-max\n");
      assert.equal(fs.readFileSync(target, "utf8"), "exclusive near-name-max\n");
      pinned.writeAtomic(targetName, "atomic near-name-max\n");
      assert.equal(fs.readFileSync(target, "utf8"), "atomic near-name-max\n");
    } finally {
      pinned.close();
    }
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith(".omp-") || name.includes(".cas.")),
      [],
      "bounded sibling transactions must clean up all lock and temporary entries",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor-bound writes report the exact published inode and bytes", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-write-descriptor-"));
  try {
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const atomicBytes = Buffer.from("atomic descriptor bytes\n", "utf8");
      const atomic = pinned.writeAtomicWithDescriptor("atomic.txt", atomicBytes);
      const atomicInfo = fs.statSync(join(root, "atomic.txt"));
      assert.equal(atomic.path, pinned.anchorPath("atomic.txt"));
      assert.equal(atomic.relative_path, "atomic.txt");
      assert.equal(atomic.dev, atomicInfo.dev);
      assert.equal(atomic.ino, atomicInfo.ino);
      assert.equal(atomic.size, atomicBytes.byteLength);
      assert.equal(atomic.sha256, createHash("sha256").update(atomicBytes).digest("hex"));

      const expected = { dev: atomicInfo.dev, ino: atomicInfo.ino, sha256: atomic.sha256 };
      const replacementBytes = Buffer.from("replacement descriptor bytes\n", "utf8");
      const replacement = pinned.replaceFileIfMatchesWithDescriptor("atomic.txt", expected, replacementBytes);
      const replacementInfo = fs.statSync(join(root, "atomic.txt"));
      assert.equal(replacement.dev, replacementInfo.dev);
      assert.equal(replacement.ino, replacementInfo.ino);
      assert.equal(replacement.size, replacementBytes.byteLength);
      assert.equal(replacement.sha256, createHash("sha256").update(replacementBytes).digest("hex"));

      const exclusive = pinned.writeExclusiveWithDescriptor("exclusive.txt", "exclusive descriptor bytes\n");
      const exclusiveInfo = fs.statSync(join(root, "exclusive.txt"));
      assert.equal(exclusive.dev, exclusiveInfo.dev);
      assert.equal(exclusive.ino, exclusiveInfo.ino);
      assert.equal(exclusive.size, Buffer.byteLength("exclusive descriptor bytes\n", "utf8"));
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor batch rolls back the detached old tree after root replacement", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-batch-root-replace-"));
  const replacement = fs.mkdtempSync(join(tmpdir(), "spec-pinned-batch-root-replacement-"));
  const moved = `${root}-moved`;
  try {
    fs.writeFileSync(join(root, "a.txt"), "old-a\n", "utf8");
    let swapped = false;
    const pinned = PinnedProjectRoot.open(root, {
      beforeCleanup: (relativePath) => {
        if (swapped || relativePath !== "a.txt") return;
        swapped = true;
        fs.renameSync(root, moved);
        fs.renameSync(replacement, root);
      },
    });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.writeAtomicFilesWithReceipts([
          { path: "a.txt", content: "new-a\n" },
          { path: "b.txt", content: "new-b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      pinned.close();
    }
    assert.equal(swapped, true, "the root replacement seam must run after helper publication");
    assert.equal(fs.readFileSync(join(moved, "a.txt"), "utf8"), "old-a\n");
    assert.equal(fs.existsSync(join(moved, "b.txt")), false, "detached old tree keeps a newly-created target absent");
    assert.equal(fs.existsSync(join(root, "a.txt")), false, "replacement root must remain untouched");
    assert.equal(fs.existsSync(join(root, "b.txt")), false, "replacement root must remain untouched");
  } finally {
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(replacement, { recursive: true, force: true });
  }
});

test("batch receipt binds the exact same-byte replacement made before helper capture", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-batch-receipt-race-"));
  try {
    const target = join(root, "target.txt");
    fs.writeFileSync(target, "same bytes\n", "utf8");
    const original = fs.statSync(target);
    let interposed = false;
    const pinned = PinnedProjectRoot.open(root, {
      beforeTempOpen: (relativePath) => {
        if (interposed || relativePath !== "target.txt") return;
        interposed = true;
        fs.unlinkSync(target);
        fs.writeFileSync(target, "same bytes\n", "utf8");
      },
    });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const [receipt] = pinned.writeAtomicFilesWithReceipts([{ path: "target.txt", content: "next bytes\n" }]);
      assert.equal(interposed, true);
      assert.equal(receipt.preimage.kind, "file");
      if (receipt.preimage.kind !== "file") return;
      assert.equal(Buffer.from(receipt.preimage.bytes).toString("utf8"), "same bytes\n");
      assert.notEqual(receipt.preimage.expectation.ino, original.ino, "receipt must bind the replacement inode, not a stale capture");
      assert.equal(receipt.rollback(), true);
      assert.equal(fs.readFileSync(target, "utf8"), "same bytes\n");
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional replacement receipt captures one exact preimage before callback publication", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-conditional-receipt-"));
  try {
    const target = join(root, "target.txt");
    fs.writeFileSync(target, "old conditional\n", "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update("old conditional\n").digest("hex") };
    let callbackReceipt: { preimage: unknown; rollback: () => boolean } | undefined;
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const receipt = pinned.replaceFileIfMatchesWithReceipt("target.txt", expected, "new conditional\n", {
        beforePublish: (candidate) => { callbackReceipt = candidate; },
      });
      assert.ok(callbackReceipt, "beforePublish must receive the staged receipt");
      assert.deepEqual(callbackReceipt.preimage, receipt.preimage, "callback and returned receipts must carry one exact preimage");
      assert.equal(receipt.preimage.kind, "file");
      if (receipt.preimage.kind !== "file") return;
      assert.equal(Buffer.from(receipt.preimage.bytes).toString("utf8"), "old conditional\n");
      assert.equal(receipt.preimage.expectation.size, Buffer.byteLength("old conditional\n"));
      assert.equal(receipt.rollback(), true);
      assert.equal(fs.readFileSync(target, "utf8"), "old conditional\n");
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch beforePublish observes every preimage before visibility and aborts all", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-batch-before-publish-"));
  try {
    const existing = join(root, "existing.txt");
    const created = join(root, "created.txt");
    fs.writeFileSync(existing, "old existing\n", "utf8");
    let callbacks = 0;
    let observed: Array<{ kind: string; bytes?: string }> = [];
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.writeAtomicFilesWithReceipts([
          { path: "existing.txt", content: "new existing\n" },
          { path: "created.txt", content: "new created\n" },
        ], {
          beforePublish: (receipts) => {
            callbacks += 1;
            observed = receipts.map((receipt) => receipt.preimage.kind === "file"
              ? { kind: receipt.preimage.kind, bytes: Buffer.from(receipt.preimage.bytes).toString("utf8") }
              : { kind: receipt.preimage.kind });
            if (fs.readFileSync(existing, "utf8") !== "old existing\n" || fs.existsSync(created)) {
              throw new Error("batch became visible before beforePublish callback");
            }
            throw new Error("injected beforePublish abort");
          },
        }),
        /injected beforePublish abort/u,
      );
      assert.equal(callbacks, 1);
      assert.deepEqual(observed, [
        { kind: "file", bytes: "old existing\n" },
        { kind: "absent" },
      ]);
      assert.equal(fs.readFileSync(existing, "utf8"), "old existing\n");
      assert.equal(fs.existsSync(created), false);
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch post-ACK mutation preserves every exact preimage", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-batch-receipt-conversion-"));
  try {
    fs.writeFileSync(join(root, "existing.txt"), "old existing\n", "utf8");
    const pinned = PinnedProjectRoot.open(root, {
      beforeCleanup: (relativePath) => {
        if (relativePath !== "existing.txt") return;
        fs.writeFileSync(join(root, "existing.txt"), "in-place interloper\n", "utf8");
      },
    });
    assert.ok(pinned);
    if (!pinned) return;
    const originalAnchor = pinned.anchorPath.bind(pinned);
    Object.defineProperty(pinned, "anchorPath", {
      configurable: true,
      value: (relativePath: string) => {
        if (fs.readFileSync(join(root, "existing.txt"), "utf8") === "in-place interloper\n") throw new Error("injected receipt conversion failure");
        return originalAnchor(relativePath);
      },
    });
    try {
      assert.throws(
        () => pinned.writeAtomicFilesWithReceipts([
          { path: "existing.txt", content: "new existing\n" },
          { path: "created.txt", content: "new created\n" },
        ]),
        /injected receipt conversion failure/u,
      );
      assert.equal(fs.readFileSync(join(root, "existing.txt"), "utf8"), "in-place interloper\n", "same-inode in-place mutation must not be overwritten by rollback");
      assert.equal(fs.existsSync(join(root, "created.txt")), false);
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portable single writes roll back after publish failpoints and preserve same-byte interlopers", () => {
  if (process.platform === "darwin") return;
  for (const operation of ["atomic", "exclusive"] as const) {
    for (const phase of ["afterPublish", "afterPublishLiveness"] as const) {
      const root = fs.mkdtempSync(join(tmpdir(), `spec-pinned-portable-${operation}-${phase}-`));
      try {
        const target = join(root, "target.txt");
        if (operation === "atomic") fs.writeFileSync(target, "old bytes\n", "utf8");
        let fired = false;
        const pinned = PinnedProjectRoot.open(root, {
          afterPublish: phase === "afterPublish" ? () => {
            if (fired) return;
            fired = true;
            if (operation === "atomic") {
              fs.unlinkSync(target);
              fs.writeFileSync(target, "new bytes\n", "utf8");
            }
            throw new Error("injected after-publish failure");
          } : undefined,
          afterPublishLiveness: phase === "afterPublishLiveness" ? () => {
            fired = true;
            throw new Error("injected after-publish-liveness failure");
          } : undefined,
        });
        assert.ok(pinned);
        if (!pinned) continue;
        try {
          assert.throws(
            () => operation === "atomic"
              ? pinned.writeAtomicWithDescriptor("target.txt", "new bytes\n")
              : pinned.writeExclusiveWithDescriptor("target.txt", "new bytes\n"),
            (error: unknown) => error instanceof PinnedRootError,
          );
          assert.equal(fired, true);
          if (operation === "atomic") assert.equal(fs.readFileSync(target, "utf8"), phase === "afterPublish" ? "new bytes\n" : "old bytes\n");
          else assert.equal(fs.existsSync(target), false);
        } finally {
          pinned.close();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("legacy PID-only CAS locks use grace then token-quarantined reclaim", () => {
  for (const operation of ["replace", "remove"] as const) {
    const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-legacy-pid-" + operation + "-"));
    try {
      const target = join(root, "document.md");
      const oldContent = "old legacy pid-only content\n";
      const newContent = "new legacy pid-only content\n";
      fs.writeFileSync(target, oldContent, "utf8");
      const before = fs.statSync(target);
      const expected = { dev: before.dev, ino: before.ino, sha256: createHash("sha256").update(oldContent).digest("hex") };
      const lockPath = join(root, ".document.md.cas.lock");
      const metadata = {
        schema_version: 1, token: "legacy-" + operation, pid: process.pid, operation, expected,
        desired_sha256: createHash("sha256").update(operation === "replace" ? newContent : "").digest("hex"), stage: ".document.md.cas.tmp",
      };
      fs.writeFileSync(lockPath, JSON.stringify(metadata) + "\n", "utf8");
      const blocked = PinnedProjectRoot.open(root);
      assert.ok(blocked);
      try {
        assert.throws(
          () => operation === "replace"
            ? blocked.replaceFileIfMatches("document.md", expected, newContent)
            : blocked.removeFileIfMatches("document.md", expected),
          (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
        );
      } finally { blocked.close(); }
      assert.equal(fs.existsSync(lockPath), true, "a live legacy owner remains protected during grace");
      const expired = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, expired, expired);
      const retry = PinnedProjectRoot.open(root);
      assert.ok(retry);
      try {
        if (operation === "replace") retry.replaceFileIfMatches("document.md", expected, newContent);
        else retry.removeFileIfMatches("document.md", expected);
      } finally { retry.close(); }
      assert.equal(fs.existsSync(target), operation === "replace");
      if (operation === "replace") assert.equal(fs.readFileSync(target, "utf8"), newContent);
      assert.equal(fs.existsSync(lockPath), false);
      assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes(".legacy.") || name.includes(".cas.")), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("conditional replacement reclaims a wrong-start live PID lock", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-pid-reuse-replace-"));
  try {
    const target = join(root, "document.md");
    const oldContent = "old pid-reuse content\n";
    const newContent = "new pid-reuse content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, sha256: createHash("sha256").update(oldContent).digest("hex") };
    fs.writeFileSync(join(root, ".document.md.cas.lock"), JSON.stringify({
      schema_version: 2, token: "wrong-start-replace", pid: process.pid, start_identity: "wrong-start-identity",
      operation: "replace", expected, desired_sha256: createHash("sha256").update(newContent).digest("hex"), stage: ".document.md.cas.tmp",
    }) + "\n", "utf8");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try { pinned.replaceFileIfMatches("document.md", expected, newContent); } finally { pinned.close(); }
    assert.equal(fs.readFileSync(target, "utf8"), newContent);
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional removal reclaims a wrong-start live PID lock", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-pid-reuse-remove-"));
  try {
    const target = join(root, "document.md");
    const oldContent = "old pid-reuse removable content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, sha256: createHash("sha256").update(oldContent).digest("hex") };
    fs.writeFileSync(join(root, ".document.md.cas.lock"), JSON.stringify({
      schema_version: 2, token: "wrong-start-remove", pid: process.pid, start_identity: "wrong-start-identity",
      operation: "remove", expected, desired_sha256: createHash("sha256").update("").digest("hex"), stage: ".document.md.cas.tmp",
    }) + "\n", "utf8");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try { pinned.removeFileIfMatches("document.md", expected); } finally { pinned.close(); }
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("pinned reads reject FIFOs without blocking", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-fifo-"));
  try {
    execFileSync("mkfifo", [join(root, "blocked.fifo")]);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try {
      const started = Date.now();
      assert.throws(() => pinned.readFile("blocked.fifo"), (error: unknown) => error instanceof PinnedRootError && error.code === "not_regular");
      assert.ok(Date.now() - started < 1000, "FIFO inspection must be bounded and non-blocking");
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux descriptor anchor paths round-trip only for the live owned descriptor", () => {
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-descriptor-relative-"));
  try {
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    const anchor = pinned.anchorPath("state.json");
    try {
      assert.equal(pinned.relativePath(anchor), "state.json");
      const wrongDescriptor = anchor.replace(/\/fd\/\d+(?=\/)/u, "/fd/999999/");
      assert.equal(pinned.relativePath(wrongDescriptor), null, "another descriptor alias must not be accepted");
      assert.equal(pinned.relativePath(`${anchor}/../escape`), null, "descriptor traversal must not be normalized into an accepted path");
    } finally {
      pinned.close();
    }
    assert.equal(pinned.relativePath(anchor), null, "a closed pin must reject stale descriptor aliases");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("pinned directory public limits reject one above the documented boundary", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-directory-bound-"));
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    const exact = pinned.listDirectoryPage("", {
      maxEntries: 16384,
      maxNameBytes: 4 * 1024 * 1024,
      maxScanEntries: 16384,
      maxScanNameBytes: 4 * 1024 * 1024,
    });
    assert.deepEqual(exact.names, []);
    assert.throws(
      () => pinned.listDirectoryPage("", { maxEntries: 16385 }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
    );
    assert.throws(
      () => pinned.listDirectoryPage("", { maxNameBytes: 4 * 1024 * 1024 + 1 }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
    );
    assert.throws(
      () => pinned.listDirectoryPage("", { maxScanEntries: 16385 }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
    );
    assert.throws(
      () => pinned.listDirectoryBatch("", { maxEntries: 16385 }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
    );
  } finally {
    pinned.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin pinned closeAsync awaits helper exit and is idempotent", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-close-async-"));
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    assert.equal(pinned.pathEntryExists("missing.txt"), false);
  } finally {
    await pinned.closeAsync();
    await pinned.closeAsync();
    let lingering = "";
    try {
      lingering = execFileSync("pgrep", ["-P", String(process.pid), "-f", "python3.*-c"], "utf8").trim();
    } catch {
      // pgrep exits 1 when no matching child remains.
    }
    assert.equal(lingering, "", "awaited closeAsync must leave no helper child");
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("Darwin process identity ignores PATH shadow binaries", () => {
  if (process.platform !== "darwin") return;
  const fake = fs.mkdtempSync(join(tmpdir(), "spec-pinned-fake-ps-"));
  const marker = join(fake, "invoked");
  const fakePs = join(fake, "ps");
  const previousPath = process.env.PATH;
  try {
    fs.writeFileSync(fakePs, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    process.env.PATH = fake;
    assert.match(processStartIdentity(process.pid) ?? "", /^darwin:/u);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test("Darwin self process identity survives a transient probe outage without relaxing foreign fencing", () => {
  if (process.platform !== "darwin") return;
  const first = processStartIdentity(process.pid);
  assert.match(first ?? "", /^darwin:/u);
  const originalSpawnSync = childProcess.spawnSync;
  let foreignProbeCount = 0;
  childProcess.spawnSync = (() => {
    foreignProbeCount += 1;
    throw new Error("simulated process identity probe outage");
  }) as typeof originalSpawnSync;
  syncBuiltinESMExports();
  try {
    assert.equal(processStartIdentity(process.pid), first, "trusted self identity remains usable during a transient probe outage");
    assert.equal(processStartIdentity(process.pid + 1), null, "foreign identity remains fail-closed when its probe is unavailable");
    assert.equal(foreignProbeCount, 1, "foreign PID probes are not served from the self cache");
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});

test("Darwin helper spawn errors poison only the pinned operation and host survives", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-spawn-error-"));
  const pinned = PinnedProjectRoot.open(root, { helperExecutable: "/definitely/missing/omp-python3" });
  assert.ok(pinned);
  try {
    assert.throws(() => pinned.pathEntryExists("missing.txt"), (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported");
    assert.throws(() => pinned.pathEntryExists("missing.txt"), (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported");
    assert.equal(process.pid > 0, true);
  } finally {
    await pinned.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin helper handles short writes and rejects EPIPE/EOF without reuse", async () => {
  if (process.platform !== "darwin") return;
  for (const mode of ["short_write", "epipe", "eof", "two_frames"] as const) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-protocol-${mode}-`));
    const pinned = PinnedProjectRoot.open(root, { helperProtocolTest: mode });
    assert.ok(pinned);
    try {
      if (mode === "short_write") {
        assert.equal(pinned.pathEntryExists("missing.txt"), false);
      } else {
        assert.throws(() => pinned.pathEntryExists("missing.txt"), (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported");
      }
    } finally {
      await pinned.closeAsync();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("prepared batch with a lost commit ACK quarantines the published postimage", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-batch-unacked-"));
  try {
    fs.writeFileSync(join(root, "a.txt"), "old a\n", "utf8");
    fs.writeFileSync(join(root, "b.txt"), "old b\n", "utf8");
    const failing = PinnedProjectRoot.open(root, { helperProtocolTest: "eof_after_prepared_commit" });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(
        () => failing.writeAtomicFilesWithReceipts([
          { path: "a.txt", content: "new a\n" },
          { path: "b.txt", content: "new b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failing.close();
    }
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      assert.throws(
        () => retry.writeAtomicFilesWithReceipts([
          { path: "a.txt", content: "recovered a\n" },
          { path: "b.txt", content: "recovered b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      retry.close();
    }
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "new a\n");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "old b\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("receipt write accepts an ACK EOF after verifying the exact anchored postimage", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-receipt-ack-eof-"));
  try {
    const target = join(root, "target.txt");
    fs.writeFileSync(target, "old ACK EOF\n", "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update("old ACK EOF\n").digest("hex") };
    const pinned = PinnedProjectRoot.open(root, { helperProtocolTest: "eof_after_prepared_ack" });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const receipt = pinned.replaceFileIfMatchesWithReceipt("target.txt", expected, "new ACK EOF\n");
      assert.equal(receipt.preimage.kind, "file");
      assert.equal(fs.readFileSync(target, "utf8"), "new ACK EOF\n");
    } finally {
      pinned.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grouped prepared crashes before lease upgrade recover without residue", () => {
  if (process.platform !== "darwin") return;
  for (const phase of ["after_prepared_stage_before_journal", "after_prepared_batch_journal"] as const) {
    const root = fs.mkdtempSync(join(tmpdir(), `spec-pinned-prepared-${phase}-`));
    const a = join(root, "a.txt");
    const b = join(root, "nested", "b.txt");
    try {
      fs.mkdirSync(join(root, "nested"));
      fs.writeFileSync(a, `old ${phase} a\n`, "utf8");
      fs.writeFileSync(b, `old ${phase} b\n`, "utf8");
      const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: phase });
      assert.ok(failing);
      if (!failing) return;
      try {
        assert.throws(() => failing.writeAtomicFiles([
          { path: "a.txt", content: `new ${phase} a\n` },
          { path: "nested/b.txt", content: `new ${phase} b\n` },
        ]), (error: unknown) => error instanceof PinnedRootError);
      } finally {
        failing.close();
      }
      const retry = PinnedProjectRoot.open(root);
      assert.ok(retry);
      if (!retry) return;
      try {
        retry.writeAtomicFiles([
          { path: "a.txt", content: `new ${phase} a\n` },
          { path: "nested/b.txt", content: `new ${phase} b\n` },
        ]);
      } finally {
        retry.close();
      }
      assert.equal(fs.readFileSync(a, "utf8"), `new ${phase} a\n`);
      assert.equal(fs.readFileSync(b, "utf8"), `new ${phase} b\n`);
      assert.equal(fs.readdirSync(root, { recursive: true }).some((name) => String(name).includes(".omp-cas-") || String(name).includes(".omp-batch-journal-")), false, "retry must leave no grouped residue");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("mixed partial recovery retains an owner-present foreign target", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-mixed-partial-recovery-"));
  const a = join(root, "a.txt");
  const b = join(root, "b.txt");
  try {
    fs.writeFileSync(a, "old mixed a\n", "utf8");
    fs.writeFileSync(b, "old mixed b\n", "utf8");
    const failing = PinnedProjectRoot.open(root, {
      conditionalFailurePhase: "after_prepared_batch_journal",
      preparedBatchJournalIndex: 1,
    });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(
        () => failing.writeAtomicFiles([
          { path: "a.txt", content: "new mixed a\n" },
          { path: "b.txt", content: "new mixed b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failing.close();
    }
    const names = fs.readdirSync(root);
    const lockNames = names.filter((name) => name.startsWith(".omp-cas-lock-") && name.endsWith(".lock"));
    const lockMetadata = new Map(lockNames.map((name) => [JSON.parse(fs.readFileSync(join(root, name), "utf8")).path as string, { name, metadata: JSON.parse(fs.readFileSync(join(root, name), "utf8")) }]));
    const aLock = lockMetadata.get("a.txt");
    const bLock = lockMetadata.get("b.txt");
    assert.ok(aLock && bLock, "crash must leave both authenticated grouped leases");
    if (!aLock || !bLock) return;
    fs.rmSync(join(root, aLock.name));
    fs.rmSync(join(root, aLock.metadata.stage));
    fs.rmSync(join(root, bLock.metadata.stage));
    fs.writeFileSync(b, "foreign mixed target\n", "utf8");
    const journal = fs.readdirSync(root).find((name) => name.startsWith(".omp-batch-journal-") && name.endsWith(".json"));
    assert.ok(journal, "crash must leave the signed grouped journal");
    if (!journal) return;
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      assert.throws(
        () => retry.writeAtomicFiles([{ path: "b.txt", content: "retry mixed b\n" }]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
        "foreign owner-present target must block partial cleanup",
      );
    } finally {
      retry.close();
    }
    assert.equal(fs.readFileSync(b, "utf8"), "foreign mixed target\n");
    assert.equal(fs.existsSync(join(root, bLock.name)), true, "ambiguous owner-present entry must retain its lease");
    assert.equal(fs.existsSync(join(root, journal)), true, "ambiguous owner-present entry must retain its journal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared lease replacement during upgrade preserves foreign lease", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-lease-replacement-"));
  const target = join(root, "target.txt");
  try {
    fs.writeFileSync(target, "old lease replacement\n", "utf8");
    const pinned = PinnedProjectRoot.open(root, { preparedLeaseReplacement: true });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.writeAtomicWithDescriptor("target.txt", "new lease replacement\n"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
        "lease replacement must fail closed before prepared write publication",
      );
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), "old lease replacement\n");
    const lock = fs.readdirSync(root).find((name) => name.startsWith(".omp-cas-lock-") && name.endsWith(".lock"));
    assert.ok(lock, "foreign lease must survive the failed authenticated update");
    if (lock) assert.equal(fs.readFileSync(join(root, lock), "utf8"), "foreign lease replacement\n");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-prepared-lease-") && name.endsWith(".tmp")), false, "failed lease exchange must not leave its update temp");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PREPARED_LEASE_CHILD_SCRIPT = String.raw`
const fs = await import("node:fs");
const { join } = await import("node:path");
const { PinnedProjectRoot } = await import("./src/specification/pinned-root.js");
const [root, ready, release, result, mode] = process.argv.slice(1);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const exclusive = mode.startsWith("exclusive-");
if (mode === "holder" || mode === "exclusive-holder") {
  const pinned = PinnedProjectRoot.open(root, { beforePublish: () => {
    fs.writeFileSync(ready, "ready", "utf8");
    while (!fs.existsSync(release)) Atomics.wait(waitCell, 0, 0, 5);
  } });
  if (!pinned) throw new Error("holder could not open pinned root");
  try { (exclusive ? pinned.writeExclusiveWithDescriptor : pinned.writeAtomicWithDescriptor).call(pinned, "target.txt", exclusive ? "exclusive holder winner\\n" : "holder winner\\n"); fs.writeFileSync(result, "holder:ok", "utf8"); }
  catch (error) { fs.writeFileSync(result, "holder:error:" + (error?.code ?? "unknown"), "utf8"); process.exitCode = 1; }
  finally { pinned.close(); }
} else {
  const pinned = PinnedProjectRoot.open(root);
  if (!pinned) throw new Error("challenger could not open pinned root");
  try { (exclusive ? pinned.writeExclusiveWithDescriptor : pinned.writeAtomicWithDescriptor).call(pinned, "target.txt", exclusive ? "exclusive challenger winner\\n" : "challenger winner\\n"); fs.writeFileSync(result, "challenger:ok", "utf8"); }
  catch (error) { fs.writeFileSync(result, "challenger:error:" + (error?.code ?? "unknown"), "utf8"); }
  finally { pinned.close(); }
}
`;

test("foreign live helper cannot reclaim another Node process lease", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-foreign-live-lease-"));
  const ready = join(root, "holder.ready");
  const release = join(root, "holder.release");
  const holderResult = join(root, "holder.result");
  const challengerResult = join(root, "challenger.result");
  fs.writeFileSync(join(root, "target.txt"), "old foreign lease\\n", "utf8");
  const holder = spawn(process.execPath, ["--import", "tsx", "--eval", PREPARED_LEASE_CHILD_SCRIPT, root, ready, release, holderResult, "holder"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
  let holderError = "";
  holder.stderr.on("data", (chunk: Buffer) => { holderError += chunk.toString("utf8"); });
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error(`holder did not reach beforePublish: ${holderError}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const challenger = spawn(process.execPath, ["--import", "tsx", "--eval", PREPARED_LEASE_CHILD_SCRIPT, root, ready, release, challengerResult, "challenger"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      challenger.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      challenger.once("error", reject);
      challenger.once("close", (code) => code === 0 ? resolve() : reject(new Error(`challenger exited ${code}: ${stderr}`)));
    });
    assert.equal(fs.readFileSync(challengerResult, "utf8"), "challenger:error:changed");
    assert.equal(fs.readFileSync(join(root, "target.txt"), "utf8"), "old foreign lease\\n");
    fs.writeFileSync(release, "release", "utf8");
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("close", (code) => code === 0 ? resolve() : reject(new Error(`holder exited ${code}: ${holderError}`)));
    });
    assert.equal(fs.readFileSync(holderResult, "utf8"), "holder:ok");
    assert.equal(fs.readFileSync(join(root, "target.txt"), "utf8"), "holder winner\\n");
  } finally {
    try { fs.writeFileSync(release, "release", "utf8"); } catch { /* root cleanup */ }
    await new Promise<void>((resolve) => { if (holder.exitCode !== null) resolve(); else holder.once("close", () => resolve()); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent exclusive prepared writers report contention without recovery", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-exclusive-contention-"));
  const ready = join(root, "exclusive-holder.ready");
  const release = join(root, "exclusive-holder.release");
  const holderResult = join(root, "exclusive-holder.result");
  const challengerResult = join(root, "exclusive-challenger.result");
  try {
    const holder = spawn(process.execPath, ["--import", "tsx", "--eval", PREPARED_LEASE_CHILD_SCRIPT, root, ready, release, holderResult, "exclusive-holder"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let holderError = "";
    holder.stderr.on("data", (chunk: Buffer) => { holderError += chunk.toString("utf8"); });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error(`exclusive holder did not reach beforePublish: ${holderError}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const challenger = spawn(process.execPath, ["--import", "tsx", "--eval", PREPARED_LEASE_CHILD_SCRIPT, root, ready, release, challengerResult, "exclusive-challenger"], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        challenger.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        challenger.once("error", reject);
        challenger.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exclusive challenger exited ${code}: ${stderr}`)));
      });
      assert.match(fs.readFileSync(challengerResult, "utf8"), /^challenger:error:(?:changed|exists)$/);
      fs.writeFileSync(release, "release", "utf8");
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exclusive holder exited ${code}: ${holderError}`)));
      });
    } finally {
      if (holder.exitCode === null) {
        fs.writeFileSync(release, "release", "utf8");
        await new Promise<void>((resolve) => holder.once("close", () => resolve()));
      }
    }
    assert.equal(fs.readFileSync(join(root, "target.txt"), "utf8"), "exclusive holder winner\\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const RESTART_RECOVERY_CHILD_SCRIPT = String.raw`
const fs = await import("node:fs");
const { join } = await import("node:path");
const { PinnedProjectRoot } = await import("./src/specification/pinned-root.js");
const [root, result, mode, outside] = process.argv.slice(1);
const pinned = PinnedProjectRoot.open(root, mode === "crash" ? { conditionalFailurePhase: "after_prepared_publication_before_lease" } : {});
if (!pinned) throw new Error("restart probe could not open pinned root");
try {
  if (mode === "crash") {
    try { pinned.writeAtomicFiles([{ path: "a.txt", content: "prefix from dead process\\n" }, { path: "b.txt", content: "unpublished dead process\\n" }]); fs.writeFileSync(result, "crash:unexpected", "utf8"); }
    catch (error) { fs.writeFileSync(result, "crash:" + (error?.code ?? "unknown"), "utf8"); }
  } else {
    try { pinned.writeAtomicWithDescriptor("b.txt", "explicit restart winner\\n"); fs.writeFileSync(result, "recover:ok", "utf8"); }
    catch (error) { fs.writeFileSync(result, "recover:" + (error?.code ?? "unknown") + ":" + (error?.message ?? ""), "utf8"); process.exitCode = 1; }
  }
} finally { pinned.close(); }
`;

async function runRestartProbeChild(root: string, result: string, mode: "crash" | "recover", outside?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", RESTART_RECOVERY_CHILD_SCRIPT, root, result, mode, outside ?? ""], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`restart probe ${mode} exited ${code}: ${stderr} result=${fs.existsSync(result) ? fs.readFileSync(result, "utf8") : "missing"}`)));
  });
}

test("fresh Node restart quarantines dead grouped residue before explicit write", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-restart-recovery-"));
  const crashResult = join(root, "crash.result");
  const recoverResult = join(root, "recover.result");
  try {
    fs.writeFileSync(join(root, "a.txt"), "old restart a\\n", "utf8");
    fs.writeFileSync(join(root, "b.txt"), "old restart b\\n", "utf8");
    await runRestartProbeChild(root, crashResult, "crash");
    assert.match(fs.readFileSync(crashResult, "utf8"), /^crash:/);
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "prefix from dead process\\n", "group prefix remains published by the dead process");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "old restart b\\n", "unpublished target remains unchanged");
    await runRestartProbeChild(root, recoverResult, "recover");
    assert.equal(fs.readFileSync(recoverResult, "utf8"), "recover:ok");
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "prefix from dead process\\n", "explicit recovery does not rewrite the prior prefix");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "explicit restart winner\\n");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-restart-lease-") && name.endsWith(".quarantined")), true, "dead lease is retained in an operation-unique quarantine");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-restart-journal-") && name.endsWith(".quarantined")), true, "safe old journal is retained as opaque quarantine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forged dead lease metadata cannot quarantine or write outside requested path", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-forged-restart-"));
  const outside = fs.mkdtempSync(join(tmpdir(), "spec-pinned-forged-restart-outside-"));
  const crashResult = join(root, "crash.result");
  const recoverResult = join(root, "recover.result");
  const sentinel = join(outside, "sentinel.txt");
  try {
    fs.writeFileSync(sentinel, "outside sentinel\\n", "utf8");
    fs.writeFileSync(join(root, "a.txt"), "old forged a\\n", "utf8");
    fs.writeFileSync(join(root, "b.txt"), "old forged b\\n", "utf8");
    await runRestartProbeChild(root, crashResult, "crash");
    const lockName = fs.readdirSync(root).find((name) => name.startsWith(".omp-cas-lock-") && name.endsWith(".lock") && JSON.parse(fs.readFileSync(join(root, name), "utf8")).path === "b.txt");
    assert.ok(lockName, "dead process must leave b lease");
    if (!lockName) return;
    const forged = JSON.parse(fs.readFileSync(join(root, lockName), "utf8"));
    forged.pid = 999999999;
    forged.start_identity = "darwin:forged-dead";
    forged.batch_journal = "../../outside/sentinel.txt";
    forged.stage = "../../outside/should-not-touch";
    forged.signature = "00".repeat(32);
    fs.writeFileSync(join(root, lockName), JSON.stringify(forged) + "\n", "utf8");
    await runRestartProbeChild(root, recoverResult, "recover", outside);
    assert.equal(fs.readFileSync(recoverResult, "utf8"), "recover:ok");
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "prefix from dead process\\n");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "explicit restart winner\\n");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside sentinel\\n");
    assert.equal(fs.existsSync(join(outside, "should-not-touch")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("prepared ACK rejects a same-inode mutation before lease release", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-ack-mutation-"));
  const target = join(root, "target.txt");
  try {
    fs.writeFileSync(target, "old ACK mutation\n", "utf8");
    const pinned = PinnedProjectRoot.open(root, { preparedPostVerifyMutation: true });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.writeAtomicWithDescriptor("target.txt", "new ACK mutation\n"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
        "ACK must re-verify the canonical target after the same-inode mutation seam",
      );
    } finally {
      pinned.close();
    }
    if (fs.existsSync(target)) assert.notEqual(fs.readFileSync(target, "utf8"), "new ACK mutation\n", "the mutated postimage must not be accepted as a receipt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared abort preserves a stage replaced after prepare", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-abort-stage-replacement-"));
  const target = join(root, "target.txt");
  try {
    fs.writeFileSync(target, "old abort stage\n", "utf8");
    const pinned = PinnedProjectRoot.open(root, { beforePublish: () => {
      const lock = fs.readdirSync(root).find((name) => name.startsWith(".omp-cas-lock-") && name.endsWith(".lock"));
      assert.ok(lock, "prepared write must publish a deterministic lease before beforePublish");
      if (lock) {
        const metadata = JSON.parse(fs.readFileSync(join(root, lock), "utf8")) as Record<string, unknown>;
        assert.equal(typeof metadata.host_instance_id, "string", "lease must bind to the host instance");
        assert.equal(typeof metadata.signature, "string", "lease metadata must be authenticated");
      }
      const stage = fs.readdirSync(root).find((name) => name.startsWith(".omp-cas-stage-") && name.endsWith(".tmp"));
      assert.ok(stage, "prepared write must publish a deterministic stage before beforePublish");
      if (!stage) return;
      fs.unlinkSync(join(root, stage));
      fs.writeFileSync(join(root, stage), "foreign abort stage\n", "utf8");
      throw new Error("abort after stage replacement");
    } });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(() => pinned.writeAtomicWithDescriptor("target.txt", "new abort stage\n"), /abort after stage replacement/);
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), "old abort stage\n");
    assert.ok(fs.readdirSync(root).some((name) => name.startsWith(".omp-cas-stage-") && name.endsWith(".tmp")), "foreign stage must remain for recovery");
    assert.ok(fs.readdirSync(root).some((name) => name.startsWith(".omp-cas-lock-")), "lease must remain for recovery");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared single publication crash before lease update quarantines the postimage", () => {
  for (const operation of ["atomic", "exclusive"] as const) {
    const root = fs.mkdtempSync(join(tmpdir(), `spec-pinned-prepared-prelease-${operation}-`));
    try {
      const target = join(root, "target.txt");
      if (operation === "atomic") fs.writeFileSync(target, "old prelease\n", "utf8");
      const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: "after_prepared_publication_before_lease" });
      assert.ok(failing);
      if (!failing) return;
      try {
        assert.throws(
          () => operation === "atomic"
            ? failing.writeAtomicWithDescriptor("target.txt", "new prelease\n")
            : failing.writeExclusiveWithDescriptor("target.txt", "new prelease\n"),
          (error: unknown) => error instanceof PinnedRootError,
        );
      } finally {
        failing.close();
      }
      const retry = PinnedProjectRoot.open(root);
      assert.ok(retry);
      if (!retry) return;
      try {
        assert.throws(
          () => operation === "atomic"
            ? retry.writeAtomicWithDescriptor("target.txt", "recovered prelease\n")
            : retry.writeExclusiveWithDescriptor("target.txt", "recovered prelease\n"),
          (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
        );
      } finally {
        retry.close();
      }
      assert.equal(fs.readFileSync(target, "utf8"), "new prelease\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("no-callback batch recovers a durable prefix and finishes the full requested batch", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-no-callback-batch-crash-"));
  try {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    fs.writeFileSync(a, "old no-callback a\n", "utf8");
    fs.writeFileSync(b, "old no-callback b\n", "utf8");
    const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: "after_prepared_publication_before_lease" });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(
        () => failing.writeAtomicFiles([
          { path: "a.txt", content: "new no-callback a\n" },
          { path: "b.txt", content: "new no-callback b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failing.close();
    }
    assert.ok(["old no-callback a\n", "new no-callback a\n"].includes(fs.readFileSync(a, "utf8")), "the first target must remain an exact old-or-new value after helper death");
    assert.ok(["old no-callback b\n", "new no-callback b\n"].includes(fs.readFileSync(b, "utf8")), "the suffix must remain an exact old-or-new value until recovery");
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      retry.writeAtomicFiles([
        { path: "a.txt", content: "new no-callback a\n" },
        { path: "b.txt", content: "new no-callback b\n" },
      ]);
    } finally {
      retry.close();
    }
    assert.equal(fs.readFileSync(a, "utf8"), "new no-callback a\n", "recovery must preserve the exact published prefix");
    assert.equal(fs.readFileSync(b, "utf8"), "new no-callback b\n", "recovery must finish every exact prepared suffix entry");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-") && name.endsWith(".json")), false, "completed recovery must remove the exact group journal");
    const next = PinnedProjectRoot.open(root);
    assert.ok(next);
    if (!next) return;
    try {
      next.writeAtomicFiles([{ path: "a.txt", content: "next no-callback a\n" }]);
    } finally {
      next.close();
    }
    assert.equal(fs.readFileSync(a, "utf8"), "next no-callback a\n", "subsequent writes must proceed after group recovery");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-root grouped journal replay fails closed before mutation", () => {
  if (process.platform !== "darwin") return;
  const rootA = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cross-root-a-"));
  const rootB = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cross-root-b-"));
  try {
    for (const root of [rootA, rootB]) {
      fs.writeFileSync(join(root, "a.txt"), "old cross-root a\\n", "utf8");
      fs.writeFileSync(join(root, "b.txt"), "old cross-root b\\n", "utf8");
    }
    const failing = PinnedProjectRoot.open(rootA, { conditionalFailurePhase: "after_prepared_publication_before_lease" });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(() => failing.writeAtomicFiles([
        { path: "a.txt", content: "new cross-root a\\n" },
        { path: "b.txt", content: "new cross-root b\\n" },
      ]), (error: unknown) => error instanceof PinnedRootError);
    } finally {
      failing.close();
    }
    for (const name of fs.readdirSync(rootA)) {
      if (name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-") || name.startsWith(".omp-batch-journal-")) {
        fs.copyFileSync(join(rootA, name), join(rootB, name));
      }
    }
    const replay = PinnedProjectRoot.open(rootB);
    assert.ok(replay);
    if (!replay) return;
    try {
      assert.throws(() => replay.writeAtomicFiles([{ path: "a.txt", content: "attacker must not publish\\n" }]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required");
    } finally {
      replay.close();
    }
    assert.equal(fs.readFileSync(join(rootB, "a.txt"), "utf8"), "old cross-root a\\n");
    assert.equal(fs.readFileSync(join(rootB, "b.txt"), "utf8"), "old cross-root b\\n");
    assert.ok(fs.readdirSync(rootB).some((name) => name.startsWith(".omp-cas-lock-")), "copied lease must remain for explicit recovery");
    assert.ok(fs.readdirSync(rootB).some((name) => name.startsWith(".omp-batch-journal-")), "copied journal must remain unactioned");
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("grouped later prepare failure removes authenticated journal residue", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-batch-prepare-failure-"));
  try {
    fs.writeFileSync(join(root, "a.txt"), "old prepare a\\n", "utf8");
    fs.writeFileSync(join(root, "b.txt"), "old prepare b\\n", "utf8");
    const hooks: { beforeTempOpen?: (path: string) => void } = { beforeTempOpen: (path) => { if (path === "b.txt") throw new Error("injected later prepare failure"); } };
    const failing = PinnedProjectRoot.open(root, hooks);
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(() => failing.writeAtomicFiles([
        { path: "a.txt", content: "new prepare a\\n" },
        { path: "b.txt", content: "new prepare b\\n" },
      ]), (error: unknown) => error instanceof Error);
    } finally {
      failing.close();
    }
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "old prepare a\\n");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "old prepare b\\n");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-") || name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-")), false, "later prepare failure must leave no grouped residue");
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try { retry.writeAtomicFiles([{ path: "a.txt", content: "next prepare a\\n" }]); } finally { retry.close(); }
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "next prepare a\\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no-callback grouped recovery stops on a foreign stage without mutation", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-no-callback-batch-ambiguous-"));
  try {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    fs.writeFileSync(a, "old ambiguous a\n", "utf8");
    fs.writeFileSync(b, "old ambiguous b\n", "utf8");
    const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: "after_prepared_publication_before_lease" });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(
        () => failing.writeAtomicFiles([
          { path: "a.txt", content: "new ambiguous a\n" },
          { path: "b.txt", content: "new ambiguous b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failing.close();
    }
    const stageName = fs.readdirSync(root).find((name) => name.startsWith(".omp-cas-stage-") && name.endsWith(".tmp"));
    assert.ok(stageName, "helper death must leave a durable grouped stage");
    if (!stageName) return;
    fs.writeFileSync(join(root, stageName), "foreign stage bytes\n", "utf8");
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      assert.throws(
        () => retry.writeAtomicFiles([
          { path: "a.txt", content: "new ambiguous a\n" },
          { path: "b.txt", content: "new ambiguous b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
        "foreign stage content must stop grouped recovery without guessing ownership",
      );
    } finally {
      retry.close();
    }
    assert.ok(["old ambiguous a\n", "new ambiguous a\n"].includes(fs.readFileSync(a, "utf8")), "ambiguous recovery must preserve an old-or-new target");
    assert.ok(["old ambiguous b\n", "new ambiguous b\n"].includes(fs.readFileSync(b, "utf8")), "ambiguous recovery must preserve an old-or-new target");
    assert.equal(fs.readFileSync(join(root, stageName), "utf8"), "foreign stage bytes\n", "the foreign stage must remain untouched");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-") && name.endsWith(".json")), true, "ambiguous recovery must retain the group journal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("grouped finalization crash recovers after partial lease release", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-finalizing-crash-"));
  try {
    fs.writeFileSync(join(root, "a.txt"), "old finalizing a\\n", "utf8");
    fs.writeFileSync(join(root, "b.txt"), "old finalizing b\\n", "utf8");
    const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: "after_prepared_batch_first_lease_release" });
    assert.ok(failing);
    if (!failing) return;
    try {
      failing.writeAtomicFiles([
        { path: "a.txt", content: "new finalizing a\\n" },
        { path: "b.txt", content: "new finalizing b\\n" },
      ]);
    } finally {
      failing.close();
    }
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-")), false, "same-call finalizing recovery must remove the journal before returning");
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      retry.writeAtomicFiles([
        { path: "a.txt", content: "new finalizing a\\n" },
        { path: "b.txt", content: "new finalizing b\\n" },
      ]);
    } finally {
      retry.close();
    }
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "new finalizing a\\n");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "new finalizing b\\n");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-")), false, "finalizing recovery must remove the journal after all leases are exact");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared batch publication crash before lease update quarantines the postimages", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-batch-prelease-"));
  try {
    fs.writeFileSync(join(root, "a.txt"), "old prelease a\n", "utf8");
    fs.writeFileSync(join(root, "b.txt"), "old prelease b\n", "utf8");
    const failing = PinnedProjectRoot.open(root, { conditionalFailurePhase: "after_prepared_publication_before_lease" });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(
        () => failing.writeAtomicFilesWithReceipts([
          { path: "a.txt", content: "new prelease a\n" },
          { path: "b.txt", content: "new prelease b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failing.close();
    }
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      assert.throws(
        () => retry.writeAtomicFilesWithReceipts([
          { path: "a.txt", content: "recovered prelease a\n" },
          { path: "b.txt", content: "recovered prelease b\n" },
        ]),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      retry.close();
    }
    assert.equal(fs.readFileSync(join(root, "a.txt"), "utf8"), "new prelease a\n");
    assert.equal(fs.readFileSync(join(root, "b.txt"), "utf8"), "old prelease b\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared commit failure after publish aborts before ACK without destructive recovery", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-abort-"));
  try {
    const target = join(root, "target.txt");
    fs.writeFileSync(target, "old prepared abort\n", "utf8");
    const pinned = PinnedProjectRoot.open(root, { conditionalFailurePhase: "after_prepared_publish_error" });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.writeAtomicWithDescriptor("target.txt", "failed prepared abort\n"),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      pinned.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), "failed prepared abort\n");
    assert.equal(fs.readdirSync(root).some((name) => name.includes("cas-lock")), true, "quarantined abort must retain a durable lease");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared publication with lost ACK quarantines and preserves a concurrent winner", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-prepared-unacked-"));
  try {
    const target = join(root, "target.txt");
    fs.writeFileSync(target, "old prepared\n", "utf8");
    const failing = PinnedProjectRoot.open(root, { helperProtocolTest: "eof_after_prepared_commit" });
    assert.ok(failing);
    if (!failing) return;
    try {
      assert.throws(
        () => failing.writeAtomicWithDescriptor("target.txt", "unacked prepared\n"),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failing.close();
    }
    // The commit may have become visible before its response was lost. A
    // same-inode winner must remain untouched while the stale lease quarantines.
    assert.equal(fs.readFileSync(target, "utf8"), "unacked prepared\n");
    fs.writeFileSync(target, "concurrent winner\n", "utf8");
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      assert.throws(
        () => retry.writeAtomicWithDescriptor("target.txt", "recovered prepared\n"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      retry.close();
    }
    assert.equal(fs.readFileSync(target, "utf8"), "concurrent winner\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin helper rejects invalid UTF-8 responses and recovers with a fresh helper", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-invalid-utf8-response-"));
  const invalidHooks: { helperProtocolTest?: "invalid_utf8" } = { helperProtocolTest: "invalid_utf8" };
  const pinned = PinnedProjectRoot.open(root, invalidHooks);
  assert.ok(pinned);
  try {
    assert.throws(
      () => pinned.pathEntryExists("missing.txt"),
      (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported" && /invalid UTF-8/u.test(error.message),
    );
    assert.equal(fs.existsSync(join(root, "must-not-write")), false, "an invalid response must not be accepted as a result or write target");
  } finally {
    await pinned.closeAsync();
  }

  const recovered = PinnedProjectRoot.open(root);
  assert.ok(recovered);
  try {
    assert.equal(recovered.pathEntryExists("missing.txt"), false, "a fresh helper must recover after the failed session is discarded");
    recovered.writeExclusive("recovered.txt", "recovered\n");
    assert.equal(fs.readFileSync(join(root, "recovered.txt"), "utf8"), "recovered\n");
  } finally {
    await recovered.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin helper accepts valid multibyte and control response data", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-valid-response-"));
  const hooks: { helperProtocolTest?: "valid_multibyte_control" } = { helperProtocolTest: "valid_multibyte_control" };
  const pinned = PinnedProjectRoot.open(root, hooks);
  assert.ok(pinned);
  try {
    assert.equal(pinned.pathEntryExists("missing.txt"), false);
    hooks.helperProtocolTest = undefined;
    assert.equal(pinned.pathEntryExists("missing.txt"), false);
  } finally {
    await pinned.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin helper rejects invalid JSON and truncated response frames", async () => {
  if (process.platform !== "darwin") return;
  for (const mode of ["invalid_json", "truncated"] as const) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-malformed-response-${mode}-`));
    const hooks: { helperProtocolTest?: "invalid_json" | "truncated"; helperTimeoutMs?: number } = {
      helperProtocolTest: mode,
      ...(mode === "truncated" ? { helperTimeoutMs: 50 } : {}),
    };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    try {
      assert.throws(
        () => pinned.pathEntryExists("missing.txt"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported",
      );
    } finally {
      await pinned.closeAsync();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Darwin oversized response keeps request id and permits next request reuse", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-oversized-response-"));
  const hooks: { helperProtocolTest?: "oversized_response" } = { helperProtocolTest: "oversized_response" };
  const pinned = PinnedProjectRoot.open(root, hooks);
  assert.ok(pinned);
  try {
    assert.throws(() => pinned.pathEntryExists("missing.txt"), (error: unknown) => error instanceof PinnedRootError && error.code === "limit");
    hooks.helperProtocolTest = undefined;
    assert.equal(pinned.pathEntryExists("missing.txt"), false);
  } finally {
    await pinned.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin discard/link/rename failures keep descriptor count stable", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-fd-stability-"));
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  const countFds = () => fs.readdirSync("/dev/fd").length;
  try {
    pinned.pathEntryExists("missing.txt");
    const baseline = countFds();
    fs.mkdirSync(join(root, "queue"));
    fs.mkdirSync(join(root, "rejected"));
    for (let i = 0; i < 100; i += 1) {
      fs.writeFileSync(join(root, "queue", "item"), "item\n");
      assert.equal(pinned.discardBatch("queue", ["item"], "rejected"), 1);
      fs.writeFileSync(join(root, "source"), "source\n");
      assert.throws(() => pinned.linkExclusive("source", "missing/destination"), (error: unknown) => error instanceof PinnedRootError && error.code === "not_found");
      assert.throws(() => pinned.renameFile("source", "missing/destination"), (error: unknown) => error instanceof PinnedRootError && error.code === "not_found");
      assert.throws(() => pinned.renameFileExclusive("source", "missing/destination"), (error: unknown) => error instanceof PinnedRootError && error.code === "not_found");
      assert.equal(countFds(), baseline);
      fs.unlinkSync(join(root, "source"));
    }
  } finally {
    await pinned.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned write max+1 rejects before content copy", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-write-bound-"));
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    const oversized = { byteLength: 64 * 1024 * 1024 + 1 } as unknown as Uint8Array;
    assert.throws(
      () => pinned.writeAtomic("oversized.bin", oversized),
      (error: unknown) => error instanceof PinnedRootError && error.code === "limit",
    );
    assert.equal(fs.existsSync(join(root, "oversized.bin")), false);
  } finally {
    pinned.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("Darwin helper blocked watchdog remains strictly below five seconds", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-helper-watchdog-"));
  const pinned = PinnedProjectRoot.open(root, { helperSleepMs: 60_000 });
  assert.ok(pinned);
  const started = Date.now();
  try {
    assert.throws(
      () => pinned.pathEntryExists("missing.txt"),
      (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported" && /timed out/u.test(error.message),
    );
  } finally {
    await pinned.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(Date.now() - started < 5_000, "synchronous helper watchdog must stay below five seconds");
});

test("conditional removal restores a target mutated before its move", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-remove-preimage-recovery-"));
  const hooks: { conditionalPreMoveMutation?: boolean } = { conditionalPreMoveMutation: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old remove pre-move content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.removeFileIfMatches("document.md", expected),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
      hooks.conditionalPreMoveMutation = false;
      assert.throws(
        () => pinned.removeFileIfMatches("document.md", expected),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
    } finally {
      pinned.close();
    }
    assert.notEqual(fs.readFileSync(target, "utf8"), oldContent, "the mutated winner must remain canonical");
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release its lease");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined")), false, "an uncontended winner needs no quarantine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conditional removal restores a target symlink without clobbering it", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-cas-remove-symlink-recovery-"));
  const hooks: { conditionalPreMoveSymlink?: boolean } = { conditionalPreMoveSymlink: true };
  try {
    const target = join(root, "document.md");
    const oldContent = "old remove symlink content\n";
    fs.writeFileSync(target, oldContent, "utf8");
    const before = fs.statSync(target);
    const expected = { dev: before.dev, ino: before.ino, size: before.size, sha256: createHash("sha256").update(oldContent).digest("hex") };
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.removeFileIfMatches("document.md", expected),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
      hooks.conditionalPreMoveSymlink = false;
      assert.throws(
        () => pinned.removeFileIfMatches("document.md", expected),
        (error: unknown) => error instanceof PinnedRootError && error.code === "path_unauthorized",
      );
    } finally {
      pinned.close();
    }
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true, "the newer symlink winner must remain canonical");
    assert.equal(fs.readlinkSync(target), "conditional-winner");
    assert.equal(fs.existsSync(join(root, ".document.md.cas.lock")), false, "the failed operation must release its lease");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined")), false, "an uncontended symlink winner needs no quarantine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scoped batch cleanup cannot mutate another live batch", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-live-batch-scope-"));
  const hooksA: { conditionalFailurePhase?: "after_prepared_publication_before_lease" } = { conditionalFailurePhase: "after_prepared_publication_before_lease" };
  const hooksB: { conditionalFailurePhase?: "after_prepared_publication_before_lease" } = { conditionalFailurePhase: "after_prepared_publication_before_lease" };
  try {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    fs.writeFileSync(a, "old live A\n", "utf8");
    fs.writeFileSync(b, "old live B\n", "utf8");
    const failingA = PinnedProjectRoot.open(root, hooksA);
    const failingB = PinnedProjectRoot.open(root, hooksB);
    assert.ok(failingA);
    assert.ok(failingB);
    if (!failingA || !failingB) return;
    try {
      assert.throws(
        () => failingA.writeAtomicFiles([{ path: "a.txt", content: "new live A\n" }]),
        (error: unknown) => error instanceof PinnedRootError,
      );
      assert.throws(
        () => failingB.writeAtomicFiles([{ path: "b.txt", content: "new live B\n" }]),
        (error: unknown) => error instanceof PinnedRootError,
      );
    } finally {
      failingA.close();
      failingB.close();
    }
    const beforeBResidue = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-") || name.startsWith(".omp-batch-journal-"));
    assert.ok(beforeBResidue.length >= 2, "both failed live batches must leave independently recoverable residue");
    const bLeaseAndJournal = new Map(beforeBResidue.filter((name) => name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-batch-journal-"))
      .filter((name) => fs.readFileSync(join(root, name), "utf8").includes('"path":"b.txt"'))
      .map((name) => [name, fs.readFileSync(join(root, name))] as const));
    assert.ok(bLeaseAndJournal.size >= 2, "batch B must have an authenticated lease and journal");
    const recoverA = PinnedProjectRoot.open(root);
    assert.ok(recoverA);
    if (!recoverA) return;
    try {
      recoverA.writeAtomicFiles([{ path: "a.txt", content: "new live A\n" }]);
    } finally {
      recoverA.close();
    }
    assert.equal(fs.readFileSync(a, "utf8"), "new live A\n", "batch A retry must complete its own publication");
    assert.equal(fs.readFileSync(b, "utf8"), "new live B\n", "batch A cleanup must not alter batch B's already-published result");
    for (const [name, bytes] of bLeaseAndJournal) {
      assert.deepEqual(fs.readFileSync(join(root, name)), bytes, `batch A cleanup must not mutate batch B artifact ${name}`);
    }
    const afterAResidue = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-") || name.startsWith(".omp-batch-journal-"));
    assert.ok(afterAResidue.length >= 1, "batch B residue must remain live after batch A cleanup");
    const recoverB = PinnedProjectRoot.open(root);
    assert.ok(recoverB);
    if (!recoverB) return;
    try {
      recoverB.writeAtomicFiles([{ path: "b.txt", content: "new live B\n" }]);
    } finally {
      recoverB.close();
    }
    assert.equal(fs.readFileSync(b, "utf8"), "new live B\n", "batch B ACK/retry must remain valid after batch A cleanup");
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-") || name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-")), false, "both scoped batches must finish without cross-cleanup residue");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin helper rejects forged requests, responses, and cross-session frames", async () => {
  if (process.platform !== "darwin") return;
  for (const mode of ["forged_request", "forged_response", "cross_session_replay"] as const) {
    const root = await fsPromises.mkdtemp(join(tmpdir(), `spec-pinned-adversarial-${mode}-`));
    const pinned = PinnedProjectRoot.open(root, { helperProtocolTest: mode });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.pathEntryExists("missing.txt"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported",
        `${mode} must fail closed without treating the frame as an operation result`,
      );
    } finally {
      await pinned.closeAsync();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Darwin helper rejects a replayed response nonce in the same session", async () => {
  if (process.platform !== "darwin") return;
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-pinned-replay-response-"));
  const pinned = PinnedProjectRoot.open(root, { helperProtocolTest: "replay_response" });
  assert.ok(pinned);
  if (!pinned) return;
  try {
    assert.equal(pinned.pathEntryExists("missing.txt"), false);
    assert.throws(
      () => pinned.pathEntryExists("missing.txt"),
      (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported",
      "a stale response frame must not satisfy a newer request",
    );
  } finally {
    await pinned.closeAsync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repeated disabled helper attempts do not retain durable batch IDs", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-disabled-live-id-"));
  const hooks: { disableDarwinHelper?: boolean } = { disableDarwinHelper: true };
  try {
    const pinned = PinnedProjectRoot.open(root, hooks);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        assert.throws(
          () => pinned.writeAtomicFiles([{ path: "bounded.txt", content: `attempt ${attempt}\n` }]),
          (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported",
        );
      }
    } finally {
      await pinned.closeAsync();
    }
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-") || name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-")), false, "unsupported startup attempts must leave no durable residue");
    const startup = PinnedProjectRoot.open(root, { helperExecutable: "/definitely/missing/omp-python3" });
    assert.ok(startup);
    if (!startup) return;
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        assert.throws(
          () => startup.writeAtomicFiles([{ path: "startup.txt", content: `startup ${attempt}\\n` }]),
          (error: unknown) => error instanceof PinnedRootError && error.code === "unsupported",
        );
      }
    } finally {
      await startup.closeAsync();
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".omp-batch-journal-") || name.startsWith(".omp-cas-lock-") || name.startsWith(".omp-cas-stage-")), false, "startup failures must leave no durable residue");
    }
    const retry = PinnedProjectRoot.open(root);
    assert.ok(retry);
    if (!retry) return;
    try {
      retry.writeAtomicFiles([{ path: "bounded.txt", content: "after disabled attempts\n" }]);
    } finally {
      await retry.closeAsync();
    }
    assert.equal(fs.readFileSync(join(root, "bounded.txt"), "utf8"), "after disabled attempts\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared exclusive create quarantines a substituted stage before publication", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(join(tmpdir(), "spec-pinned-exclusive-stage-race-"));
  try {
    const pinned = PinnedProjectRoot.open(root, {
      beforePublish: () => {
        const stage = fs.readdirSync(root).find((name) => name.startsWith(".omp-cas-stage-") && name.endsWith(".tmp"));
        assert.ok(stage, "prepared exclusive write must expose a deterministic stage");
        if (!stage) return;
        fs.unlinkSync(join(root, stage));
        fs.writeFileSync(join(root, stage), "attacker exclusive stage\n", "utf8");
      },
    });
    assert.ok(pinned);
    if (!pinned) return;
    try {
      assert.throws(
        () => pinned.writeExclusiveWithDescriptor("new.txt", "trusted exclusive bytes\n"),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
    } finally {
      pinned.close();
    }
    assert.equal(fs.existsSync(join(root, "new.txt")), false, "substituted stage bytes must never remain canonical");
    assert.equal(fs.existsSync(join(root, ".omp-cas-lock-" + createHash("sha256").update("new.txt").digest("hex") + ".lock")), false, "failed exclusive publication must release its lease");
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith(".omp-cas-recovery-") && name.endsWith(".quarantined"));
    assert.equal(quarantined.length, 1, "the substituted stage must be retained in quarantine");
    assert.equal(fs.readFileSync(join(root, quarantined[0]!), "utf8"), "attacker exclusive stage\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
