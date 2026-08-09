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
 * handleInboxTask / resolveInboxRunId) plus the core wave/gate APIs against
 * an ISOLATED temporary git repository with real git worktrees. No network,
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  dispatcherLockPath,
  inboxDir,
  queueCtoDelivery,
  sha256Hex,
} from '../../fullstack/src/adapters/registry.js';
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

/** Write one inbound task file (single-writer: the test is the writer). */
function writeInbound(scratch: string, name: string, task: { id: string; text: string; at: string; by: string }): void {
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
    ['--import', 'tsx', FIXTURE, '--root', scratch, '--evidence', evidencePath, '--interval-ms', String(intervalMs)],
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
  // Two-channel config: RW primary "control" (persisted fake-RW) + RO
  // audit sink "audit" (persisted, subscribed to progress/summary). The
  // audit channel uses the "mock-ro" transport kind registered by the
  // dispatcher fixture — createChannelSet builds each channel from the
  // entry whose adapter kind matches, so distinct kinds are required for
  // distinct persisted dirs.
  writeFileSync(
    join(scratch, '.omp', 'escalation.json'),
    `${JSON.stringify(
      {
        channels: [
          {
            id: 'control',
            adapter: 'mock',
            direction: 'read-write',
            primary: true,
            mock: { persisted: true, dir: '.omp/fake-rw-control' },
          },
          {
            id: 'audit',
            adapter: 'mock-ro',
            direction: 'read-only',
            subscriptions: ['progress', 'summary'],
            mock: { persisted: true, dir: '.omp/fake-rw-audit' },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(scratch, 'slices'), { recursive: true });
  writeFileSync(join(scratch, 'README.md'), '# Process E2E scratch\n');
  writeFileSync(join(scratch, 'slices', '.gitkeep'), '');
  git(scratch, ['init', '-b', 'main']);
  git(scratch, ['add', '-A']);
  git(scratch, ['commit', '-m', 'initial']);
}

test('cto process e2e: resident control plane — waves, worktrees, dedupe, restart recovery, gates', async () => {
  // GIVEN: an isolated scratch git repository with the two-channel escalation config.
  const scratch = mkdtempSync(join(tmpdir(), 'omp-cto-process-e2e-'));
  const evidencePath = join(scratch, 'evidence.jsonl');
  const children: TrackedChild[] = [];
  const stopped = new Set<TrackedChild>();
  try {
    initScratch(scratch);

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
    writeInbound(scratch, 'task-1.json', {
      id: MAIN_TASK_ID,
      text: MAIN_TASK_TEXT,
      at: new Date().toISOString(),
      by: 'fake-rw',
    });

    // THEN (all from disk): durable inbox admission + wave + online ack.
    const wakeMain = await waitForEvidence(
      evidencePath,
      (l) => l.t === 'wake' && l.task?.id === MAIN_TASK_ID,
      'main wake',
      20_000,
    );
    const runId = wakeMain.task.runId;
    const wave1Id = wakeMain.task.waveId;
    assert.ok(typeof runId === 'string' && runId.length > 0, 'wake carries runId');
    assert.ok(typeof wave1Id === 'string' && wave1Id.length > 0, 'wake carries waveId');

    assert.ok(
      existsSync(join(scratch, '.work-state', 'cto', runId, 'inbox', `${MAIN_TASK_ID}.json`)),
      'inbox task file is durable on disk',
    );
    const stateA = readCtoState(runId, scratch);
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
      () => readCtoState(runId, scratch)!.wave_history![0].status === 'done',
      { timeoutMs: 15_000, label: 'main wave done' },
    );
    await waitFor(
      () => controlLines(scratch).some((l) => l.intent === 'summary' && l.receipt?.sent === true),
      { timeoutMs: 15_000, label: 'main summary line' },
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE C — RO-REPORT-ONLY
    // ══════════════════════════════════════════════════════════════════════
    const auditOut = join(scratch, '.omp', 'fake-rw-audit', 'outbound', 'messages.jsonl');
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
      () => !existsSync(dispatcherLockPath(scratch)),
      { timeoutMs: 5_000, label: 'dispatcher lease released' },
    );
    // Queue a delivery from the TEST while no dispatcher runs — it must sit
    // durably in the outbox until the restarted dispatcher drains it.
    const progressId = `${runId}/system/progress/${Date.now()}`;
    const queued = queueCtoDelivery(scratch, runId, {
      id: progressId,
      level: 'question',
      title: 'Progress',
      body: 'pending before restart',
      intent: 'progress',
    });
    assert.ok(queued, 'progress delivery queued');
    assert.ok(existsSync(queued!), 'delivery file durable in outbox before restart');

    const child2 = spawnFixture(scratch, evidencePath, 1000);
    children.push(child2);

    // THEN (disk): the pending delivery is recovered across the restart, and
    // the wave/run state is untouched (exactly-one wave, one inbox file,
    // admitted quarantine).
    await waitFor(
      () => controlLines(scratch).some((l) => l.escId === progressId && l.receipt?.sent === true),
      { timeoutMs: 15_000, label: 'progress recovered across restart' },
    );
    const stateD = readCtoState(runId, scratch)!;
    assert.equal(stateD.wave_history!.length, 1, 'exactly one wave after restart (no re-admission)');
    assert.equal(stateD.wave_history![0].source_id, MAIN_TASK_ID);
    assert.equal(readdirSync(inboxDir(runId, scratch)).length, 1, 'inbox dir has exactly one file');
    assert.equal(
      stateD.inbox_quarantine![sha256Hex(MAIN_TASK_TEXT)]?.status,
      'admitted',
      'main-task hash quarantined as admitted',
    );

    // ══════════════════════════════════════════════════════════════════════
    // PHASE E — DUPLICATE MESSAGE ID (both layers: quarantine hash + wx)
    // ══════════════════════════════════════════════════════════════════════
    const now = new Date().toISOString();
    // (a) same id + same text -> quarantine admitted-dedup
    writeInbound(scratch, 'task-2.json', { id: MAIN_TASK_ID, text: MAIN_TASK_TEXT, at: now, by: 'fake-rw' });
    // (b) same id + different text -> wx collision on the inbox file
    writeInbound(scratch, 'task-3.json', { id: MAIN_TASK_ID, text: 'Different text body for the same id', at: now, by: 'fake-rw' });
    await waitFor(
      () =>
        !existsSync(join(scratch, '.omp', 'fake-rw-control', 'inbound', 'task-2.json')) &&
        !existsSync(join(scratch, '.omp', 'fake-rw-control', 'inbound', 'task-3.json')),
      { timeoutMs: 10_000, label: 'duplicate tasks consumed by transport' },
    );

    const wakesMain = evidenceLines(evidencePath).filter((l) => l.t === 'wake' && l.task?.id === MAIN_TASK_ID);
    assert.equal(wakesMain.length, 1, 'no new wake for the duplicate message id');
    const stateE = readCtoState(runId, scratch)!;
    assert.equal(readdirSync(inboxDir(runId, scratch)).length, 1, 'still exactly one inbox file');
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
    });
    const wakeFollow = await waitForEvidence(
      evidencePath,
      (l) => l.t === 'wake' && l.task?.id === FOLLOW_TASK_ID,
      'follow-up wake',
      20_000,
    );
    const followWaveId = wakeFollow.task.waveId;
    assert.ok(typeof followWaveId === 'string' && followWaveId !== wave1Id, 'follow-up gets a NEW waveId');

    const runDirs = readdirSync(join(scratch, '.work-state', 'cto'));
    assert.equal(runDirs.length, 1, 'exactly one run dir (no new standby run)');
    assert.equal(runDirs[0], runId, 'follow-up landed in the SAME resident run');

    await waitFor(
      () => {
        const st = readCtoState(runId, scratch)!;
        return st.wave_history!.length === 2 && st.wave_history!.every((w) => w.status === 'done');
      },
      { timeoutMs: 30_000, label: 'two waves both done' },
    );
    const stateF = readCtoState(runId, scratch)!;
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
    const gateState = readCtoState(runId, scratch)!;
    const probeWaveId = `wave-gate-probe-${Date.now()}`;
    appendWave(
      gateState,
      { id: probeWaveId, source: 'gate-probe', source_id: 'gate-probe-1', task: 'gate probe wave', slice_ids: [...SLICES] },
      scratch,
    );
    const marker = buildCtoSliceMarker(runId, 'slice-a');
    const gateEvent = { toolName: 'task', input: { agent: 'team-lead', task: `work slice-a\n${marker}` } };

    // ALLOWED: full per-slice classification + workflow + DoD are on disk.
    assert.equal(
      ctoSliceTaskGate(gateEvent, { cwd: scratch }),
      undefined,
      'slice gate allows a fully-provisioned dispatchable slice',
    );

    // Negative (fail-closed, architecture-3): corrupt the persisted
    // classification and the gate must BLOCK mentioning the field.
    const pristine = structuredClone(readCtoState(runId, scratch));
    const corrupted = readCtoState(runId, scratch)!;
    const teamA = corrupted.teams.find((t) => t.id === 'slice-a' || t.slice_id === 'slice-a')!;
    teamA.classification = {
      type: 'FEATURE',
      complexity: 'MEDIUM',
      confidence: 'HIGH',
      autonomous: 'yes',
    } as never;
    writeCtoState(corrupted, scratch);
    try {
      const res = ctoSliceTaskGate(gateEvent, { cwd: scratch });
      assert.ok(res, 'gate blocks on corrupt classification');
      assert.match(res!.reason, /autonomous/, 'block reason mentions the field');
    } finally {
      writeCtoState(pristine!, scratch); // restore the real scratch state
    }
    assert.equal(ctoSliceTaskGate(gateEvent, { cwd: scratch }), undefined, 'gate allows again after restore');

    // Marker run mismatch -> actionable failure.
    const restored = readCtoState(runId, scratch)!;
    const mismatch = assertCtoSliceDispatchable(restored, { sliceId: 'slice-a', root: scratch, markerRunId: 'standby-other' });
    assert.equal(mismatch.ok, false);
    assert.match((mismatch as { reason: string }).reason, /marker run mismatch/, 'actionable mismatch reason');

    // Close the probe wave so no active wave lingers.
    finishWave(readCtoState(runId, scratch)!, { id: probeWaveId, status: 'done' }, scratch);

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
      () => !existsSync(dispatcherLockPath(scratch)),
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
