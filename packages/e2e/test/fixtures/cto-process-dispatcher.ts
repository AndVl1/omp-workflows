/**
 * Dispatcher child-process fixture for the CTO process E2E
 * (packages/e2e/test/cto-process-e2e.test.ts).
 *
 * WHY A CHILD-PROCESS FIXTURE INSTEAD OF THE IN-REPO HARNESS: the e2e
 * harness (`startTestSession`/`WsDriver`, packages/e2e/src/server.ts) spawns
 * an omp PTY and is UX-oriented. A deterministic control-plane process E2E
 * needs a real process boundary: dispatcher stop/restart, cross-process file
 * observability (persisted fake-RW transport), and lease claim/release
 * semantics only exist for real when the dispatcher runs in its own process.
 * This fixture drives the ACTUAL exported fullstack dispatcher APIs
 * (createChannelSet / startChannelDispatcher / queueCtoDelivery) plus the
 * core wave/state APIs in a plain node process — no omp binary, no network,
 * no credentials, no LLM.
 *
 * Usage: node --import tsx cto-process-dispatcher.ts --root <scratch> --evidence <evidencePath> --interval-ms <ms> [--run-id <id>] [--session-id <id>] [--lease-only]
 *
 * Protocol (append-only JSONL on the evidence file):
 *   {"t":"start", at, runId, ownershipEpoch, sessionId, branch} after exact ingress/claim
 *   {"t":"wake", at, task:{id,text,by,runId,waveId}}      one per admitted task
 *   {"t":"answer", id, answer}                            escalation answers (none in this E2E)
 *   {"t":"wave-start", runId, waveId, taskId}
 *   {"t":"slice-dod", slice, path}                        per-slice DoD written BEFORE workers
 *   {"t":"worktree", slice, path, branch, created}        created=true on first wave, false on resume
 *   {"t":"wave-done", runId, waveId, taskId, slices:[{slice,worktree,branch,commit}]}
 *   {"t":"wave-error", taskId, error}                     executor failure — the wake must never die
 *   {"t":"lease-busy", at}                                live foreign lease -> exit code 3
 *   {"t":"lease-ready", at, sessionId}                    claim-free lease holder is ready
 *   {"t":"shutdown", runId, ownershipEpoch}                    managed suspension before exit
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createChannelSet,
  dispatcherLockPath,
  queueCtoDelivery,
  registerEscalationAdapter,
  startChannelDispatcher,
  startDispatcher,
  type DispatcherBinding,
  type InboxTask,
} from '../../../fullstack/src/adapters/registry.js';
import { MockEscalationAdapter } from '../../../fullstack/src/adapters/mock.js';
import { acquireCtoIngress, suspendCtoSession } from '../../../core/src/cto/run.js';
import { finishWave, readCtoState, writeCtoState } from '../../../core/src/cto/state.js';
import { createWorkflowSessionController } from '../../../core/src/engine/host-controller.js';
import { resolveActiveBranch } from '../../../core/src/engine/state.js';
import type { TrustedExecutionContext } from '../../../core/src/engine/types.js';
import { resolveWorkflow } from '../../../core/src/engine/profile.js';

/** Identity on EVERY git command (the scratch repo has no user config). */
const GIT_IDENTITY = ['-c', 'user.name=Process E2E', '-c', 'user.email=process-e2e@example.invalid'];

/** The two slices every wave dispatches concurrently into real git worktrees. */
const SLICES = ['slice-a', 'slice-b'];

/** Per-slice PHASE-0 classification (architecture-3): complete before workers. */
const SLICE_CLASSIFICATION = { type: 'FEATURE', complexity: 'MEDIUM', confidence: 'HIGH', autonomous: true } as const;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const root = arg('--root');
const evidencePath = arg('--evidence');
const intervalMs = Number(arg('--interval-ms') ?? '1000');
const requestedRunId = arg('--run-id');
const leaseOnly = process.argv.includes('--lease-only');
const sessionId = arg('--session-id') ?? `process-e2e:${resolve(root ?? process.cwd())}`;
if (!root || !evidencePath) {
  process.stderr.write('usage: cto-process-dispatcher.ts --root <scratch> --evidence <path> --interval-ms <ms> [--run-id <id>] [--session-id <id>] [--lease-only]\n');
  process.exit(2);
}

function record(entry: Record<string, unknown>): void {
  mkdirSync(dirname(evidencePath), { recursive: true });
  appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`);
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${(res.stderr ?? '').trim()}`);
  }
  return (res.stdout ?? '').trim();
}

// ── Channel set ────────────────────────────────────────────────────────────
//
// Explicit `channels[]` profiles bind their adapter configuration by profile
// id, not by adapter kind. Distinct ids therefore keep the control and audit
// directories isolated even when two profiles share a transport. This fixture
// registers `mock-ro` as a separate kind to make the read-only adapter profile
// explicit while preserving the persisted mock behavior.
registerEscalationAdapter('mock-ro', (config, cwd) => {
  const mock = config.mock as { persisted?: boolean; dir?: string } | undefined;
  if (mock?.persisted === true) {
    return new MockEscalationAdapter({ persisted: { dir: resolve(cwd, mock.dir ?? '.omp/fake-rw') } });
  }
  return new MockEscalationAdapter();
});

const channelSet = createChannelSet(root);

function ownsCurrentDispatcherLease(): boolean {
  try {
    const raw = JSON.parse(readFileSync(dispatcherLockPath(root), 'utf8')) as { pid?: number };
    return raw.pid === process.pid;
  } catch {
    return false;
  }
}

function runLeaseOnly(): void {
  const dispatcherBinding: DispatcherBinding = {
    session_id: sessionId,
    getClaim: () => undefined,
  };
  const stop = startDispatcher(root, channelSet.primary, intervalMs, { binding: dispatcherBinding });
  if (!ownsCurrentDispatcherLease()) {
    stop();
    record({ t: 'lease-busy', at: new Date().toISOString(), sessionId });
    process.exit(3);
  }
  record({ t: 'lease-ready', at: new Date().toISOString(), sessionId });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    try {
      stop();
      record({ t: 'lease-release', at: new Date().toISOString(), sessionId });
      process.exit(0);
    } catch (error) {
      record({
        t: 'lease-release-error',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function runNormal(): void {
  const branch = resolveActiveBranch(root);
  const executionContext: TrustedExecutionContext = {
    session_id: sessionId,
    caller: 'host',
    process_id: process.pid,
    worktree: root,
    branch,
    authority: 'coordinator',
  };
  const controller = createWorkflowSessionController({ cwd: root, context: executionContext });
  const dispatcherBinding: DispatcherBinding = {
    session_id: executionContext.session_id,
    getClaim: () => controller.activeCtoClaim(),
  };

// ── Wave executor (deterministic resident simulation, no LLM) ──────────────

const SLICE_WORKER = fileURLToPath(new URL('./slice-worker.ts', import.meta.url));

/** Pids of in-flight slice workers — reaped on shutdown (insurance only). */
const workerPids = new Set<number>();

/** Spawn one slice-worker child; resolves when it exits 0, rejects otherwise. */
function spawnSliceWorker(worktree: string, slice: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const worker: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', SLICE_WORKER, '--worktree', worktree, '--slice', slice, '--evidence', evidencePath],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (worker.pid) workerPids.add(worker.pid);
    let out = '';
    let err = '';
    worker.stdout?.on('data', (d: Buffer) => (out += String(d)));
    worker.stderr?.on('data', (d: Buffer) => (err += String(d)));
    worker.on('error', reject);
    worker.on('close', (code) => {
      workerPids.delete(worker.pid);
      if (code === 0) resolveP();
      else reject(new Error(`slice-worker ${slice} exited ${code}: ${err || out}`));
    });
  });
}

async function executeWave(task: InboxTask): Promise<void> {
  const runId = task.runId ?? '';
  const waveId = task.waveId ?? '';
  record({ t: 'wave-start', runId, waveId, taskId: task.id });

  // Online ACK queued right after admission — the dispatcher's NEXT tick
  // drains it to the primary RW channel (RO sinks never receive
  // non-summary intents).
  queueCtoDelivery(root, runId, {
    id: `${runId}/system/ack/${Date.now()}`,
    level: 'question',
    title: 'CTO online',
    body: 'resident standby',
    intent: 'ack',
  });

  // Per-slice state + DoD BEFORE any worker spawn (architecture-3/7 proof):
  // the run's CtoState must carry full per-slice classification, the
  // matrix-resolved workflow, and dod_path, and the dod.json must exist
  // before the slice workers are dispatched — exactly what the
  // ctoSliceTaskGate enforces. Write only when missing/changed.
  const state = readCtoState(runId, root);
  if (!state) throw new Error(`no CtoState for run ${runId}`);
  const expectedWorkflow = resolveWorkflow('FEATURE', 'MEDIUM', true);
  let teamsChanged = false;
  for (const slice of SLICES) {
    const dodPath = `.work-state/artifacts/${slice}`;
    const existing = state.teams.find((t) => t.id === slice || t.slice_id === slice);
    const c = existing?.classification;
    const complete =
      existing &&
      c?.type === 'FEATURE' &&
      c.complexity === 'MEDIUM' &&
      c.confidence === 'HIGH' &&
      c.autonomous === true &&
      existing.workflow === expectedWorkflow &&
      existing.dod_path === dodPath;
    if (!complete) {
      if (existing) {
        existing.slice_id = slice;
        existing.classification = { ...SLICE_CLASSIFICATION };
        existing.workflow = expectedWorkflow;
        existing.dod_path = dodPath;
        existing.status = 'in_progress';
      } else {
        state.teams.push({
          id: slice,
          slice_id: slice,
          status: 'in_progress',
          escalations: {},
          classification: { ...SLICE_CLASSIFICATION },
          workflow: expectedWorkflow,
          dod_path: dodPath,
        });
      }
      teamsChanged = true;
    }
  }
  if (teamsChanged) writeCtoState(state, root);

  for (const slice of SLICES) {
    const dodDir = join(root, '.work-state', 'artifacts', slice);
    mkdirSync(dodDir, { recursive: true });
    const dodPath = join(dodDir, 'dod.json');
    writeFileSync(
      dodPath,
      `${JSON.stringify(
        {
          items: [{ id: `${slice}-1`, criterion: `${slice} acceptance criteria`, status: 'pending' }],
          type_requirements_met: false,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    record({ t: 'slice-dod', slice, path: dodPath });
  }

  // Real git worktrees: created once on the first wave, reused on resume
  // (restart/follow-up) — the resume path is the production behavior.
  mkdirSync(join(root, 'worktrees'), { recursive: true });
  const worktrees: Array<{ slice: string; path: string; branch: string; created: boolean }> = [];
  for (const slice of SLICES) {
    const wtPath = join(root, 'worktrees', slice);
    const created = !existsSync(join(wtPath, '.git'));
    if (created) git(root, ['worktree', 'add', wtPath, '-b', slice]);
    const branch = git(wtPath, ['branch', '--show-current']);
    worktrees.push({ slice, path: wtPath, branch, created });
    record({ t: 'worktree', slice, path: wtPath, branch, created });
  }

  // CONCURRENT execution: both slice workers run in parallel (Promise.all).
  await Promise.all(worktrees.map((wt) => spawnSliceWorker(wt.path, wt.slice)));

  const slices = worktrees.map((wt) => ({
    slice: wt.slice,
    worktree: wt.path,
    branch: wt.branch,
    commit: git(wt.path, ['rev-parse', 'HEAD']),
  }));
  record({ t: 'wave-done', runId, waveId, taskId: task.id, slices });

  // Wave completion: the run stays resident (standby carve-out); the
  // summary delivery is drained by the next tick to the primary + RO sinks.
  const finalState = readCtoState(runId, root);
  if (finalState) finishWave(finalState, { id: waveId, status: 'done' }, root);
  queueCtoDelivery(root, runId, {
    id: `${runId}/system/summary/${Date.now()}`,
    level: 'question',
    title: `Wave ${task.id} complete`,
    body: JSON.stringify({ waveId, slices }),
    intent: 'summary',
    topic: 'summary',
  });
}

// ── Dispatcher wiring ──────────────────────────────────────────────────────

// Serialized per task: a promise chain — two tasks arriving in one poll must
// never overlap (ticks never overlap either, but a burst within one poll is
// serialized here as well). A rejected executor is recorded as wave-error,
// never thrown back into the wake path.
let chain: Promise<void> = Promise.resolve();
const onTask = (task: InboxTask): void => {
  const runId = task.runId ?? '';
  const waveId = task.waveId ?? '';
  record({ t: 'wake', at: new Date().toISOString(), task: { id: task.id, text: task.text, by: task.by, runId, waveId } });
  chain = chain
    .then(() => executeWave(task))
    .catch((error: unknown) => {
      record({ t: 'wave-error', taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    });
};
const onAnswer = (answer: { id: string; answer: string }): void => {
  record({ t: 'answer', id: answer.id, answer: answer.answer });
};

  // Start the dispatcher while the controller is still unbound. The lease is
  // the first ownership boundary: a live foreign lease exits before CTO
  // ingress can publish a standby run or claim.
  const stop = startChannelDispatcher(root, channelSet, intervalMs, {
    binding: dispatcherBinding,
    onTask,
    onAnswer,
  });
  if (!ownsCurrentDispatcherLease()) {
    stop();
    record({ t: 'lease-busy', at: new Date().toISOString(), sessionId });
    process.exit(3);
  }

  // Only the lease owner may publish/bind the real core CTO claim. A failed
  // acquisition must release this process's dispatcher lease before surfacing.
  const ingress = (() => {
    try {
      return acquireCtoIngress({
        cwd: root,
        branch,
        task: '',
        controller,
        ...(requestedRunId ? { run_id: requestedRunId } : {}),
      });
    } catch (error) {
      stop();
      throw error;
    }
  })();
  const exactClaim = controller.activeCtoClaim();
  if (
    !exactClaim
    || exactClaim.run_id !== ingress.run_id
    || exactClaim.ownership_epoch !== ingress.claim.claim.ownership_epoch
  ) {
    stop();
    throw new Error(`CTO ingress did not produce an active exact claim for run ${ingress.run_id}`);
  }

  let onlineAckId: string | undefined;
  if (channelSet.profile.direction === 'rw') {
    onlineAckId = `${exactClaim.run_id}/system/ack/${Date.now()}`;
    queueCtoDelivery(root, exactClaim.run_id, {
      id: onlineAckId,
      level: 'question',
      title: 'CTO online',
      body: 'resident standby',
      intent: 'ack',
    });
  }
  record({
    t: 'start',
    at: new Date().toISOString(),
    runId: exactClaim.run_id,
    ownershipEpoch: exactClaim.ownership_epoch,
    sessionId: executionContext.session_id,
    branch: executionContext.branch,
    ...(onlineAckId ? { onlineAckId } : {}),
  });

// SIGTERM/SIGINT: release the dispatcher lease, then perform the managed CTO
// suspension before this child tears down its controller/process identity.
let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // worker already gone
    }
  }
  try {
    stop();
    suspendCtoSession(controller, 'session-shutdown');
    record({ t: 'shutdown', runId: exactClaim.run_id, ownershipEpoch: exactClaim.ownership_epoch });
  } catch (error) {
    record({
      t: 'shutdown-error',
      runId: exactClaim.run_id,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
}

if (leaseOnly) {
  runLeaseOnly();
} else {
  runNormal();
}
