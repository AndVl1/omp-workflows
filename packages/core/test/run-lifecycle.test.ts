import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  LifecycleError,
  createSelectionSnapshot,
  listRuns,
  persistCanonicalRun,
  readRunControl,
  readRunState,
  recordPrepareReceipt,
  resolveRunSelection,
  selectRunCandidate,
  resumeCanonicalRun,
  acquireExecutionClaim,
  releaseExecutionClaim,
  beginLifecycleTransaction,
  recoverLifecycleTransactions,
  lifecycleTransactionStatus,
  lifecycleTransactionPath,
  runStatePath,
  snapshotCanonicalRun,
  validateExactPrepareReplay,
  newRequestForTask,
  resolveCanonicalRun,
  prepareWorkflowState,
  run,
  updateCanonicalRun,
  finalizeCanonicalRun,
  discoverLegacySources,
  preflightLegacyMigration,
} from "../src/index.js";
import type {
  LifecycleRequest,
  RunCandidate,
  TeamState,
  TrustedExecutionContext,
  WorkIdentity,
} from "../src/engine/types.js";
import type { TaskCaller } from "../src/index.js";
const BRANCH = "feature/lifecycle-regression";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: "full-feature" as const,
};

function scratch(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", BRANCH], { stdio: "ignore" });
}

function context(root: string, sessionId: string, branch = BRANCH, processId = process.pid): TrustedExecutionContext {
  return {
    session_id: sessionId,
    caller: "host",
    process_id: processId,
    worktree: root,
    branch,
    authority: "coordinator",
  };
}

function childClaim(root: string, runId: string, sessionId: string): Promise<{ code: number | null; output: string }> {
  const script = `
    import { acquireExecutionClaim } from './packages/core/src/index.ts';
    const [root, runId, sessionId] = process.argv.slice(1);
    try {
      acquireExecutionClaim(root, {
        run_id: runId,
        context: {
          session_id: sessionId,
          caller: 'host',
          process_id: process.pid,
          worktree: root,
          branch: '${BRANCH}',
          authority: 'coordinator'
        }
      });
      process.stdout.write('acquired');
    } catch (error) {
      process.stdout.write(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed');
      process.exitCode = 1;
    }
  `;
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, runId, sessionId], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("close", (code) => resolveResult({ code, output }));
  });
}

function candidate(runId: string, title: string, status: RunCandidate["status"] = "paused", branch = BRANCH): RunCandidate {
  return {
    run_id: runId,
    title,
    task: title,
    branch,
    status,
    stage: "implementation",
    updated_at: "2026-09-19T00:00:00.000Z",
    rework_generation: 0,
  };
}

function state(runId: string, overrides: Partial<TeamState> = {}): TeamState {
  return {
    schema: 2,
    run_id: runId,
    run_key: runId,
    title: "Lifecycle regression",
    lifecycle_status: "paused",
    branch: BRANCH,
    classification: CLASSIFICATION,
    task: "Lifecycle regression task",
    workflow_override: true,
    issue: null,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "pending" }],
    artifacts: { upstream: "artifacts/upstream.json", downstream: "artifacts/downstream.json" },
    pause: { kind: "user_checkpoint", reason: "waiting for coordinator" },
    updated_at: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function identity(runId: string, workflow: WorkIdentity["workflow"] = "full-feature"): WorkIdentity {
  return {
    run_id: runId,
    wave_id: "wave-1",
    slice_id: "slice-1",
    session_id: "session-1",
    workflow,
    stage_id: "implementation",
    stage_cursor: "implementation",
    capability_id: "capability-1",
    capability_epoch: "epoch-1",
    slot_id: "slot-1",
    task_id: "task-1",
    dispatch_id: "dispatch-1",
    attempt: 1,
    worker_id: "worker-1",
  };
}

function prepareRequest(root: string, requestId = randomUUID()): LifecycleRequest {
  return {
    mode: "new",
    request_id: requestId,
    task: "same task text",
    branch: BRANCH,
    execution: context(root, "prepare-session"),
    classification: CLASSIFICATION,
  };
}
function prepareOptions(root: string, task: string, requestId: string, execution: TrustedExecutionContext) {
  return {
    task,
    cwd: root,
    branch: BRANCH,
    autonomous: false,
    classification: { type: "BUG_FIX" as const, complexity: "QUICK" as const, confidence: "HIGH" as const, autonomous: false },
    files: [],
    issue: null,
    mode: "new" as const,
    request_id: requestId,
    execution,
  };
}

test("explicit terminal resume is run_terminal and never falls back", () => {
  const terminal = candidate("11111111-1111-4111-8111-111111111111", "Finished export", "complete");
  const resumable = candidate("22222222-2222-4222-8222-222222222222", "Another export");
  const result = selectRunCandidate({
    mode: "resume",
    candidates: [terminal, resumable],
    currentBranch: BRANCH,
    selector: { run_id: terminal.run_id },
    sessionRunId: resumable.run_id,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.error.code, "run_terminal");
  assert.equal(result.error.run_id, terminal.run_id);
  assert.deepEqual(result.candidates, [resumable]);
});

test("invalid explicit selector does not use session or branch fallback", () => {
  const resumable = candidate("33333333-3333-4333-8333-333333333333", "Export reports");
  const result = selectRunCandidate({
    mode: "resume",
    candidates: [resumable],
    currentBranch: BRANCH,
    selector: { title: "No such export" },
    sessionRunId: resumable.run_id,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "run_not_found");
  assert.match(result.error.message, /explicit selector/);
});

test("identical titles require an explicit candidate choice", () => {
  const first = candidate("13131313-1313-4131-8131-131313131313", "Export reports");
  const second = candidate("14141414-1414-4141-8141-141414141414", "Export reports");
  const result = selectRunCandidate({
    mode: "resume",
    candidates: [first, second],
    currentBranch: BRANCH,
    selector: { title: "export reports" },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "run_selection_required");
  assert.deepEqual(result.candidates.map((entry) => entry.run_id), [first.run_id, second.run_id]);
  assert.equal(result.snapshot?.candidates.length, 2);
});

test("unique title fragment resolves its intended candidate", () => {
  const first = candidate("15151515-1515-4151-8151-151515151515", "Export reports");
  const second = candidate("16161616-1616-4161-8161-161616161616", "Repair billing");
  const result = selectRunCandidate({
    mode: "resume",
    candidates: [first, second],
    currentBranch: BRANCH,
    selector: { title: "billing" },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidate.run_id, second.run_id);
  assert.equal(result.selector, "explicit_title");
});

test("read-only listing ignores legacy-only state and does not create canonical control", () => {
  const root = scratch("omp-lifecycle-legacy-list");
  try {
    const legacyRoot = join(root, ".work-state");
    mkdirSync(join(legacyRoot, "artifacts"), { recursive: true });
    const legacyPath = join(legacyRoot, "team-state.json");
    const legacyState = {
      schema: 1,
      branch: BRANCH,
      run_key: `${BRANCH}:root`,
      classification: CLASSIFICATION,
      task: "legacy only",
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "pending" as const }],
      artifacts: { history: "artifacts/history.json" },
      pause: { kind: "none" as const, reason: "" },
      updated_at: "2026-09-19T00:00:00.000Z",
    };
    const legacyBytes = JSON.stringify(legacyState, null, 2) + "\n";
    writeFileSync(join(legacyRoot, "artifacts", "history.json"), JSON.stringify({ preserved: true }) + "\n");
    writeFileSync(legacyPath, legacyBytes);
    const discovery = discoverLegacySources(root);
    assert.equal(discovery.sources.length, 1);
    const source = discovery.sources[0];
    assert.ok(source);
    const preflight = preflightLegacyMigration(root, source);
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    assert.deepEqual(listRuns(root), []);
    assert.equal(existsSync(join(legacyRoot, "runs")), false);
    assert.equal(existsSync(join(legacyRoot, "run-control.json")), false);
    assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection snapshot keeps list item identity after a later run is added", () => {
  const first = candidate("44444444-4444-4444-8444-444444444444", "First run");
  const second = candidate("55555555-5555-4555-8555-555555555555", "Second run");
  const snapshot = {
    snapshot_id: "snapshot-1",
    created_at: "2026-09-19T00:00:00.000Z",
    branch: BRANCH,
    candidates: [first],
  };
  const result = resolveRunSelection({
    mode: "resume",
    candidates: [first, second],
    currentBranch: BRANCH,
    snapshot,
    selector: { list_item: { snapshot_id: snapshot.snapshot_id, index: 0, run_id: first.run_id } },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.candidate.run_id, first.run_id);
  assert.equal(result.selector, "list_item");
});

test("two new canonical runs on one branch remain independently listed and readable", () => {
  const root = scratch("omp-lifecycle-independent");
  try {
    const firstId = "66666666-6666-4666-8666-666666666666";
    const secondId = "77777777-7777-4777-8777-777777777777";
    persistCanonicalRun(root, state(firstId, { task: "first task" }));
    persistCanonicalRun(root, state(secondId, { task: "second task" }));

    const listed = listRuns(root, { branch: BRANCH });
    assert.deepEqual(new Set(listed.map((run) => run.run_id)), new Set([firstId, secondId]));
    assert.equal(readRunState(root, firstId)?.task, "first task");
    assert.equal(readRunState(root, secondId)?.task, "second task");

    const snapshot = createSelectionSnapshot(root, { branch: BRANCH });
    persistCanonicalRun(root, state("88888888-8888-4888-8888-888888888888", { task: "later task" }));
    const selected = resolveRunSelection({
      mode: "resume",
      candidates: listRuns(root, { branch: BRANCH }),
      currentBranch: BRANCH,
      snapshot,
      selector: { list_item: { snapshot_id: snapshot.snapshot_id, index: 0, run_id: snapshot.candidates[0]!.run_id } },
    });
    assert.equal(selected.ok, true);
    if (selected.ok) assert.equal(selected.candidate.run_id, snapshot.candidates[0]!.run_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare creates independent new runs and exact replay returns the first receipt", () => {
  const root = scratch("omp-lifecycle-prepare");
  try {
    initGit(root);
    const execution = context(root, "prepare-ingress");
    const first = prepareWorkflowState(prepareOptions(root, "first ingress task", "prepare-a", execution));
    const second = prepareWorkflowState(prepareOptions(root, "second ingress task", "prepare-b", execution));
    assert.notEqual(first.state.run_id, second.state.run_id);
    assert.equal(first.transition?.operation, "new");
    assert.equal(first.transition?.previous_run_id, null);
    assert.equal(readRunState(root, second.state.run_id!)?.task, "second ingress task");
    assert.equal(readRunState(root, first.state.run_id!)?.task, "first ingress task");
    const normalized = resolveCanonicalRun(root, { kind: "team", runId: first.state.run_id! });
    assert.equal(normalized?.state?.migration, undefined);
    const replay = prepareWorkflowState(prepareOptions(root, "first ingress task", "prepare-a", execution));
    assert.equal(replay.transition?.selected_run_id, first.transition?.selected_run_id);
    assert.equal(listRuns(root, { branch: BRANCH }).length, 2);
    assert.throws(
      () => prepareWorkflowState(prepareOptions(root, "changed ingress task", "prepare-a", execution)),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    assert.equal(listRuns(root, { branch: BRANCH }).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("busy new start publishes neither a second run nor a partial control transition", () => {

  const root = scratch("omp-lifecycle-busy");
  try {
    const firstId = "99999999-9999-4999-8999-999999999999";
    const secondId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const owner = context(root, "owner-session");
    persistCanonicalRun(root, state(firstId));
    acquireExecutionClaim(root, { run_id: firstId, context: owner, worker_ids: ["worker-1"] });
    const before = readRunControl(root);

    assert.throws(
      () => persistCanonicalRun(root, state(secondId), { context: context(root, "other-session") }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readRunControl(root), before);
    assert.equal(existsSync(runStatePath(root, secondId)), false, "unpublished run must not have a state file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare rework snapshots evidence and invalidates downstream outputs", () => {
  const root = scratch("omp-lifecycle-rework");
  try {
    initGit(root);
    const execution = context(root, "rework-ingress");
    const prepared = prepareWorkflowState(prepareOptions(root, "rework ingress task", "rework-new", execution));
    assert.equal(prepared.profile.name, "bug-fix");
    const affectedStage = "implementation";
    const upstreamStage = "diagnose";
    const downstreamStage = "review";
    const diagnosisBytes = Buffer.from("{\"artifact\":\"diagnosis\",\"version\":1}\n", "utf8");
    const implementationBytes = Buffer.from("{\"artifact\":\"implementation\",\"version\":1}\n", "utf8");
    const reviewBytes = Buffer.from("{\"artifact\":\"review\",\"version\":1}\n", "utf8");
    mkdirSync(prepared.artifactsDir, { recursive: true });
    writeFileSync(join(prepared.artifactsDir, "diagnosis.json"), diagnosisBytes);
    writeFileSync(join(prepared.artifactsDir, "implementation.json"), implementationBytes);
    writeFileSync(join(prepared.artifactsDir, "review.json"), reviewBytes);
    updateCanonicalRun(root, prepared.state.run_id!, (current) => ({
      ...current,
      lifecycle_status: "complete",
      pause: { kind: "done", reason: "completed" },
      stages: current.stages.map((stage) => ({ ...stage, status: "done" as const })),
      artifacts: {
        diagnosis: "artifacts/diagnosis.json",
        implementation: "artifacts/implementation.json",
        review: "artifacts/review.json",
      },
    }));

    const reworked = prepareWorkflowState({
      ...prepareOptions(root, "ignored task text", "rework-apply", execution),
      mode: "rework" as const,
      run_id: prepared.state.run_id,
      feedback: "revisit the affected stage",
      affected_stage: affectedStage,
    });
    assert.equal(reworked.transition?.operation, "rework");
    assert.equal(reworked.state.stages.find((stage) => stage.id === affectedStage)?.status, "pending");
    assert.equal(reworked.state.stages.find((stage) => stage.id === downstreamStage)?.status, "pending");
    assert.equal(reworked.state.artifacts.diagnosis, "artifacts/diagnosis.json");
    assert.equal(reworked.state.artifacts.implementation, undefined);
    assert.equal(reworked.state.artifacts.review, undefined);
    assert.equal(reworked.state.stages.find((stage) => stage.id === upstreamStage)?.status, "done");
    const revisionsRoot = join(root, ".work-state", "runs", prepared.state.run_id!, "revisions");
    const revisionId = readdirSync(revisionsRoot)[0]!;
    assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, "artifacts", "diagnosis.json")), diagnosisBytes);
    assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, "artifacts", "implementation.json")), implementationBytes);
    assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, "artifacts", "review.json")), reviewBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare receipt exact replay is idempotent while changed payload conflicts", () => {
  const root = scratch("omp-lifecycle-replay");
  try {
    const request = prepareRequest(root, "request-replay-1");
    const receipt = {
      request_id: request.request_id,
      payload_hash: "placeholder",
      operation: "new" as const,
      previous_run_id: null,
      selected_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      committed_at: "2026-09-19T00:00:00.000Z",
      continuation: { stage: "implementation", status: "active" as const },
    };
    const first = recordPrepareReceipt(root, request, receipt);
    const replay = recordPrepareReceipt(root, request, { ...receipt, selected_run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    assert.deepEqual(replay, first);
    assert.equal(validateExactPrepareReplay(first, request).ok, true);

    const changed = { ...request, task: "changed payload" };
    assert.throws(
      () => recordPrepareReceipt(root, changed, receipt),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    const newRequestA = newRequestForTask({ task: request.task, branch: request.branch, execution: request.execution, classification: request.classification });
    const newRequestB = newRequestForTask({ task: request.task, branch: request.branch, execution: request.execution, classification: request.classification });
    assert.notEqual(newRequestA.request_id, newRequestB.request_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rework snapshot preserves artifact bytes and records their manifest hash", () => {
  const root = scratch("omp-lifecycle-snapshot");
  try {
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    persistCanonicalRun(root, state(runId));
    const artifactPath = join(root, ".work-state", "runs", runId, "artifacts", "upstream.json");
    mkdirSync(dirname(artifactPath), { recursive: true });
    const original = Buffer.from('{"upstream":"stable","bytes":[1,2,3]}\n', "utf8");
    writeFileSync(artifactPath, original);

    const snapshot = snapshotCanonicalRun(root, runId, "rework");
    const revisionDir = dirname(snapshot.manifest_path);
    const preserved = readFileSync(join(revisionDir, "artifacts", "upstream.json"));
    const manifest = JSON.parse(readFileSync(snapshot.manifest_path, "utf8")) as { artifact_sha256: Record<string, string> };
    assert.deepEqual(preserved, original);
    assert.equal(manifest.artifact_sha256["upstream.json"], createHash("sha256").update(original).digest("hex"));

    writeFileSync(artifactPath, Buffer.from('{"upstream":"invalidated"}\n', "utf8"));
    assert.deepEqual(readFileSync(join(revisionDir, "artifacts", "upstream.json")), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership tokens fence release and a live claim blocks another run", () => {
  const root = scratch("omp-lifecycle-claims");
  try {
    const firstId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const secondId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    persistCanonicalRun(root, state(firstId));
    const first = acquireExecutionClaim(root, { run_id: firstId, context: context(root, "claim-owner") });
    assert.throws(
      () => releaseExecutionClaim(root, { run_id: firstId, token: "stale-token" }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.equal(readRunControl(root).execution_claim?.token, first.claim.token);
    assert.throws(
      () => acquireExecutionClaim(root, { run_id: secondId, context: context(root, "other-owner") }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    releaseExecutionClaim(root, { run_id: firstId, token: first.claim.token, receipt: "trusted-release" });
    assert.equal(readRunControl(root).execution_claim, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent process starts serialize to one execution claim", async () => {
  const root = scratch("omp-lifecycle-process-race");
  try {
    const firstId = "abababab-abab-4bab-8bab-abababababab";
    const secondId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    persistCanonicalRun(root, state(firstId));
    persistCanonicalRun(root, state(secondId));
    const [first, second] = await Promise.all([
      childClaim(root, firstId, "process-one"),
      childClaim(root, secondId, "process-two"),
    ]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.equal(results.filter((result) => result.code !== 0).length, 1);
    assert.ok(results.find((result) => result.code !== 0)?.output.length);
    assert.ok(readRunControl(root).execution_claim);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run resume does not invoke task.call or task.batch for pending or succeeded work", async () => {
  const root = scratch("omp-lifecycle-run-resume");
  try {
    initGit(root);
    const execution = context(root, "run-resume-session");
    const prepared = prepareWorkflowState(prepareOptions(root, "run resume ingress", "run-new", execution));
    const runId = prepared.state.run_id!;
    const calls = { call: 0, batch: 0 };
    const taskTool: TaskCaller = {
      async call() {
        calls.call += 1;
        return { id: "unexpected-call", output: "unexpected", artifacts: {}, exitCode: 0 };
      },
      async batch() {
        calls.batch += 1;
        return [{ id: "unexpected-batch", output: "unexpected", artifacts: {}, exitCode: 0 }];
      },
    };
    const pending = {
      identity: identity(runId, prepared.state.classification.workflow),
      status: "pending" as const,
      pending_reason: "awaiting_result" as const,
      updated_at: "2026-09-19T00:00:00.000Z",
    };
    updateCanonicalRun(root, runId, (current) => ({
      ...current,
      lifecycle_status: "paused",
      pause: { kind: "background_wait", reason: "provider still running" },
      pending,
    }));
    await run({
      ...prepareOptions(root, "ignored pending task", "run-resume-pending", execution),
      mode: "resume" as const,
      run_id: runId,
      taskTool,
    });
    assert.deepEqual(calls, { call: 0, batch: 0 });

    updateCanonicalRun(root, runId, (current) => {
      const next = {
        ...current,
        lifecycle_status: "active" as const,
        pause: { kind: "none" as const, reason: "" },
        stages: current.stages.map((stage) => ({ ...stage, status: "done" as const })),
      };
      delete next.pending;
      return next;
    });
    await run({
      ...prepareOptions(root, "ignored succeeded task", "run-resume-succeeded", execution),
      mode: "resume" as const,
      run_id: runId,
      taskTool,
    });
    assert.deepEqual(calls, { call: 0, batch: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal recovery rolls back prepared authority without overwriting external bytes and repairs committing publication forward", () => {
  const rollbackRoot = scratch("omp-lifecycle-journal-rollback");
  const forwardRoot = scratch("omp-lifecycle-journal-forward");
  try {
    const rollbackPath = join(rollbackRoot, "scratch", "value.txt");
    mkdirSync(dirname(rollbackPath), { recursive: true });
    writeFileSync(rollbackPath, "before");
    const prepared = beginLifecycleTransaction({
      cwd: rollbackRoot,
      operation: "rework",
      before: { [rollbackPath]: "before" },
      after: { [rollbackPath]: "after" },
    });
    writeFileSync(rollbackPath, "torn-publication");
    const rolled = recoverLifecycleTransactions(rollbackRoot);
    assert.equal(rolled[0]?.status, "rolled_back");
    assert.equal(readFileSync(rollbackPath, "utf8"), "torn-publication");
    writeFileSync(rollbackPath, "newer-authority");
    assert.equal(recoverLifecycleTransactions(rollbackRoot)[0]?.status, "rolled_back");
    assert.equal(readFileSync(rollbackPath, "utf8"), "newer-authority");
    assert.equal(lifecycleTransactionStatus(rollbackRoot, prepared.transaction_id)?.status, "rolled_back");

    const forwardPath = join(forwardRoot, "scratch", "value.txt");
    mkdirSync(dirname(forwardPath), { recursive: true });
    writeFileSync(forwardPath, "before");
    const committing = beginLifecycleTransaction({
      cwd: forwardRoot,
      operation: "rework",
      before: { [forwardPath]: "before" },
      after: { [forwardPath]: "after" },
    });
    const recordPath = join(lifecycleTransactionPath(forwardRoot, committing.transaction_id), "transaction.json");
    const interrupted = { ...committing, status: "committing" as const, commit_marker: "publication-marker" };
    writeFileSync(recordPath, `${JSON.stringify(interrupted, null, 2)}\n`);
    writeFileSync(forwardPath, "partial-publication");
    assert.equal(recoverLifecycleTransactions(forwardRoot)[0]?.status, "committed");
    assert.equal(readFileSync(forwardPath, "utf8"), "after");
    writeFileSync(forwardPath, "newer-authority");
    assert.equal(recoverLifecycleTransactions(forwardRoot)[0]?.status, "committed");
    assert.equal(readFileSync(forwardPath, "utf8"), "newer-authority");
  } finally {
    rmSync(rollbackRoot, { recursive: true, force: true });
    rmSync(forwardRoot, { recursive: true, force: true });
  }
});

test("terminal finalization atomically publishes done state and releases the ownership claim", () => {
  const root = scratch("omp-lifecycle-terminal-finalize");
  try {
    const runId = "56565656-5656-4565-8565-565656565656";
    const owner = context(root, "terminal-finalizer");
    persistCanonicalRun(root, state(runId, {
      lifecycle_status: "active",
      pause: { kind: "none", reason: "" },
      stages: [{ id: "implementation", status: "done" }],
    }), { context: owner });
    const claim = readRunControl(root).execution_claim;
    assert.ok(claim);
    const before = readRunControl(root);
    assert.throws(
      () => finalizeCanonicalRun(root, runId, "stale-terminal-token"),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readRunControl(root), before);
    assert.equal(readRunState(root, runId)?.pause.kind, "none");

    const finalized = finalizeCanonicalRun(root, runId, claim.token);
    assert.equal(finalized.lifecycle_status, "complete");
    assert.equal(finalized.pause.kind, "done");
    const control = readRunControl(root);
    assert.equal(control.execution_claim, null);
    assert.equal(control.selections[owner.session_id]?.active, false);
    assert.equal(readRunState(root, runId)?.pause.kind, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal resume leaves state and ownership claim unchanged", () => {
  const root = scratch("omp-lifecycle-terminal");
  try {
    const runId = "12121212-1212-4121-8121-121212121212";
    const owner = context(root, "terminal-owner");
    persistCanonicalRun(root, state(runId, { lifecycle_status: "complete", pause: { kind: "done", reason: "completed" } }), { context: owner });
    const before = readRunControl(root);
    assert.throws(
      () => resumeCanonicalRun(root, runId, context(root, "new-session")),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_terminal",
    );
    assert.deepEqual(readRunControl(root), before);
    assert.equal(readRunState(root, runId)?.lifecycle_status, "complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume marks persisted pending work as transport reconnect without changing dispatch identity", () => {
  const root = scratch("omp-lifecycle-resume-pending");
  try {
    initGit(root);
    const runId = "34343434-3434-4343-8343-343434343434";
    const pending = {
      identity: identity(runId),
      status: "pending" as const,
      pending_reason: "awaiting_result" as const,
      updated_at: "2026-09-19T00:00:00.000Z",
    };
    persistCanonicalRun(root, state(runId, { pending }));
    const resumed = resumeCanonicalRun(root, runId, context(root, "resume-session"));
    assert.equal(resumed.lifecycle_status, "paused");
    assert.equal(resumed.pause.kind, "background_wait");
    assert.match(resumed.pause.reason, /transport_reconnect/);
    assert.deepEqual(resumed.pending?.identity, pending.identity);
    assert.equal(resumed.pending?.status, "pending");
    assert.equal(resumed.pending?.pending_reason, "transport_reconnect");
    const resumedAgain = resumeCanonicalRun(root, runId, context(root, "resume-session"));
    assert.deepEqual(resumedAgain.pending?.identity, pending.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
