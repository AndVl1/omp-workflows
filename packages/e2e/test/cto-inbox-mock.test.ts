import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { acquireCtoIngress, suspendCtoSession } from '../../core/src/cto/run.js';
import { createWorkflowSessionController, type WorkflowSessionController } from '../../core/src/engine/host-controller.js';
import { resolveActiveBranch } from '../../core/src/engine/state.js';
import type { TrustedExecutionContext } from '../../core/src/engine/types.js';
import { inboxDir, startDispatcher } from '../../fullstack/src/adapters/registry.js';
import { WsDriver, waitFor } from '../src/driver.js';
import { startTestSession, type TestSession } from '../src/server.js';

const GIT_IDENTITY = ['-c', 'user.name=Mock Inbox E2E', '-c', 'user.email=mock-inbox-e2e@example.invalid'];

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}
interface InboxTask {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly by?: string;
}

interface PlainMessageHandler {
  (task: InboxTask): void;
}

/** Deterministic Telegram-shaped transport; no network or LLM is involved. */
class MockInboundAdapter {
  readonly kind = 'telegram';
  private handler: PlainMessageHandler | undefined;
  private readonly pending: InboxTask[] = [];
  private activePolls = 0;
  maxConcurrentPolls = 0;
  pollCount = 0;

  setPlainMessageHandler(handler: PlainMessageHandler): void {
    this.handler = handler;
  }

  push(id: string, text: string): void {
    this.pending.push({ id, text, at: new Date().toISOString(), by: 'mock-telegram' });
  }

  async pollOnce(): Promise<[]> {
    this.activePolls += 1;
    this.maxConcurrentPolls = Math.max(this.maxConcurrentPolls, this.activePolls);
    this.pollCount += 1;
    try {
      const batch = this.pending.splice(0);
      for (const task of batch) this.handler?.(task);
      return [];
    } finally {
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

  acceptInboxTask(task: InboxTask): void {
    assert.equal(this.activeWave, 1, 'inbox task arrives while the current wave is active');
    this.received.push(task);
    void this.send(`[CTO-INBOX] ${task.id}: ${task.text}`);
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

function initScratch(root: string): void {
  mkdirSync(join(root, '.omp'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Mock inbox E2E scratch\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'initial']);
}

test('mock E2E: resident CTO accepts inbox tasks during wave 1 and starts wave 2', async t => {
  // GIVEN: a real E2E PTY/WS session, a fixture-owned CTO claim with a
  // canonical run, and a deterministic Telegram-shaped inbound transport.
  // This fixture does not exercise registered public slash ingress or simulate
  // public command acceptance; it acquires the exact claim through core ingress.
  const scratch = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-cto-inbox-'));
  initScratch(scratch);
  const mockOmp = join(scratch, 'mock-omp.sh');
  writeMockOmp(mockOmp);

  let session: TestSession | null = null;
  let driver: WsDriver | null = null;
  let stopDispatcher: (() => void) | null = null;
  let suspendSession: (() => void) | null = null;
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

    // The mock binary is used only for the PTY/WS surface; no public `/cto`
    // command is typed or accepted in this fixture.

    const resident = new MockResidentCto(driver);
    await resident.startWave(['team-a', 'team-b', 'team-c']);
    await resident.flush();
    await waitFor(async () => (await driver!.readScreen()).includes('MOCK_WAVE_1_STARTED'), { label: 'wave 1 started' });

    const sessionId = `mock-inbox:${scratch}`;
    const branch = resolveActiveBranch(scratch);
    const executionContext: TrustedExecutionContext = {
      session_id: sessionId,
      caller: 'host',
      process_id: process.pid,
      worktree: scratch,
      branch,
      authority: 'coordinator',
    };
    const controller: WorkflowSessionController = createWorkflowSessionController({ cwd: scratch, context: executionContext });
    const ingress = acquireCtoIngress({ cwd: scratch, branch, task: '', controller });
    const exactClaim = controller.activeCtoClaim();
    assert.ok(exactClaim, 'fixture ingress publishes an exact active claim');
    assert.equal(exactClaim.run_id, ingress.run_id);
    const runId = exactClaim.run_id;
    suspendSession = () => suspendCtoSession(controller, 'session-shutdown');

    const adapter = new MockInboundAdapter();
    stopDispatcher = startDispatcher(scratch, adapter as unknown as Parameters<typeof startDispatcher>[1], 5, {
      binding: { session_id: sessionId, getClaim: () => controller.activeCtoClaim() },
      // This mirrors the production main-session callback: the resident CTO is
      // woken through a user message, not by starting another CTO session.
      onTask: task => resident.acceptInboxTask(task),
    });

    // WHEN: two new tasks arrive while wave 1 is still active.
    adapter.push('tg:inbox-1', 'add the export endpoint');
    adapter.push('tg:inbox-2', 'update the mobile copy');
    await waitFor(() => resident.received.length === 2, { label: 'two inbox wakes', timeoutMs: 3000 });
    await resident.flush();

    // THEN: both tasks are durable in the active run, both wakes reach the
    // resident CTO, and no poll overlap occurs.
    assert.equal(resident.activeWave, 1);
    assert.deepEqual(
      readdirSync(inboxDir(runId, scratch)).filter(name => name.endsWith('.json')).sort(),
      ['tg-inbox-1.json', 'tg-inbox-2.json'],
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
    const files = readdirSync(inboxDir(runId, scratch)).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 2);
    assert.deepEqual(
      JSON.parse(readFileSync(join(inboxDir(runId, scratch), 'tg-inbox-1.json'), 'utf8')).runId,
      runId,
    );
  } finally {
    stopDispatcher?.();
    suspendSession?.();
    await driver?.close();
    await session?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
