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
 * Usage: node --import tsx cto-process-dispatcher.ts --root <scratch> --evidence <evidencePath> --interval-ms <ms>
 *
 * Protocol (append-only JSONL on the evidence file):
 *   {"t":"start", at}                                     after channel set creation
 *   {"t":"wake", at, task:{id,text,by,runId,waveId}}      one per admitted task
 *   {"t":"answer", id, answer}                            escalation answers (none in this E2E)
 *   {"t":"wave-start", runId, waveId, taskId}
 *   {"t":"slice-dod", slice, path}                        per-slice DoD written BEFORE workers
 *   {"t":"worktree", slice, path, branch, created}        created=true on first wave, false on resume
 *   {"t":"wave-done", runId, waveId, taskId, slices:[{slice,worktree,branch,commit}]}
 *   {"t":"wave-error", taskId, error}                     executor failure — the wake must never die
 *   {"t":"lease-busy", at}                                live foreign lease -> exit code 3
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
  type InboxTask,
} from '../../../fullstack/src/adapters/registry.js';
import { MockEscalationAdapter, registerMockAdapterForTesting } from '../../../fullstack/src/adapters/mock.js';
import { writeFullstackActivationMarker } from '../../../fullstack/src/activation-marker.js';
import { fullstackOwnerForCwd } from '../../../fullstack/src/index.js';
import { findActiveCtoRun } from '../../../core/src/commands/cto.js';
import { readCtoState, writeCtoState } from '../../../core/src/cto/state.js';
import { finishWave } from '../../../core/src/cto/waves.js';
import { resolveWorkflow } from '../../../core/src/engine/profile.js';
import { openCtoRuntimeAccess, type CtoRuntimeAccessFacade } from '@andvl1/omp-workflows-core/cto-runtime';
import {
  beginRegistryRegistration,
  closeWorkflowActivation,
  commitRegistryRegistration,
  createRegistryRegistrationLiveGuard,
  openWorkflowActivation,
  rollbackRegistryRegistration,
} from '@andvl1/omp-workflows-core/registry';

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
if (!root || !evidencePath) {
  process.stderr.write('usage: cto-process-dispatcher.ts --root <scratch> --evidence <path> --interval-ms <ms>\n');
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
// The E2E fixture explicitly injects the "mock" transport below. createChannelSet
// matches channel entries BY ADAPTER KIND (channels.find(c => c.adapter ===
// kind)), so two channels with adapter "mock" would BOTH build from the
// FIRST entry — the RO audit sink would share the control dir and RO-only
// assertions would be meaningless. A distinct transport kind is exactly how
// production wires a second channel (e.g. telegram RW + http RO): register
// "mock-ro" through the exported consumer seam and build the persisted mock
// the same way the built-in factory does.
writeFullstackActivationMarker(root);
const registrationActivation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], fullstackOwnerForCwd(root));
if (!registrationActivation.ok) throw new Error(`${registrationActivation.code}: ${registrationActivation.error}`);
const registrationTransaction = beginRegistryRegistration(registrationActivation.registry_context, root, ["escalation_adapters", "workflow_tools"]);
if (!registrationTransaction.ok) {
  closeWorkflowActivation(registrationActivation);
  throw new Error(`${registrationTransaction.code}: ${registrationTransaction.error}`);
}
const activationSnapshotGuard = createRegistryRegistrationLiveGuard(registrationTransaction.token, "workflow_tools");
try {
  registerMockAdapterForTesting(registrationTransaction.token);
  registerEscalationAdapter(registrationTransaction.token, "mock-ro", (config, cwd) => {
    const mock = config["mock-ro"] as { persisted?: boolean; dir?: string } | undefined;
    if (mock?.persisted === true) {
      return new MockEscalationAdapter({ persisted: { dir: resolve(cwd, mock.dir ?? ".omp/fake-rw"), root: cwd } });
    }
    return new MockEscalationAdapter();
  }, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
  commitRegistryRegistration(registrationTransaction.token);
} catch (error) {
  try { rollbackRegistryRegistration(registrationTransaction.token); } finally {
    closeWorkflowActivation(registrationActivation);
  }
  throw error;
}

const openedRuntime = openCtoRuntimeAccess(
  registrationActivation.registry_context,
  { sessionId: `cto-process-dispatcher-${process.pid}`, main: true },
  root,
);
if (!openedRuntime.ok) {
  closeWorkflowActivation(registrationActivation);
  throw new Error(`${openedRuntime.code}: ${openedRuntime.error}`);
}
const runtimeAccess: CtoRuntimeAccessFacade = openedRuntime.access;
const sessionId = `cto-process-dispatcher-${process.pid}`;
const activationLiveGuard = activationSnapshotGuard;
const channelSet = createChannelSet(root, undefined, undefined, runtimeAccess);

// ── Wave executor (deterministic resident simulation, no LLM) ──────────────

const SLICE_WORKER = fileURLToPath(new URL('./slice-worker.ts', import.meta.url));

/** In-flight slice workers — awaited and reaped on shutdown. */
const workers = new Set<ChildProcess>();

/** Spawn one slice-worker child; resolves when it exits 0, rejects otherwise. */
function spawnSliceWorker(worktree: string, slice: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const worker: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', SLICE_WORKER, '--worktree', worktree, '--slice', slice, '--evidence', evidencePath],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    workers.add(worker);
    let out = '';
    let err = '';
    worker.stdout?.on('data', (d: Buffer) => (out += String(d)));
    worker.stderr?.on('data', (d: Buffer) => (err += String(d)));
    worker.on('error', reject);
    worker.on('close', (code) => {
      workers.delete(worker);
      if (code === 0) resolveP();
      else reject(new Error(`slice-worker ${slice} exited ${code}: ${err || out}`));
    });
  });
}

async function executeWave(task: InboxTask): Promise<void> {
  const runId = task.runId ?? '';
  const waveId = task.waveId ?? '';
  record({ t: 'wave-start', runId, waveId, taskId: task.id });

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
  if (teamsChanged) writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });

  for (const slice of SLICES) {
    const dodDir = join(root, '.work-state', 'artifacts', slice);
    mkdirSync(dodDir, { recursive: true });
    const dodPath = join(dodDir, 'dod.json');
    writeFileSync(
      dodPath,
      `${JSON.stringify(
        {
          items: [{
            id: `${slice}-1`,
            source: 'cto-process-e2e',
            criterion: `${slice} acceptance criteria`,
            verify_method: 'automated process E2E',
            status: 'pending',
            evidence: '',
          }],
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
  if (channelSet.profile.direction === 'rw') queueOnlineAck(runId);
  queueCtoDelivery(root, runId, {
    id: `${runId}/system/summary/${Date.now()}`,
    level: 'question',
    title: `Wave ${task.id} complete`,
    body: JSON.stringify({ waveId, slices }),
    intent: 'summary',
    topic: 'summary',
  }, undefined, undefined, runtimeAccess);
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

// Replicate the production session_start resident wiring: when the resolved
// profile is RW AND an active CTO run exists, queue the online-ACK delivery
// (drained by the dispatcher's immediate first tick). A brand-new resident
// has no active run until its first inbox task is admitted, so the same ACK is
// queued from onTask below for that first run.
let onlineAckQueued = false;
const queueOnlineAck = (runId: string): void => {
  if (onlineAckQueued) return;
  const published = queueCtoDelivery(root, runId, {
    id: `${runId}/system/ack/${Date.now()}`,
    level: 'question',
    title: 'CTO online',
    body: 'resident standby',
    intent: 'ack',
  }, undefined, undefined, runtimeAccess);
  if (published !== null) onlineAckQueued = true;
};
if (channelSet.profile.direction === 'rw') {
  const active = findActiveCtoRun(root);
  if (active) queueOnlineAck(active.runId);
}

const stop = startChannelDispatcher(root, channelSet, intervalMs, { onTask, onAnswer, runtimeAccess, session_id: sessionId, liveGuard: activationLiveGuard });

// Fail-closed lease verification: after start, the lock file must name OUR
// pid. When a LIVE foreign lease exists the claim returns null and the loop
// returns a no-op stop — detect it and exit 3 so the test can assert the
// single-dispatcher-per-root contract.
let leaseHeld = false;
try {
  const raw = JSON.parse(readFileSync(dispatcherLockPath(root), 'utf8')) as { pid?: number };
  leaseHeld = raw.pid === process.pid;
} catch {
  leaseHeld = false;
}
if (!leaseHeld) {
  record({ t: 'lease-busy', at: new Date().toISOString() });
  runtimeAccess.close();
  closeWorkflowActivation(registrationActivation);
  process.exit(3);
}

// SIGTERM/SIGINT: stop every spawned worker, await their close events,
// then release the dispatcher lease and exit. A direct process.exit before
// awaiting children lets node-isolation workers survive the fixture.
let stopping = false;
async function stopWorker(worker: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolveExit) => worker.once('close', () => resolveExit()));
  if (worker.exitCode === null && worker.signalCode === null) {
    try {
      worker.kill('SIGTERM');
    } catch {
      // worker may have exited between the state check and signal.
    }
  }
  let timer: NodeJS.Timeout | undefined;
  const graceful = new Promise<boolean>((resolveGraceful) => {
    timer = setTimeout(() => resolveGraceful(false), 45_000);
    void exited.then(() => {
      if (timer !== undefined) clearTimeout(timer);
      resolveGraceful(true);
    });
  });
  if (!await graceful) {
    throw new Error('slice worker did not exit gracefully within 45000ms after SIGTERM');
  }
}
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const dispatcherStopped = stop();
  await Promise.all([...workers].map((worker) => stopWorker(worker)));
  try {
    await dispatcherStopped;
  } catch {
    // best-effort release; the heartbeat TTL handles crashed owners
  } finally {
    runtimeAccess.close();
    closeWorkflowActivation(registrationActivation);
  }
  process.exitCode = 0;
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
record({ t: 'start', pid: process.pid, at: new Date().toISOString() });
