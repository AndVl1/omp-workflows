import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitCtoStateForModel,
  readCtoStateForModel,
  recoverLegacyCtoIngress,
  acquireCtoIngress,
  suspendCtoSession,
} from "../src/cto/run.js";
import { newCtoState, readCtoState } from "../src/cto/state.js";
import { createWorkflowSessionController, type WorkflowSessionController } from "../src/engine/host-controller.js";
import { acquireExecutionClaim, readRunControl } from "../src/engine/run-store.js";
import { LifecycleError } from "../src/engine/run-lifecycle.js";
import type { TrustedExecutionContext } from "../src/engine/types.js";

const RUN_ID = "run-lifecycle-01a0bacd";
const BRANCH = "main";

function context(root: string, sessionId: string, caller: TrustedExecutionContext["caller"] = "host", authority: TrustedExecutionContext["authority"] = "coordinator"): TrustedExecutionContext {
  return {
    session_id: sessionId,
    caller,
    process_id: process.pid,
    worktree: root,
    branch: BRANCH,
    authority,
  };
}

function legacyFixture(root: string, runId = RUN_ID): { path: string; raw: Buffer } {
  const state = newCtoState({
    id: runId,
    task: "resume the existing CTO task",
    branch: BRANCH,
    autonomous: false,
    plan: { id: runId, task: "resume the existing CTO task", teams: [], created_at: "2026-09-27T00:00:00.000Z" },
  });
  const rawValue = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  rawValue.completion_intent = {
    mode: "handoff_only",
    acceptance: "explicit_human_acceptance",
    source: "workflow_policy",
  };
  delete rawValue.updated_at;
  rawValue.session = "old-coordinator-session";
  rawValue.workflow = "cto";
  rawValue.orchestration_profile = "legacy-cto";
  rawValue.stage = "teams";
  rawValue.checkpoint = "approve_implementation";
  rawValue.progress = { completed: 1, total: 2 };
  rawValue.teams = [{ id: "legacy-team", status: "in_progress", escalations: {} }];
  rawValue.wave_history = [{ id: "legacy-wave", source: "terminal", source_id: "legacy-wave-source", task: "resume the existing CTO task", slice_ids: [], status: "active" }];
  rawValue.active_wave_id = "legacy-wave";
  const raw = Buffer.from(JSON.stringify(rawValue, null, 2) + "\n", "utf8");
  const path = join(root, ".work-state", "cto", runId, "state.json");
  mkdirSync(join(root, ".work-state", "cto", runId), { recursive: true });
  writeFileSync(path, raw);
  return { path, raw };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof LifecycleError ? error.code : undefined;
}

function makeController(root: string, sessionId = "new-coordinator"): WorkflowSessionController {
  return createWorkflowSessionController({ cwd: root, context: context(root, sessionId) });
}

test("legacy CTO recovery repairs the exact malformed shape, commits strictly, and resumes normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-success-"));
  try {
    const fixture = legacyFixture(root);
    const controller = makeController(root);
    let confirmationSummary = "";
    const recovered = await recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller }, async (summary) => {
      confirmationSummary = summary;
      return true;
    });
    assert.ok(recovered);
    assert.equal(recovered.created, false);
    assert.equal(recovered.run_id, RUN_ID);
    assert.match(confirmationSummary, /Previous coordinator: old-coordinator-session/);
    assert.match(confirmationSummary, /New coordinator: new-coordinator/);
    assert.match(confirmationSummary, /previous coordinator AND all workers for this run have been stopped/);
    assert.ok(recovered.recovery);
    assert.deepEqual(readFileSync(join(root, recovered.recovery!.raw_backup_path)), fixture.raw);
    const repaired = JSON.parse(readFileSync(fixture.path, "utf8")) as Record<string, unknown>;
    assert.equal(repaired.owner_session, "new-coordinator");
    assert.equal(typeof repaired.updated_at, "string");
    assert.deepEqual(repaired.wave_history, JSON.parse(fixture.raw.toString("utf8")).wave_history);
    assert.equal(repaired.active_wave_id, "legacy-wave");
    assert.deepEqual(repaired.teams, JSON.parse(fixture.raw.toString("utf8")).teams);
    for (const key of ["session", "workflow", "orchestration_profile", "stage", "checkpoint", "progress"]) assert.equal(Object.prototype.hasOwnProperty.call(repaired, key), false);
    assert.equal(readRunControl(root).execution_claim?.run_id, RUN_ID);

    const read = readCtoStateForModel(controller, root, RUN_ID);
    const committed = commitCtoStateForModel({ controller, cwd: root, run_id: RUN_ID, expected_state_revision: read.state_revision, state: read.state });
    assert.equal(committed.transition, "state");
    suspendCtoSession(controller, "session-shutdown");
    const resumed = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "normal resume",
      run_id: RUN_ID,
      controller: makeController(root, "resumed-coordinator"),
    });
    assert.equal(resumed.created, false);
    assert.equal(resumed.run_id, RUN_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy CTO recovery denial leaves state, control, and backup namespace untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-denied-"));
  try {
    const fixture = legacyFixture(root);
    const controller = makeController(root);
    const denied = await recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller }, async () => false);
    assert.equal(denied, undefined);
    assert.deepEqual(readFileSync(fixture.path), fixture.raw);
    assert.equal(existsSync(join(root, ".work-state", "run-control.json")), false);
    assert.equal(existsSync(join(root, ".work-state", "cto", RUN_ID, "legacy-recovery")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy CTO recovery refuses foreign or headless contexts before confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-context-"));
  try {
    legacyFixture(root);
    const foreign = createWorkflowSessionController({ cwd: root, context: { ...context(root, "foreign"), branch: "other" } });
    await assert.rejects(
      recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: foreign }, async () => true),
      (error: unknown) => errorCode(error) === "run_context_mismatch",
    );
    const headless = createWorkflowSessionController({ cwd: root, context: context(root, "headless", "worker", "dispatch") });
    await assert.rejects(
      recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: headless }, async () => true),
      (error: unknown) => errorCode(error) === "lifecycle_request_conflict",
    );
    assert.equal(existsSync(join(root, ".work-state", "run-control.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy CTO recovery rejects snapshot drift while confirmation is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-drift-"));
  try {
    const fixture = legacyFixture(root);
    const controller = makeController(root);
    await assert.rejects(
      recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller }, async () => {
        writeFileSync(fixture.path, Buffer.concat([fixture.raw, Buffer.from("\n", "utf8")]));
        return true;
      }),
      (error: unknown) => errorCode(error) === "lifecycle_request_conflict",
    );
    assert.equal(existsSync(join(root, ".work-state", "run-control.json")), false);
    assert.equal(existsSync(join(root, ".work-state", "cto", RUN_ID, "legacy-recovery")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy CTO recovery refuses active claims and pending lease evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-busy-"));
  try {
    acquireExecutionClaim(root, {
      run_id: "11111111-1111-4111-8111-111111111111",
      context: context(root, "ordinary-owner"),
      owner_kind: "workflow",
    });
    legacyFixture(root);
    await assert.rejects(
      recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: makeController(root) }, async () => true),
      (error: unknown) => errorCode(error) === "run_busy",
    );

    const leaseRoot = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-lease-"));
    try {
      const leaseFixture = legacyFixture(leaseRoot);
      const legacy = JSON.parse(readFileSync(leaseFixture.path, "utf8")) as Record<string, unknown>;
      legacy.leases = { teams: { token: "opaque", acquired_at: "2026-09-27T00:00:00.000Z", heartbeat_at: "2026-09-27T00:00:00.000Z", ttl_ms: 0, pid: process.pid, team_id: "teams" } };
      writeFileSync(leaseFixture.path, JSON.stringify(legacy, null, 2) + "\n");
      await assert.rejects(
        recoverLegacyCtoIngress({ cwd: leaseRoot, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: makeController(leaseRoot) }, async () => true),
        (error: unknown) => errorCode(error) === "run_busy",
      );
    } finally {
      rmSync(leaseRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy CTO recovery preserves an original raw backup instead of overwriting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-backup-"));
  try {
    const fixture = legacyFixture(root);
    const sourceHash = createHash("sha256").update(fixture.raw).digest("hex");
    const backupPath = join(root, ".work-state", "cto", RUN_ID, "legacy-recovery", sourceHash, "raw-state.json");
    const originalBackup = Buffer.from("original immutable backup\n", "utf8");
    mkdirSync(join(root, ".work-state", "cto", RUN_ID, "legacy-recovery", sourceHash), { recursive: true });
    writeFileSync(backupPath, originalBackup);
    await assert.rejects(
      recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: makeController(root) }, async () => true),
      (error: unknown) => errorCode(error) === "recovery_required",
    );
    assert.deepEqual(readFileSync(backupPath), originalBackup);
    assert.deepEqual(readFileSync(fixture.path), fixture.raw);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy CTO recovery refuses symlinked output ancestors", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-outside-"));
  try {
    const fixture = legacyFixture(root);
    const recoveryRoot = join(root, ".work-state", "cto", RUN_ID, "legacy-recovery");
    symlinkSync(outside, recoveryRoot, "dir");
    await assert.rejects(
      recoverLegacyCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: makeController(root) }, async () => true),
      (error: unknown) => errorCode(error) === "recovery_required",
    );
    assert.deepEqual(readFileSync(fixture.path), fixture.raw);
    assert.equal(readRunControl(root).execution_claim, null);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("normal CTO ingress remains strict for the malformed legacy image", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-recovery-strict-"));
  try {
    legacyFixture(root);
    assert.throws(
      () => acquireCtoIngress({ cwd: root, branch: BRANCH, task: "resume", run_id: RUN_ID, controller: makeController(root) }),
      (error: unknown) => errorCode(error) === "recovery_required",
    );
    assert.equal(readCtoState(RUN_ID, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
