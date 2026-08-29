/**
 * CTO resident control-plane — deterministic PROCESS-level E2E.
 *
 * WHY PROCESS-LEVEL (not the in-repo harness): `startTestSession`/`WsDriver`
 * (packages/e2e/src/server.ts) spawn an omp PTY and are UX-oriented. A
 * deterministic control-plane E2E needs a REAL process boundary for the
 * dispatcher: stop/restart lease recovery, cross-process file observability
 * (persisted fake-RW transport), and pending-delivery recovery across
 * restarts only exist when the dispatcher runs in its own process. This test
 * drives the ACTUAL exported fullstack dispatcher machinery
 * (createChannelSet / startChannelDispatcher / queueCtoDelivery /
 * handleInboxTask) plus the core wave/gate APIs against an
 * ISOLATED temporary git repository with real git worktrees. No network,
 * no credentials, no LLM, no omp binary.
 *
 * Test code NEVER writes inside the monorepo: every artifact lives in a
 * fresh `mkdtempSync` scratch (the dispatcher fixture + slice workers are
 * child processes of this test, running against the scratch root).
 *
 * The TEST is the single writer of the fake-RW `inbound/` task files
 * (documented single-writer contract of the persisted mock transport — the
 * adapter only ever consumes them); the fixture/workers are single writers
 * of their own evidence lines and worktree commits.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { WorkflowRunIdentity } from '@andvl1/omp-workflows-core';
import {
  dispatcherLockPath,
  queueCtoDelivery,
  sha256Hex,
} from '../../fullstack/src/adapters/registry.js';
import { runtimeFixture, type RuntimeFixture } from '../../fullstack/test/runtime-fixtures.js';
import { appendWave, finishWave, readCtoState, writeCtoState } from '../../core/src/cto/state.js';
import {
  assertCtoSliceDispatchable,
  buildCtoSliceMarker,
  ctoSliceTaskGate,
} from '../../core/src/cto/slice-gate.js';
import { ctoNestingGuard } from '../../core/src/gates/cto-nesting.js';
import { waitFor } from '../src/driver.js';

/** Absolute paths to the child-process fixtures (siblings of this test). */
const FIXTURE = fileURLToPath(new URL('./fixtures/cto-process-dispatcher.ts', import.meta.url));
const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Identity on EVERY git command (the scratch repo has no user config). */
const GIT_IDENTITY = ['-c', 'user.name=Process E2E', '-c', 'user.email=process-e2e@example.invalid'];

const MAIN_TASK_TEXT = 'Implement feature X with slice-a and slice-b';
const MAIN_TASK_ID = 'msg-main-1';
const FOLLOW_TASK_ID = 'msg-follow-1';
const SLICES = ['slice-a', 'slice-b'] as const;
const PROCESS_RUN_ID = 'process-e2e-run';

type EvidenceLine = Record<string, any>;

// ── Small helpers (node test conventions per the sibling cto-inbox-mock test) ──

function jsonlLines(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function evidenceLines(evidencePath: string): EvidenceLine[] {
  return jsonlLines(evidencePath);
}

function controlLines(scratch: string): Array<Record<string, any>> {
  return jsonlLines(join(scratch, '.omp', 'fake-rw-control', 'outbound', 'messages.jsonl'));
}

function auditLines(scratch: string): Array<Record<string, any>> {
  return jsonlLines(join(scratch, '.omp', 'fake-rw-audit', 'outbound', 'messages.jsonl'));
}

function storageJsonEntries(context: RuntimeFixture['context'], relativeDirectory: string): readonly { name: string; relative_path: string }[] {
  if (!context.storage) throw new Error('process E2E requires an explicit FullstackStorageAuthority');
  const listed = context.storage.listJsonBounded(relativeDirectory, 512);
  if (!listed.ok) throw new Error(`storage listing failed for ${relativeDirectory}: ${listed.message ?? listed.reason}`);
  return listed.value;
}

function storageExists(context: RuntimeFixture['context'], relativePath: string): boolean {
  if (!context.storage) throw new Error('process E2E requires an explicit FullstackStorageAuthority');
  const stat = context.storage.statBounded(relativePath);
  if (!stat.ok) throw new Error(`storage stat failed for ${relativePath}: ${stat.message ?? stat.reason}`);
  return stat.value.exists;
}

function ctoInboxRelative(runId: string, processed = false): string {
  return `.work-state/cto/${runId}/inbox${processed ? '/processed' : ''}`;
}

function fakeInboundRelative(name: string, processed = false): string {
  return `.omp/fake-rw-control/inbound${processed ? '/processed' : ''}/${name}`;
}

/** Write one inbound task file (single-writer: the test is the writer). */
function writeInbound(
  scratch: string,
  name: string,
  task: { id: string; text: string; at: string; by: string; run_identity: WorkflowRunIdentity },
): void {
  const dir = join(scratch, '.omp', 'fake-rw-control', 'inbound');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(task, null, 2)}\n`);
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}) in ${cwd}: ${(res.stderr ?? '').trim()}`);
  }
  return (res.stdout ?? '').trim();
}

/** Poll the evidence file until a line matches; returns that line. */
async function waitForEvidence(
  evidencePath: string,
  pred: (line: EvidenceLine) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<EvidenceLine> {
  let found: EvidenceLine | undefined;
  await waitFor(
    () => {
      found = evidenceLines(evidencePath).find(pred);
      return found !== undefined;
    },
    { timeoutMs, intervalMs: 50, label },
  );
  return found!;
}

interface TrackedChild {
  proc: ChildProcess;
  logs: { out: string; err: string };
}

function spawnFixture(scratch: string, evidencePath: string, intervalMs: number): TrackedChild {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', FIXTURE, '--root', scratch, '--evidence', evidencePath, '--interval-ms', String(intervalMs), '--run-id', PROCESS_RUN_ID],
    { cwd: E2E_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const logs = { out: '', err: '' };
  proc.stdout?.on('data', (d: Buffer) => (logs.out += String(d)));
  proc.stderr?.on('data', (d: Buffer) => (logs.err += String(d)));
  return { proc, logs };
}

/** SIGTERM, wait up to 5s, then SIGKILL fallback; returns the exit code. */
async function stopChild(tracked: TrackedChild): Promise<number> {
  const { proc } = tracked;
  if (proc.exitCode !== null) return proc.exitCode;
  const exited = new Promise<number>((resolve) => proc.once('exit', (code) => resolve(code ?? -1)));
  proc.kill('SIGTERM');
  const code = await Promise.race([
    exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(-2), 5000)),
  ]);
  if (code === -2) {
    proc.kill('SIGKILL');
    return exited;
  }
  return code;
}

function initScratch(scratch: string): void {
  mkdirSync(join(scratch, '.omp'), { recursive: true });
  mkdirSync(join(scratch, 'slices'), { recursive: true });
  writeFileSync(join(scratch, 'README.md'), '# Process E2E scratch\n');
  writeFileSync(join(scratch, 'slices', '.gitkeep'), '');
  git(scratch, ['init', '-b', 'main']);
  git(scratch, ['add', '-A']);
  git(scratch, ['commit', '-m', 'initial']);
}

test('cto process e2e: resident control plane — waves, worktrees, dedupe, restart recovery, gates', async () => {
  // GIVEN: an isolated scratch git repository with an explicit runtime context.
  const scratch = mkdtempSync(join(tmpdir(), 'omp-cto-process-e2e-'));
  const evidencePath = join(scratch, 'evidence.jsonl');
  const children: TrackedChild[] = [];
  const stopped = new Set<TrackedChild>();
  try {
    initScratch(scratch);
    const runtime = runtimeFixture(scratch, { runId: PROCESS_RUN_ID });
    const runIdentity = runtime.run_identity;
    const context = runtime.context;

    // ══════════════════════════════════════════════════════════════════════
    // PHASE A — MAIN WAVE + durable admission + online ACK
    // ══════════════════════════════════════════════════════════════════════
    const child1 = spawnFixture(scratch, evidencePath, 1000);
    children.push(child1);

    // WHEN: the dispatcher comes online and the main task lands in the RW inbound.
    await waitFor(
      () => evidenceLines(evidencePath).some((l) => l.t === 'start'),
      { timeoutMs: 10_000, label: 'dispatcher start evidence' },
    );
    const mainTaskAt = new Date().toISOString();
    writeInbound(scratch, 'task-1.json', {
      id: MAIN_TASK_ID,
      text: MAIN_TASK_TEXT,
      at: mainTaskAt,
      by: 'fake-rw',
      run_identity: runIdentity,
    });
    // THEN (all from disk): durable inbox admission + wave + online ack.
    const wakeMain = await waitForEvidence(
      evidencePath,
      (l) => l.t === 'wake' && l.task?.id === MAIN_TASK_ID,
      'main wake',
      20_000,
    );
    const runId = runIdentity.run_id;
    const wave1Id = wakeMain.task.waveId;
    assert.equal(wakeMain.task.runId, runId, 'wake carries the exact prepared run id');
    assert.deepEqual(wakeMain.task.run_identity, runIdentity, 'wake carries the exact prepared run identity');
    assert.ok(typeof wave1Id === 'string' && wave1Id.length > 0, 'wake carries waveId');

    const pendingInboxCount = storageJsonEntries(context, ctoInboxRelative(runId)).length;
    const processedInboxCount = storageJsonEntries(context, ctoInboxRelative(runId, true)).length;
    assert.equal(
      pendingInboxCount + processedInboxCount,
      1,
      'inbox task file is durable on disk (pending or processed)',
    );
    const stateA = readCtoState(runId, scratch, runIdentity);
    assert.ok(stateA, 'run state readable');
    assert.equal(stateA!.wave_history!.length, 1, 'exactly one wave admitted');
    assert.equal(stateA!.wave_history![0].source_id, MAIN_TASK_ID);
    assert.equal(stateA!.wave_history![0].status, 'active', 'wave active right after admission');
    await waitFor(
      () => controlLines(scratch).some((l) => l.intent === 'ack' && l.receipt?.sent === true),
      { timeoutMs: 10_000, label: 'online ack line' },
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE B — CONCURRENT WORKTREES + wave completion
    // ══════════════════════════════════════════════════════════════════════
    const doneA = await waitForEvidence(evidencePath, (l) => l.t === 'worker-done' && l.slice === 'slice-a', 'worker-done slice-a', 30_000);
    const doneB = await waitForEvidence(evidencePath, (l) => l.t === 'worker-done' && l.slice === 'slice-b', 'worker-done slice-b', 30_000);

    // Real git worktrees, distinct branches.
    const wtList = git(scratch, ['worktree', 'list', '--porcelain']);
    for (const slice of SLICES) {
      assert.match(wtList, new RegExp(`worktrees[\\/\\\\]${slice}`), `worktree path for ${slice}`);
      assert.match(wtList, new RegExp(`refs\\/heads\\/${slice}`), `distinct branch ${slice}`);
    }
    // Each worktree HEAD matches the worker's evidence commit; done.json is committed.
    for (const [slice, done] of [
      ['slice-a', doneA],
      ['slice-b', doneB],
    ] as const) {
      const wtPath = join(scratch, 'worktrees', slice);
      assert.equal(git(wtPath, ['rev-parse', 'HEAD']), done.commit, `HEAD commit matches evidence for ${slice}`);
      assert.ok(git(wtPath, ['show', 'HEAD:done.json']).includes(slice), `done.json committed for ${slice}`);
    }
    // DoD written BEFORE any worker spawn (per-slice ordering).
    const evB = evidenceLines(evidencePath);
    for (const slice of SLICES) {
      const dodIdx = evB.findIndex((l) => l.t === 'slice-dod' && l.slice === slice);
      const startIdx = evB.findIndex((l) => l.t === 'worker-start' && l.slice === slice);
      assert.ok(dodIdx >= 0 && startIdx >= 0, `slice-dod and worker-start present for ${slice}`);
      assert.ok(dodIdx < startIdx, `slice-dod precedes worker-start for ${slice}`);
    }
    // Per-slice DoD artifacts on disk.
    for (const slice of SLICES) {
      const dod = JSON.parse(readFileSync(join(scratch, '.work-state', 'artifacts', slice, 'dod.json'), 'utf8'));
      assert.ok(Array.isArray(dod.items) && dod.items.length > 0, `dod.json non-empty items for ${slice}`);
    }
    // Wave completes; summary delivery lands on the primary.
    await waitFor(
      () => readCtoState(runId, scratch, runIdentity)!.wave_history![0].status === 'done',
      { timeoutMs: 15_000, label: 'main wave done' },
    );
    await waitFor(
      () => controlLines(scratch).some((l) => l.intent === 'summary' && l.receipt?.sent === true),
      { timeoutMs: 15_000, label: 'main summary line' },
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE C — RO-REPORT-ONLY
    // ══════════════════════════════════════════════════════════════════════
    await waitFor(() => auditLines(scratch).length >= 1, { timeoutMs: 15_000, label: 'audit fan-out line' });
    const audit = auditLines(scratch);
    assert.ok(audit.length >= 1, 'audit sink received the summary');
    for (const line of audit) {
      assert.equal(line.intent, 'summary', 'audit line is a summary');
      assert.equal(line.receipt?.sent, true);
      assert.ok(line.topic === undefined || line.topic === 'summary', 'audit topic is summary');
    }
    assert.ok(
      !audit.some((l) => ['ack', 'question', 'progress'].includes(l.intent)),
      'audit has NO ack/question/progress lines',
    );
    assert.ok(
      !existsSync(join(scratch, '.omp', 'fake-rw-audit', 'inbound')),
      'RO sink never receives inbound',
    );
    assert.ok(
      !existsSync(join(scratch, '.omp', 'fake-rw-audit', 'answers')),
      'RO sink has no answers dir',
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE D — RESTART + PENDING DELIVERY RECOVERY
    // ══════════════════════════════════════════════════════════════════════
    const code1 = await stopChild(child1);
    stopped.add(child1);
    assert.equal(code1, 0, 'dispatcher child exits 0 on SIGTERM');
    await waitFor(
      () => !storageExists(context, dispatcherLockPath(context)),
      { timeoutMs: 5_000, label: 'dispatcher lease released' },
    );
    // Queue a delivery from the TEST while no dispatcher runs — it must sit
    // durably in the outbox until the restarted dispatcher drains it.
    const progressId = `${runId}/system/progress/${Date.now()}`;
    const queued = queueCtoDelivery(context, {
      id: progressId,
      level: 'question',
      title: 'Progress',
      body: 'pending before restart',
      intent: 'progress',
      run_identity: runIdentity,
    });
    if (!queued.ok) throw new Error(`progress delivery queue failed: ${queued.diagnostics.map((d) => d.remediation).join('; ')}`);
    assert.ok(queued.value, 'progress delivery queued');
    const queuedPath = queued.value;
    if (!queuedPath) throw new Error('progress delivery queue returned no durable path');
    assert.ok(storageExists(context, queuedPath), 'delivery file durable in outbox before restart');

    const child2 = spawnFixture(scratch, evidencePath, 1000);
    children.push(child2);

    // THEN (disk): the pending delivery is recovered across the restart, and
    // the wave/run state is untouched (exactly-one wave, one processed inbox file,
    // admitted quarantine).
    await waitFor(
      () => controlLines(scratch).some((l) => l.escId === progressId && l.receipt?.sent === true),
      { timeoutMs: 15_000, label: 'progress recovered across restart' },
    );
    const stateD = readCtoState(runId, scratch, runIdentity)!;
    assert.equal(stateD.wave_history!.length, 1, 'exactly one wave after restart (no re-admission)');
    assert.equal(stateD.wave_history![0].source_id, MAIN_TASK_ID);
    assert.equal(storageJsonEntries(context, ctoInboxRelative(runId, true)).length, 1, 'processed inbox has exactly one file');
    assert.equal(
      stateD.inbox_quarantine![sha256Hex(MAIN_TASK_TEXT)]?.status,
      'admitted',
      'main-task hash quarantined as admitted',
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE E — DUPLICATE MESSAGE ID (both layers: quarantine hash + wx)
    // ══════════════════════════════════════════════════════════════════════
    const now = mainTaskAt;
    // (a) same id + same text -> admitted dedup and processed transport file
    writeInbound(scratch, 'task-2.json', {
      id: MAIN_TASK_ID,
      text: MAIN_TASK_TEXT,
      at: now,
      by: 'fake-rw',
      run_identity: runIdentity,
    });
    // (b) same id + different text -> processed-key conflict remains retryable
    writeInbound(scratch, 'task-3.json', {
      id: MAIN_TASK_ID,
      text: 'Different text body for the same id',
      at: now,
      by: 'fake-rw',
      run_identity: runIdentity,
    });
    await waitFor(
      () => storageExists(context, fakeInboundRelative('task-2.json', true))
        && !storageExists(context, fakeInboundRelative('task-2.json'))
        && storageExists(context, fakeInboundRelative('task-3.json')),
      { timeoutMs: 10_000, label: 'duplicate tasks handled by transport' },
    );

    const wakesMain = evidenceLines(evidencePath).filter((l) => l.t === 'wake' && l.task?.id === MAIN_TASK_ID);
    assert.equal(wakesMain.length, 1, 'no new wake for the duplicate message id');
    const stateE = readCtoState(runId, scratch, runIdentity)!;
    assert.equal(storageJsonEntries(context, ctoInboxRelative(runId, true)).length, 1, 'still exactly one processed inbox file');
    assert.equal(stateE.wave_history!.length, 1, 'still exactly one wave');
    assert.equal(stateE.wave_history![0].source_id, MAIN_TASK_ID);
    assert.equal(
      stateE.inbox_quarantine![sha256Hex(MAIN_TASK_TEXT)]?.status,
      'admitted',
      'admitted record for the main-task hash',
    );
    assert.notEqual(
      stateE.inbox_quarantine![sha256Hex('Different text body for the same id')]?.status,
      'admitted',
      'no second admission for the different-text duplicate',
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE F — FOLLOW-UP WAVE (same resident run, worktree reuse)
    // ══════════════════════════════════════════════════════════════════════
    writeInbound(scratch, 'task-4.json', {
      id: FOLLOW_TASK_ID,
      text: 'Follow-up: polish slice-a',
      at: new Date().toISOString(),
      by: 'fake-rw',
      run_identity: runIdentity,
    });
    const wakeFollow = await waitForEvidence(
      evidencePath,
      (l) => l.t === 'wake' && l.task?.id === FOLLOW_TASK_ID,
      'follow-up wake',
      20_000,
    );
    const followWaveId = wakeFollow.task.waveId;
    assert.ok(typeof followWaveId === 'string' && followWaveId !== wave1Id, 'follow-up gets a NEW waveId');

    if (!context.storage) throw new Error('process E2E requires an explicit FullstackStorageAuthority');
    const runDirectories = context.storage.listBounded('.work-state/cto', 512);
    if (!runDirectories.ok) throw new Error(`run directory listing failed: ${runDirectories.message ?? runDirectories.reason}`);
    const runDirs = runDirectories.value.map((entry) => entry.name);
    assert.equal(runDirs.length, 1, 'exactly one run dir (no new standby run)');
    assert.equal(runDirs[0], runId, 'follow-up landed in the SAME resident run');

    await waitFor(
      () => {
        const st = readCtoState(runId, scratch, runIdentity)!;
        return st.wave_history!.length === 2 && st.wave_history!.every((w) => w.status === 'done');
      },
      { timeoutMs: 30_000, label: 'two waves both done' },
    );
    const stateF = readCtoState(runId, scratch, runIdentity)!;
    assert.equal(stateF.wave_history![1].source_id, FOLLOW_TASK_ID);
    assert.notEqual(stateF.wave_history![1].id, stateF.wave_history![0].id, 'distinct wave ids');

    // Worktree resume: each slice worktree was created once then REUSED.
    const wtLines = evidenceLines(evidencePath).filter((l) => l.t === 'worktree');
    for (const slice of SLICES) {
      const created = wtLines.find((l) => l.slice === slice && l.created === true);
      const reused = wtLines.find((l) => l.slice === slice && l.created === false);
      assert.ok(created, `worktree created for ${slice}`);
      assert.ok(reused, `worktree reused for ${slice}`);
      assert.equal(reused!.path, created!.path, `same worktree path reused for ${slice}`);
    }
    assert.equal(
      (git(scratch, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) ?? []).length,
      3,
      'still 3 worktrees total (main + 2 slices) — no re-creation',
    );

    await waitFor(
      () => controlLines(scratch).filter((l) => l.intent === 'summary' && l.receipt?.sent === true).length >= 2,
      { timeoutMs: 15_000, label: 'follow-up summary line' },
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE G — MARKER/LEAD GATE + NESTED CTO BLOCKED (closest core seam)
    // ══════════════════════════════════════════════════════════════════════
    // Nested CTO is structurally impossible.
    assert.ok(ctoNestingGuard({ toolName: 'task', input: { agent: 'cto' } }), 'task(agent:"cto") blocked');
    assert.ok(ctoNestingGuard({ toolName: 'task', input: { agent: '@cto' } }), 'task(agent:"@cto") blocked');
    assert.ok(
      ctoNestingGuard({ toolName: 'task', input: { tasks: [{ agent: '@cto' }] } }),
      'batch task(agent:"@cto") blocked',
    );
    assert.equal(
      ctoNestingGuard({ toolName: 'task', input: { agent: 'team-lead' } }),
      undefined,
      'non-CTO task allowed',
    );

    // The slice gate requires an ACTIVE wave (contract) — both real waves are
    // done by now, so admit a gate-probe wave to exercise the allow path.
    const gateState = readCtoState(runId, scratch, runIdentity)!;
    const probeWaveId = `wave-gate-probe-${Date.now()}`;
    appendWave(
      gateState,
      {
        id: probeWaveId,
        source: 'gate-probe',
        source_id: 'gate-probe-1',
        task: 'gate probe wave',
        slice_ids: [...SLICES],
        run_identity: runIdentity,
      },
      scratch,
    );
    const marker = buildCtoSliceMarker(runId, 'slice-a');
    const gateEvent = { toolName: 'task', input: { agent: 'team-lead', task: `work slice-a\n${marker}` } };
    const gateContext = { cwd: scratch, project_identity: runtime.project_identity, run_identity: runIdentity };

    // ALLOWED: full per-slice classification + workflow + DoD are on disk.
    assert.equal(
      ctoSliceTaskGate(gateEvent, gateContext),
      undefined,
      'slice gate allows a fully-provisioned dispatchable slice',
    );

    // Negative (fail-closed, architecture-3): corrupt the persisted
    // classification and the gate must BLOCK mentioning the field.
    const pristine = structuredClone(readCtoState(runId, scratch, runIdentity));
    const corrupted = readCtoState(runId, scratch, runIdentity)!;
    const teamA = corrupted.teams.find((t) => t.id === 'slice-a' || t.slice_id === 'slice-a')!;
    teamA.classification = {
      type: 'FEATURE',
      complexity: 'MEDIUM',
      confidence: 'HIGH',
      autonomous: 'yes',
    } as never;
    writeCtoState(corrupted, scratch, runIdentity);
    try {
      const res = ctoSliceTaskGate(gateEvent, gateContext);
      assert.ok(res, 'gate blocks on corrupt classification');
      assert.match(res!.reason, /autonomous/, 'block reason mentions the field');
    } finally {
      writeCtoState(pristine!, scratch, runIdentity); // restore the real scratch state
    }
    assert.equal(ctoSliceTaskGate(gateEvent, gateContext), undefined, 'gate allows again after restore');

    // Marker run mismatch -> actionable failure.
    const restored = readCtoState(runId, scratch, runIdentity)!;
    const mismatch = assertCtoSliceDispatchable(restored, { sliceId: 'slice-a', root: scratch, markerRunId: 'standby-other', runIdentity });
    assert.equal(mismatch.ok, false);
    assert.match((mismatch as { reason: string }).reason, /marker run mismatch/, 'actionable mismatch reason');

    // Close the probe wave so no active wave lingers.
    finishWave(readCtoState(runId, scratch, runIdentity)!, { id: probeWaveId, status: 'done', run_identity: runIdentity }, scratch);

    // No executor failure anywhere in the run.
    assert.ok(
      !evidenceLines(evidencePath).some((l) => l.t === 'wave-error' || l.t === 'worker-error'),
      'no wave/worker errors in the whole run',
    );

    // ══════════════════════════════════════════════════════════════════════
    // TEARDOWN — stop the live dispatcher, assert clean exit
    // ══════════════════════════════════════════════════════════════════════
    const code2 = await stopChild(child2);
    stopped.add(child2);
    assert.equal(code2, 0, 'dispatcher child #2 exits 0 on SIGTERM');
    await waitFor(
      () => !storageExists(context, dispatcherLockPath(context)),
      { timeoutMs: 5_000, label: 'dispatcher #2 lease released' },
    );
  } finally {
    // Kill every child (SIGTERM -> SIGKILL fallback), then drop the scratch.
    for (const tracked of children) {
      if (!stopped.has(tracked)) {
        await stopChild(tracked).catch(() => -1);
      }
    }
    for (const tracked of children) {
      assert.notEqual(tracked.proc.exitCode, null, 'no fixture child remains alive');
    }
    // The scratch holds the git worktrees; removing it removes them too.
    rmSync(scratch, { recursive: true, force: true });
  }
});
