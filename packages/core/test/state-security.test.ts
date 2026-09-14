import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_PERSISTED_STATE_BYTES, atomicWriteFile, resolveState, setStateTransactionTestHooks, updateStateAtomically, writeState } from "../src/engine/state.js";
import type { TeamState } from "../src/engine/types.js";
import { secureAtomicWriteFile } from "../src/cto/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { bindFeatureWorkspaceToRoot, validFeatureWorkspace } from "./fixtures/specification-fixtures.js";
import { resolveFeatureWorkspace } from "../src/specification/workspace.js";

function tempEntries(dir: string, target: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(`.${target}.`) && name.endsWith(".tmp"));
}

test("state writer commits exact UTF-8 bytes with restrictive mode and preserves unrelated temp collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "state-writer-security-"));
  try {
    const dir = join(root, ".work-state", "features", "secure", "artifacts");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "authority.json");
    const collision = join(dir, ".authority.json.collision.tmp");
    const content = "{\n  \"trusted\": \"π\\u0000capability\",\n  \"answer\": true\n}\n";
    writeFileSync(collision, "attacker-owned", { mode: 0o644 });

    atomicWriteFile(target, content);

    assert.deepEqual(readFileSync(target), Buffer.from(content, "utf8"), "writer persists every requested byte exactly");
    assert.equal(lstatSync(target).mode & 0o777, 0o600, "authority file is never group/world readable");
    assert.equal(readFileSync(collision, "utf8"), "attacker-owned", "unique O_EXCL temp creation never clobbers a collision");
    assert.deepEqual(tempEntries(dir, "authority.json"), [".authority.json.collision.tmp"], "writer leaves no private temp behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state writer rejects symlinked final and ancestor paths without changing prior bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "state-writer-symlink-"));
  try {
    const workState = join(root, ".work-state");
    const safeDir = join(workState, "features", "secure");
    const outside = join(root, "outside");
    mkdirSync(safeDir, { recursive: true });
    mkdirSync(outside);

    const prior = join(outside, "prior.json");
    writeFileSync(prior, "prior-authority", { mode: 0o600 });
    const finalLink = join(safeDir, "state.json");
    symlinkSync(prior, finalLink);
    assert.throws(() => atomicWriteFile(finalLink, "replacement"), /must not be a symlink/);
    assert.equal(readFileSync(prior, "utf8"), "prior-authority", "final symlink target remains intact");
    assert.deepEqual(tempEntries(safeDir, "state.json"), [], "rejected final symlink leaks no temp");

    const ancestorLink = join(workState, "features", "linked");
    symlinkSync(outside, ancestorLink);
    assert.throws(
      () => atomicWriteFile(join(ancestorLink, "authority.json"), "replacement"),
      /state directory must not be a symlink|workflow state parent contains a symlink/,
    );
    assert.equal(readFileSync(prior, "utf8"), "prior-authority", "symlinked ancestor cannot redirect the write");
    assert.equal(readdirSync(outside).includes("authority.json"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state writer cleans its temp after a failed target replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "state-writer-cleanup-"));
  try {
    const dir = join(root, ".work-state", "features", "secure");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "state.json");
    mkdirSync(target);

    assert.throws(() => atomicWriteFile(target, "never-committed"), /not a regular file/);
    assert.equal(lstatSync(target).isDirectory(), true, "failed write leaves the prior directory entry intact");
    assert.deepEqual(tempEntries(dir, "state.json"), [], "failed write leaks no temp file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor-anchored state writer keeps parent replacement writes off an outside sentinel", () => {
  const root = mkdtempSync(join(tmpdir(), "state-writer-parent-swap-"));
  const outside = mkdtempSync(join(tmpdir(), "state-writer-parent-swap-outside-"));
  const parent = join(root, ".work-state", "features", "secure");
  const moved = parent + ".opened";
  const target = join(parent, "state.json");
  const outsideSentinel = join(outside, "sentinel.txt");
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  let writeError = false;
  try {
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, "prior-state", { mode: 0o600 });
    writeFileSync(outsideSentinel, "attacker-owned", { mode: 0o600 });
    PinnedProjectRoot.open = (projectRoot, hooks = {}) => originalOpen(projectRoot, {
      ...hooks,
      beforeRename: (relativePath) => {
        hooks.beforeRename?.(relativePath);
        if (swapped) return;
        swapped = true;
        renameSync(parent, moved);
        symlinkSync(outside, parent, "dir");
      },
    });

    try {
      secureAtomicWriteFile(target, "replacement-state");
    } catch {
      // Darwin's pathname identity guard rejects the replaced parent; Linux
      // commits to the already-open parent descriptor. Both are safe outcomes.
      writeError = true;
    }

    assert.equal(swapped, true, "the deterministic pre-rename seam must execute");
    assert.equal(readFileSync(outsideSentinel, "utf8"), "attacker-owned", "parent replacement cannot redirect writes");
    assert.equal(existsSync(join(outside, "state.json")), false, "outside parent receives no replacement state");
    assert.equal(
      readFileSync(join(moved, "state.json"), "utf8"),
      writeError ? "prior-state" : "replacement-state",
      "the result is either fail-closed or committed through the opened parent",
    );
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      try { unlinkSync(parent); } catch { /* replacement link may already be gone */ }
      try { renameSync(moved, parent); } catch { /* cleanup below removes incomplete fixtures */ }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("legacy ownerless lock recovery stays descriptor-bound across root swap-away/back", () => {
  const root = mkdtempSync(join(tmpdir(), "state-lock-aba-"));
  const moved = root + ".moved";
  const replacement = root + ".replacement";
  const lockPath = join(root, ".work-state", ".state.lock");
  try {
    mkdirSync(lockPath, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath, old, old);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "original project root can be pinned");
    if (!pinned) return;
    let swapped = false;
    const originalTryAcquireExclusiveLock = pinned.tryAcquireExclusiveLock.bind(pinned);
    pinned.tryAcquireExclusiveLock = ((candidate: string, target: string, owner: string, options?: { ownerlessGraceMs?: number }) => {
      if (!swapped && target === ".work-state/.state.lock") {
        swapped = true;
        renameSync(root, moved);
        mkdirSync(root);
        writeFileSync(join(root, "replacement-marker"), "replacement\n", "utf8");
        renameSync(root, replacement);
        renameSync(moved, root);
      }
      return originalTryAcquireExclusiveLock(candidate, target, owner, options);
    }) as PinnedProjectRoot["tryAcquireExclusiveLock"];
    try {
      const result = updateStateAtomically(root, () => ({ op: "discard" as const, value: null }), {
        pinnedRoot: pinned,
        rootGuard: pinned,
        lockTimeoutMs: 500,
      });
      assert.equal(result.ok, true, result.ok ? "descriptor remained bound to the original inode" : result.error);
      assert.equal(swapped, true, "the test exercised a real away/back root replacement");
      assert.deepEqual(readdirSync(replacement), ["replacement-marker"], "replacement root receives no lock or state writes");
      assert.equal(existsSync(lockPath), false, "the old ownerless lock was removed only from the pinned original root");
    } finally {
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
  }
});
test("state lock never reclaims a live legacy PID-only owner", () => {
  const root = mkdtempSync(join(tmpdir(), "state-lock-live-legacy-"));
  const lockPath = join(root, ".work-state", ".state.lock");
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const owner = JSON.stringify({ pid: process.pid, token: "legacy-live-owner", acquired_at: new Date().toISOString() });
    writeFileSync(lockPath, owner, { mode: 0o600 });
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "project root can be pinned");
    if (!pinned) return;
    try {
      const result = updateStateAtomically(
        root,
        () => ({ op: "discard" as const, value: null }),
        { pinnedRoot: pinned, lockTimeoutMs: 80 },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /state lock wait timeout exceeded/);
      assert.equal(readFileSync(lockPath, "utf8"), owner, "a live PID-only owner remains authoritative after grace");
    } finally {
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state lock helper preserves a regular owner interposed over a stale legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "state-lock-interpose-"));
  const lockPath = join(root, ".work-state", ".state.lock");
  const relativeLockPath = ".work-state/.state.lock";
  try {
    mkdirSync(lockPath, { recursive: true });
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "project root can be pinned");
    if (!pinned) return;
    try {
      const replacement = JSON.stringify({ pid: process.pid, token: "live-interloper", acquired_at: new Date().toISOString() });
      const owner = JSON.stringify({ pid: process.pid, token: "candidate", acquired_at: new Date().toISOString() });
      const originalTryAcquireExclusiveLock = pinned.tryAcquireExclusiveLock.bind(pinned);
      let interposed = false;
      pinned.tryAcquireExclusiveLock = ((candidate: string, target: string, content: string, options?: { ownerlessGraceMs?: number }) => {
        if (!interposed && target === relativeLockPath) {
          interposed = true;
          rmSync(lockPath, { recursive: true, force: true });
          writeFileSync(lockPath, replacement, { mode: 0o600 });
        }
        return originalTryAcquireExclusiveLock(candidate, target, content, options);
      }) as PinnedProjectRoot["tryAcquireExclusiveLock"];

      const acquired = pinned.tryAcquireExclusiveLock(
        ".work-state/.state.lock.candidate",
        relativeLockPath,
        owner,
        { ownerlessGraceMs: 50 },
      );
      assert.equal(interposed, true, "the test interposed a replacement before the descriptor operation");
      assert.equal(acquired, false, "a regular interloper is never treated as an ownerless legacy directory");
      assert.equal(readFileSync(lockPath, "utf8"), replacement, "the interposed owner remains authoritative");
    } finally {
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive state locks release and reacquire only with the exact owner token", () => {
  const root = mkdtempSync(join(tmpdir(), "state-lock-release-reacquire-"));
  const lockDir = join(root, ".work-state");
  const target = ".work-state/.state.lock";
  const candidate = ".work-state/.state.lock.candidate";
  try {
    mkdirSync(lockDir, { recursive: true });
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const firstOwner = JSON.stringify({ pid: process.pid, token: "owner-one" });
      assert.equal(pinned.tryAcquireExclusiveLock(candidate, target, firstOwner), true);
      assert.equal(pinned.releaseExclusiveLock(target, "foreign-token"), false);
      assert.equal(pinned.pathEntryExists(target), true);
      assert.equal(pinned.releaseExclusiveLock(target, "owner-one"), true);
      assert.equal(pinned.releaseExclusiveLock(target, "owner-one"), false);

      const secondOwner = JSON.stringify({ pid: process.pid, token: "owner-two" });
      assert.equal(pinned.tryAcquireExclusiveLock(candidate, target, secondOwner), true);
      assert.equal(pinned.releaseExclusiveLock(target, "owner-two"), true);
      assert.equal(pinned.pathEntryExists(target), false);
    } finally {
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function persistenceStateFixture(): TeamState {
  return {
    schema: 1,
    branch: "main",
    classification: {
      type: "FEATURE",
      complexity: "MEDIUM",
      confidence: "HIGH",
      workflow: "standard",
      autonomous: false,
    },
    task: "state persistence byte-bound fixture",
    workflow_override: false,
    issue: null,
    stage_cursor: "",
    stages: [],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-25T00:00:00.000Z",
    run_key: "main",
  };
}

function boundedArtifacts(count: number, payloadBytes: number): Record<string, string> {
  assert.equal(payloadBytes % 2, 0, "UTF-8 fixture payload must have an even byte size");
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `artifact-${String(index).padStart(4, "0")}`,
      "π".repeat(payloadBytes / 2),
    ]),
  );
}

test("state transaction securely initializes the workflow state directory in a fresh git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "state-transaction-fresh-repo-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    assert.equal(existsSync(join(root, ".work-state")), false, "fixture starts with only its git metadata");
    const result = updateStateAtomically(
      root,
      () => ({ op: "commit" as const, state: persistenceStateFixture() }),
      { branch: "main", featureSlug: "fresh" },
    );
    assert.equal(result.ok, true, result.ok ? "fresh repository state commit succeeded" : result.error);
    assert.equal(existsSync(join(root, ".work-state", "features", "fresh", "state.json")), true);
    assert.equal(readFileSync(join(root, ".work-state", ".active-feature"), "utf8"), "fresh\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("engine state writer keeps a near-limit UTF-8 state readable and rejects cap+1 without state/history mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "engine-state-byte-bound-"));
  try {
    const near = persistenceStateFixture();
    near.artifacts = boundedArtifacts(900, 8 * 1024);
    const nearPath = writeState(root, near, { featureSlug: "near-limit" }).statePath;
    const before = readFileSync(nearPath);
    assert.ok(before.byteLength < MAX_PERSISTED_STATE_BYTES, "near-bound fixture must remain within the canonical reader cap");
    const resolved = resolveState(root, undefined, { feature_id: "near-limit", run_key: "main" });
    assert.ok(resolved.state, "a state accepted by the writer must be readable by the bounded reader");

    const beforeState = JSON.parse(before.toString("utf8")) as TeamState;
    const over = {
      ...beforeState,
      artifacts: boundedArtifacts(1024, 8 * 1024),
      history: [
        ...(beforeState.history ?? []),
        { task: "oversized state", feedback: "must not persist", at: "2026-08-25T00:00:00.000Z" },
      ],
    };
    const result = updateStateAtomically(
      root,
      () => ({ op: "commit" as const, state: over }),
      { target: resolved },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "state_invalid");
      assert.match(result.error, /byte limit/u);
    }
    assert.deepEqual(readFileSync(nearPath), before, "over-limit state must not replace the prior canonical bytes");
    assert.equal(readFileSync(join(root, ".work-state", ".active-feature"), "utf8"), "near-limit\n", "failed state write must not move the active pointer");
    const after = resolveState(root, undefined, { feature_id: "near-limit", run_key: "main" }).state;
    assert.deepEqual(after?.history, beforeState.history, "over-limit state must not append persisted history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical feature-state consumers resolve writer-valid states above their former lower caps", () => {
  const root = mkdtempSync(join(tmpdir(), "engine-state-reader-bound-"));
  try {
    const featureId = "wide-state";
    const workspace = bindFeatureWorkspaceToRoot(
      validFeatureWorkspace({ featureId, projectRoot: root }),
      root,
    );
    const state = persistenceStateFixture();
    state.run_key = "run-wide-state";
    state.specification = workspace as TeamState["specification"];
    state.artifacts = boundedArtifacts(600, 8 * 1024);
    const statePath = writeState(root, state, { featureSlug: featureId }).statePath;
    assert.ok(readFileSync(statePath).byteLength > 4 * 1024 * 1024, "consumer fixture must exceed the former 4MiB state cap");
    const resolved = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: state.run_key });
    assert.equal(resolved.ok, true, resolved.ok ? "canonical workspace resolves" : resolved.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("state precommit guards run after beforeCas and preserve bytes on rejection", () => {
  const root = mkdtempSync(join(tmpdir(), "state-precommit-guard-"));
  try {
    const initial = writeState(root, persistenceStateFixture(), { featureSlug: "precommit" });
    const before = readFileSync(initial.statePath);
    const resolved = resolveState(root, undefined, { feature_id: "precommit", run_key: "main" });
    assert.ok(resolved.state && resolved.statePath, "state fixture resolves");
    if (!resolved.state || !resolved.statePath) return;
    const order: string[] = [];
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "state root can be pinned");
    if (!pinned) return;
    setStateTransactionTestHooks({ beforeCas: () => order.push("beforeCas") }, root);
    try {
      const rejected = updateStateAtomically(root, (snapshot) => {
        order.push("mutate");
        return { op: "commit" as const, state: { ...snapshot.state!, task: "must-not-persist" } };
      }, { target: resolved, pinnedRoot: PinnedProjectRoot.open(root)!, preCommit: () => {
        order.push("preCommit");
        throw new Error("guard denied");
      } });
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.match(rejected.error, /pre-commit guard failed: guard denied/u);
      assert.deepEqual(order, ["mutate", "beforeCas", "preCommit"]);
      assert.deepEqual(readFileSync(initial.statePath), before, "rejected precommit leaves state bytes untouched");
    } finally {
      setStateTransactionTestHooks(null, root);
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
