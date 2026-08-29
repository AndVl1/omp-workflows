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

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAdapterFactories,
  createChannelSet,
  dispatcherLockPath,
  queueCtoDelivery,
  registerEscalationAdapterFactory,
  sha256Hex,
  startChannelDispatcher,
  type InboxTask,
} from '../../../fullstack/src/adapters/registry.js';
import { MockEscalationAdapter } from '../../../fullstack/src/adapters/mock.js';
import { appendWave, finishWave, newCtoState, readCtoState, validateCtoRunIdentity, writeCtoState } from '../../../core/src/cto/state.js';
import type { AgentRef, WorkflowV2Digest } from '@andvl1/omp-workflows-core';
import { channelAdmission, runtimeFixture } from '../../../fullstack/test/runtime-fixtures.js';
import { resolveWorkflow } from '../../../core/src/engine/profile.js';

/** Identity on EVERY git command (the scratch repo has no user config). */
const GIT_IDENTITY = ['-c', 'user.name=Process E2E', '-c', 'user.email=process-e2e@example.invalid'];

/** The two slices every wave dispatches concurrently into real git worktrees. */
const SLICES = ['slice-a', 'slice-b'];

/** Per-slice PHASE-0 classification (architecture-3): complete before workers. */
const SLICE_CLASSIFICATION = { type: 'FEATURE', complexity: 'MEDIUM', confidence: 'HIGH', autonomous: true } as const;
const AGENT_SOURCE_FINGERPRINT = `sha256:${'b'.repeat(64)}` as WorkflowV2Digest;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const root = arg('--root');
const evidencePath = arg('--evidence');
const requestedRunId = arg('--run-id');
const intervalMs = Number(arg('--interval-ms') ?? '1000');
if (!root || !evidencePath || !requestedRunId) {
  process.stderr.write('usage: cto-process-dispatcher.ts --root <scratch> --evidence <path> --interval-ms <ms> --run-id <run-id>\n');
  process.exit(2);
}

const runtime = runtimeFixture(root, { runId: requestedRunId });
const runtimeContext = runtime.context;
const runIdentity = runtime.run_identity;
const runId = runIdentity.run_id;

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

const existingState = readCtoState(runId, root, runIdentity);
if (!existingState) {
  const standbyTask = 'standby — awaiting inbox tasks';
  const standby = newCtoState({
    id: runId,
    task: standbyTask,
    branch: '',
    autonomous: true,
    standby: true,
    run_identity: runIdentity,
    plan: {
      id: runId,
      task: standbyTask,
      teams: [],
      created_at: new Date().toISOString(),
      run_identity: runIdentity,
    },
  });
  writeCtoState(standby, root, runIdentity);
}

// ── Explicit channel admission and test transport factories ────────────────
//
// The production registry has no mock builtin. This process explicitly
// registers two persisted test transports and binds both to the exact runtime
// context and manager-issued channel admission.
const factories = createAdapterFactories();
for (const kind of ['mock', 'mock-ro']) {
  const registered = registerEscalationAdapterFactory(factories, kind, ({ project_root, run_identity, filesystem_authority, storage, channel }) => {
    if (!filesystem_authority || !storage || channel.persisted !== true || typeof channel.dir !== 'string') {
      throw new Error(`persisted ${kind} transport requires explicit storage, filesystem authority, and relative dir`);
    }
    return new MockEscalationAdapter({
      project_root,
      run_identity,
      filesystem_authority,
      storage,
      persisted: { relative_dir: channel.dir },
    });
  });
  if (!registered.ok) throw new Error(`failed to register ${kind}: ${registered.diagnostics.map((d) => d.remediation).join('; ')}`);
}

const admission = channelAdmission(runtime, [
  {
    id: 'control',
    adapter: 'mock',
    direction: 'read-write',
    primary: true,
    persisted: true,
    dir: '.omp/fake-rw-control',
  },
  {
    id: 'audit',
    adapter: 'mock-ro',
    direction: 'read-only',
    persisted: true,
    subscriptions: ['summary'],
    dir: '.omp/fake-rw-audit',
  },
]);
const context = { ...runtimeContext, channel_admission: admission };
const resolvedChannelSet = createChannelSet({ ...context, factories });
if (!resolvedChannelSet.ok) {
  throw new Error(`channel set activation failed: ${resolvedChannelSet.diagnostics.map((d) => d.remediation).join('; ')}`);
}
const channelSet = resolvedChannelSet.value;

// ── Wave executor (deterministic resident simulation, no LLM) ──────────────

const SLICE_WORKER = fileURLToPath(new URL('./slice-worker.ts', import.meta.url));
/** Package root used to resolve the tsx loader for workers launched in a git worktree. */
const E2E_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Pids of in-flight slice workers — reaped on shutdown (insurance only). */
const workerPids = new Set<number>();

/** Spawn one slice-worker child; resolves when it exits 0, rejects otherwise. */
function spawnSliceWorker(worktree: string, slice: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const worker: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', SLICE_WORKER, '--worktree', worktree, '--slice', slice, '--evidence', evidencePath],
      { cwd: E2E_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
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

async function executeWave(task: InboxTask, waveId: string): Promise<void> {
  const runIdentity = task.run_identity;
  const runId = runIdentity.run_id;
  record({ t: 'wave-start', runId, waveId, taskId: task.id });

  // Online ACK queued right after admission — the dispatcher's NEXT tick
  // drains it to the primary RW channel (RO sinks never receive
  // non-summary intents).
  const onlineAck = queueCtoDelivery(context, {
    id: `${runId}/system/ack/${Date.now()}`,
    level: 'question',
    title: 'CTO online',
    body: 'resident standby',
    intent: 'ack',
    run_identity: runIdentity,
  });
  if (!onlineAck.ok) throw new Error(`online ACK queue failed: ${onlineAck.diagnostics.map((d) => d.remediation).join('; ')}`);

  // Per-slice state + DoD BEFORE any worker spawn (architecture-3/7 proof):
  // the run's CtoState must carry full per-slice classification, the
  // matrix-resolved workflow, and dod_path, and the dod.json must exist
  // before the slice workers are dispatched — exactly what the
  // ctoSliceTaskGate enforces. Write only when missing/changed.
  const state = readCtoState(runId, root, runIdentity);
  if (!state) throw new Error(`no CtoState for run ${runId}`);
  const expectedWorkflow = resolveWorkflow('FEATURE', 'MEDIUM', true);
  const leadRef: AgentRef = {
    registered_name: 'team-lead',
    provider_id: runIdentity.provider_id,
    source_fingerprint: AGENT_SOURCE_FINGERPRINT,
  };
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
        existing.run_identity = runIdentity;
        existing.profile_identity = runIdentity.profile_identity;
        existing.lead_ref = leadRef;
        existing.roster_refs = [leadRef];
      } else {
        state.teams.push({
          id: slice,
          slice_id: slice,
          status: 'in_progress',
          escalations: {},
          classification: { ...SLICE_CLASSIFICATION },
          workflow: expectedWorkflow,
          dod_path: dodPath,
          run_identity: runIdentity,
          profile_identity: runIdentity.profile_identity,
          lead_ref: leadRef,
          roster_refs: [leadRef],
        });
      }
      teamsChanged = true;
    }
  }
  if (teamsChanged) writeCtoState(state, root, runIdentity);

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
  const finalState = readCtoState(runId, root, runIdentity);
  if (finalState) finishWave(finalState, { id: waveId, status: 'done', run_identity: runIdentity }, root);
  const summary = queueCtoDelivery(context, {
    id: `${runId}/system/summary/${Date.now()}`,
    level: 'question',
    title: `Wave ${task.id} complete`,
    body: JSON.stringify({ waveId, slices }),
    intent: 'summary',
    topic: 'summary',
    run_identity: runIdentity,
  });
  if (!summary.ok) throw new Error(`summary queue failed: ${summary.diagnostics.map((d) => d.remediation).join('; ')}`);
}

// ── Dispatcher wiring ──────────────────────────────────────────────────────

// Serialized per task: a promise chain — two tasks arriving in one poll must
// never overlap (ticks never overlap either, but a burst within one poll is
// serialized here as well). A rejected executor is recorded as wave-error,
// never thrown back into the wake path.
let chain: Promise<void> = Promise.resolve();
const onTask = async (task: InboxTask): Promise<void> => {
  const taskRunIdentity = task.run_identity;
  const state = readCtoState(taskRunIdentity.run_id, root, taskRunIdentity);
  if (!state) throw new Error(`no CtoState for run ${taskRunIdentity.run_id}`);
  const hash = sha256Hex(task.text);
  if (state.inbox_quarantine?.[hash]?.status === 'admitted') return;
  if (state.wave_history?.some((wave) => wave.source_id === task.id)) return;

  const waveId = `wave-${task.id}`;
  state.inbox_quarantine = state.inbox_quarantine ?? {};
  state.inbox_quarantine[hash] = {
    id: task.id,
    hash,
    received_at: task.at,
    by: task.by ?? 'fake-rw',
    status: 'admitted',
  };
  appendWave(
    state,
    {
      id: waveId,
      source: task.by ?? 'fake-rw',
      source_id: task.id,
      task: task.text,
      slice_ids: [...SLICES],
      run_identity: taskRunIdentity,
    },
    root,
  );
  record({
    t: 'wake',
    at: new Date().toISOString(),
    task: { id: task.id, text: task.text, by: task.by, runId: taskRunIdentity.run_id, waveId, run_identity: taskRunIdentity },
  });
  chain = chain
    .then(() => executeWave(task, waveId))
    .catch((error: unknown) => {
      record({ t: 'wave-error', taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    });
  await chain;
};
const onAnswer = (answer: { id: string; answer: string }): void => {
  record({ t: 'answer', id: answer.id, answer: answer.answer });
};

// The explicit runtime context and admitted channel set are already bound to
// this exact resident run. Queue the online ACK before the first dispatcher
// tick so it is drained by the primary RW channel.
if (channelSet.profile.direction === 'rw') {
  const onlineAck = queueCtoDelivery(context, {
    id: `${runId}/system/ack/${Date.now()}`,
    level: 'question',
    title: 'CTO online',
    body: 'resident standby',
    intent: 'ack',
    run_identity: runIdentity,
  });
  if (!onlineAck.ok) throw new Error(`online ACK queue failed: ${onlineAck.diagnostics.map((d) => d.remediation).join('; ')}`);
}

const started = startChannelDispatcher(context, channelSet, { intervalMs, onTask, onAnswer });
if (!started.ok) throw new Error(`dispatcher activation failed: ${started.diagnostics.map((d) => d.remediation).join('; ')}`);
const stop = started.value.stop;
record({ t: 'start', at: new Date().toISOString() });

// Fail-closed lease verification: after start, the lock file must carry OUR
// exact run identity. A foreign live lease yields no dispatcher capability;
// detect it and exit 3 so the test can assert single-dispatcher ownership.
let leaseHeld = false;
if (context.storage) {
  const lock = context.storage.readJsonBounded(dispatcherLockPath(context), 64 * 1024, 16);
  if (lock.ok && lock.value && typeof lock.value === 'object' && !Array.isArray(lock.value)) {
    const raw = lock.value as { lease_id?: unknown; run_identity?: unknown };
    leaseHeld = typeof raw.lease_id === 'string'
      && validateCtoRunIdentity(raw.run_identity, runIdentity).ok;
  }
}
if (!leaseHeld) {
  record({ t: 'lease-busy', at: new Date().toISOString() });
  process.exit(3);
}
// The dispatcher intentionally unrefs its poll timers so embedders do not
// inherit a process-liveness policy. This fixture is a resident process,
// though: keep one referenced handle until the explicit shutdown path.
const residentKeepAlive = setInterval(() => undefined, 60_000);

// SIGTERM/SIGINT: release the lease through the async stop function and exit 0.
let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(residentKeepAlive);
  for (const pid of workerPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // worker already gone
    }
  }
  try {
    await stop();
  } catch {
    // best-effort release; the heartbeat TTL handles crashed owners
  }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
