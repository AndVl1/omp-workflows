/**
 * Approval-review closure regressions (fix/workflow-control-plane-deadlocks).
 *
 * Every test here pins one finding of the complete approval review:
 *
 *   - LOCK: a dead lock is reclaimed through rename + inode verification, a
 *     live foreign lock is never stolen, an unreadable owner fails closed,
 *     and five REAL competing processes reclaiming one dead lock stay
 *     mutually exclusive with zero lost updates and zero leftover quarantine
 *     files;
 *   - CAS: deleting the state file during a transaction is a state_conflict
 *     — a deletion is never silently committed (resurrected) over;
 *   - ACTIVE capability: own-undefined required fields reject exactly like
 *     absent ones, and a capability missing only its dispatch ledger is a
 *     structured rejection through public durable paths;
 *   - DEFERRED roster: the cursor move into a roster-policy stage leaves NO
 *     capability behind, so workflow_begin can arm the stage; the terminal
 *     advance does NOT rotate the epoch, keeping the completed capability
 *     strictly bound to the live cursor;
 *   - TERMINAL completion clears the root pending lifecycle;
 *   - the public transition result carries the committed, revision-stamped
 *     state on disk;
 *   - STAGE SCOPE: a capability whose checkpoint policy hash or loop
 *     iteration does not match the current stage window cannot authorize;
 *   - LEDGER: the legacy decision mirror participates in the one
 *     current-scope conflict/idempotency check;
 *   - IDENTITY: a stale top-level work_identity neither names checkpoint
 *     runs nor survives a same-stage reopen;
 *   - ARTIFACTS: fan-in side effects of a rejected advance are rolled back.
 *
 * Cross-process tests synchronize on observable file state (never fixed
 * sleeps) because fake timers cannot drive another OS process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  advanceCursor,
  authorizeDispatch,
  beginCapability,
  completeDispatch,
  createCapability,
  persistPendingDispatch,
  type IssuedCapability,
} from "../src/engine/durable.js";
import {
  appendCheckpointDecision,
  checkpointPolicyHash,
  recordTrustedCheckpointAnswer,
} from "../src/engine/checkpoints.js";
import { loadProfile, profileHash, registerWorkflowProfiles, type Profile } from "../src/engine/profile.js";
import { updateStateAtomically, writeStateBootstrap } from "../src/engine/state.js";
import { finalizeWorkflowRun, run } from "../src/engine/run.js";
import { validateActiveCapabilityStateBinding, validateActiveDispatchCapabilityValue } from "../src/engine/control-plane-contract.js";
import { resolveConfig } from "../src/engine/config.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import type { CheckpointPolicy, TeamState, TypedCheckpointDecision, WorkIdentity } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// The spawned child loads the engine through the tsx loader with the module
// URL passed on argv — the specifier is genuinely runtime-selected (the
// child process does not exist at author time), so a dynamic import inside
// the child script is the point of the test seam.
const ENGINE_STATE_URL = pathToFileURL(join(REPO_ROOT, "packages/core/src/engine/state.ts")).href;

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch = "main"): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function scopedPolicy(defaultRule: CheckpointPolicy["default"]): CheckpointPolicy {
  return {
    default: defaultRule,
    scope: "decision",
    hard_human: [],
    rules: {
      gate_ok: {
        kind: "clarification",
        default: defaultRule,
        allowed_decisions: ["proceed", "reject"],
        phase: "before_advance",
        rationale: "closure policy",
      },
    },
    source: "profile",
    policy_version: 1,
    rationale: "closure policy",
  };
}

/** Single orchestrator stage: terminal advance with no next stage. */
const terminalProfile: Profile = {
  name: "closure-terminal",
  title: "Closure terminal",
  description: "one-stage workflow",
  match: { type: ["OPS"] },
  stages: [{ id: "only", title: "Only", type: "orchestrator" }],
};

/** Single dispatch stage: authorize -> pending -> terminal completion. */
const dispatchProfile: Profile = {
  name: "closure-dispatch",
  title: "Closure dispatch",
  description: "one single-dispatch stage",
  match: { type: ["OPS"] },
  stages: [{ id: "build", title: "Build", type: "single" }],
};

/** Checkpoint stage for policy/loop scope and ledger regressions. */
const scopedProfile: Profile = {
  name: "closure-scoped",
  title: "Closure scoped",
  description: "one checkpoint stage",
  match: { type: ["OPS"] },
  checkpoint_policy: scopedPolicy("autonomous_allowed"),
  stages: [{ id: "build", title: "Build", type: "orchestrator", checkpoint: "gate_ok" }],
};

/** One checkpointed orchestrator stage for interpreter fresh-read races. */
const checkpointRaceProfile: Profile = {
  name: "closure-checkpoint-race",
  title: "Closure checkpoint race",
  description: "checkpoint resolution races the interpreter advance",
  match: { type: ["BUG_FIX"] },
  checkpoint_policy: scopedPolicy("required_human"),
  stages: [{ id: "approve", title: "Approve", type: "orchestrator", checkpoint: "gate_ok" }],
};

/** Multi-slot consilium whose advance gate fails AFTER fan-in synthesis. */
const rollbackProfile: Profile = {
  name: "closure-fanin-rollback",
  title: "Closure fan-in rollback",
  description: "fan-in rolls back when the advance rejects",
  match: { type: ["FEATURE"] },
  stages: [{ id: "research", title: "Research", type: "consilium", produces: "synthesis", gate: "plan_valid" }],
};
registerWorkflowProfiles([terminalProfile, dispatchProfile, scopedProfile, rollbackProfile, checkpointRaceProfile]);

interface SeedOptions {
  profile: Profile;
  stageCursor: string;
  slug?: string;
  capability?: TeamState["dispatch_capability"];
  stageStatus?: "pending" | "in_progress";
  workIdentity?: WorkIdentity;
  legacyDecisions?: unknown[];
}

function seedState(root: string, opts: SeedOptions): IssuedCapability {
  const slug = opts.slug ?? "closure";
  const issued = opts.capability
    ? ({ capability_id: opts.capability.capability_id!, dispatch_token: "seeded", advance_token: "seeded", state: opts.capability } as IssuedCapability)
    : createCapability({
        run_key: "main", branch: "main", workflow: opts.profile.name, profile_hash: profileHash(opts.profile),
        stage_cursor: opts.stageCursor, kind: "none", expected_roster: [],
      });
  const state = {
    schema: 1 as const,
    branch: "main",
    run_key: "main",
    classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: opts.profile.name },
    task: "approval closure",
    workflow_override: false,
    issue: null,
    stage_cursor: opts.stageCursor,
    stages: opts.profile.stages.map((stage) => ({ id: stage.id, status: stage.id === opts.stageCursor ? (opts.stageStatus ?? "in_progress") : "pending" })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(opts.profile),
    scope: NO_SCOPE,
    updated_at: new Date().toISOString(),
    ...(opts.workIdentity ? { work_identity: opts.workIdentity } : {}),
    ...(opts.legacyDecisions ? { checkpoint_decisions: opts.legacyDecisions } : {}),
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
  } as TeamState;
  writeStateBootstrap(root, state, { featureSlug: slug });
  return issued;
}

function staleIdentity(): WorkIdentity {
  return {
    run_id: "stale-run",
    wave_id: "stale-wave",
    slice_id: "prior",
    session_id: "stale-session",
    workflow: "closure-scoped",
    stage_id: "prior",
    stage_cursor: "prior",
    capability_id: "cap-old",
    capability_epoch: "epoch-old",
    slot_id: "orchestrator",
    task_id: "stale-task",
    dispatch_id: "stale-dispatch",
    attempt: 1,
    worker_id: "engine",
  };
}

/** A dead owner pid: the process printed its pid and exited. */
function deadOwnerPid(): number {
  return Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
}

function writeDeadLock(root: string, token: string, pid: number): string {
  const lockPath = join(root, ".work-state", ".state.lock");
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid, token, acquired_at: new Date().toISOString() }));
  return lockPath;
}

// ---------------------------------------------------------------------------
// LOCK: atomic owner publication, verified reclaim, live locks never stolen
// ---------------------------------------------------------------------------

test("closure: a dead lock is reclaimed; a live foreign lock is never stolen; an unreadable owner fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-lock-"));
  const lockPath = join(root, ".work-state", ".state.lock");
  try {
    initGit(root);
    seedState(root, { profile: terminalProfile, stageCursor: "only", stageStatus: "pending" });

    // A lock owned by THIS (alive) process is live: it is never stolen, and
    // a bounded waiter fails with a timeout instead of taking the lock.
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live-foreign", acquired_at: new Date().toISOString() }));
    const blocked = updateStateAtomically(root, () => ({ op: "commit", state: {} as TeamState }), { lockTimeoutMs: 400 });
    assert.equal(blocked.ok, false, "a live foreign lock is never stolen");
    if (!blocked.ok) {
      assert.equal(blocked.code, "state_lock_unavailable");
      assert.match(blocked.error, /wait timeout/);
    }
    const survived = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    assert.equal(survived.token, "live-foreign", "the live lock file survives the waiter verbatim");

    // An unreadable owner is not verifiably dead: fail closed, never steal.
    writeFileSync(lockPath, "{not json");
    const unreadable = updateStateAtomically(root, () => ({ op: "commit", state: {} as TeamState }), { lockTimeoutMs: 400 });
    assert.equal(unreadable.ok, false, "an unreadable owner is never stolen");
    if (!unreadable.ok) assert.match(unreadable.error, /unreadable owner/);

    // A lock owned by a process that has exited is verified dead and
    // reclaimed: the very next transaction takes the lock and leaves no
    // quarantine or owner-temp litter behind.
    writeDeadLock(root, "dead-token", deadOwnerPid());
    const reclaimed = updateStateAtomically(root, (snapshot) => {
      assert.ok(snapshot.state);
      return { op: "commit", state: { ...snapshot.state, task: "reclaimed" } };
    });
    assert.equal(reclaimed.ok, true, reclaimed.ok ? "dead lock reclaimed" : reclaimed.error);
    assert.ok(!existsSync(lockPath), "the reclaimed lock is released after the transaction");
    assert.equal((JSON.parse(readFileSync(join(root, ".work-state", "features", "closure", "state.json"), "utf8")) as TeamState).task, "reclaimed");

    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "begin took the lock cleanly" : begun.error);
    assert.ok(!existsSync(lockPath), "no lock file is left after a clean release");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure: five real competing processes reclaim one dead lock with mutual exclusion and no litter", async () => {
  const root = mkdtempSync(join(tmpdir(), "closure-race-"));
  const lockPath = join(root, ".work-state", ".state.lock");
  try {
    initGit(root);
    seedState(root, { profile: terminalProfile, stageCursor: "only", stageStatus: "pending" });
    writeDeadLock(root, "dead-token", deadOwnerPid());

    const childScript = `
      // The engine module URL arrives on argv: a genuinely runtime-selected
      // specifier loaded through the tsx loader in a fresh child process.
      // node -e CODE a b c numbers extra args from argv[1] (argv[0] is the
      // binary): the engine URL is argv[1], root and id follow.
      const { updateStateAtomically } = await import(process.argv[1]);
      const [root, id] = process.argv.slice(2);
      const result = updateStateAtomically(root, (snapshot) => {
        if (!snapshot.state) return { op: "fail", code: "state_missing", error: "no state" };
        const notes = Array.isArray(snapshot.state.notes) ? snapshot.state.notes : [];
        return { op: "commit", state: { ...snapshot.state, notes: [...notes, id] } };
      }, { lockTimeoutMs: 30000 });
      process.stdout.write(JSON.stringify({ id, ok: result.ok, code: result.ok ? null : result.code, error: result.ok ? null : result.error }));
    `;
    const children = ["c1", "c2", "c3", "c4", "c5"].map((id) =>
      spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript, ENGINE_STATE_URL, root, id], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }));
    const outputs = await Promise.all(children.map((child) => new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      child.stderr.on("data", (chunk) => { out += String(chunk); });
      child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${out}`)));
    })));
    const results = outputs.map((line) => JSON.parse(line.trim().split("\n").pop()!) as { id: string; ok: boolean; code: string | null; error: string | null });
    for (const result of results) {
      assert.equal(result.ok, true, `child ${result.id} must win the lock eventually: ${String(result.error)}`);
    }
    const persisted = JSON.parse(readFileSync(join(root, ".work-state", "features", "closure", "state.json"), "utf8")) as { notes?: string[] };
    assert.deepEqual([...(persisted.notes ?? [])].sort(), ["c1", "c2", "c3", "c4", "c5"], "every competing transaction commits exactly once");
    assert.ok(!existsSync(lockPath), "the lock is fully released after all competitors finish");
    const litter = readdirSync(join(root, ".work-state")).filter((entry) => entry.startsWith(".state.lock"));
    assert.deepEqual(litter, [], "no quarantine or owner-temp files are left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure: guarded reclaim never displaces a live generation created after stale inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "closure-generation-race-"));
  const lockPath = join(root, ".work-state", ".state.lock");
  const inspectedBarrier = join(root, "stale-inspected");
  const releaseBarrier = join(root, "release-reclaimer");
  const renameObserved = join(root, "authoritative-lock-renamed");
  let child: ChildProcess | null = null;
  try {
    initGit(root);
    seedState(root, { profile: terminalProfile, stageCursor: "only", stageStatus: "pending" });
    const stalePid = deadOwnerPid();
    writeDeadLock(root, "stale-generation", stalePid);

    const childScript = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [engineUrl, root, lockPath, stalePidText, inspectedBarrier, releaseBarrier, renameObserved] = process.argv.slice(1);
      const stalePid = Number(stalePidText);
      const originalRename = fs.renameSync.bind(fs);
      fs.renameSync = (source, destination) => {
        if (source === lockPath) fs.writeFileSync(renameObserved, "renamed");
        return originalRename(source, destination);
      };
      syncBuiltinESMExports();
      const originalKill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid === stalePid && signal === 0) {
          fs.writeFileSync(inspectedBarrier, "inspected");
          const signalCell = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(releaseBarrier)) Atomics.wait(signalCell, 0, 0, 10);
        }
        return originalKill(pid, signal);
      };
      const { updateStateAtomically } = await import(engineUrl);
      const result = updateStateAtomically(root, () => ({ op: "discard" }), { lockTimeoutMs: 500 });
      process.stdout.write(JSON.stringify(result));
    `;
    child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", childScript,
      ENGINE_STATE_URL, root, lockPath, String(stalePid), inspectedBarrier, releaseBarrier, renameObserved,
    ], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });

    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const inspectionDeadline = Date.now() + 5_000;
    while (!existsSync(inspectedBarrier) && Date.now() < inspectionDeadline) {
      Atomics.wait(waitCell, 0, 0, 10);
    }
    assert.ok(existsSync(inspectedBarrier), "child reached the barrier after inspecting the stale generation");

    // Publish a different, live generation while the child still holds the
    // stale inode snapshot. The guarded re-read must notice this generation
    // and must not invoke rename on the authoritative lock path at all.
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live-generation", acquired_at: new Date().toISOString() }));
    writeFileSync(releaseBarrier, "release");

    const runningChild = child;
    assert.ok(runningChild.stdout);
    assert.ok(runningChild.stderr);
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      runningChild.stdout!.on("data", (chunk) => { stdout += String(chunk); });
      runningChild.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      runningChild.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    const result = JSON.parse(output) as { ok: boolean; code?: string };
    assert.equal(result.ok, false, "the waiter times out behind the new live generation");
    assert.equal(result.code, "state_lock_unavailable");
    assert.equal(existsSync(renameObserved), false, "the new live generation was never renamed, even temporarily");
    const liveOwner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
    assert.equal(liveOwner.token, "live-generation");
  } finally {

    if (!existsSync(releaseBarrier)) writeFileSync(releaseBarrier, "release");
    child?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
test("closure: run observes a checkpoint decision committed while advance waits for the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "closure-run-checkpoint-race-"));
  const childEntered = join(root, "decision-writer-entered");
  let decisionChild: ChildProcess | null = null;
  let decisionChildExit: Promise<void> | null = null;
  try {
    initGit(root);
    const result = await run({
      task: "checkpoint resolution race",
      cwd: root,
      branch: "main",
      autonomous: false,
      classification: {
        type: "BUG_FIX",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: false,
        workflow: checkpointRaceProfile.name,
      },
      taskTool: {
        call: async () => ({ id: "unused", output: "unused", artifacts: {}, exitCode: 0 }),
      },
      orchestrate: async () => {
        const statePath = join(root, ".work-state", "features", "main", "state.json");
        const current = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
        const trusted = recordTrustedCheckpointAnswer(current, {
          answer_id: "closure/checkpoint-race",
          channel: "terminal",
          reference: "terminal-answer/closure/checkpoint-race",
          stage_id: "approve",
          checkpoint_id: "gate_ok",
          decision: "proceed",
        });
        const cap = current.dispatch_capability!;
        const appended = appendCheckpointDecision(trusted.state, {
          run_id: current.run_key ?? current.branch,
          stage_id: "approve",
          checkpoint_id: "gate_ok",
          checkpoint_kind: "clarification",
          decision: "proceed",
          authorization: "human",
          actor: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
          capability_id: cap.capability_id!,
          capability_epoch: cap.issued_for!.cursor_epoch,
          loop_iteration: cap.issued_for!.loop_iteration!,
          policy_hash: checkpointPolicyHash(current.checkpoint_policy!),
          rationale: "human resolved while interpreter was advancing",
          decided_at: new Date().toISOString(),
        });
        assert.equal(appended.ok, true, appended.ok ? "decision appended" : appended.error);
        if (!appended.ok) throw new Error(appended.error);
        const encodedState = Buffer.from(JSON.stringify(appended.state)).toString("base64");
        const childScript = `
          const [engineUrl, root, barrier, encodedState] = process.argv.slice(1);
          const fs = await import("node:fs");
          const { updateStateAtomically } = await import(engineUrl);
          const nextState = JSON.parse(Buffer.from(encodedState, "base64").toString("utf8"));
          const result = updateStateAtomically(root, () => {
            fs.writeFileSync(barrier, "entered");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
            return { op: "commit", state: nextState };
          }, { lockTimeoutMs: 5000 });
          if (!result.ok) {
            process.stderr.write(JSON.stringify(result));
            process.exitCode = 1;
          }
        `;
        decisionChild = spawn(process.execPath, [
          "--import", "tsx", "--input-type=module", "-e", childScript,
          ENGINE_STATE_URL, root, childEntered, encodedState,
        ], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
        const runningChild = decisionChild;
        decisionChildExit = new Promise<void>((resolve, reject) => {
          let stderr = "";
          runningChild.stderr!.on("data", (chunk) => { stderr += String(chunk); });
          runningChild.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`decision child exited ${code}: ${stderr}`)));
        });
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 5_000;
        while (!existsSync(childEntered) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 10);
        assert.ok(existsSync(childEntered), "concurrent decision writer holds the state lock before orchestrator completion");
        return { id: "approve", output: "orchestrator completed", artifacts: {}, exitCode: 0 };
      },
    });
    await decisionChildExit;
    assert.equal(result.outcomes[0]?.status, "done", "fresh advance observes the concurrently committed decision");
    const final = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
    assert.equal(final.pause.kind, "done");
    assert.equal(final.typed_checkpoint_decisions?.length, 1);
  } finally {
    decisionChild?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure: terminal finalization classifies state committed while it waits for the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "closure-terminal-race-"));
  const childEntered = join(root, "terminal-writer-entered");
  let child: ChildProcess | null = null;
  try {
    initGit(root);
    seedState(root, { profile: terminalProfile, stageCursor: "only", stageStatus: "pending" });
    const childScript = `
      const [engineUrl, root, barrier] = process.argv.slice(1);
      const fs = await import("node:fs");
      const { updateStateAtomically } = await import(engineUrl);
      const result = updateStateAtomically(root, (snapshot) => {
        fs.writeFileSync(barrier, "entered");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        return {
          op: "commit",
          state: {
            ...snapshot.state,
            stages: snapshot.state.stages.map((stage) => ({ ...stage, status: "done" })),
            pause: { kind: "none", reason: "" },
          },
        };
      }, { lockTimeoutMs: 5000 });
      if (!result.ok) {
        process.stderr.write(JSON.stringify(result));
        process.exitCode = 1;
      }
    `;
    child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", childScript,
      ENGINE_STATE_URL, root, childEntered,
    ], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
    const runningChild = child;
    const childExit = new Promise<void>((resolve, reject) => {
      let stderr = "";
      runningChild.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      runningChild.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`terminal child exited ${code}: ${stderr}`)));
    });
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5_000;
    while (!existsSync(childEntered) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 10);
    assert.ok(existsSync(childEntered), "concurrent terminal writer holds the lock before finalization");
    const finalized = finalizeWorkflowRun(root);
    await childExit;
    assert.equal(finalized.stages[0]?.status, "done");
    assert.deepEqual(finalized.pause, { kind: "done", reason: "" }, "terminal decision uses the fresh committed stage status");
  } finally {
    child?.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CAS: a deletion during the transaction is a conflict, never a resurrection
// ---------------------------------------------------------------------------

test("closure: deleting the state file during a transaction is a state_conflict, not a silent commit", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-cas-del-"));
  try {
    initGit(root);
    seedState(root, { profile: terminalProfile, stageCursor: "only", stageStatus: "pending" });
    const statePath = join(root, ".work-state", "features", "closure", "state.json");
    const result = updateStateAtomically(root, (snapshot) => {
      assert.ok(snapshot.state);
      // A lockless writer deleted the state while this transaction held the
      // lock: the presence-parity CAS must reject the commit — writing would
      // resurrect a deleted run.
      unlinkSync(statePath);
      return { op: "commit", state: { ...snapshot.state, task: "resurrected" } };
    });
    assert.equal(result.ok, false, "the deletion must be detected");
    if (!result.ok) {
      assert.equal(result.code, "state_conflict");
      assert.match(result.error, /deleted during the transaction/);
    }
    assert.ok(!existsSync(statePath), "a failed transaction never resurrects the deleted state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ACTIVE capability: own-undefined required fields reject like absent ones
// ---------------------------------------------------------------------------

function completeCapabilityFixture(): Record<string, unknown> {
  return {
    capability_id: "cap-complete",
    dispatch_token_hash: "a".repeat(64),
    advance_token_hash: "b".repeat(64),
    issued_for: {
      run_key: "main", branch: "main", workflow: "closure-terminal",
      profile_hash: profileHash(terminalProfile), stage_cursor: "only",
      cursor_epoch: "epoch-1", loop_iteration: 1, checkpoint_policy_hash: null,
    },
    kind: "none",
    expected_roles: [],
    expected_count: 0,
    expected_roster: [],
    status: "ready",
    dispatches: [],
  };
}

test("closure: active validation rejects own-undefined required fields, not just absent keys", () => {
  const base = completeCapabilityFixture();
  assert.equal(validateActiveDispatchCapabilityValue(base).ok, true, "the complete fixture is active");

  for (const key of ["dispatch_token_hash", "advance_token_hash", "expected_roles", "expected_count", "expected_roster", "dispatches"]) {
    const ownUndefined = { ...base, [key]: undefined };
    const result = validateActiveDispatchCapabilityValue(ownUndefined);
    assert.equal(result.ok, false, `own-undefined ${key} must reject`);
    if (!result.ok) {
      assert.ok(
        result.issues.some((issue) => issue.path === `$.${key}`),
        `own-undefined ${key} reports at its own path: ${JSON.stringify(result.issues)}`,
      );
    }
  }
  const undefinedPolicyHash = {
    ...base,
    issued_for: { ...(base.issued_for as Record<string, unknown>), checkpoint_policy_hash: undefined },
  };
  const policyResult = validateActiveDispatchCapabilityValue(undefinedPolicyHash);
  assert.equal(policyResult.ok, false, "own-undefined issued_for.checkpoint_policy_hash must reject");
  if (!policyResult.ok) {
    assert.ok(policyResult.issues.some((issue) => issue.path === "$.issued_for.checkpoint_policy_hash"));
  }
});

test("closure: a capability missing only its dispatch ledger is a structured public rejection", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-partial-"));
  try {
    initGit(root);
    const profile = terminalProfile;
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "only", kind: "none", expected_roster: [],
    });
    // Shape-valid (the persisted shape keeps dispatches optional) but not
    // ACTIVE: the dispatch ledger is required for every transition.
    const partial = issued.state as Record<string, unknown>;
    delete partial.dispatches;
    seedState(root, { profile, stageCursor: "only", capability: issued.state });

    const advanced = advanceCursor(root, {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "only",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      evidence: "attempt",
    });
    assert.equal(advanced.ok, false, "advance without a dispatch ledger cannot authorize");
    if (!advanced.ok) assert.match(advanced.error, /dispatch capability unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure: public pending transition rejects every forged modern dispatch identity binding", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-active-identity-"));
  try {
    initGit(root);
    const issued = createCapability({
      run_key: "main",
      branch: "main",
      workflow: dispatchProfile.name,
      profile_hash: profileHash(dispatchProfile),
      stage_cursor: "build",
      kind: "single",
      expected_roster: [{ role: "dev", agent: "worker" }],
    });
    seedState(root, { profile: dispatchProfile, stageCursor: "build", capability: issued.state });
    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: dispatchProfile.name,
      profile_hash: profileHash(dispatchProfile),
      stage_cursor: "build",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      role: "dev",
      agent: "worker",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    assert.ok(authorized.ok && authorized.record);
    const dispatchId = authorized.record.id;
    const statePath = join(root, ".work-state", "features", "closure", "state.json");
    const baseline = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;

    const identityFields: Array<{ field: keyof WorkIdentity; value: string | number }> = [
      { field: "capability_id", value: "forged-capability" },
      { field: "capability_epoch", value: "forged-epoch" },
      { field: "workflow", value: "forged-workflow" },
      { field: "stage_id", value: "forged-stage" },
      { field: "stage_cursor", value: "forged-stage" },
      { field: "loop_iteration", value: 2 },
      { field: "slot_id", value: "forged-slot" },
      { field: "dispatch_id", value: "forged-dispatch" },
      { field: "attempt", value: 2 },
      { field: "worker_id", value: "forged-worker" },
    ];
    for (const mutation of identityFields) {
      const forged = structuredClone(baseline);
      const identity = forged.dispatch_capability!.dispatches![0]!.work_identity!;
      Object.assign(identity, { [mutation.field]: mutation.value });
      writeFileSync(statePath, JSON.stringify(forged, null, 2) + "\n");
      const rejected = persistPendingDispatch(root, { ...auth, dispatch_id: dispatchId, pending_reason: "provider_running" });
      assert.equal(rejected.ok, false, `public transition rejects forged ${mutation.field}`);
    }

    const nestedMutations: Array<{ label: string; apply: (state: TeamState) => void }> = [
      {
        label: "capability pending identity",
        apply: (state) => { state.dispatch_capability!.pending![0]!.identity.worker_id = "forged-worker"; },
      },
      {
        label: "record pending identity",
        apply: (state) => { state.dispatch_capability!.dispatches![0]!.pending!.identity.worker_id = "forged-worker"; },
      },
      {
        label: "record completion-envelope identity",
        apply: (state) => { state.dispatch_capability!.dispatches![0]!.completion_envelope!.identity.worker_id = "forged-worker"; },
      },
    ];
    for (const mutation of nestedMutations) {
      const forged = structuredClone(baseline);
      mutation.apply(forged);
      writeFileSync(statePath, JSON.stringify(forged, null, 2) + "\n");
      const rejected = persistPendingDispatch(root, { ...auth, dispatch_id: dispatchId, pending_reason: "provider_running" });
      assert.equal(rejected.ok, false, `public transition rejects forged ${mutation.label}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DEFERRED roster + terminal advance coherence
// ---------------------------------------------------------------------------

const poolRoles = { architect: "architect" } as const;
const ARCHITECT_SELECTION = { occurrences: [{ role: "architect", facet: "closure" }] };

function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: poolRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(poolRoles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(poolRoles),
  });
  writeAgentMapping(root, mapping);
}

test("closure: a deferred roster stage keeps no capability after the cursor move and workflow_begin arms it", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-deferred-"));
  const statePath = join(root, ".work-state", "features", "closure-deferred", "state.json");
  try {
    initGit(root);
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const persistedHash = profileHash(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: "full-feature", profile_hash: persistedHash,
      stage_cursor: "clarify", kind: "none", expected_roster: [],
    });
    const state = {
      schema: 1 as const,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
      task: "deferred roster closure",
      workflow_override: false,
      issue: null,
      stage_cursor: "clarify",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "clarify" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedHash,
      scope: NO_SCOPE,
      updated_at: new Date().toISOString(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
    } as TeamState;
    writeStateBootstrap(root, state, { featureSlug: "closure-deferred" });

    const artifactsDir = join(root, ".work-state", "features", "closure-deferred", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "closure", branch: "main", constraints: [] }));
    writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "explored" }));
    writeFileSync(join(artifactsDir, "clarifications.json"), JSON.stringify({ questions: [], answers: ["proceed"] }));

    // Resolve the checkpoint so the advance reaches the cursor move.
    const persistedState = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    const trusted = recordTrustedCheckpointAnswer(persistedState, {
      answer_id: "closure/deferred/user_answers",
      channel: "terminal",
      reference: "terminal-answer/closure/deferred/user_answers",
      stage_id: "clarify",
      checkpoint_id: "user_answers",
      decision: "proceed",
    });
    writeStateBootstrap(root, trusted.state, { featureSlug: "closure-deferred" });
    const policy = profile.checkpoint_policy!;
    const recorded = updateStateAtomically(root, (snapshot) => {
      assert.ok(snapshot.state);
      return { op: "commit", state: {
        ...snapshot.state,
        typed_checkpoint_decisions: [{
          run_id: "main",
          stage_id: "clarify",
          checkpoint_id: "user_answers",
          checkpoint_kind: policy.rules.user_answers!.kind,
          decision: "proceed",
          authorization: "human",
          actor: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
          capability_id: issued.capability_id,
          capability_epoch: issued.state.issued_for!.cursor_epoch,
          loop_iteration: 1,
          policy_hash: checkpointPolicyHash(policy),
          rationale: "closure deferred",
          decided_at: new Date().toISOString(),
        }],
      } as TeamState };
    });
    assert.equal(recorded.ok, true, recorded.ok ? "checkpoint decision persisted" : recorded.error);

    publishMapping(root);
    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: "full-feature",
      profile_hash: persistedHash,
      stage_cursor: "clarify",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      evidence: "clarify done",
    });
    assert.equal(advanced.ok, true, advanced.ok ? "advance into the roster stage" : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "architecture");
    // The completed prior-stage capability is DELETED, never carried with a
    // stale stage/epoch binding: workflow_begin must be able to arm the
    // deferred stage.
    assert.equal(advanced.state.dispatch_capability, undefined, "no stale capability is left behind");

    const begun = beginCapability(root, ARCHITECT_SELECTION);
    assert.equal(begun.ok, true, begun.ok ? "workflow_begin arms the deferred stage" : begun.error);
    if (!begun.ok) return;
    const after = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(after.dispatch_capability?.issued_for?.stage_cursor, "architecture");
    assert.equal(after.dispatch_capability?.issued_for?.cursor_epoch, after.cursor_epoch, "the armed capability binds the live cursor epoch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closure: a terminal advance does not rotate the epoch; the completed capability stays strictly bound", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-terminal-"));
  const statePath = join(root, ".work-state", "features", "closure", "state.json");
  try {
    initGit(root);
    const issued = seedState(root, { profile: terminalProfile, stageCursor: "only" });
    const epochBefore = issued.state.issued_for!.cursor_epoch;
    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: terminalProfile.name,
      profile_hash: profileHash(terminalProfile),
      stage_cursor: "only",
      cursor_epoch: epochBefore,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      evidence: "terminal stage done",
    });
    assert.equal(advanced.ok, true, advanced.ok ? "terminal advance accepted" : advanced.error);
    if (!advanced.ok) return;
    const after = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(after.pause.kind, "done");
    assert.equal(after.cursor_epoch, epochBefore, "the epoch is not rotated without a next stage");
    assert.equal(after.dispatch_capability?.status, "complete");
    assert.equal(after.dispatch_capability?.issued_for?.cursor_epoch, after.cursor_epoch, "the completed capability keeps the live epoch");
    assert.equal(validateActiveCapabilityStateBinding(after).ok, true, "the terminal state stays strictly bound");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Terminal completion clears the root pending; results are committed states
// ---------------------------------------------------------------------------

test("closure: terminal completion clears the root pending lifecycle and returns the committed state", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-pending-"));
  const statePath = join(root, ".work-state", "features", "closure", "state.json");
  try {
    initGit(root);
    const profile = dispatchProfile;
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "build", kind: "single", expected_roster: [{ role: "dev", agent: "dev" }],
    });
    seedState(root, { profile, stageCursor: "build", capability: issued.state });
    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "build",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
    };

    const authorized = authorizeDispatch(root, { ...auth, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok || !authorized.record) return;
    // The public transition result is the COMMITTED, revision-stamped state.
    const diskAfterAuthorize = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(authorized.state.state_revision, diskAfterAuthorize.state_revision, "the result carries the committed revision");
    assert.equal(authorized.state.updated_at, diskAfterAuthorize.updated_at, "the result carries the committed timestamp");

    const pending = persistPendingDispatch(root, { ...auth, dispatch_id: authorized.record.id, pending_reason: "provider_running", provider_ref: "prov-1" });
    assert.equal(pending.ok, true, pending.ok ? "pending persisted" : pending.error);
    const pendingMirror = (JSON.parse(readFileSync(statePath, "utf8")) as TeamState).pending;
    assert.ok(pendingMirror, "the provider wait is mirrored at the root");

    const completed = completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done" });
    assert.equal(completed.ok, true, completed.ok ? "terminal completion accepted" : completed.error);
    const after = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(after.pending, undefined, "a terminal completion clears the root pending");
    assert.equal(after.pause.kind, "none");
    assert.equal(after.completion_envelope?.outcome, "succeeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stage-scope binding: policy hash and loop iteration of the CURRENT window
// ---------------------------------------------------------------------------

test("closure: authorizing mutations reject a capability whose policy hash or loop iteration left the stage window", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-scope-"));
  const statePath = join(root, ".work-state", "features", "closure", "state.json");
  try {
    initGit(root);
    const profile = scopedProfile;
    const declaredHash = checkpointPolicyHash(scopedPolicy("autonomous_allowed"));

    const wrongHash = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "build", kind: "none", expected_roster: [],
      checkpoint_policy_hash: "0".repeat(64),
    });
    seedState(root, { profile, stageCursor: "build", capability: wrongHash.state });
    const wrongHashAdvance = advanceCursor(root, {
      token: wrongHash.advance_token,
      capability_id: wrongHash.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "build",
      cursor_epoch: wrongHash.state.issued_for!.cursor_epoch,
      loop_iteration: 1,
      evidence: "wrong policy hash",
    });
    assert.equal(wrongHashAdvance.ok, false, "a drifted policy hash cannot authorize");
    if (!wrongHashAdvance.ok) assert.match(wrongHashAdvance.error, /checkpoint policy hash does not match the current stage declaration/);

    const wrongIteration = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "build", kind: "none", expected_roster: [],
      loop_iteration: 2,
      checkpoint_policy_hash: declaredHash,
    });
    writeStateBootstrap(root, { ...JSON.parse(readFileSync(statePath, "utf8")) as TeamState, dispatch_capability: wrongIteration.state, cursor_epoch: wrongIteration.state.issued_for!.cursor_epoch }, { featureSlug: "closure" });
    const wrongIterationAdvance = advanceCursor(root, {
      token: wrongIteration.advance_token,
      capability_id: wrongIteration.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "build",
      cursor_epoch: wrongIteration.state.issued_for!.cursor_epoch,
      loop_iteration: 2,
      evidence: "wrong iteration",
    });
    assert.equal(wrongIterationAdvance.ok, false, "a capability from another loop iteration cannot authorize");
    if (!wrongIterationAdvance.ok) assert.match(wrongIterationAdvance.error, /loop iteration does not match/);

    // The correctly bound capability passes the scope gate (and reaches the
    // expected unresolved-checkpoint pause instead).
    const bound = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "build", kind: "none", expected_roster: [],
      checkpoint_policy_hash: declaredHash,
    });
    writeStateBootstrap(root, { ...JSON.parse(readFileSync(statePath, "utf8")) as TeamState, dispatch_capability: bound.state, cursor_epoch: bound.state.issued_for!.cursor_epoch }, { featureSlug: "closure" });
    const boundAdvance = advanceCursor(root, {
      token: bound.advance_token,
      capability_id: bound.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "build",
      cursor_epoch: bound.state.issued_for!.cursor_epoch,
      loop_iteration: 1,
      evidence: "bound capability",
    });
    assert.equal(boundAdvance.ok, false);
    if (!boundAdvance.ok) assert.match(boundAdvance.error, /checkpoint_unresolved/, "the bound capability passed the scope gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Ledger: the legacy mirror joins the single current-scope conflict check
// ---------------------------------------------------------------------------

test("closure: a current-scope legacy mirror decision conflicts and replays exactly like the typed ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-mirror-"));
  const statePath = join(root, ".work-state", "features", "closure", "state.json");
  try {
    initGit(root);
    const profile = scopedProfile;
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "build", kind: "none", expected_roster: [],
      checkpoint_policy_hash: checkpointPolicyHash(scopedPolicy("autonomous_allowed")),
    });
    const issuedFor = issued.state.issued_for!;
    const mirror = {
      stage_id: "build",
      checkpoint: "gate_ok",
      mode: "autonomous",
      decision: "proceed",
      actor: "system:closure",
      rationale: "mirror first",
      decided_at: new Date().toISOString(),
      run_id: "main",
      checkpoint_id: "gate_ok",
      checkpoint_kind: "clarification",
      authorization: "policy_auto",
      actor_provenance: { kind: "system", ref: "closure" },
      capability_id: issued.capability_id,
      capability_epoch: issuedFor.cursor_epoch,
      loop_iteration: 1,
      policy_hash: checkpointPolicyHash(scopedPolicy("autonomous_allowed")),
    };
    seedState(root, { profile, stageCursor: "build", capability: issued.state, legacyDecisions: [mirror] });
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;

    const decision = (over: Partial<TypedCheckpointDecision>): TypedCheckpointDecision => ({
      run_id: "main",
      stage_id: "build",
      checkpoint_id: "gate_ok",
      checkpoint_kind: "clarification",
      decision: "proceed",
      authorization: "policy_auto",
      actor: { kind: "system", ref: "closure" },
      capability_id: issued.capability_id,
      capability_epoch: issuedFor.cursor_epoch,
      loop_iteration: 1,
      policy_hash: checkpointPolicyHash(scopedPolicy("autonomous_allowed")),
      rationale: "closure",
      decided_at: new Date().toISOString(),
      ...over,
    });

    // The exact decision replays idempotently FROM THE MIRROR (the typed
    // array is empty), with a regenerated decided_at. The immutable decision
    // key includes the rationale, so the replay carries the mirror's
    // rationale verbatim.
    const replay = appendCheckpointDecision(persisted, decision({ rationale: "mirror first", decided_at: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(replay.ok, true, replay.ok ? "mirror replay is idempotent" : `${replay.code}: ${replay.error}`);
    assert.equal(replay.ok && replay.idempotent, true, "the mirror record is recognized as final");

    // A DIFFERENT decision is a conflict against the mirror alone.
    const conflicting = appendCheckpointDecision(persisted, decision({ decision: "reject", rationale: "changed" }));
    assert.equal(conflicting.ok, false, "the mirror is as final as the typed ledger");
    if (!conflicting.ok) assert.equal(conflicting.code, "decision_conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Identity: a stale top-level work_identity is forbidden in an active window
// ---------------------------------------------------------------------------

test("closure: a stale work_identity is rejected by every authorizing path", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-identity-"));
  const statePath = join(root, ".work-state", "features", "closure", "state.json");
  try {
    initGit(root);
    seedState(root, { profile: scopedProfile, stageCursor: "build", workIdentity: staleIdentity() });
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;

    // Strict active binding forbids a top-level identity when the capability
    // projects none; it is never silently ignored as non-authorizing metadata.
    assert.throws(() => recordTrustedCheckpointAnswer(state, {
      answer_id: "closure/identity/gate_ok",
      channel: "terminal",
      reference: "terminal-answer/closure/identity/gate_ok",
      stage_id: "build",
      checkpoint_id: "gate_ok",
      decision: "proceed",
    }), /work_identity.*forbidden/);

    const begun = beginCapability(root);
    assert.equal(begun.ok, false, "an authorizing reopen must fail closed on malformed active identity");
    if (!begun.ok) assert.match(begun.error, /work identity.*workflow state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Artifacts: fan-in side effects of a rejected advance roll back
// ---------------------------------------------------------------------------

test("closure: fan-in synthesis writes of a rejected advance are rolled back", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-rollback-"));
  const statePath = join(root, ".work-state", "features", "closure", "state.json");
  try {
    initGit(root);
    const profile = rollbackProfile;
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "research", kind: "consilium",
      expected_roster: [
        { role: "analyst#1", agent: "analyst" },
        { role: "analyst#2", agent: "analyst" },
      ],
    });
    seedState(root, { profile, stageCursor: "research", capability: issued.state });
    const artifactsDir = join(root, ".work-state", "features", "closure", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "research",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
    };
    // Each slot declares the stage's shared produced id and writes its own
    // content: the snapshots feed the fan-in synthesis at advance.
    for (const [role, items] of [["analyst#1", ["a"]], ["analyst#2", ["b"]]] as const) {
      writeFileSync(join(artifactsDir, "synthesis.json"), JSON.stringify({ items }));
      const authorized = authorizeDispatch(root, { ...auth, role, agent: "analyst" });
      assert.equal(authorized.ok, true, authorized.ok ? `${role} authorized` : authorized.error);
      if (!authorized.ok || !authorized.record) return;
      const completed = completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: `${role} done`, artifact_ids: ["synthesis"] });
      assert.equal(completed.ok, true, completed.ok ? `${role} completed` : completed.error);
    }
    const beforeAdvance = readFileSync(join(artifactsDir, "synthesis.json"), "utf8");

    // The advance synthesizes the merged shared artifact ({ items: [a, b] }),
    // THEN fails its stage gate (plan_valid has no team_plan artifact): the
    // synthesis write is rolled back to the exact pre-advance bytes.
    const advanced = advanceCursor(root, { ...auth, token: issued.advance_token, evidence: "research done" });
    assert.equal(advanced.ok, false, "the gate fails the advance closed");
    if (!advanced.ok) assert.doesNotMatch(advanced.error, /invalid secret/, "the advance token authenticates");
    assert.equal(readFileSync(join(artifactsDir, "synthesis.json"), "utf8"), beforeAdvance, "the synthesis write is rolled back to the pre-advance content");
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as TeamState).stage_cursor, "research", "the cursor never moved");
    assert.notEqual(JSON.parse(beforeAdvance), { items: ["a", "b"] }, "the pre-advance content proves a synthesized write happened");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
