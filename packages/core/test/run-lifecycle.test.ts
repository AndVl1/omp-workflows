import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  LifecycleError,
  LifecycleRecoveryError,
  createSelectionSnapshot,
  listRuns,
  persistCanonicalRun,
  readRunControl,
  readRunState,
  resolveRunSelection,
  resolveLifecycleIntent,
  selectRunCandidate,
  resumeCanonicalRun,
  handoverExecutionClaim,
  acquireExecutionClaim,
  releaseExecutionClaim,
  beginLifecycleTransaction,
  recoverLifecycleTransactions,
  lifecycleTransactionStatus,
  lifecycleTransactionPath,
  runStatePath,
  lifecyclePayloadHash,
  snapshotCanonicalRun,
  validateExactPrepareReplay,
  resolveCanonicalRun,
  prepareWorkflowState,
  run,
  updateCanonicalRun,
  finalizeCanonicalRun,
  discoverLegacySources,
  preflightLegacyMigration,
  registerWorkflowProfiles,
  resolveWorkflowContract,
} from "../src/index.js";
import { reworkCanonicalRunAtomically, selectSession, updateRunControl } from "../src/engine/run-store.js";
import { createCapability } from "../src/engine/durable.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import type {
  CompletionEnvelope,
  DispatchCapabilityState,
  DispatchCompletion,
  DispatchRecord,
  LifecycleRequest,
  PrepareRequestReceipt,
  Profile,
  RunCandidate,
  PendingState,
  TeamState,
  TrustedExecutionContext,
  WorkIdentity,
} from "../src/engine/types.js";
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
function snapshotTree(root: string): Record<string, Buffer | null> {
  const snapshot: Record<string, Buffer | null> = {};
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(prefix, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[relativePath] = null;
        visit(absolutePath, relativePath);
      } else {
        snapshot[relativePath] = readFileSync(absolutePath);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return snapshot;
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

type ChildClaimOutcome = "acquired" | "run_busy";
type ChildClaimResult = { code: number | null; output: string; outcome?: ChildClaimOutcome };
type HeldChildClaim = {
  child: ChildProcess;
  attempt: Promise<ChildClaimResult>;
  closed: Promise<void>;
  release: () => void;
  terminate: () => void;
};

function childClaim(root: string, runId: string, sessionId: string, workerIds?: string[]): Promise<ChildClaimResult>;
function childClaim(root: string, runId: string, sessionId: string, workerIds: string[], options: { holdOpen: true }): HeldChildClaim;
function childClaim(
  root: string,
  runId: string,
  sessionId: string,
  workerIds: string[] = [],
  options?: { holdOpen: true },
): Promise<ChildClaimResult> | HeldChildClaim {
  const workerIdsLiteral = JSON.stringify(workerIds);
  const holdOpen = options?.holdOpen === true;
  const script = `
    import { acquireExecutionClaim } from './packages/core/src/index.ts';
    const [root, runId, sessionId] = process.argv.slice(1);
    let outcome = 'failed';
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
        },
        worker_ids: ${workerIdsLiteral}
      });
      outcome = 'acquired';
    } catch (error) {
      outcome = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed';
      process.exitCode = 1;
    }
    if (${String(holdOpen)}) {
      process.stdout.write('__claim_attempt__:' + outcome + '\\n');
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.once('data', () => process.exit());
    } else {
      process.stdout.write(outcome);
    }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, runId, sessionId], {
    cwd: REPO_ROOT,
    stdio: [holdOpen ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdoutOutput = "";
  let attemptSettled = false;
  let finalSettled = false;
  let resolveAttempt!: (result: ChildClaimResult) => void;
  let resolveFinal!: (result: ChildClaimResult) => void;
  let resolveClosed!: () => void;
  const attempt = new Promise<ChildClaimResult>((resolveResult) => { resolveAttempt = resolveResult; });
  const final = new Promise<ChildClaimResult>((resolveResult) => { resolveFinal = resolveResult; });
  const closed = new Promise<void>((resolveResult) => { resolveClosed = resolveResult; });
  const settleAttempt = (result: ChildClaimResult): void => {
    if (attemptSettled) return;
    attemptSettled = true;
    resolveAttempt(result);
  };
  const recordError = (error: unknown, stream?: string): void => {
    const message = error instanceof Error ? error.message : String(error);
    output += `\n${stream ? `${stream}: ` : ""}${message}`;
    settleAttempt({ code: null, output });
  };
  const settleFinal = (code: number | null): void => {
    if (finalSettled) return;
    finalSettled = true;
    const result = { code, output };
    settleAttempt(result);
    resolveFinal(result);
  };
  child.stdin?.on("error", (error) => recordError(error, "stdin"));
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutOutput += chunk;
    output += chunk;
    const marker = stdoutOutput.match(/__claim_attempt__:([^\n]+)\n/);
    if (marker) {
      if (marker[1] === "acquired" || marker[1] === "run_busy") {
        const outcome: ChildClaimOutcome = marker[1];
        settleAttempt({ code: outcome === "acquired" ? 0 : 1, output, outcome });
      } else {
        settleAttempt({ code: null, output });
      }
    }
  });
  child.stdout?.on("error", (error) => recordError(error, "stdout"));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("error", (error) => recordError(error, "stderr"));
  child.once("error", (error) => recordError(error));
  child.once("close", (code) => {
    settleFinal(code);
    resolveClosed();
  });
  if (!holdOpen) return final;
  let released = false;
  return {
    child,
    attempt,
    closed,
    release: () => {
      if (released || child.exitCode !== null || child.signalCode !== null) return;
      released = true;
      child.stdin?.end("\n");
    },
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
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

function completionEnvelope(identityValue: WorkIdentity, outcome: CompletionEnvelope["outcome"]): CompletionEnvelope {
  return {
    schema_version: 1,
    identity: identityValue,
    outcome,
    terminal_signal: outcome === "pending" ? null : "workflow_complete",
    artifact_refs: [],
    evidence_ref: null,
    conflict_ref: null,
    completed_by: "workflow_complete",
    emitted_at: "2026-09-19T00:00:00.000Z",
  };
}

function pendingRootState(runId: string, pause: TeamState["pause"] = { kind: "user_checkpoint", reason: "awaiting a checkpoint decision" }): TeamState {
  const workIdentity = identity(runId);
  return state(runId, {
    lifecycle_status: "active",
    pause,
    work_identity: workIdentity,
    pending: {
      identity: workIdentity,
      status: "pending",
      pending_reason: "transport_reconnect",
      updated_at: "2026-09-19T00:00:00.000Z",
    },
    completion_envelope: completionEnvelope(workIdentity, "pending"),
  });
}

function dispatchedState(runId: string, activeDispatch = false): TeamState {
  const profile = loadProfile(CLASSIFICATION.workflow);
  assert.ok(profile);
  const issued = createCapability({
    run_key: runId,
    branch: BRANCH,
    workflow: profile.name,
    profile_hash: profileHash(profile),
    stage_cursor: "implementation",
    kind: "single",
    expected_roster: [{ role: "dev", agent: "dev" }],
  }).state;
  const workIdentity: WorkIdentity = {
    ...identity(runId, profile.name),
    capability_id: issued.capability_id,
    capability_epoch: issued.issued_for!.cursor_epoch,
    loop_iteration: issued.issued_for!.loop_iteration!,
    slot_id: "dev",
    task_id: "completed-task",
    dispatch_id: "completed-dispatch",
    worker_id: "dev",
  };
  const timestamp = "2026-09-19T00:00:00.000Z";
  const activePending: PendingState = {
    identity: workIdentity,
    status: "running",
    pending_reason: "transport_reconnect",
    updated_at: timestamp,
  };
  const record: DispatchRecord = {
    id: workIdentity.dispatch_id,
    role: "dev",
    agent: "dev",
    status: activeDispatch ? "running" : "succeeded",
    attempt: 1,
    created_at: timestamp,
    work_identity: workIdentity,
    completion_envelope: completionEnvelope(workIdentity, activeDispatch ? "pending" : "succeeded"),
    ...(activeDispatch
      ? { pending: activePending }
      : {
          completed_at: timestamp,
          completion: {
            dispatch_id: workIdentity.dispatch_id,
            cursor_epoch: issued.issued_for!.cursor_epoch,
            outcome: "succeeded",
            artifact_ids: [],
            evidence: "completed dispatch evidence",
            completed_by: "workflow_complete",
            completed_at: timestamp,
            work_identity: workIdentity,
          } satisfies DispatchCompletion,
        }),
  };
  const capability: DispatchCapabilityState = {
    ...issued,
    status: activeDispatch ? "dispatched" : "complete",
    work_identity: workIdentity,
    pending: activeDispatch ? [activePending] : [],
    dispatches: [record],
  };
  return state(runId, {
    lifecycle_status: "active",
    pause: { kind: "user_checkpoint", reason: "awaiting a required user decision" },
    profile_hash: profileHash(profile),
    cursor_epoch: issued.issued_for!.cursor_epoch,
    work_identity: workIdentity,
    pending: {
      identity: workIdentity,
      status: "succeeded",
      pending_reason: "transport_reconnect",
      updated_at: timestamp,
    },
    completion_envelope: completionEnvelope(workIdentity, "succeeded"),
    typed_checkpoint_decisions: [],
    dispatch_capability: capability,
  });
}

function childJoin(parent: WorkIdentity, joinState: NonNullable<TeamState["child_join"]>["state"], completionEnvelopeRef: string | null): NonNullable<TeamState["child_join"]> {
  return {
    parent,
    child: { ...parent, slot_id: "child#1", task_id: "child-task", dispatch_id: "child-dispatch", worker_id: "child-worker" },
    state: joinState,
    expected_artifact_ids: [],
    completion_envelope_ref: completionEnvelopeRef,
    attempt: 1,
    created_at: "2026-09-19T00:00:00.000Z",
    joined_at: "2026-09-19T00:00:00.000Z",
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

test("lifecycle intent is anchored, history-independent, and explicit-mode first", () => {
  assert.deepEqual(resolveLifecycleIntent({ text: "/do-work продолжи фичу" }), {
    mode: "resume",
    source: "natural_language",
  });
  assert.deepEqual(resolveLifecycleIntent({ text: "resume the previous feature" }), {
    mode: "resume",
    source: "natural_language",
  });
  assert.equal(resolveLifecycleIntent({ text: "Add a Continue button" }).source, "default");
  assert.equal(resolveLifecycleIntent({ text: "Fix login bug" }).source, "default");
  assert.equal(resolveLifecycleIntent({ text: "fix the previous login result" }).mode, "rework");
  assert.equal(resolveLifecycleIntent({ text: "rework previous result" }).mode, "rework");
  assert.equal(resolveLifecycleIntent({ text: "revise project" }).source, "default");
  assert.equal(resolveLifecycleIntent({ text: "доработай задачу" }).source, "default");
  assert.equal(resolveLifecycleIntent({ text: "доработай предыдущую реализацию" }).mode, "rework");
  assert.equal(resolveLifecycleIntent({ text: "продолжи фичу", mode: "new" }).source, "explicit");
  assert.equal(resolveLifecycleIntent({ text: "продолжи фичу", mode: "new" }).mode, "new");
});

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

test("workflow_prepare rejects an unavailable explicit workflow before canonical mutation", () => {
  const root = scratch("omp-lifecycle-unavailable-profile");
  const missingWorkflow = `missing-profile-${randomUUID()}`;
  try {
    initGit(root);
    const execution = context(root, "unavailable-profile");
    const base = prepareOptions(root, "unavailable profile task", "unavailable-profile-request", execution);
    const options = {
      ...base,
      classification: { ...base.classification, workflow: missingWorkflow },
    };

    assert.throws(
      () => prepareWorkflowState(options),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_state_invalid",
    );
    assert.equal(existsSync(join(root, ".work-state")), false, "unavailable explicit workflow must not create canonical state");
    assert.deepEqual(listRuns(root, { branch: BRANCH }), [], "unavailable explicit workflow must not publish a run or selection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare with an omitted workflow preserves matrix selection", () => {
  const root = scratch("omp-lifecycle-matrix-profile");
  try {
    initGit(root);
    const execution = context(root, "matrix-profile");
    const prepared = prepareWorkflowState(prepareOptions(root, "matrix profile task", "matrix-profile-request", execution));

    assert.equal(prepared.profile.name, "bug-fix");
    assert.equal(prepared.state.profile_hash, profileHash(prepared.profile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare resolves a uniquely registered profile through the public contract", () => {
  const root = scratch("omp-lifecycle-registered-profile");
  const workflow = `registered-prepare-${randomUUID()}`;
  const customProfile: Profile = {
    name: workflow,
    title: "Registered prepare profile",
    description: "A uniquely registered profile for lifecycle preparation.",
    match: { type: ["FEATURE"] },
    stages: [{
      id: "intake",
      title: "Registered intake",
      type: "orchestrator",
      description: "Prepare the registered workflow.",
      prompt: "Use the registered workflow contract.",
    }],
  };
  try {
    registerWorkflowProfiles([customProfile]);
    initGit(root);
    const execution = context(root, "registered-profile");
    const base = prepareOptions(root, "registered profile task", "registered-profile-request", execution);
    const prepared = prepareWorkflowState({
      ...base,
      classification: { ...base.classification, type: "FEATURE", workflow },
    });
    const expectedHash = profileHash(customProfile);
    const contract = resolveWorkflowContract(root, { runId: prepared.state.run_id, branch: BRANCH });

    assert.equal(prepared.profile.name, workflow);
    assert.equal(prepared.state.profile_hash, expectedHash);
    assert.equal(contract.workflow, workflow);
    assert.equal(contract.profile.hash, expectedHash);
    assert.equal(contract.stage.id, "intake");
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
    assert.equal(first.transition?.previous_title, null);
    assert.equal(first.transition?.previous_status, null);
    assert.equal(first.transition?.selected_run_id, first.state.run_id);
    assert.equal(first.transition?.selected_title, "first ingress task");
    assert.equal(first.transition?.selected_status, "active");
    assert.deepEqual(first.transition?.continuation, { stage: first.state.stage_cursor, status: "active" });
    assert.equal(second.transition?.previous_run_id, first.state.run_id);
    assert.equal(second.transition?.previous_title, "first ingress task");
    assert.equal(second.transition?.previous_status, "active");
    assert.equal(second.transition?.selected_run_id, second.state.run_id);
    assert.equal(second.transition?.selected_title, "second ingress task");
    assert.deepEqual(second.transition?.continuation, { stage: second.state.stage_cursor, status: "active" });
    assert.equal(second.transition?.selected_status, "active");
    assert.equal(readRunState(root, second.state.run_id!)?.task, "second ingress task");
    assert.equal(readRunState(root, first.state.run_id!)?.task, "first ingress task");
    const normalized = resolveCanonicalRun(root, { kind: "team", runId: first.state.run_id! });
    assert.equal(normalized?.state?.migration, undefined);
    const replay = prepareWorkflowState(prepareOptions(root, "first ingress task", "prepare-a", execution));
    assert.deepEqual(replay.transition, first.transition);

    assert.throws(
      () => prepareWorkflowState(prepareOptions(root, "changed ingress task", "prepare-a", execution)),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    assert.equal(listRuns(root, { branch: BRANCH }).length, 2);
    const beforeReplayControl = readRunControl(root);
    const beforeReplayRunIds = listRuns(root, { branch: BRANCH }).map((candidate) => candidate.run_id);
    const beforeReplayStates = beforeReplayRunIds.map((runId) => readRunState(root, runId));
    const changedWorkflowOptions = prepareOptions(root, "first ingress task", "prepare-a", execution);
    const replayWithUnavailableWorkflow = {
      ...changedWorkflowOptions,
      classification: {
        ...changedWorkflowOptions.classification,
        workflow: `missing-replay-profile-${randomUUID()}`,
      },
    };
    assert.throws(
      () => prepareWorkflowState(replayWithUnavailableWorkflow),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    assert.deepEqual(readRunControl(root), beforeReplayControl);
    assert.deepEqual(listRuns(root, { branch: BRANCH }).map((candidate) => candidate.run_id), beforeReplayRunIds);
    assert.deepEqual(beforeReplayRunIds.map((runId) => readRunState(root, runId)), beforeReplayStates);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct run new creates independent canonical transition receipts on one branch", async () => {
  const root = scratch("omp-lifecycle-direct-run-new");
  try {
    initGit(root);
    const taskTool = {
      async call() {
        return { id: "unused-call", output: "unused", artifacts: {}, exitCode: 0 };
      },
      async batch() {
        return [];
      },
    };
    await run({
      ...prepareOptions(root, "direct first task", "direct-run-a", context(root, "direct-run-session")),
      taskTool,
    });
    await run({
      ...prepareOptions(root, "direct second task", "direct-run-b", context(root, "direct-run-session")),
      taskTool,
    });
    const control = readRunControl(root);
    const firstReceipt = control.prepare_receipts["direct-run-a"];
    const secondReceipt = control.prepare_receipts["direct-run-b"];
    assert.ok(firstReceipt);
    assert.ok(secondReceipt);
    assert.notEqual(firstReceipt.selected_run_id, secondReceipt.selected_run_id);
    assert.equal(firstReceipt.previous_title, null);
    assert.equal(firstReceipt.previous_status, null);
    assert.equal(firstReceipt.selected_title, "direct first task");
    assert.equal(firstReceipt.selected_status, "active");
    assert.equal(secondReceipt.selected_title, "direct second task");
    const firstCurrent = listRuns(root, { includeTerminal: true }).find((candidate) => candidate.run_id === firstReceipt.selected_run_id);
    assert.ok(firstCurrent);
    assert.equal(secondReceipt.previous_run_id, firstCurrent.run_id);
    assert.equal(secondReceipt.previous_title, firstCurrent.title);
    assert.equal(secondReceipt.previous_status, firstCurrent.status);
    assert.equal(secondReceipt.selected_status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct canonical exact replay bypasses a later CTO claim without mutation", () => {
  const root = scratch("omp-lifecycle-direct-replay-cto");
  const runId = "41414141-4141-4141-8141-414141414141";
  const execution = context(root, "direct-replay-session");
  const request: LifecycleRequest = {
    mode: "new",
    request_id: "direct-replay-request",
    execution,
    task: "direct replay task",
    branch: BRANCH,
    classification: CLASSIFICATION,
    files: [],
    issue: null,
  };
  const receipt: PrepareRequestReceipt = {
    request_id: request.request_id,
    payload_hash: lifecyclePayloadHash(request),
    operation: "new",
    previous_run_id: null,
    previous_title: null,
    previous_status: null,
    selected_run_id: runId,
    selected_title: "direct replay task",
    selected_status: "paused",
    committed_at: "2026-09-24T00:00:00.000Z",
    continuation: { stage: "implementation", status: "paused" },
  };
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    const committed = persistCanonicalRun(
      root,
      state(runId, { title: "direct replay task", task: "direct replay task" }),
      { context: execution, request, receipt },
    );
    const committedReceipt = { ...receipt };
    const workflowClaim = readRunControl(root).execution_claim;
    assert.ok(workflowClaim);
    releaseExecutionClaim(root, { run_id: runId, token: workflowClaim.token });
    acquireExecutionClaim(root, {
      run_id: "cto-replay-owner",
      owner_kind: "cto",
      context: context(root, "cto-replay-owner"),
    });
    const beforeState = readFileSync(runStatePath(root, runId));
    const beforeControl = readFileSync(controlPath);
    const replayReceipt = { ...committedReceipt };
    const replayed = persistCanonicalRun(root, committed.state, { context: execution, request, receipt: replayReceipt });
    assert.deepEqual(replayed.state, committed.state);
    assert.deepEqual(replayReceipt, committedReceipt);
    assert.deepEqual(readFileSync(runStatePath(root, runId)), beforeState);
    assert.deepEqual(readFileSync(controlPath), beforeControl);
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

test("new ingress replaces a dead quiescent claim after completed dispatch and preserves old authority", () => {
  const root = scratch("omp-lifecycle-cross-run-ingress");
  const oldRunId = "12121212-1212-4121-8121-121212121212";
  const deadPid = 31337;
  const controlPath = join(root, ".work-state", "run-control.json");
  const artifactPath = join(root, ".work-state", "runs", oldRunId, "artifacts", "upstream.json");
  try {
    initGit(root);
    const oldState = dispatchedState(oldRunId);
    persistCanonicalRun(root, oldState);
    mkdirSync(dirname(artifactPath), { recursive: true });
    const artifactBytes = Buffer.from('{"artifact":"old-authority","bytes":[1,2,3]}\n', "utf8");
    writeFileSync(artifactPath, artifactBytes);
    const oldClaim = acquireExecutionClaim(root, {
      run_id: oldRunId,
      context: context(root, "old-coordinator", BRANCH, deadPid),
    });
    selectSession(root, context(root, "foreign-selector"), oldRunId, BRANCH);
    const beforeStateBytes = readFileSync(runStatePath(root, oldRunId));
    const beforeArtifactBytes = readFileSync(artifactPath);
    const beforeControl = readRunControl(root);
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid) throw Object.assign(new Error("coordinator exited"), { code: "ESRCH" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      const prepared = prepareWorkflowState(prepareOptions(root, "new ingress task", "cross-run-ingress", context(root, "new-coordinator")));
      const newRunId = prepared.state.run_id!;
      assert.notEqual(newRunId, oldRunId);
      assert.equal(prepared.transition?.previous_run_id, oldRunId);
      assert.equal(prepared.transition?.previous_title, oldState.title);
      assert.equal(prepared.transition?.previous_status, "active");
      assert.equal(prepared.transition?.selected_run_id, newRunId);
      assert.equal(prepared.transition?.selected_status, "active");
      assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeStateBytes);
      assert.deepEqual(readFileSync(artifactPath), beforeArtifactBytes);

      const afterControl = readRunControl(root);
      assert.equal(afterControl.execution_claim?.run_id, newRunId);
      assert.notEqual(afterControl.execution_claim?.token, oldClaim.claim.token);
      assert.deepEqual(afterControl.runs[oldRunId], beforeControl.runs[oldRunId]);
      assert.deepEqual(afterControl.selections["foreign-selector"], beforeControl.selections["foreign-selector"]);
      const receipt = afterControl.prepare_receipts["cross-run-ingress"];
      assert.ok(receipt);
      assert.equal(receipt.previous_run_id, oldRunId);
      assert.equal(receipt.previous_title, oldState.title);
      assert.equal(receipt.previous_status, "active");
      assert.equal(receipt.selected_run_id, newRunId);
    } finally {
      process.kill = originalKill;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireExecutionClaim replaces a dead quiescent workflow claim for a different run", () => {
  const root = scratch("omp-lifecycle-cross-run-acquire");
  const oldRunId = "31313131-3131-4313-8313-313131313131";
  const newRunId = "32323232-3232-4323-8323-323232323232";
  const deadPid = 31337;
  try {
    persistCanonicalRun(root, state(oldRunId));
    const oldClaim = acquireExecutionClaim(root, { run_id: oldRunId, context: context(root, "old-owner", BRANCH, deadPid) });
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid) throw Object.assign(new Error("coordinator exited"), { code: "ESRCH" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      const replacement = acquireExecutionClaim(root, {
        run_id: newRunId,
        context: context(root, "new-owner"),
        worker_ids: ["new-worker"],
      });
      assert.equal(replacement.claim.run_id, newRunId);
      assert.deepEqual(replacement.claim.worker_ids, ["new-worker"]);
      assert.notEqual(replacement.claim.token, oldClaim.claim.token);
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.equal(readRunControl(root).execution_claim?.run_id, newRunId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign selection without a claim is historical and does not block new ingress", () => {
  const root = scratch("omp-lifecycle-cross-run-selection-only");
  const oldRunId = "33333333-3333-4333-8333-333333333333";
  try {
    initGit(root);
    persistCanonicalRun(root, pendingRootState(oldRunId));
    selectSession(root, context(root, "foreign-selector"), oldRunId, BRANCH);
    const before = readRunControl(root);
    const prepared = prepareWorkflowState(prepareOptions(root, "selection-only ingress", "cross-run-selection-only", context(root, "new-owner")));
    assert.equal(prepared.transition?.previous_run_id, null);
    assert.equal(prepared.transition?.previous_title, null);
    assert.equal(prepared.transition?.previous_status, null);
    const after = readRunControl(root);
    assert.deepEqual(after.selections["foreign-selector"], before.selections["foreign-selector"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-session quiescent claim admits a new run without changing old state", () => {
  const root = scratch("omp-lifecycle-cross-run-same-session");
  const oldRunId = "13131313-1313-4131-8131-131313131313";
  const newRunId = "14141414-1414-4141-8141-141414141414";
  try {
    const execution = context(root, "same-session");
    persistCanonicalRun(root, state(oldRunId));
    const oldStateBytes = readFileSync(runStatePath(root, oldRunId));
    const oldClaim = acquireExecutionClaim(root, { run_id: oldRunId, context: execution });
    const before = readRunControl(root);
    const oldCandidate = before.runs[oldRunId];
    assert.ok(oldCandidate);
    const committed = persistCanonicalRun(root, state(newRunId), { context: execution });
    assert.equal(committed.state.run_id, newRunId);
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), oldStateBytes);
    const after = readRunControl(root);
    assert.equal(after.execution_claim?.run_id, newRunId);
    assert.notEqual(after.execution_claim?.token, oldClaim.claim.token);
    assert.deepEqual(after.runs[oldRunId], oldCandidate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("released quiescent claim admits a foreign session without adopting its selection", () => {
  const root = scratch("omp-lifecycle-cross-run-released");
  const oldRunId = "15151515-1515-4151-8151-151515151515";
  const newRunId = "16161616-1616-4161-8161-161616161616";
  try {
    const oldOwner = context(root, "released-owner");
    persistCanonicalRun(root, state(oldRunId));
    acquireExecutionClaim(root, { run_id: oldRunId, context: oldOwner });
    selectSession(root, context(root, "foreign-selector"), oldRunId, BRANCH);
    updateRunControl(root, (control) => {
      if (!control.execution_claim) throw new Error("released test requires a claim");
      return {
        commit: true,
        value: undefined,
        control: {
          ...control,
          execution_claim: { ...control.execution_claim, released_at: "2026-09-24T00:00:00.000Z" },
        },
      };
    });
    const before = readRunControl(root);
    const committed = persistCanonicalRun(root, state(newRunId), { context: context(root, "new-session", BRANCH, 31337) });
    assert.equal(committed.state.run_id, newRunId);
    const after = readRunControl(root);
    assert.equal(after.execution_claim?.run_id, newRunId);
    assert.deepEqual(after.selections["foreign-selector"], before.selections["foreign-selector"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active old work denies cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-active");
  const oldRunId = "17171717-1717-4171-8171-171717171717";
  const newRunId = "18181818-1818-4181-8181-181818181818";
  const deadPid = 31337;
  try {
    const oldState = pendingRootState(oldRunId);
    persistCanonicalRun(root, oldState);
    acquireExecutionClaim(root, { run_id: oldRunId, context: context(root, "old-owner", BRANCH, deadPid) });
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = readFileSync(controlPath);
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid) throw Object.assign(new Error("coordinator exited"), { code: "ESRCH" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      assert.throws(
        () => persistCanonicalRun(root, state(newRunId), { context: context(root, "new-owner") }),
        (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
      );
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active dispatch pending denies same-session cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-dispatch-pending");
  const oldRunId = "43434343-4343-4343-8343-434343434343";
  const newRunId = "44444444-4444-4444-8444-444444444444";
  const execution = context(root, "dispatch-pending-session");
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    persistCanonicalRun(root, dispatchedState(oldRunId, true));
    acquireExecutionClaim(root, { run_id: oldRunId, context: execution });
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const beforeControl = readFileSync(controlPath);
    assert.throws(
      () => persistCanonicalRun(root, state(newRunId), { context: execution }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background wait denies same-session cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-background-wait");
  const oldRunId = "45454545-4545-4545-8545-454545454545";
  const newRunId = "46464646-4646-4646-8464-464646464646";
  const execution = context(root, "background-wait-session");
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    persistCanonicalRun(root, state(oldRunId, { pause: { kind: "background_wait", reason: "provider still running" } }));
    acquireExecutionClaim(root, { run_id: oldRunId, context: execution });
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const beforeControl = readFileSync(controlPath);
    assert.throws(
      () => persistCanonicalRun(root, state(newRunId), { context: execution }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child-join conflict denies same-session cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-child-join");
  const oldRunId = "47474747-4747-4747-8474-474747474747";
  const newRunId = "48484848-4848-4848-8484-484848484848";
  const execution = context(root, "child-join-session");
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    const parent = identity(oldRunId);
    persistCanonicalRun(root, state(oldRunId, { work_identity: parent, child_join: childJoin(parent, "conflict", null) }));
    acquireExecutionClaim(root, { run_id: oldRunId, context: execution });
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const beforeControl = readFileSync(controlPath);
    assert.throws(
      () => persistCanonicalRun(root, state(newRunId), { context: execution }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed old canonical state denies cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-malformed-state");
  const oldRunId = "19191919-1919-4191-8191-191919191919";
  const newRunId = "20202020-2020-4202-8202-202020202020";
  const deadPid = 31337;
  try {
    persistCanonicalRun(root, state(oldRunId));
    acquireExecutionClaim(root, { run_id: oldRunId, context: context(root, "old-owner", BRANCH, deadPid) });
    const malformedBytes = Buffer.from("{\"schema\":2,\"run_id\":\n", "utf8");
    writeFileSync(runStatePath(root, oldRunId), malformedBytes);
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = readFileSync(controlPath);
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid) throw Object.assign(new Error("coordinator exited"), { code: "ESRCH" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      assert.throws(
        () => persistCanonicalRun(root, state(newRunId), { context: context(root, "new-owner") }),
        (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
      );
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), malformedBytes);
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed execution claim denies cross-run replacement without changing bytes", () => {
  const root = scratch("omp-lifecycle-cross-run-malformed-claim");
  const oldRunId = "21212121-2121-4212-8212-212121212121";
  const newRunId = "22222222-2222-4222-8222-222222222222";
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    persistCanonicalRun(root, state(oldRunId));
    const control = readRunControl(root);
    writeFileSync(controlPath, `${JSON.stringify({
      ...control,
      execution_claim: {
        token: "malformed-token",
        owner_kind: "workflow",
        run_id: oldRunId,
        coordinator_session_id: "old-owner",
        ownership_epoch: "malformed-epoch",
        worker_ids: "not-an-array",
        released_at: null,
      },
    }, null, 2)}\n`);
    const beforeControl = readFileSync(controlPath);
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    assert.throws(
      () => persistCanonicalRun(root, state(newRunId), { context: context(root, "new-owner") }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live foreign coordinator denies a quiescent cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-live");
  const oldRunId = "23232323-2323-4232-8232-232323232323";
  const newRunId = "24242424-2424-4242-8242-242424242424";
  try {
    persistCanonicalRun(root, state(oldRunId));
    acquireExecutionClaim(root, { run_id: oldRunId, context: context(root, "live-owner", BRANCH, process.pid) });
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = readFileSync(controlPath);
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    assert.throws(
      () => persistCanonicalRun(root, state(newRunId), { context: context(root, "new-owner") }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown foreign coordinator denies a quiescent cross-run replacement atomically", () => {
  const root = scratch("omp-lifecycle-cross-run-unknown");
  const oldRunId = "25252525-2525-4252-8252-252525252525";
  const newRunId = "26262626-2626-4262-8262-262626262626";
  const unknownPid = 31337;
  try {
    persistCanonicalRun(root, state(oldRunId));
    acquireExecutionClaim(root, { run_id: oldRunId, context: context(root, "unknown-owner", BRANCH, unknownPid) });
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = readFileSync(controlPath);
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === unknownPid) throw Object.assign(new Error("coordinator liveness unavailable"), { code: "EACCES" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      assert.throws(
        () => persistCanonicalRun(root, state(newRunId), { context: context(root, "new-owner") }),
        (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
      );
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing foreign coordinator pid denies a quiescent cross-run replacement", () => {
  const root = scratch("omp-lifecycle-cross-run-missing-pid");
  const oldRunId = "27272727-2727-4272-8272-272727272727";
  const newRunId = "28282828-2828-4282-8282-282828282828";
  try {
    persistCanonicalRun(root, state(oldRunId));
    const owner = { ...context(root, "missing-pid-owner"), process_id: undefined };
    acquireExecutionClaim(root, { run_id: oldRunId, context: owner });
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = readFileSync(controlPath);
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    assert.throws(
      () => persistCanonicalRun(root, state(newRunId), { context: context(root, "new-owner") }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.equal(existsSync(runStatePath(root, newRunId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-kind mismatch denies a same-ID claim before idempotence", () => {
  const root = scratch("omp-lifecycle-claim-kind-mismatch");
  const runId = "29292929-2929-4292-8292-292929292929";
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    const workflowClaim = acquireExecutionClaim(root, {
      run_id: runId,
      owner_kind: "workflow",
      context: context(root, "workflow-owner"),
    });
    const beforeControl = readFileSync(controlPath);
    assert.throws(
      () => acquireExecutionClaim(root, { run_id: runId, owner_kind: "cto", context: context(root, "cto-owner") }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.equal(readRunControl(root).execution_claim?.token, workflowClaim.claim.token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt binding failure for a displaced run leaves missing index and new ingress unpublished", () => {
  const root = scratch("omp-lifecycle-cross-run-missing-index");
  const oldRunId = "30303030-3030-4303-8303-303030303030";
  const deadPid = 31337;
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    initGit(root);
    persistCanonicalRun(root, state(oldRunId));
    acquireExecutionClaim(root, { run_id: oldRunId, context: context(root, "old-owner", BRANCH, deadPid) });
    updateRunControl(root, (control) => {
      const runs = { ...control.runs };
      delete runs[oldRunId];
      return { commit: true, value: undefined, control: { ...control, runs } };
    });
    const beforeControl = readFileSync(controlPath);
    const beforeState = readFileSync(runStatePath(root, oldRunId));
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid) throw Object.assign(new Error("coordinator exited"), { code: "ESRCH" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      assert.throws(
        () => prepareWorkflowState(prepareOptions(root, "missing index ingress", "cross-run-missing-index", context(root, "new-owner"))),
        (error: unknown) => error instanceof LifecycleError && error.code === "recovery_required",
      );
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(readFileSync(controlPath), beforeControl);
    assert.deepEqual(readFileSync(runStatePath(root, oldRunId)), beforeState);
    assert.equal(listRuns(root, { includeTerminal: true }).filter((run) => run.run_id !== oldRunId).length, 0);
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

    const reworkOptions = {
      ...prepareOptions(root, "ignored task text", "rework-apply", execution),
      mode: "rework" as const,
      run_id: prepared.state.run_id,
      feedback: "revisit the affected stage",
      affected_stage: affectedStage,
    };
    const reworked = prepareWorkflowState(reworkOptions);
    assert.equal(reworked.transition?.operation, "rework");
    assert.equal(reworked.transition?.previous_run_id, prepared.state.run_id);
    assert.equal(reworked.transition?.previous_title, "rework ingress task");
    assert.equal(reworked.transition?.previous_status, "complete");
    assert.equal(reworked.transition?.selected_run_id, prepared.state.run_id);
    assert.equal(reworked.transition?.selected_title, "rework ingress task");
    assert.equal(reworked.transition?.selected_status, "active");
    assert.deepEqual(reworked.transition?.continuation, { stage: affectedStage, status: "active" });
    assert.equal(reworked.state.stages.find((stage) => stage.id === affectedStage)?.status, "pending");
    assert.equal(reworked.state.stages.find((stage) => stage.id === downstreamStage)?.status, "pending");
    assert.equal(reworked.state.artifacts.diagnosis, "artifacts/diagnosis.json");
    assert.equal(reworked.state.artifacts.implementation, undefined);
    assert.equal(reworked.state.artifacts.review, undefined);
    assert.equal(reworked.state.stages.find((stage) => stage.id === upstreamStage)?.status, "done");
    const replayed = prepareWorkflowState(reworkOptions);
    assert.deepEqual(replayed.transition, reworked.transition);
    const revisionsRoot = join(root, ".work-state", "runs", prepared.state.run_id!, "revisions");
    const revisionId = readdirSync(revisionsRoot)[0]!;
    assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, "artifacts", "diagnosis.json")), diagnosisBytes);
    assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, "artifacts", "implementation.json")), implementationBytes);
    assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, "artifacts", "review.json")), reviewBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rework requires an explicit affected stage before any lifecycle mutation", () => {
  const root = scratch("omp-lifecycle-rework-stage-required");
  try {
    initGit(root);
    const execution = context(root, "rework-stage-required");
    const prepared = prepareWorkflowState({
      ...prepareOptions(root, "summary rework", "rework-stage-required-new", execution),
      classification: {
        type: "FEATURE",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: false,
        workflow: "full-feature",
      },
    });
    const runId = prepared.state.run_id!;
    const artifactBytes = {
      exploration: Buffer.from('{"artifact":"exploration","version":1}\n', "utf8"),
      implementation: Buffer.from('{"artifact":"implementation","version":1}\n', "utf8"),
      review: Buffer.from('{"artifact":"review","version":1}\n', "utf8"),
      summary: Buffer.from('{"artifact":"summary","version":1}\n', "utf8"),
    };
    mkdirSync(prepared.artifactsDir, { recursive: true });
    for (const [artifactId, bytes] of Object.entries(artifactBytes)) {
      writeFileSync(join(prepared.artifactsDir, `${artifactId}.json`), bytes);
    }
    updateCanonicalRun(root, runId, (current) => ({
      ...current,
      lifecycle_status: "complete",
      pause: { kind: "done", reason: "completed" },
      stage_cursor: "summary",
      stages: current.stages.map((stage) => ({ ...stage, status: "done" as const })),
      artifacts: Object.fromEntries(Object.keys(artifactBytes).map((artifactId) => [artifactId, `artifacts/${artifactId}.json`])),
    }));

    const statePath = runStatePath(root, runId);
    const controlPath = join(root, ".work-state", "run-control.json");
    const revisionsRoot = join(root, ".work-state", "runs", runId, "revisions");
    const beforeState = readFileSync(statePath);
    const beforeControl = readFileSync(controlPath);
    const beforeClaim = readRunControl(root).execution_claim;
    const beforeArtifacts = Object.fromEntries(
      Object.keys(artifactBytes).map((artifactId) => [artifactId, readFileSync(join(prepared.artifactsDir, `${artifactId}.json`))]),
    );
    assert.equal(existsSync(revisionsRoot), false);

    const reworkBase = {
      ...prepareOptions(root, "ignored task text", "rework-stage-required", execution),
      classification: {
        type: "FEATURE" as const,
        complexity: "COMPLEX" as const,
        confidence: "HIGH" as const,
        autonomous: false,
        workflow: "full-feature" as const,
      },
      mode: "rework" as const,
      run_id: runId,
      feedback: "repair the implementation result",
    };
    for (const [index, affectedStage] of [undefined, "", " \t"].entries()) {
      const invalidRequest = {
        ...reworkBase,
        request_id: `rework-stage-required-${index}`,
        ...(affectedStage === undefined ? {} : { affected_stage: affectedStage }),
      };
      assert.throws(
        () => prepareWorkflowState(invalidRequest),
        (error: unknown) =>
          error instanceof LifecycleError
          && error.code === "lifecycle_request_conflict"
          && error.unchanged === true
          && typeof error.next_action === "string"
          && error.next_action.length > 0,
      );
      assert.deepEqual(readFileSync(statePath), beforeState);
      assert.deepEqual(readFileSync(controlPath), beforeControl);
      assert.deepEqual(readRunControl(root).execution_claim, beforeClaim);
      for (const [artifactId, bytes] of Object.entries(beforeArtifacts)) {
        assert.deepEqual(readFileSync(join(prepared.artifactsDir, `${artifactId}.json`)), bytes);
      }
      assert.equal(existsSync(revisionsRoot), false);
    }

    const explicitRequest = {
      ...reworkBase,
      request_id: "rework-stage-required-explicit",
      affected_stage: "implementation",
    };
    const reworked = prepareWorkflowState(explicitRequest);
    assert.equal(reworked.state.stage_cursor, "implementation");
    assert.equal(reworked.state.stages.find((stage) => stage.id === "exploration")?.status, "done");
    assert.equal(reworked.state.stages.find((stage) => stage.id === "implementation")?.status, "pending");
    assert.equal(reworked.state.stages.find((stage) => stage.id === "code_review")?.status, "pending");
    assert.equal(reworked.state.stages.find((stage) => stage.id === "summary")?.status, "pending");
    assert.equal(reworked.state.artifacts.exploration, "artifacts/exploration.json");
    assert.equal(reworked.state.artifacts.implementation, undefined);
    assert.equal(reworked.state.artifacts.review, undefined);
    assert.equal(reworked.state.artifacts.summary, undefined);
    assert.deepEqual(readFileSync(join(prepared.artifactsDir, "exploration.json")), artifactBytes.exploration);
    assert.equal(existsSync(join(prepared.artifactsDir, "implementation.json")), false);
    assert.equal(existsSync(join(prepared.artifactsDir, "review.json")), false);
    assert.equal(existsSync(join(prepared.artifactsDir, "summary.json")), false);

    const afterState = readFileSync(statePath);
    const afterControl = readFileSync(controlPath);
    const revisionId = readdirSync(revisionsRoot)[0]!;
    const revisionFiles = ["state.json", "manifest.json", "artifacts/exploration.json", "artifacts/implementation.json", "artifacts/review.json", "artifacts/summary.json"];
    const afterRevisionBytes = Object.fromEntries(
      revisionFiles.map((relativePath) => [relativePath, readFileSync(join(revisionsRoot, revisionId, relativePath))]),
    );
    const replayed = prepareWorkflowState(explicitRequest);
    assert.deepEqual(replayed.transition, reworked.transition);
    assert.deepEqual(readFileSync(statePath), afterState);
    assert.deepEqual(readFileSync(controlPath), afterControl);
    for (const [relativePath, bytes] of Object.entries(afterRevisionBytes)) {
      assert.deepEqual(readFileSync(join(revisionsRoot, revisionId, relativePath)), bytes);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("invalid nonblank rework stage refuses before legacy migration mutation", () => {
  const root = scratch("omp-lifecycle-rework-stage-preflight");
  try {
    initGit(root);
    const execution = context(root, "rework-stage-preflight");
    const prepared = prepareWorkflowState({
      ...prepareOptions(root, "completed summary", "rework-stage-preflight-new", execution),
      classification: {
        type: "FEATURE",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: false,
        workflow: "full-feature",
      },
    });
    const runId = prepared.state.run_id!;
    const artifactBytes = {
      exploration: Buffer.from('{"artifact":"exploration","version":1}\n', "utf8"),
      implementation: Buffer.from('{"artifact":"implementation","version":1}\n', "utf8"),
      review: Buffer.from('{"artifact":"review","version":1}\n', "utf8"),
      summary: Buffer.from('{"artifact":"summary","version":1}\n', "utf8"),
    };
    mkdirSync(prepared.artifactsDir, { recursive: true });
    for (const [artifactId, bytes] of Object.entries(artifactBytes)) {
      writeFileSync(join(prepared.artifactsDir, `${artifactId}.json`), bytes);
    }
    updateCanonicalRun(root, runId, (current) => ({
      ...current,
      lifecycle_status: "complete",
      pause: { kind: "done", reason: "completed" },
      stage_cursor: "summary",
      stages: current.stages.map((stage) => ({ ...stage, status: "done" as const })),
      artifacts: Object.fromEntries(Object.keys(artifactBytes).map((artifactId) => [artifactId, `artifacts/${artifactId}.json`])),
    }));

    const legacyRoot = join(root, ".work-state");
    const legacyPath = join(legacyRoot, "team-state.json");
    const legacyArtifactPath = join(legacyRoot, "artifacts", "history.json");
    mkdirSync(dirname(legacyArtifactPath), { recursive: true });
    const legacyState = {
      schema: 1,
      branch: BRANCH,
      run_key: `${BRANCH}:root`,
      classification: prepared.state.classification,
      task: "pending legacy source",
      stage_cursor: prepared.profile.stages[0]?.id ?? "exploration",
      stages: prepared.profile.stages.map((stage) => ({ id: stage.id, status: stage.id === prepared.profile.stages[0]?.id ? "done" as const : "pending" as const })),
      artifacts: { history: "artifacts/history.json" },
      scope: { scope: ["worker"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "worker" },
      pause: { kind: "none" as const, reason: "" },
      updated_at: "2026-09-19T00:00:00.000Z",
    };
    const legacyStateBytes = Buffer.from(`${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
    const legacyArtifactBytes = Buffer.from('{"legacy":"preserved"}\n', "utf8");
    writeFileSync(legacyPath, legacyStateBytes);
    writeFileSync(legacyArtifactPath, legacyArtifactBytes);
    assert.deepEqual(discoverLegacySources(root).sources.map((source) => source.source_id), ["legacy"]);

    const beforeWorkspace = snapshotTree(legacyRoot);
    const invalidRequest = {
      ...prepareOptions(root, "ignored task text", "rework-stage-preflight-invalid", execution),
      classification: {
        type: "FEATURE" as const,
        complexity: "COMPLEX" as const,
        confidence: "HIGH" as const,
        autonomous: false,
        workflow: "full-feature" as const,
      },
      mode: "rework" as const,
      run_id: runId,
      feedback: "repair the summary result",
      affected_stage: "not-declared",
    };
    assert.throws(
      () => prepareWorkflowState(invalidRequest),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_state_invalid",
    );
    assert.deepEqual(snapshotTree(legacyRoot), beforeWorkspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("prepare receipt exact replay is idempotent while changed payload and corruption fail closed", () => {
  const root = scratch("omp-lifecycle-replay");
  try {
    initGit(root);
    const execution = context(root, "prepare-replay-session");
    const options = prepareOptions(root, "same task text", "request-replay-1", execution);
    const first = prepareWorkflowState(options);
    assert.ok(first.transition);
    const receipt = first.transition!;
    const request: LifecycleRequest = {
      mode: "new",
      request_id: options.request_id!,
      task: options.task,
      branch: options.branch,
      execution,
      classification: first.state.classification,
      files: options.files,
      issue: options.issue,
    };
    assert.equal(validateExactPrepareReplay(receipt, request).ok, true);
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeReplay = readFileSync(controlPath);
    const replay = prepareWorkflowState(options);
    assert.deepEqual(replay.transition, receipt);
    assert.deepEqual(readFileSync(controlPath), beforeReplay);

    assert.throws(
      () => prepareWorkflowState({ ...options, task: "changed payload" }),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    assert.deepEqual(readFileSync(controlPath), beforeReplay);

    const control = readRunControl(root);
    const persisted = control.prepare_receipts[options.request_id!];
    assert.ok(persisted);
    writeFileSync(controlPath, `${JSON.stringify({
      ...control,
      prepare_receipts: {
        ...control.prepare_receipts,
        [options.request_id!]: { ...persisted, continuation: { ...persisted.continuation, status: "paused" } },
      },
    }, null, 2)}\n`);
    assert.throws(
      () => readRunControl(root),
      (error: unknown) => error instanceof LifecycleError && error.code === "recovery_required",
    );
    assert.throws(
      () => prepareWorkflowState(options),
      (error: unknown) => error instanceof LifecycleError && error.code === "recovery_required",
    );
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
test("rework snapshot uses one captured state image and fences competing writes", () => {
  const root = scratch("omp-lifecycle-snapshot-cas");
  try {
    const runId = "abababab-abab-4aba-8bab-abababababab";
    persistCanonicalRun(root, state(runId));
    const statePath = runStatePath(root, runId);
    const beforeBytes = readFileSync(statePath);
    const revisionsRoot = join(root, ".work-state", "runs", runId, "revisions");
    const competingBytes = Buffer.from(`${JSON.stringify(state(runId, { task: "competing write" }), null, 2)}\n`, "utf8");
    const request: LifecycleRequest = {
      mode: "rework",
      request_id: "snapshot-cas-competing",
      execution: context(root, "snapshot-cas"),
      run_id: runId,
      branch: BRANCH,
      feedback: "rework after competing write",
      affected_stage: "implementation",
    };
    const receipt: PrepareRequestReceipt = {
      request_id: request.request_id,
      payload_hash: "placeholder",
      operation: "rework",
      previous_run_id: runId,
      previous_title: "Lifecycle regression",
      previous_status: "paused",
      selected_run_id: runId,
      selected_title: "Lifecycle regression",
      selected_status: "active",
      committed_at: "2026-09-19T00:00:00.000Z",
      continuation: { stage: "implementation", status: "active" },
    };

    assert.throws(
      () => reworkCanonicalRunAtomically(root, runId, (current) => {
        writeFileSync(statePath, competingBytes);
        return { ...current, task: "reworked" };
      }, request, receipt),
      (error: unknown) => error instanceof LifecycleRecoveryError && /CAS precondition failed/.test(error.message),
    );
    assert.deepEqual(readFileSync(statePath), competingBytes);
    assert.equal(existsSync(revisionsRoot), false, "a competing write must not leave a partial revision");

    const controlPath = join(root, ".work-state", "run-control.json");
    const competingControlBytes = Buffer.from(`${JSON.stringify({ ...readRunControl(root), revision: readRunControl(root).revision + 1 }, null, 2)}\n`, "utf8");
    const controlRequest = { ...request, request_id: "snapshot-control-cas" };
    const controlReceipt = { ...receipt, request_id: controlRequest.request_id };
    assert.throws(
      () => reworkCanonicalRunAtomically(root, runId, (current) => {
        writeFileSync(controlPath, competingControlBytes);
        return { ...current, task: "control-raced" };
      }, controlRequest, controlReceipt),
      (error: unknown) => error instanceof LifecycleRecoveryError && /CAS precondition failed/.test(error.message),
    );
    assert.deepEqual(readFileSync(controlPath), competingControlBytes, "a competing control write must survive the failed publication");

    writeFileSync(statePath, beforeBytes);
    let restoredBeforeCommit = false;
    const successRequest = { ...request, request_id: "snapshot-cas-success" };
    const successReceipt = { ...receipt, request_id: successRequest.request_id };
    reworkCanonicalRunAtomically(root, runId, (current) => {
      writeFileSync(statePath, competingBytes);
      const next = { ...current, task: "reworked" };
      Object.defineProperty(next, "task", {
        configurable: true,
        enumerable: true,
        get: () => {
          if (!restoredBeforeCommit) {
            writeFileSync(statePath, beforeBytes);
            restoredBeforeCommit = true;
          }
          return "reworked";
        },
      });
      return next;
    }, successRequest, successReceipt);

    const revisionId = readdirSync(revisionsRoot)[0]!;
    const revisionDir = join(revisionsRoot, revisionId);
    const revisionStateBytes = readFileSync(join(revisionDir, "state.json"));
    const manifest = JSON.parse(readFileSync(join(revisionDir, "manifest.json"), "utf8")) as { state_sha256: string };
    assert.equal(restoredBeforeCommit, true);
    assert.deepEqual(revisionStateBytes, beforeBytes, "revision state must use the captured before-state bytes");
    assert.equal(manifest.state_sha256, createHash("sha256").update(beforeBytes).digest("hex"));
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

test("unknown coordinator liveness cannot displace an execution claim", () => {
  const root = scratch("omp-lifecycle-unknown-liveness");
  const runId = "abababab-abab-4bab-8bab-abababababab";
  const ownerPid = 31337;
  const controlPath = join(root, ".work-state", "run-control.json");
  try {
    persistCanonicalRun(root, state(runId));
    const claim = acquireExecutionClaim(root, {
      run_id: runId,
      context: context(root, "claim-owner", BRANCH, ownerPid),
      worker_ids: ["worker-pending"],
    });
    const beforeControl = readRunControl(root);
    const beforeBytes = readFileSync(controlPath);
    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === ownerPid) throw Object.assign(new Error("coordinator liveness unavailable"), { code: "EACCES" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      const attempts = [
        () => acquireExecutionClaim(root, { run_id: runId, context: context(root, "new-session", BRANCH, ownerPid + 1) }),
        () => handoverExecutionClaim(root, { run_id: runId, context: context(root, "handover-session", BRANCH, ownerPid + 2), token: claim.claim.token }),
      ];
      for (const attempt of attempts) {
        assert.throws(
          attempt,
          (error: unknown) => {
            assert.ok(error instanceof LifecycleError);
            assert.equal(error.code, "run_busy");
            assert.equal(error.run_id, runId);
            assert.equal(error.unchanged, true);
            return true;
          },
        );
        const unchanged = readRunControl(root);
        assert.deepEqual(unchanged, beforeControl);
        assert.equal(unchanged.execution_claim?.token, claim.claim.token);
        assert.equal(unchanged.execution_claim?.ownership_epoch, claim.claim.ownership_epoch);
        assert.deepEqual(unchanged.execution_claim?.worker_ids, ["worker-pending"]);
        assert.deepEqual(readFileSync(controlPath), beforeBytes);
      }
    } finally {
      process.kill = originalKill;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-run dead-owner resume rotates ownership epoch without changing rework or pending identity", async () => {
  const root = scratch("omp-lifecycle-handover-resume");
  const runId = "45454545-4545-4454-8454-454545454545";
  const generation = 7;
  const pending = {
    identity: identity(runId),
    status: "pending" as const,
    pending_reason: "provider_running" as const,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
  try {
    initGit(root);
    persistCanonicalRun(root, state(runId, {
      lifecycle_status: "paused",
      pause: { kind: "background_wait", reason: "provider still running" },
      rework_generation: generation,
      pending,
    }));
    const deadOwner = await childClaim(root, runId, "dead-owner", ["worker-pending"]);
    assert.equal(deadOwner.code, 0, deadOwner.output);
    assert.match(deadOwner.output, /acquired/);

    const beforeClaim = readRunControl(root).execution_claim;
    assert.ok(beforeClaim);
    assert.deepEqual(beforeClaim.worker_ids, ["worker-pending"]);
    const beforeEpoch = beforeClaim.ownership_epoch;
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

    await run({
      ...prepareOptions(root, "ignored pending task", "handover-resume", context(root, "handover-session")),
      mode: "resume" as const,
      run_id: runId,
      taskTool,
    });

    const afterClaim = readRunControl(root).execution_claim;
    assert.ok(afterClaim);
    assert.notEqual(afterClaim.ownership_epoch, beforeEpoch);
    assert.deepEqual(afterClaim.worker_ids, ["worker-pending"]);
    const resumed = readRunState(root, runId);
    assert.ok(resumed);
    assert.equal(resumed.rework_generation, generation);
    assert.deepEqual(resumed.pending?.identity, pending.identity);
    assert.equal(resumed.pending?.status, "pending");
    assert.equal(resumed.pending?.pending_reason, "transport_reconnect");
    assert.deepEqual(calls, { call: 0, batch: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent process starts serialize to one execution claim", async () => {
  const root = scratch("omp-lifecycle-process-race");
  const contenders: HeldChildClaim[] = [];
  try {
    const firstId = "abababab-abab-4bab-8bab-abababababab";
    const secondId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    persistCanonicalRun(root, state(firstId));
    persistCanonicalRun(root, state(secondId));
    contenders.push(childClaim(root, firstId, "process-one", [], { holdOpen: true }));
    contenders.push(childClaim(root, secondId, "process-two", [], { holdOpen: true }));
    const results = await Promise.all(contenders.map((contender) => contender.attempt));
    assert.equal(contenders.filter(({ child }) => child.exitCode === null && child.signalCode === null).length, 2);
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
    assert.equal(results.filter((result) => result.code === 0 && result.outcome === "acquired").length, 1);
    assert.equal(results.filter((result) => result.code === 1 && result.outcome === "run_busy").length, 1);
    assert.ok(readRunControl(root).execution_claim);
  } finally {
    for (const contender of contenders) {
      try {
        contender.release();
      } catch {
        // The child may have already closed; termination below is still required.
      }
      try {
        contender.terminate();
      } catch {
        // A closed child needs no further termination.
      }
    }
    await Promise.all(contenders.map((contender) => contender.closed));
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
    const resumeContext = context(root, "new-session");
    const resumeRequest: LifecycleRequest = { mode: "resume", request_id: "terminal-resume", execution: resumeContext, run_id: runId, branch: BRANCH };
    const resumeReceipt: PrepareRequestReceipt = {
      request_id: resumeRequest.request_id,
      payload_hash: lifecyclePayloadHash(resumeRequest),
      operation: "resume",
      previous_run_id: runId,
      previous_title: "Lifecycle regression",
      previous_status: "complete",
      selected_run_id: runId,
      selected_title: "Lifecycle regression",
      selected_status: "complete",
      committed_at: "2026-09-20T00:00:00.000Z",
      continuation: { stage: "implementation", status: "complete" },
    };
    assert.throws(
      () => resumeCanonicalRun(root, runId, resumeContext, { request: resumeRequest, receipt: resumeReceipt }),
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
    const resumeContext = context(root, "resume-session");
    const resumeRequest: LifecycleRequest = { mode: "resume", request_id: "resume-pending-1", execution: resumeContext, run_id: runId, branch: BRANCH };
    const resumeReceipt: PrepareRequestReceipt = {
      request_id: resumeRequest.request_id,
      payload_hash: lifecyclePayloadHash(resumeRequest),
      operation: "resume",
      previous_run_id: runId,
      previous_title: "Lifecycle regression",
      previous_status: "paused",
      selected_run_id: runId,
      selected_title: "Lifecycle regression",
      selected_status: "paused",
      committed_at: "2026-09-20T00:00:00.000Z",
      continuation: { stage: "implementation", status: "paused" },
    };
    const resumed = resumeCanonicalRun(root, runId, resumeContext, { request: resumeRequest, receipt: resumeReceipt });
    assert.equal(resumed.lifecycle_status, "paused");
    assert.equal(resumed.pause.kind, "background_wait");
    assert.match(resumed.pause.reason, /transport_reconnect/);
    assert.deepEqual(resumed.pending?.identity, pending.identity);
    assert.equal(resumed.pending?.status, "pending");
    assert.equal(resumed.pending?.pending_reason, "transport_reconnect");
    const resumeAgainRequest: LifecycleRequest = { mode: "resume", request_id: "resume-pending-2", execution: resumeContext, run_id: runId, branch: BRANCH };
    const resumeAgainReceipt: PrepareRequestReceipt = {
      ...resumeReceipt,
      request_id: resumeAgainRequest.request_id,
      payload_hash: lifecyclePayloadHash(resumeAgainRequest),
      committed_at: "2026-09-20T00:00:01.000Z",
    };
    const resumedAgain = resumeCanonicalRun(root, runId, resumeContext, { request: resumeAgainRequest, receipt: resumeAgainReceipt });
    assert.deepEqual(resumedAgain.pending?.identity, pending.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
