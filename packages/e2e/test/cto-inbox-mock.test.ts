import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { dispatcherLockPath, inboxDir, startDispatcher } from '../../fullstack/src/adapters/registry.js';
import { fullstackOwnerForCwd } from '../../fullstack/src/index.js';
import { writeFullstackActivationMarker } from '../../fullstack/src/activation-marker.js';
import { openCtoRuntimeAccess } from '@andvl1/omp-workflows-core/cto-runtime';
import { newCtoState, readCtoRunDeliveryIndexPage, readCtoState, setTeamStatus, writeCtoState } from '../../core/src/cto/state.js';
import { finishWave } from '../../core/src/cto/waves.js';
import { beginRegistryRegistration, closeWorkflowActivation, commitRegistryRegistration, createRegistryRegistrationLiveGuard, openWorkflowActivation, rollbackRegistryRegistration } from '@andvl1/omp-workflows-core/registry';
import { WsDriver, waitFor } from '../src/driver.js';
import { startTestSession, type TestSession } from '../src/server.js';

interface InboxTask {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly by?: string;
}

interface PlainMessageHandler {
  (task: InboxTask): void | Promise<void>;
}

const PTY_SETTLE_TIMEOUT_MS = 90_000;
// Descriptor-safe dispatcher ticks are bounded but intentionally not sub-10ms:
// a 5ms loop starves child-process close events during session startup.
const DISPATCHER_INTERVAL_MS = 10_000;
const INBOX_IDS = ['tg:inbox-1', 'tg:inbox-2'] as const;

/** Deterministic Telegram-shaped transport; no network or LLM is involved. */
class MockInboundAdapter {
  readonly kind = 'telegram';
  private handler: PlainMessageHandler | undefined;
  private pending: InboxTask[] = [];
  private activePolls = 0;
  maxConcurrentPolls = 0;
  pollCount = 0;

  setPlainMessageHandler(handler: PlainMessageHandler): void {
    this.handler = handler;
  }

  push(id: string, text: string): void {
    this.pending.push({ id, text, at: new Date().toISOString(), by: 'mock-telegram' });
  }

  acknowledge(id: string): void {
    this.pending = this.pending.filter(task => task.id !== id);
  }

  async pollOnce(): Promise<[]> {
    this.activePolls += 1;
    this.maxConcurrentPolls = Math.max(this.maxConcurrentPolls, this.activePolls);
    try {
      const batch = [...this.pending];
      for (const task of batch) await this.handler?.(task);
      return [];
    } finally {
      this.pollCount += 1;
      this.activePolls -= 1;
    }
  }

  async send(): Promise<{ sent: true }> {
    return { sent: true };
  }

  async cancel(): Promise<void> {
    // No outbound channel is needed for this scenario.
  }
}

/**
 * Mock resident CTO attached to the real E2E PTY/WS surface. It keeps wave 1
 * active while inbox wakes arrive, then folds all received tasks into wave 2.
 */
class MockResidentCto {
  private writeChain = Promise.resolve();
  private readonly pendingSends = new Set<Promise<void>>();
  private active = false;
  private wave = 0;
  readonly received: InboxTask[] = [];
  readonly events: string[] = [];

  constructor(private readonly driver: WsDriver) {}

  get activeWave(): number {
    return this.active ? this.wave : 0;
  }

  startWave(taskNames: string[]): Promise<void> {
    this.active = true;
    this.wave = 1;
    this.events.push('wave-1-started');
    return this.send(`MOCK_WAVE_1_STARTED:${taskNames.join(',')}`);
  }

  acceptInboxTask(task: InboxTask): void {
    assert.ok(this.activeWave === 1 || this.activeWave === 2 || this.activeWave === 3, 'inbox task arrives while a resident wave is active');
    this.received.push(task);
    this.events.push(`inbox:${task.id}`);
    const pending = new Promise<void>(resolve => {
      setImmediate(() => {
        void this.send(`[CTO-INBOX] ${task.id}: ${task.text}`).then(resolve, resolve);
      });
    });
    this.pendingSends.add(pending);
    void pending.then(() => this.pendingSends.delete(pending), () => this.pendingSends.delete(pending));
  }

  async finishWaveAndStartNext(): Promise<void> {
    const currentWave = this.activeWave;
    assert.ok(currentWave > 0, 'a resident wave must be active before completion');
    await this.send(`MOCK_WAVE_${currentWave}_FINISHED`);
    this.events.push(`wave-${currentWave}-finished`);
    this.active = false;
    this.wave = 0;

    const ids = this.received.map(task => task.id).join(',');
    this.active = true;
    this.wave = currentWave + 1;
    await this.send(`MOCK_WAVE_${this.wave}_STARTED:${ids}`);
    this.events.push(`wave-${this.wave}-started`);
  }

  async flush(): Promise<void> {
    for (;;) {
      await this.writeChain.catch(() => undefined);
      const pending = [...this.pendingSends];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private send(text: string): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await this.driver.type(text);
      await this.driver.pressEnter();
    });
    return this.writeChain;
  }
}

function writeMockOmp(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'omp-mock 1.0\\n'
  exit 0
fi
printf 'MOCK_READY\\n'
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\\r')
  case "$line" in
    /cto*) printf 'MOCK_STANDBY_READY\\n' ;;
    \\[CTO-INBOX\\]*) printf 'MOCK_INBOX_ACCEPTED:%s\\n' "$line" ;;
    MOCK_WAVE_1_FINISHED*) printf 'MOCK_WAVE_1_FINISHED\\n' ;;
    MOCK_WAVE_2_STARTED*) printf 'MOCK_WAVE_2_STARTED:%s\\n' "$line" ;;
    *) printf 'MOCK_INPUT:%s\\n' "$line" ;;
  esac
done
`,
  );
  chmodSync(path, 0o755);
}

function writeActiveRun(root: string): void {
  const runDir = join(root, '.work-state', 'cto', 'run-active');
  mkdirSync(join(runDir, 'inbox'), { recursive: true });
  mkdirSync(join(root, '.omp'), { recursive: true });
  writeFileSync(join(root, '.omp', 'escalation.json'), JSON.stringify({ channels: [{ id: 'control', adapter: 'mock', direction: 'read-write', primary: true, mock: { persisted: true, dir: '.omp/fake-rw-control' } }] }));
  const now = new Date().toISOString();
  const state = newCtoState({
    id: 'run-active',
    task: 'finish the current product wave',
    branch: 'main',
    autonomous: true,
    plan: {
      id: 'run-active',
      task: 'finish the current product wave',
      created_at: now,
      teams: ['team-a', 'team-b', 'team-c'].map(team => ({
        team,
        scope: [],
        slice: 'slice-' + team,
        profile: 'generic',
        worktree: 'same_branch',
        depends_on: [],
      })),
    },
  });
  for (const team of ['team-a', 'team-b', 'team-c']) setTeamStatus(state, team, 'in_progress');
  state.active_wave_id = 'wave-1';
  state.wave_history = [{
    id: 'wave-1',
    source: 'mock',
    source_id: 'mock-wave-1',
    task: 'finish the current product wave',
    slice_ids: ['team-a', 'team-b', 'team-c'],
    status: 'active',
    started_at: now,
  }];
  // Seed the active run through the canonical writer so the delivery index and
  // revision/CAS metadata are present before the resident dispatcher starts.
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
}

function markCanonicalWaveDone(root: string): void {
  const state = readCtoState('run-active', root);
  assert.ok(state, 'active run state remains readable while completing wave 1');
  const wave = state.wave_history?.find(candidate => candidate.id === state.active_wave_id);
  assert.ok(wave, 'canonical active wave is present before completion');
  finishWave(state, { id: wave.id, status: 'done' }, root);
}

function durableInboxIds(root: string): string[] {
  const state = readCtoState('run-active', root);
  if (!state) return [];
  return Object.values(state.inbox_quarantine ?? {})
    .filter(record => record.status === 'admitted' && record.wake_status === 'delivered')
    .map(record => record.id)
    .sort();
}

function durableWakeIds(root: string): string[] {
  const wakeDir = join(root, '.work-state', 'cto', 'run-active', 'wake-effects');
  if (!existsSync(wakeDir)) return [];
  return readdirSync(wakeDir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(wakeDir, name), 'utf8')) as { identity?: string; status?: string })
    .filter(record => record.status === 'delivered' && typeof record.identity === 'string')
    .map(record => record.identity as string)
    .sort();
}


test('mock E2E: resident CTO accepts inbox tasks during wave 1 and starts wave 2', async t => {
  // GIVEN: a real E2E PTY/WS session, an active CTO run with several teams,
  // and a deterministic Telegram-shaped inbound transport.
  const scratch = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-cto-inbox-'));
  writeActiveRun(scratch);
  const mockOmp = join(scratch, 'mock-omp.sh');
  writeMockOmp(mockOmp);

  let session: TestSession | null = null;
  let driver: WsDriver | null = null;
  let stopDispatcher: (() => Promise<void>) | null = null;
  const adapter = new MockInboundAdapter();
  let resident: MockResidentCto | null = null;
  let closeRuntimeAccess: (() => void) | undefined;
  try {
    writeFullstackActivationMarker(scratch);
    const activation = openWorkflowActivation(scratch, ['workflow_registration', 'workflow_tools'], fullstackOwnerForCwd(scratch));
    if (!activation.ok) throw new Error(`${activation.code}: ${activation.error}`);
    const registration = beginRegistryRegistration(activation.registry_context, scratch, ['workflow_tools']);
    if (!registration.ok) {
      closeWorkflowActivation(activation);
      throw new Error(`${registration.code}: ${registration.error}`);
    }
    const activationSnapshotGuard = createRegistryRegistrationLiveGuard(registration.token, 'workflow_tools');
    try {
      commitRegistryRegistration(registration.token);
    } catch (error) {
      try { rollbackRegistryRegistration(registration.token); } finally { closeWorkflowActivation(activation); }
      throw error;
    }
    const sessionId = `cto-inbox-mock-${process.pid}`;
    const activationLiveGuard = activationSnapshotGuard;
    const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId, main: true }, scratch);
    if (!opened.ok) {
      closeWorkflowActivation(activation);
      throw new Error(`${opened.code}: ${opened.error}`);
    }
    closeRuntimeAccess = () => {
      opened.access.close();
      closeWorkflowActivation(activation);
    };

    // Establish the PTY/WS surface before starting the resident dispatcher.
    // Its descriptor-safe tick performs synchronous filesystem work; starting
    // it first can starve child close and WS handshake events on a busy host.
    session = await startTestSession({
      cwd: scratch,
      ompBinary: mockOmp,
      surface: 'text',
      maxTimeSec: 30,
      idleMs: 30_000,
    });
    if (session.pty.mode !== 'pty') {
      await session.close();
      throw new Error('node-pty PTY is unavailable; startTestSession used its noPty fallback');
    }
    driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath, inputReceiptTimeoutMs: 90_000 });
    await driver.open();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_READY'), { label: 'mock omp ready' });

    await driver.type('/cto');
    await driver.pressEnter();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_STANDBY_READY'), { label: 'cto standby' });

    resident = new MockResidentCto(driver);
    await resident.startWave(['team-a', 'team-b', 'team-c']);
    await resident.flush();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_WAVE_1_STARTED'), { label: 'wave 1 started' });

    // The resident dispatcher claims the project control queue once. The
    // sender driver below only writes to that resident PTY and never starts a
    // competing dispatcher/session.
    stopDispatcher = startDispatcher(scratch, adapter as unknown as Parameters<typeof startDispatcher>[1], DISPATCHER_INTERVAL_MS, {
      onTask: task => {
        resident?.acceptInboxTask(task);
        adapter.acknowledge(task.id);
      },
      runtimeAccess: opened.access,
      session_id: sessionId,
      liveGuard: activationLiveGuard,
    });
    await waitFor(() => existsSync(dispatcherLockPath(scratch)), { label: 'resident dispatcher lease', timeoutMs: 3000 });
    const lease = JSON.parse(readFileSync(dispatcherLockPath(scratch), 'utf8')) as { pid?: number; token?: string; epoch?: number };
    assert.equal(lease.pid, process.pid, 'resident dispatcher owns the project control queue');
    assert.equal(typeof lease.token, 'string');
    assert.equal(typeof lease.epoch, 'number');
    const indexed = readCtoRunDeliveryIndexPage(scratch);
    assert.equal(indexed.active_run_id, 'run-active', 'active run is present in the canonical index');
    assert.equal(indexed.entries.some(entry => entry.run_id === 'run-active'), false, 'idle active run has no pending delivery page');

    // WHEN: two new tasks arrive while canonical wave 1 is active.
    adapter.push('tg:inbox-1', 'add the export endpoint');
    adapter.push('tg:inbox-2', 'update the mobile copy');
    await waitFor(() => {
      const state = readCtoState('run-active', scratch);
      return state?.active_wave_id === 'wave-1' && state.wave_history?.some(wave => wave.id === 'wave-1' && wave.status === 'active') === true;
    }, { label: 'canonical wave 1 active before inbox admission', timeoutMs: PTY_SETTLE_TIMEOUT_MS });
    await waitFor(() => readdirSync(inboxDir('run-active', scratch)).filter(name => name.endsWith('.json')).length === 2, {
      label: 'both inbox tasks durably queued for next waves', timeoutMs: PTY_SETTLE_TIMEOUT_MS,
    });
    assert.equal(resident.received.length, 0);
    assert.deepEqual(durableWakeIds(scratch), []);

    // Complete wave 1. Exactly one queued task starts wave 2; the second
    // remains durable until that active wave completes.
    markCanonicalWaveDone(scratch);
    await resident.finishWaveAndStartNext();
    await resident.flush();
    await waitFor(() => resident.received.length === 1, { label: 'first deferred wake in wave 2', timeoutMs: PTY_SETTLE_TIMEOUT_MS });
    await waitFor(() => durableWakeIds(scratch).join(',') === 'tg:inbox-1', { label: 'first wake delivered exactly once', timeoutMs: PTY_SETTLE_TIMEOUT_MS });
    const wave2 = readCtoState('run-active', scratch);
    assert.ok(wave2?.active_wave_id, 'canonical wave 2 is active');

    // Complete wave 2. The remaining task starts wave 3 exactly once.
    markCanonicalWaveDone(scratch);
    await resident.finishWaveAndStartNext();
    await resident.flush();
    await waitFor(() => resident.received.length === 2, { label: 'second deferred wake in wave 3', timeoutMs: PTY_SETTLE_TIMEOUT_MS });
    await waitFor(() => durableWakeIds(scratch).join(',') === [...INBOX_IDS].sort().join(','), { label: 'both wakes delivered exactly once', timeoutMs: PTY_SETTLE_TIMEOUT_MS });
    await waitFor(async () => {
      const screen = await driver!.readScreen();
      return screen.includes('MOCK_INBOX_ACCEPTED:[CTO-INBOX] tg:inbox-1') && screen.includes('MOCK_INBOX_ACCEPTED:[CTO-INBOX] tg:inbox-2');
    }, { label: 'resident accepts both queued tasks', timeoutMs: PTY_SETTLE_TIMEOUT_MS });
    const state = readCtoState('run-active', scratch);
    assert.ok(state?.active_wave_id, 'canonical wave 3 is active');
    assert.deepEqual(resident.received.map(task => task.text), ['add the export endpoint', 'update the mobile copy']);
    assert.deepEqual(resident.events, ['wave-1-started', 'wave-1-finished', 'wave-2-started', 'inbox:tg:inbox-1', 'wave-2-finished', 'wave-3-started', 'inbox:tg:inbox-2']);
    assert.deepEqual(durableInboxIds(scratch), [...INBOX_IDS].sort(), 'canonical state records both task IDs exactly once');
    assert.deepEqual(durableWakeIds(scratch), [...INBOX_IDS].sort(), 'no pending wake effects remain');
    const inboxFiles = readdirSync(inboxDir('run-active', scratch)).filter(name => name.endsWith('.json')).sort();
    assert.equal(inboxFiles.length, 2, 'both durable inbox files remain exactly once');
    assert.deepEqual(
      inboxFiles.map(name => JSON.parse(readFileSync(join(inboxDir('run-active', scratch), name), 'utf8')).id).sort(),
      [...INBOX_IDS].sort(),
    );
  } finally {
    try {
      await stopDispatcher?.();
    } finally {
      closeRuntimeAccess?.();
      try {
        await resident?.flush().catch(() => undefined);
      } finally {
        try {
          await driver?.close().catch(() => undefined);
        } finally {
          try {
            await session?.close();
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        }
      }
    }
  }
});
