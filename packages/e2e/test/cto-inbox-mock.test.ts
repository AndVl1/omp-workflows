/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  Escalation,
  EscalationAdapter,
  EscalationAnswer,
  EscalationInboundMessage,
  EscalationReceipt,
  WorkflowRunIdentity,
} from '@andvl1/omp-workflows-core';
import { startDispatcher, type DispatcherHandle, type InboxTask } from '../../fullstack/src/adapters/registry.js';
import { runtimeFixture } from '../../fullstack/test/runtime-fixtures.js';
import { WsDriver, waitFor } from '../src/driver.js';
import { startTestSession, type TestSession } from '../src/server.js';

type PlainMessageHandler = (task: EscalationInboundMessage) => Promise<void>;

/** Deterministic Telegram-shaped transport; no network or LLM is involved. */
class MockInboundAdapter implements EscalationAdapter {
  readonly kind = 'telegram';
  private handler: PlainMessageHandler | undefined;
  private readonly pending: InboxTask[] = [];
  private activePolls = 0;
  maxConcurrentPolls = 0;
  pollCount = 0;

  constructor(private readonly runIdentity: WorkflowRunIdentity) {}

  setPlainMessageHandler(handler: PlainMessageHandler): void {
    this.handler = handler;
  }

  push(id: string, text: string): void {
    this.pending.push({ id, text, at: new Date().toISOString(), by: 'mock-telegram', run_identity: this.runIdentity });
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    this.activePolls += 1;
    this.maxConcurrentPolls = Math.max(this.maxConcurrentPolls, this.activePolls);
    this.pollCount += 1;
    try {
      const batch = this.pending.splice(0);
      for (let index = 0; index < batch.length; index += 1) {
        try {
          await this.handler?.(batch[index]!);
        } catch (error) {
          this.pending.unshift(...batch.slice(index));
          throw error;
        }
      }
      return [];
    } finally {
      this.activePolls -= 1;
    }
  }

  async send(_escalation: Escalation): Promise<EscalationReceipt> {
    return { sent: true, run_identity: this.runIdentity };
  }

  async cancel(_id: string): Promise<void> {
    // No outbound channel is needed for this scenario.
  }
}

/**
 * Mock resident CTO attached to the real E2E PTY/WS surface. It keeps wave 1
 * active while inbox wakes arrive, then folds all received tasks into wave 2.
 */
class MockResidentCto {
  private writeChain = Promise.resolve();
  private active = false;
  private wave = 0;
  readonly received: InboxTask[] = [];

  constructor(private readonly driver: WsDriver) {}

  get activeWave(): number {
    return this.active ? this.wave : 0;
  }

  startWave(taskNames: string[]): Promise<void> {
    this.active = true;
    this.wave = 1;
    return this.send(`MOCK_WAVE_1_STARTED:${taskNames.join(',')}`);
  }

  async acceptInboxTask(task: InboxTask): Promise<void> {
    assert.equal(this.activeWave, 1, 'inbox task arrives while the current wave is active');
    this.received.push(task);
    await this.send(`[CTO-INBOX] ${task.id}: ${task.text}`);
  }

  async finishWaveAndStartNext(): Promise<void> {
    assert.equal(this.activeWave, 1, 'wave 1 must still be active before completion');
    await this.send('MOCK_WAVE_1_FINISHED');
    this.active = false;
    this.wave = 0;

    const ids = this.received.map(task => task.id).join(',');
    this.active = true;
    this.wave = 2;
    await this.send(`MOCK_WAVE_2_STARTED:${ids}`);
  }

  async flush(): Promise<void> {
    await this.writeChain;
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
  const now = new Date().toISOString();
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({
      schema: 1,
      id: 'run-active',
      task: 'finish the current product wave',
      branch: 'main',
      autonomous: true,
      plan: { id: 'run-active', task: 'finish the current product wave', teams: [], created_at: now },
      teams: [
        { id: 'team-a', status: 'working' },
        { id: 'team-b', status: 'working' },
        { id: 'team-c', status: 'working' },
      ],
      integration: { status: 'pending' },
      pause: { kind: 'none', reason: '' },
      updated_at: now,
    }) + '\n',
  );
}

function inboxRecordName(id: string): string {
  return `${Buffer.from(id, 'utf8').toString('base64url')}.json`;
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
  let dispatcher: DispatcherHandle | null = null;
  try {
    session = await startTestSession({
      cwd: scratch,
      ompBinary: mockOmp,
      surface: 'text',
      maxTimeSec: 30,
      idleMs: 30_000,
    });
    if (session.pty.mode !== 'pty') {
      t.skip('node-pty PTY is unavailable; startTestSession used its noPty fallback');
      return;
    }
    driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
    await driver.open();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_READY'), { label: 'mock omp ready' });

    await driver.type('/cto');
    await driver.pressEnter();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_STANDBY_READY'), { label: 'cto standby' });

    const resident = new MockResidentCto(driver);
    await resident.startWave(['team-a', 'team-b', 'team-c']);
    await resident.flush();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_WAVE_1_STARTED'), { label: 'wave 1 started' });

    const fixture = runtimeFixture(scratch, { runId: 'run-active' });
    const adapter = new MockInboundAdapter(fixture.run_identity);
    const started = startDispatcher(fixture.context, adapter, {
      intervalMs: 5,
      // This mirrors the production main-session callback: the resident CTO is
      // woken through a user message, not by starting another CTO session.
      onTask: async task => {
        await resident.acceptInboxTask(task);
      },
    });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error('mock dispatcher should start');
    dispatcher = started.value;

    // WHEN: two new tasks arrive while wave 1 is still active.
    adapter.push('tg:inbox-1', 'add the export endpoint');
    adapter.push('tg:inbox-2', 'update the mobile copy');
    await waitFor(() => resident.received.length === 2, { label: 'two inbox wakes', timeoutMs: 3000 });
    await resident.flush();

    // THEN: both tasks are durable in the active run, both wakes reach the
    // resident CTO, and no poll overlap occurs.
    assert.equal(resident.activeWave, 1);
    assert.deepEqual(
      readdirSync(join(fixture.project_root, '.work-state', 'cto', fixture.run_identity.run_id, 'inbox', 'processed'))
        .filter(name => name.endsWith('.json'))
        .sort(),
      [inboxRecordName('tg:inbox-1'), inboxRecordName('tg:inbox-2')].sort(),
    );
    assert.deepEqual(resident.received.map(task => task.text), ['add the export endpoint', 'update the mobile copy']);
    assert.equal(adapter.maxConcurrentPolls, 1, 'mock Telegram polling never overlaps');
    assert.ok(adapter.pollCount >= 1);
    await waitFor(async () => {
      const screen = await driver!.readScreen();
      return screen.includes('MOCK_INBOX_ACCEPTED:[CTO-INBOX] tg:inbox-1') && screen.includes('MOCK_INBOX_ACCEPTED:[CTO-INBOX] tg:inbox-2');
    }, { label: 'resident accepts both inbox tasks', timeoutMs: 3000 });

    // WHEN: the current wave completes.
    await resident.finishWaveAndStartNext();
    await resident.flush();

    // THEN: the queued tasks are folded into the next wave without spawning a
    // nested CTO or losing either message.
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_WAVE_2_STARTED:tg:inbox-1,tg:inbox-2'), {
      label: 'wave 2 started with both inbox tasks',
      timeoutMs: 3000,
    });
    assert.equal(resident.activeWave, 2);
    const processedInbox = join(fixture.project_root, '.work-state', 'cto', fixture.run_identity.run_id, 'inbox', 'processed');
    const files = readdirSync(processedInbox).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 2);
    const first = JSON.parse(readFileSync(join(processedInbox, inboxRecordName('tg:inbox-1')), 'utf8')) as {
      run_identity?: WorkflowRunIdentity;
    };
    assert.equal(first.run_identity?.run_id, 'run-active');
    assert.deepEqual(first.run_identity, fixture.run_identity);
  } finally {
    await dispatcher?.stop();
    await driver?.close();
    await session?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
