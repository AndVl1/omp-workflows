/**
 * Driver tests: TranscriptLog [ask_user] detection, AskStateTracker
 * pending/guard semantics, and waitFor timeout behavior.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import { deferred } from '../src/util.js';
import {
  answerNativeAsk,
  answerSelectedAsk,
  AskStateTracker,
  HOST_OTHER_OPTION,
  matchesCanonicalSelectorOptions,
  TranscriptLog,
  validateSessionUrl,
  waitFor,
  WaitTimeoutError,
  wsUrlFromPageUrl,
  WsDriver,
} from '../src/driver.js';
import { closePinnedDirectory, pinDirectory, pinOrCreateDirectory, withPinnedExclusiveLock } from '../src/fs-safety.js';
import { startTestSession } from '../src/server.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'ux-e2e-driver-'));
}

test('Darwin/Linux lock: a concurrent caller cannot reclaim a live owner lease', () => {
  const dir = makeDir();
  const root = pinOrCreateDirectory(dir);
  assert.ok(root !== null);
  if (root === null) return;
  try {
    const childScript = `
      import { pinDirectory, closePinnedDirectory, withPinnedExclusiveLock } from './src/fs-safety.ts';
      const root = pinDirectory(process.argv[1]);
      if (root === null) process.exit(3);
      try {
        withPinnedExclusiveLock(root, 'ask-state.lock', () => undefined, 50);
        process.exit(2);
      } catch {
        process.exit(0);
      } finally {
        closePinnedDirectory(root);
      }
    `;
    const child = withPinnedExclusiveLock(root, 'ask-state.lock', () => spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', childScript, dir],
      { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
    ), 1000);
    assert.equal(child.status, 0, `concurrent lock entered unexpectedly: ${child.stderr}`);
  } finally {
    closePinnedDirectory(root);
  }
});

test('Darwin/Linux lock: malformed marker with a dead owner is recoverable', () => {
  const dir = makeDir();
  const root = pinOrCreateDirectory(dir);
  assert.ok(root !== null);
  if (root === null) return;
  try {
    writeFileSync(join(dir, 'ask-state.lock'), '999999999:damaged-marker\n', 'utf8');
    let entered = false;
    withPinnedExclusiveLock(root, 'ask-state.lock', () => {
      entered = true;
    }, 1000);
    assert.equal(entered, true);
  } finally {
    closePinnedDirectory(root);
  }
});
test('Darwin/Linux lock: release never unlinks a replacement inode', () => {
  const dir = makeDir();
  const root = pinOrCreateDirectory(dir);
  assert.ok(root !== null);
  if (root === null) return;
  try {
    withPinnedExclusiveLock(root, 'ask-state.lock', () => {
      unlinkSync(join(dir, 'ask-state.lock'));
      writeFileSync(join(dir, 'ask-state.lock'), 'replacement');
    });
    assert.equal(readFileSync(join(dir, 'ask-state.lock'), 'utf8'), 'replacement');
  } finally {
    closePinnedDirectory(root);
  }
});


function oFrame(d: string): string {
  return JSON.stringify({ ts: '2026-08-02T00:00:00.000Z', t: 'o', d }) + '\n';
}

function iFrame(d: string): string {
  return JSON.stringify({ ts: '2026-08-02T00:00:00.000Z', t: 'i', d }) + '\n';
}

test('TranscriptLog: detectAskUser finds title + numbered options', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('booting…\r\n') +
      oFrame('[ask_user] Which platforms should the feature target?\r\n') +
      oFrame('1) web only\r\n') +
      oFrame('2) web + mobile\r\n') +
      oFrame('3) all surfaces\r\n') +
      oFrame('\r\n'),
  );

  const log = new TranscriptLog(path);
  const block = log.detectAskUser();
  assert.ok(block !== null, 'a block is detected');
  assert.ok(block.title.includes('[ask_user]'));
  assert.ok(block.title.includes('Which platforms'));
  assert.deepEqual(block.options, ['1) web only', '2) web + mobile', '3) all surfaces']);
});

test('TranscriptLog: blocks are indexed in order across frames', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('[ask_user] First question?\r\n') +
      oFrame('1) a\r\n2) b\r\n') +
      oFrame('stage: architecture\n') +
      oFrame('[ask_user] Second question?\r\n') +
      oFrame('1) x\r\n'),
  );
  const log = new TranscriptLog(path);
  const blocks = log.askBlocks();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.index, 1);
  assert.equal(blocks[1]?.index, 2);
  assert.ok(blocks[0]?.title.includes('First question'));
  assert.ok(blocks[1]?.title.includes('Second question'));
  assert.deepEqual(blocks[1]?.options, ['1) x']);
});

test('AskStateTracker: pendingBlock tracks the latest unanswered ask', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(
    transcriptPath,
    oFrame('[ask_user] Pick a scope?\r\n') +
      oFrame('1) narrow\r\n') +
      oFrame('[ask_user] Pick an architecture?\r\n') +
      oFrame('1) option one\r\n2) option two\r\n'),
  );

  const tracker = new AskStateTracker(transcriptPath, askStatePath);
  const pending = tracker.pendingBlock();
  assert.ok(pending !== null, 'a pending ask exists');
  assert.ok(pending.title.includes('architecture'), 'pending is the LATEST ask');

  const result = tracker.answer('1');
  assert.ok(result.ok, 'answering the pending ask succeeds');
  assert.equal(result.block.index, 2);
});

test('AskStateTracker: double-answer guard refuses a recorded answer', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Choose?\r\n') + oFrame('1) a\r\n2) b\r\n'));

  const tracker = new AskStateTracker(transcriptPath, askStatePath);
  assert.ok(tracker.pendingBlock() !== null);
  const first = tracker.answer('1');
  assert.ok(first.ok);
  assert.deepEqual(first, { ok: true, block: first.block });

  const second = tracker.answer('2');
  assert.ok(!second.ok);
  assert.equal(second.reason, 'already-answered');

  const records = JSON.parse(readFileSync(askStatePath, 'utf8').trim().split('\n')[0] ?? '{}') as Record<string, unknown>;
  assert.equal(records.answer, '1');
  assert.equal(records.block_index, 1);
});

test('AskStateTracker: refuses when the transcript advanced past the captured block', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Early question?\r\n') + oFrame('1) a\r\n'));

  const tracker = new AskStateTracker(transcriptPath, askStatePath);
  const pending = tracker.pendingBlock();
  assert.ok(pending !== null && pending.index === 1, 'block 1 captured as pending');

  // The agent moved on: a new ask appeared in the transcript.
  appendFileSync(transcriptPath, oFrame('stage: implementation\n') + oFrame('[ask_user] Later question?\r\n') + oFrame('1) z\r\n'));

  const result = tracker.answer('1');
  assert.ok(!result.ok);
  assert.equal(result.reason, 'transcript-advanced');
});

test('AskStateTracker: answer with no pending ask is refused', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('plain output, no asks\r\n'));

  const tracker = new AskStateTracker(transcriptPath, askStatePath);
  assert.equal(tracker.pendingBlock(), null);
  const result = tracker.answer('1');
  assert.ok(!result.ok);
  assert.equal(result.reason, 'no-pending');
});

test('AskStateTracker: input frames do not disturb ask detection', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(
    transcriptPath,
    oFrame('[ask_user] Confirm?\r\n') + oFrame('1) yes\r\n') + iFrame('1\n') + oFrame('ok, continuing\r\n'),
  );

  const tracker = new AskStateTracker(transcriptPath, askStatePath);
  const pending = tracker.pendingBlock();
  assert.ok(pending !== null, 'a stale (but latest) ask is still pending');
  assert.ok(pending.title.includes('Confirm'));
});
test('AskStateTracker: input frame alone cannot commit an observed delivery', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Confirm?\r\n') + oFrame('1) yes\r\n'));
  const tracker = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'session-v2', leaseMs: 30_000 });
  const pending = tracker.pendingBlock();
  assert.ok(pending !== null);
  appendFileSync(transcriptPath, iFrame('1\r'));
  assert.equal(tracker.observedAfter(pending), false, 'inbound echo is not terminal evidence');
  appendFileSync(transcriptPath, oFrame('accepted\r\n'));
  assert.equal(tracker.observedAfter(pending), true, 'subsequent terminal output is evidence');
  tracker.close();
});
test('AskStateTracker: reservations persist session/process lease binding', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Confirm?\r\n') + oFrame('1) yes\r\n'));
  const tracker = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'session-v2', leaseMs: 30_000 });
  assert.ok(tracker.pendingBlock() !== null);
  const result = tracker.reserve('1');
  assert.equal(result.ok, true);
  const record = JSON.parse(readFileSync(askStatePath, 'utf8')) as Record<string, unknown>;
  assert.equal(record.session_id, 'session-v2');
  assert.equal(typeof record.owner_pid, 'number');
  assert.equal(typeof record.owner_start, 'string');
  assert.equal(typeof record.lease_expires_at, 'string');
  tracker.close();
});

test('AskStateTracker: reservation baseline excludes earlier terminal output', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Confirm baseline?\r\n') + oFrame('1) yes\r\n'));
  const tracker = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'session-baseline', leaseMs: 30_000 });
  assert.ok(tracker.pendingBlock() !== null);
  appendFileSync(transcriptPath, oFrame('output before reservation\r\n'));
  const reserved = tracker.reserve('1');
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.equal(tracker.observedAfter(reserved.reservation), false);
  appendFileSync(transcriptPath, oFrame('accepted after reservation\r\n'));
  assert.equal(tracker.observedAfter(reserved.reservation), true);
  tracker.close();
});
test('AskStateTracker: commit requires complete delivery receipt and terminal observation', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  const deliveryPath = join(dir, 'delivery.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Confirm commit?\r\n') + oFrame('1) yes\r\n'));
  const tracker = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'session-commit', leaseMs: 30_000 });
  const reserved = tracker.reserve('1');
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;

  const beforeDelivery = tracker.commitReservation(reserved.reservation);
  assert.equal(beforeDelivery.ok, false);
  if (!beforeDelivery.ok) assert.equal(beforeDelivery.reason, 'delivery-not-observed');

  const receiptTs = '2026-08-02T00:00:00.500Z';
  const receipt = (status: 'delivery_prepared' | 'delivered') => JSON.stringify({
    ts: receiptTs,
    session_id: 'session-commit',
    reservation_id: reserved.reservation.id,
    status,
    step_index: 1,
    step_count: 1,
    is_final_submit: true,
    sequence: 1,
  }) + '\n';
  writeFileSync(deliveryPath, receipt('delivery_prepared') + receipt('delivered'));
  const beforeTerminal = tracker.commitReservation(reserved.reservation);
  assert.equal(beforeTerminal.ok, false);
  if (!beforeTerminal.ok) assert.equal(beforeTerminal.reason, 'delivery-not-observed');

  appendFileSync(transcriptPath, JSON.stringify({
    ts: '2026-08-02T00:00:01.000Z',
    t: 'o',
    d: 'accepted after receipt\r\n',
  }) + '\n');
  const committed = tracker.commitReservation(reserved.reservation);
  assert.equal(committed.ok, true);
  const duplicate = tracker.commitReservation(reserved.reservation);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, 'already-answered');
  tracker.close();
});

test('AskStateTracker: recovered delivery is content-bound and remains resumable', () => {
  const runRecovery = (contentDigest: 'actual' | 'mismatch'): string => {
    const dir = makeDir();
    const transcriptPath = join(dir, 'transcript.jsonl');
    const askStatePath = join(dir, 'ask-state.jsonl');
    const deliveryPath = join(dir, 'delivery.jsonl');
    writeFileSync(transcriptPath, oFrame('[ask_user] Confirm recovery?\r\n') + oFrame('1) yes\r\n'));
    const first = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'session-recovery', leaseMs: 30_000 });
    const reserved = first.reserve('1');
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return 'reservation-failed';
    first.close();

    const state = {
      ts: '2026-08-02T00:00:00.000Z',
      answer: '1',
      block_surface: reserved.reservation.block.surface,
      transcript_frame_start: reserved.reservation.block.frameStart,
      block_title: reserved.reservation.block.title,
      block_index: reserved.reservation.block.index,
      content_digest: contentDigest === 'actual' ? reserved.reservation.contentDigest : '0'.repeat(64),
      status: 'reserved',
      reservation_id: 'recovered-reservation',
      session_id: 'session-recovery',
      owner_pid: process.pid,
      owner_start: 'foreign-process-start',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      transcript_offset: reserved.reservation.transcriptOffset,
      transcript_digest: reserved.reservation.transcriptDigest,
      transcript_generation: reserved.reservation.transcriptGeneration,
      transcript_frame_serial: reserved.reservation.transcriptFrameSerial,
    };
    writeFileSync(askStatePath, JSON.stringify(state) + '\n');
    writeFileSync(deliveryPath, JSON.stringify({
      ts: '2026-08-02T00:00:00.500Z',
      session_id: 'session-recovery',
      reservation_id: 'recovered-reservation',
      status: 'delivered',
      step_index: 1,
      step_count: 1,
      is_final_submit: true,
      sequence: 1,
    }) + '\n');
    appendFileSync(transcriptPath, JSON.stringify({
      ts: '2026-08-02T00:00:01.000Z',
      t: 'o',
      d: 'accepted during recovery\r\n',
    }) + '\n');

    const resumed = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'session-recovery', leaseMs: 30_000 });
    const result = resumed.reserve('1');
    resumed.close();
    return result.ok ? 'committed' : result.reason;
  };

  assert.equal(runRecovery('mismatch'), 'delivery-ambiguous');
  assert.equal(runRecovery('actual'), 'already-answered');
});


test('AskStateTracker: records from a prior session cannot suppress current Ask', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Fresh session?\r\n') + oFrame('1) yes\r\n'));
  writeFileSync(askStatePath, JSON.stringify({
    ts: new Date().toISOString(),
    answer: '1',
    block_title: 'Fresh session?',
    block_index: 1,
    status: 'committed',
    session_id: 'old-session',
    owner_pid: process.pid,
    owner_start: 'old-process-start',
  }) + '\n');
  const tracker = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'current-session', leaseMs: 30_000 });
  assert.ok(tracker.pendingBlock() !== null);
  tracker.close();
});
test('AskStateTracker: committed answer suppresses the exact prompt after authenticated relaunch', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Relaunch commit?\r\n') + oFrame('1) yes\r\n'));
  const first = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'old-session', leaseMs: 30_000 });
  const reserved = first.reserve('1');
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  first.close();
  appendFileSync(askStatePath, JSON.stringify({
    ts: new Date().toISOString(),
    block_title: reserved.reservation.block.title,
    block_surface: reserved.reservation.block.surface,
    transcript_frame_start: reserved.reservation.block.frameStart,
    block_index: reserved.reservation.block.index,
    content_digest: reserved.reservation.contentDigest,
    status: 'committed',
    session_id: 'old-session',
    reservation_id: reserved.reservation.id,
  }) + '\n');

  const resumed = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'new-session', leaseMs: 30_000 });
  assert.equal(resumed.pendingBlock(), null, 'matching committed content stays answered after relaunch');
  const duplicate = resumed.reserve('1');
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, 'already-answered');
  resumed.close();
});

test('AskStateTracker: uncommitted prior-session reservation remains actionable after relaunch', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Relaunch pending?\r\n') + oFrame('1) yes\r\n'));
  writeFileSync(askStatePath, JSON.stringify({
    ts: new Date().toISOString(),
    block_title: 'Relaunch pending?',
    block_index: 1,
    content_digest: '0'.repeat(64),
    status: 'reserved',
    session_id: 'old-session',
    reservation_id: 'stale-reservation',
    owner_pid: process.pid,
    owner_start: 'old-process-start',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    transcript_offset: 0,
    transcript_digest: null,
    transcript_generation: 0,
    transcript_frame_serial: 0,
  }) + '\n');

  const resumed = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'new-session', leaseMs: 30_000 });
  assert.ok(resumed.pendingBlock() !== null, 'uncommitted prior-session reservation does not suppress the prompt');
  const retry = resumed.reserve('1');
  assert.equal(retry.ok, true, 'new session can reserve the uncommitted prompt');
  resumed.close();
});



test('waitFor: resolves immediately and times out with a clear error', async () => {
  await waitFor(() => true, { timeoutMs: 1000 });
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 60, intervalMs: 10, label: 'never-happens' }),
    (err: unknown) => err instanceof WaitTimeoutError && /never-happens/u.test(err.message),
  );
});

test('TranscriptLog: refresh reads only the delta on subsequent calls', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(oFrame(`pre-existing line ${i}\r\n`));
  }
  writeFileSync(path, lines.join(''));
  assert.equal(statSync(path).size, lines.join('').length, 'pre-existing file is non-empty');
  const log = new TranscriptLog(path);
  const first = log.refresh();
  assert.equal(first.length, 200, 'initial refresh ingests every pre-existing frame');
  assert.equal(log.frames.length, 200);

  const appended = oFrame('appended line\r\n');
  appendFileSync(path, appended);
  const second = log.refresh();
  assert.equal(second.length, 1, 'second refresh ingests only the appended frame');
  assert.equal(log.frames.length, 201);
  const last = log.frames[log.frames.length - 1];
  assert.ok(last !== undefined && last.t === 'o');
  assert.ok(last !== undefined && (last as { d: string }).d.includes('appended line'));
});
test('TranscriptLog: bounded retention keeps suffix/search/serial semantics for many short frames', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const lines: string[] = [
    oFrame('[ask_user] stale question?\r\n'),
    oFrame('1) stale option\r\n'),
  ];
  const payload = 'x'.repeat(768);
  const fillerCount = 30_000;
  for (let index = 0; index < fillerCount; index += 1) {
    lines.push(oFrame(`frame-${String(index).padStart(6, '0')} ${payload}\r\n`));
  }
  const retainedAskStart = lines.length;
  lines.push(oFrame('[ask_user] retained question?\r\n'));
  lines.push(oFrame('1) retained option\r\n'));
  const terminalIndex = lines.length;
  lines.push(JSON.stringify({ ts: '2026-08-02T00:00:00.000Z', t: 'exit', code: 0 }) + '\n');
  const initialFrames = 2;
  writeFileSync(path, lines.slice(0, initialFrames).join(''));
  const log = new TranscriptLog(path);
  assert.equal(log.refresh().length, initialFrames, 'the initial transcript prefix is ingested');
  const cursor = log.transcriptCursor();
  let ingested = initialFrames;
  const batchSize = 5_000;
  for (let start = initialFrames; start < lines.length; start += batchSize) {
    const end = Math.min(start + batchSize, lines.length);
    appendFileSync(path, lines.slice(start, end).join(''));
    ingested += log.refresh().length;
  }
  assert.equal(ingested, lines.length, 'all appended frames are ingested in bounded refresh deltas');
  assert.equal(log.transcriptCursor().frameSerial, lines.length, 'frame serials remain absolute after eviction');
  assert.equal(log.hasTerminalAfter(cursor), true, 'terminal search still aligns serials after the retained head advances');

  let expectedStart = Math.max(0, lines.length - 10_000);
  let expectedBytes = lines.slice(expectedStart).reduce((sum, line) => sum + Buffer.byteLength(line.trim(), 'utf8'), 0);
  while (expectedBytes > 8 * 1024 * 1024) {
    expectedBytes -= Buffer.byteLength(lines[expectedStart]?.trim() ?? '', 'utf8');
    expectedStart += 1;
  }
  const retained = log.frames;
  assert.equal(retained.length, lines.length - expectedStart, 'retention keeps exactly the bounded suffix');
  assert.equal(retained[0]?.t, 'o');
  assert.equal(retained[0]?.d, JSON.parse(lines[expectedStart] ?? '{}').d, 'the first retained frame is the deterministic suffix boundary');
  assert.equal(retained.at(-1)?.t, 'exit');

  const blocks = log.askBlocks();
  assert.equal(blocks.length, 1, 'the evicted ask is absent from search results');
  assert.equal(blocks[0]?.title, '[ask_user] retained question?');
  assert.equal(blocks[0]?.frameStart, retainedAskStart, 'ask frame serial remains aligned with its retained suffix position');
  assert.equal(blocks[0]?.frameEnd, terminalIndex, 'ask block end serial remains aligned through the terminal frame');
});

test('TranscriptLog: refresh observes appended execution-wave output', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, oFrame('startup output\r\n'));
  const log = new TranscriptLog(path);
  assert.equal(log.refresh().length, 1);
  appendFileSync(path, oFrame('CTO preflight mapping dispatch\r\n'));
  log.refresh();
  const output = log.frames.filter(frame => frame.t === 'o').map(frame => frame.d).join('\n');
  assert.match(output, /preflight mapping dispatch/iu);
});

test('TranscriptLog: split JSONL frame is consumed once and preserves UTF-8 tail', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const encoded = Buffer.from(oFrame('partial 🙂 frame'), 'utf8');
  const emojiOffset = encoded.indexOf(Buffer.from('🙂', 'utf8'));
  assert.ok(emojiOffset > 0);
  writeFileSync(path, encoded.subarray(0, emojiOffset + 1));
  const log = new TranscriptLog(path);

  assert.deepEqual(log.refresh(), [], 'unterminated bytes stay pending');
  appendFileSync(path, encoded.subarray(emojiOffset + 1));
  const first = log.refresh();
  assert.equal(first.length, 1, 'the completed split frame is emitted once');
  assert.equal(first[0]?.d, 'partial 🙂 frame');
  assert.equal(log.refresh().length, 0, 'a repeated refresh does not duplicate the frame');

  appendFileSync(path, oFrame('next frame'));
  assert.equal(log.refresh().length, 1, 'later appends remain independently framed');
  assert.equal(log.frames.length, 2);
});

test('session URLs are loopback-only with an explicit valid port', () => {
  assert.equal(
    wsUrlFromPageUrl('https://[::1]:443/?token=sekret'),
    'wss://[::1]/ws?token=sekret',
    'default HTTPS port remains the same effective endpoint',
  );
  assert.doesNotThrow(() => validateSessionUrl('http://localhost:43123/?token=sekret'));
  for (const hostile of [
    'http://example.test:43123/?token=sekret',
    'http://user@localhost:43123/?token=sekret',
    'http://localhost/?token=sekret',
    'http://localhost:0/?token=sekret',
    'http://localhost:65536/?token=sekret',
    'file:///tmp/session',
  ]) {
    assert.throws(
      () => new WsDriver({ url: hostile, transcriptPath: join(makeDir(), 'transcript.jsonl') }),
      /ux-e2e: (?:invalid session URL|session URL)/u,
      hostile,
    );
  }
});

test('TranscriptLog: same-size replacement resets frames instead of appending at the old offset', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const original = oFrame('old\r\n');
  const replacement = oFrame('new\r\n');
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  writeFileSync(path, original);

  const log = new TranscriptLog(path);
  assert.equal(log.refresh().length, 1);
  const rotated = join(dir, 'transcript.rotated.jsonl');
  writeFileSync(rotated, replacement);
  renameSync(rotated, path);

  const added = log.refresh();
  assert.equal(added.length, 1, 'same-size replacement is scanned from byte zero');
  assert.equal(log.frames.length, 1, 'frames from the replaced file are discarded');
  const firstFrame = log.frames[0];
  assert.ok(firstFrame !== undefined && firstFrame.t === 'o');
  assert.equal(firstFrame.d, 'new\r\n');
});
test('TranscriptLog: cursor carries and validates an exact prefix digest', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const first = oFrame('before');
  writeFileSync(path, first);
  const log = new TranscriptLog(path);
  assert.equal(log.refresh().length, 1);
  const cursor = log.transcriptCursor();
  const expected = createHash('sha256').update(first, 'utf8').digest('hex');
  assert.equal(cursor.digest, expected);
  appendFileSync(path, oFrame('after'));
  assert.equal(log.hasTerminalAfter(cursor), true);
  const stale = { ...cursor, digest: createHash('sha256').update('tampered', 'utf8').digest('hex') };
  assert.equal(log.hasTerminalAfter(stale), false, 'a mismatched prefix digest is rejected');
});

test('TranscriptLog: larger replacement clears a partial tail before framing', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, '{"partial":');
  const log = new TranscriptLog(path);
  assert.deepEqual(log.refresh(), [], 'an unterminated frame is held as partial state');

  const rotated = join(dir, 'transcript.rotated.jsonl');
  const replacement = oFrame('replacement\r\n') + oFrame('second\r\n');
  writeFileSync(rotated, replacement);
  assert.ok(statSync(rotated).size > 10);
  renameSync(rotated, path);

  const added = log.refresh();
  assert.equal(added.length, 2, 'larger replacement is scanned from byte zero');
  assert.equal(log.frames.length, 2);
  const firstFrame = log.frames[0];
  assert.ok(firstFrame !== undefined && firstFrame.t === 'o');
  assert.match(firstFrame.d, /replacement/u);
});
test('TranscriptLog: an absent rotated pathname is a neutral retry', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const original = oFrame('before rotation\r\n');
  writeFileSync(path, original);
  const log = new TranscriptLog(path);
  assert.equal(log.refresh().length, 1);

  const rotated = join(dir, 'transcript.rotated.jsonl');
  renameSync(path, rotated);
  assert.deepEqual(log.refresh(), [], 'a rotation gap has no new frames');
  assert.equal(log.frames.length, 1, 'the cursor and prior frames remain intact');

  writeFileSync(path, oFrame('after rotation\r\n'));
  const added = log.refresh();
  assert.equal(added.length, 1, 'the replacement is read on the next retry');
  assert.equal(log.frames.length, 1, 'replacement identity resets the old stream');
  assert.equal(log.frames[0]?.d, 'after rotation\r\n');
});
test('TranscriptLog: ENOENT after existence check is a neutral retry', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, oFrame('first frame'));
  let failOpen = true;
  const log = new TranscriptLog(path, {
    open(candidate) {
      assert.equal(candidate, path);
      if (failOpen) {
        failOpen = false;
        throw Object.assign(new Error('rotated between existence and open'), { code: 'ENOENT' });
      }
      return openSync(candidate, 'r');
    },
  });

  assert.deepEqual(log.refresh(), [], 'ENOENT from the open window is no data');
  assert.equal(log.frames.length, 0, 'cursor state is unchanged after a neutral retry');
  appendFileSync(path, oFrame('second frame'));
  const added = log.refresh();
  assert.equal(added.length, 2, 'the retry reads the complete file exactly once');
  assert.equal(log.frames.length, 2);
  assert.equal(log.refresh().length, 0, 'completed frames are not duplicated');
});

test('WsDriver: submit sends text plus newline in one input frame', async t => {
  const dir = makeDir();
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const script = join(dir, 'capture-input.sh');
  writeFileSync(script, '#!/bin/sh\nwhile IFS= read -r line; do printf "got:%s\n" "$line"; done\n', { mode: 0o755 });
  const session = await startTestSession({ cwd: dir, ompBinary: script, token: 'sekret', idleMs: 2000 });
  t.after(() => session.close());
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('node-pty could not spawn the input capture command');
  }

  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  await driver.open();
  await driver.submit('run command');
  // The server sends the receipt only after appending the delivered input
  // frame, so the receipt is a deterministic transcript latch rather than a
  // wall-clock wait for PTY output.
  const encodedInput = `"d":${JSON.stringify('run command\n')}`;
  assert.ok(readFileSync(session.transcriptPath, 'utf8').includes(encodedInput), 'server transcript records the submitted text plus newline');
  await driver.close();
});

test('WsDriver: post-handshake close rejects pending receipts immediately', async t => {
  const dir = makeDir();
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const session = await startTestSession({ cwd: dir, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath, inputReceiptTimeoutMs: 30_000 });
  await driver.open();
  const pending = driver.type('never acknowledged');
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  await session.close();
  await assert.rejects(pending, /ws closed before PTY input receipt/iu);
  await driver.close();
});

test('WsDriver: open() closes the failed socket on auth failure', async t => {
  const dir = makeDir();
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const session = await startTestSession({ cwd: dir, noPty: true, token: 'sekret' });
  t.after(() => session.close());

  const transcriptPath = join(dir, 'transcript-fail.jsonl');
  const driver = new WsDriver({ url: session.url.replace('sekret', 'wrong-token'), transcriptPath });
  await assert.rejects(driver.open(), /401|unexpected server response/iu);
  await driver.close();
});


const nativeAskCard = [
  'compatibility report',
  '╭─── Ask 2 questions · arrow keys navigate · Enter selects · Tab jumps · Esc closes ───╮',
  '├─── [d101] · options:2 ──────────────────────────────────────────────────────────────┤',
  '│ D-101: approve deterministic in-process retry backoff with fixed delays of 1s, 2s, and 4s, │',
  '│ without a scheduler service? │',
  '│ ○ Approve │',
  '│ ↳ Keep the imported decision exactly as written. │',
  '│ ○ Reject │',
  '│ ↳ Do not approve this imported decision. │',
  '├─── [d102] · options:2 ──────────────────────────────────────────────────────────────┤',
  '│ D-102: approve reuse of the existing orders idempotency column for the provider idempotency │',
  '│ key, with no schema migration? │',
  '│ ○ Approve │',
  '│ ↳ Keep the imported decision exactly as written. │',
  '│ ○ Reject │',
  '│ ↳ Do not approve this imported decision. │',
  '╰─── D-101 D-102 Submit ─────────────────────────────────────────────────────────────╯',
].join('\r\n') + '\r\n';
const nativeSingleAskCard = [
  '╭─── Ask 1 question · arrow keys navigate · Enter selects · Tab jumps · Esc closes ───╮',
  '├─── [d201] · options:2 ──────────────────────────────────────────────────────────────┤',
  '│ D-201: approve the single native question? │',
  '│ ○ Approve │',
  '│ ○ Reject │',
  '╰─── D-201 Submit ─────────────────────────────────────────────────────────────────────╯',
].join('\r\n') + '\r\n';
const nativeConstitutionSelectorCard = [
  '╭─ Ask ───────────────────────────────────────────────────────────────────────╮',
  '├─ [constitution:constitution-feature:checkpoint.v1] · options:3 ────────────┤',
  '│ Canonical constitution approval checkpoint:                                │',
  '│ feature_id=constitution-feature | run_key=run-origin-1 | stage_id=specify │',
  '│ gate_id=constitution-gate checkpoint_id=checkpoint.v1 draft_sha256=abc…    │',
  '│ UNTRUSTED ORCHESTRATOR NOTE: none supplied                                 │',
  '│ ❯ ○ approve_continue                                                       │',
  '│   ○ request_changes                                                        │',
  '│   ○ Other (type your own)                                                  │',
  '╰─ Constitution approval Submit ────────────────────────────────────────────╯',
].join('\r\n') + '\r\n';

test('TranscriptLog: selected constitution card preserves canonical feature/run/stage identity', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, oFrame(nativeConstitutionSelectorCard));

  const block = new TranscriptLog(path).detectSelectedAsk();
  assert.ok(block !== null, 'selected constitution card is detected');
  assert.equal(block.surface, 'selector');
  assert.match(block.title, /feature_id=constitution-feature/iu);
  assert.match(block.title, /run_key=run-origin-1/iu);
  assert.match(block.title, /stage_id=specify/iu);
});

test('TranscriptLog: parses OMP native multi-question Ask cards', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, oFrame(nativeAskCard));

  const block = new TranscriptLog(path).detectAskUser();
  assert.ok(block !== null, 'native Ask card is detected');
  assert.equal(block.surface, 'native');
  assert.match(block.title, /compatibility checkpoint/iu);
  assert.equal(block.questions.length, 2);
  assert.deepEqual(block.questions.map(question => question.id), ['d101', 'd102']);
  assert.match(block.questions[0]?.prompt ?? '', /^D-101: approve deterministic/u);
  assert.match(block.questions[1]?.prompt ?? '', /^D-102: approve reuse/u);
  assert.deepEqual(block.questions[0]?.options, [
    { label: 'Approve', description: 'Keep the imported decision exactly as written.' },
    { label: 'Reject', description: 'Do not approve this imported decision.' },
  ]);
  assert.deepEqual(block.questions[1]?.options, [
    { label: 'Approve', description: 'Keep the imported decision exactly as written.' },
    { label: 'Reject', description: 'Do not approve this imported decision.' },
  ]);
  assert.deepEqual(block.options, ['Approve', 'Reject', 'Approve', 'Reject']);
});
test('TranscriptLog: absolute frame serials survive eviction and keep repeated legacy asks actionable', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(
    transcriptPath,
    oFrame('[ask_user] Repeat this title?\r\n') + oFrame('1) approve\r\n'),
  );

  const tracker = new AskStateTracker(transcriptPath, askStatePath, {
    sessionId: 'eviction-regression',
    leaseMs: 30_000,
  });
  try {
    const first = tracker.pendingBlock();
    assert.ok(first !== null);
    assert.equal(first.surface, 'legacy');
    assert.equal(tracker.answer('1').ok, true, 'the first occurrence is recorded before eviction');

    const log = new TranscriptLog(transcriptPath);
    log.askBlocks();
    for (let offset = 0; offset < 10_000; offset += 500) {
      appendFileSync(
        transcriptPath,
        Array.from({ length: 500 }, (_, index) => oFrame(`filler ${offset + index}\r\n`)).join(''),
      );
      tracker.pendingBlock();
      log.askBlocks();
    }
    appendFileSync(
      transcriptPath,
      oFrame(nativeAskCard)
        + oFrame('[ask_user] Repeat this title?\r\n')
        + oFrame('1) approve\r\n'),
    );

    const blocks = log.askBlocks();
    assert.equal(log.frames.length, 10_000, 'frame retention remains bounded after count eviction');
    const native = blocks.find(block => block.surface === 'native');
    const repeated = blocks.find(block => block.surface === 'legacy');
    assert.ok(native !== undefined && repeated !== undefined, 'mixed native and legacy blocks are retained');
    assert.ok(native !== undefined && repeated !== undefined && native.frameStart < repeated.frameStart);
    assert.ok(repeated !== undefined && repeated.frameStart >= 10_000, 'legacy frameStart is an absolute serial, not retained index');
    assert.ok(first.questions[0] !== undefined && repeated !== undefined && repeated.questions[0] !== undefined);
    assert.notEqual(first.questions[0]?.id, repeated?.questions[0]?.id, 'evicted repeated title receives a new stable ID');
    assert.equal(tracker.pendingBlock()?.title, '[ask_user] Repeat this title?', 'newest legacy prompt is selected');
    assert.equal(tracker.answer('1').ok, true, 'the repeated title is not suppressed by the evicted answer');

    const records = readFileSync(askStatePath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { transcript_frame_start?: number; block_surface?: string });
    assert.deepEqual(records.map(record => record.transcript_frame_start), [first.frameStart, repeated?.frameStart]);
    assert.deepEqual(records.map(record => record.block_surface), ['legacy', 'legacy']);
  } finally {
    tracker.close();
  }
});

test('AskStateTracker: refuses one answer for native multi-question Ask', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame(nativeAskCard));
  const tracker = new AskStateTracker(transcriptPath, askStatePath);
  assert.ok(tracker.pendingBlock()?.surface === 'native');

  const refused = tracker.answer('1');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'native-multi-question-requires-explicit-answers');
  assert.equal(existsSync(askStatePath), false, 'refusal does not record a partial answer');

  const accepted = tracker.answerQuestions({ d101: 'Approve', d102: '2' });
  assert.equal(accepted.ok, true);
  const record = JSON.parse(readFileSync(askStatePath, 'utf8').trim()) as { answer: string };
  assert.deepEqual(JSON.parse(record.answer), { d101: 'Approve', d102: '2' });
});
test('AskStateTracker: explicit native answers remain committed across reload', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame(nativeAskCard));

  const first = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'native-reload' });
  assert.ok(first.pendingBlock()?.surface === 'native');
  const accepted = first.answerQuestions({ d101: 'Approve', d102: '2' });
  assert.equal(accepted.ok, true);
  const record = JSON.parse(readFileSync(askStatePath, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(record.status, 'committed');
  assert.equal(record.session_id, 'native-reload');
  assert.equal(record.block_surface, 'native');
  assert.equal(typeof record.transcript_frame_start, 'number');
  assert.match(String(record.content_digest), /^[0-9a-f]{64}$/u);
  first.close();

  const resumed = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'native-reload' });
  assert.equal(resumed.pendingBlock(), null, 'a committed native card is not reopened after reload');
  const duplicate = resumed.answerQuestions({ d101: 'Approve', d102: '2' });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, 'already-answered');
  resumed.close();
});

test('AskStateTracker: direct single native answer persists its stable identity', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame(nativeSingleAskCard));

  const first = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'native-direct' });
  assert.ok(first.pendingBlock()?.surface === 'native');
  assert.equal(first.answer('1').ok, true);
  first.close();

  const resumed = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'native-direct' });
  assert.equal(resumed.pendingBlock(), null, 'direct native answer remains answered after reload');
  resumed.close();
});
test('AskStateTracker: cancellation persists identity and allows immediate retry after reload', () => {
  const dir = makeDir();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const askStatePath = join(dir, 'ask-state.jsonl');
  writeFileSync(transcriptPath, oFrame('[ask_user] Retry after cancellation?\r\n') + oFrame('1) retry\r\n'));

  const first = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'cancel-reload' });
  const pending = first.pendingBlock();
  assert.ok(pending !== null);
  const reserved = first.reserve('1');
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.equal(first.cancelReservation(reserved.reservation), true);
  const cancelled = JSON.parse(readFileSync(askStatePath, 'utf8').trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reservation_id, reserved.reservation.id);
  assert.equal(cancelled.block_surface, 'legacy');
  assert.equal(cancelled.transcript_frame_start, pending.frameStart);
  assert.equal(cancelled.content_digest, reserved.reservation.contentDigest);
  first.close();

  const resumed = new AskStateTracker(transcriptPath, askStatePath, { sessionId: 'cancel-reload' });
  assert.ok(resumed.pendingBlock() !== null, 'cancelled reservation does not suppress the prompt');
  const retry = resumed.reserve('1');
  assert.equal(retry.ok, true, 'a fresh tracker can reserve immediately after cancellation');
  resumed.close();
});
test('AskStateTracker: direct answers reject a captured block after transcript mutation', () => {
  const legacyDir = makeDir();
  const legacyTranscript = join(legacyDir, 'transcript.jsonl');
  const legacyState = join(legacyDir, 'ask-state.jsonl');
  writeFileSync(legacyTranscript, oFrame('[ask_user] Mutable prompt?\r\n'));
  const legacyTracker = new AskStateTracker(legacyTranscript, legacyState, { sessionId: 'mutation-legacy' });
  const legacyPending = legacyTracker.pendingBlock();
  assert.ok(legacyPending !== null);
  appendFileSync(legacyTranscript, oFrame('1) now has an option\r\n'));
  const legacyResult = legacyTracker.answer('1');
  assert.equal(legacyResult.ok, false);
  if (!legacyResult.ok) assert.equal(legacyResult.reason, 'transcript-advanced');
  assert.equal(existsSync(legacyState), false, 'a stale legacy answer is not recorded');
  legacyTracker.close();

  const nativeDir = makeDir();
  const nativeTranscript = join(nativeDir, 'transcript.jsonl');
  const nativeState = join(nativeDir, 'ask-state.jsonl');
  writeFileSync(nativeTranscript, oFrame(nativeSingleAskCard));
  const nativeTracker = new AskStateTracker(nativeTranscript, nativeState, { sessionId: 'mutation-native' });
  assert.ok(nativeTracker.pendingBlock()?.surface === 'native');
  appendFileSync(nativeTranscript, oFrame('[ask_user] Newer prompt?\r\n') + oFrame('1) continue\r\n'));
  const nativeResult = nativeTracker.answerQuestions({ d201: 'Approve' });
  assert.equal(nativeResult.ok, false);
  if (!nativeResult.ok) assert.equal(nativeResult.reason, 'transcript-advanced');
  assert.equal(existsSync(nativeState), false, 'a stale native answer is not recorded');
  nativeTracker.close();
});

test('answerNativeAsk: selects approve and submits native Ask tabs', async () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, oFrame(nativeAskCard));
  const block = new TranscriptLog(path).detectAskUser();
  assert.ok(block !== null && block.surface === 'native');
  const events: string[] = [];
  const driver = {
    pressEnter: async (isFinalSubmit = true): Promise<void> => { events.push(isFinalSubmit ? 'Enter-final' : 'Enter-question'); },
    pressKey: async (key: 'ArrowDown' | 'ArrowRight'): Promise<void> => { events.push(key); },
  };
  await answerNativeAsk(driver, block, { d101: '1', d102: 'Approve' });
  assert.deepEqual(events, ['Enter-question', 'ArrowRight', 'Enter-question', 'ArrowRight', 'Enter-final']);
});

test('answerNativeAsk: single native question defaults to first option', async () => {
  const block = {
    index: 1,
    title: 'native Ask: approve?',
    options: ['Approve', 'Reject'],
    surface: 'native' as const,
    questions: [{ id: 'd101', prompt: 'D-101: approve?', options: [{ label: 'Approve' }, { label: 'Reject' }] }],
    frameStart: 0,
    frameEnd: 1,
  };
  const events: string[] = [];
  const driver = {
    pressEnter: async (isFinalSubmit = true): Promise<void> => { events.push(isFinalSubmit ? 'Enter-final' : 'Enter-question'); },
    pressKey: async (key: 'ArrowRight'): Promise<void> => { events.push(key); },
  };
  await answerNativeAsk(driver, block);
  assert.deepEqual(events, ['Enter-question', 'ArrowRight', 'Enter-final']);
});


test('selector parser: accepts only canonical options with an exact host Other suffix', () => {
  const canonical = ['approve_continue', 'request_changes', 'approve_stop'] as const;
  assert.equal(matchesCanonicalSelectorOptions(canonical, canonical), true);
  assert.equal(matchesCanonicalSelectorOptions([...canonical, HOST_OTHER_OPTION], canonical), true);

  const rejected = [
    ['request_changes', 'approve_continue', 'approve_stop'],
    ['approve_continue', 'request_changes', 'request_changes'],
    ['approve_continue', 'request_changes', 'approve_stop', 'custom'],
    ['approve_continue', 'request_changes', 'approve_stop', 'Other (type your own) '],
    ['approve_continue', 'request_changes', 'approve_stop', HOST_OTHER_OPTION, 'extra'],
    ['approve_continue', HOST_OTHER_OPTION, 'request_changes', 'approve_stop'],
  ];
  for (const options of rejected) {
    assert.equal(matchesCanonicalSelectorOptions(options, canonical), false, `rejected selector options: ${options.join('|')}`);
  }
});
test('TranscriptLog: detects selected checkpoint card and answers via real selector events', async () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('before selected ask\r\n╭─ Ask ─────────────────────────╮\r\n')
      + oFrame('│ CANONICAL CHECKPOINT PACKET (engine-authored; authoritative) │\r\n')
      + oFrame('│ workflow: spec-import checkpoint: import_compatibility_approval │\r\n')
      + oFrame('├──────────────────────────────┤\r\n│   ○ approve_continue          │\r\n│ ❯ ○ request_changes           │\r\n│   ○ approve_stop              │\r\n│   ○ Other (type your own)     │\r\n├──────────────────────────────┤\r\n')
      + oFrame('│ Enter select · ↑/↓ move · Esc cancel │\r\n╰────────────────────────────────────╯\r\n'),
  );

  const block = new TranscriptLog(path).detectSelectedAsk();
  assert.ok(block !== null, 'host selector card is detected');
  assert.equal(block.surface, 'selector');
  assert.match(block.title, /compatibility checkpoint/iu);
  assert.deepEqual(block.options, ['approve_continue', 'request_changes', 'approve_stop', 'Other (type your own)']);
  assert.equal(block.selectedIndex, 1, 'the selected cursor is captured from the PTY card');

  const events: string[] = [];
  const driver = {
    pressEnter: async (): Promise<void> => { events.push('Enter'); },
    pressKey: async (key: 'ArrowUp' | 'ArrowDown'): Promise<void> => { events.push(key); },
  };
  await answerSelectedAsk(driver, block, 'approve_continue');
  assert.deepEqual(events, ['ArrowUp', 'Enter'], 'answer uses selector navigation plus a real Enter event');
});
test('TranscriptLog: joins PTY output fragments inside selector option labels', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('╭─ Ask ─────────────────────────╮\r\n')
      + oFrame('│ workflow: constitution approval checkpoint │\r\n')
      + oFrame('├──────────────────────────────┤\r\n│ ❯ ○ approve_continue          │\r\n│   ○ request_chang')
      + oFrame('es                       │\r\n│   ○ Other (type your own)     │\r\n')
      + oFrame('├──────────────────────────────┤\r\n│ Enter select · ↑/↓ move · Esc cancel │\r\n╰────────────────────────────────────╯\r\n'),
  );

  const block = new TranscriptLog(path).detectSelectedAsk();
  assert.ok(block !== null, 'fragmented selector card is detected');
  assert.deepEqual(block.options, ['approve_continue', 'request_changes', 'Other (type your own)']);
  assert.equal(block.selectedIndex, 0);
});


test('TranscriptLog: selector Ask stays pending through navigation and closes on final submit', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  const card = [
    '╭─ Ask ─────────────────────────╮\r\n',
    '│ workflow: constitution approval checkpoint │\r\n',
    '├──────────────────────────────┤\r\n',
    '│   ○ approve_continue          │\r\n',
    '│ ❯ ○ request_changes           │\r\n',
    '│   ○ approve_stop              │\r\n',
    '│   ○ Other (type your own)     │\r\n',
    '├──────────────────────────────┤\r\n',
    '│ Enter select · ↑/↓ move · Esc cancel │\r\n',
    '╰────────────────────────────────────╯\r\n',
  ].join('');
  writeFileSync(path, oFrame(card));
  const inputFrame = (data: string, isFinalSubmit: boolean): string => JSON.stringify({
    ts: '2026-08-02T00:00:00.000Z',
    t: 'i',
    d: data,
    sequence: 1,
    step_index: isFinalSubmit ? 2 : 1,
    step_count: 2,
    is_final_submit: isFinalSubmit,
  }) + '\n';
  const log = new TranscriptLog(path);
  try {
    assert.equal(log.pendingSelectedAsk()?.selectedIndex, 1, 'selector card starts pending');
    appendFileSync(path, inputFrame('\x1b[A', false));
    assert.equal(log.pendingSelectedAsk()?.selectedIndex, 1, 'navigation does not close the pending card');
    appendFileSync(path, inputFrame('\r', true));
    assert.equal(log.pendingSelectedAsk(), null, 'terminal submit closes the pending card');
  } finally {
    log.close();
  }
});
test('TranscriptLog: retains complete selected checkpoint identity for concurrent cards', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('╭─ Ask ─────────────────────────╮\n')
      + oFrame('│ CANONICAL CHECKPOINT PACKET (engine-authored; authoritative) │\n')
      + oFrame('│ feature_id: feature-alpha run_key: run-alpha-1 stage_cursor: execution │\n')
      + oFrame('│ checkpoint: cto_mapping_confirmation mapping_id: map-alpha │\n')
      + oFrame('├──────────────────────────────┤\n')
      + oFrame('│ ❯ ○ approve_continue          │\n│   ○ request_changes           │\n│   ○ approve_stop              │\n│   ○ Other (type your own)     │\n')
      + oFrame('├──────────────────────────────┤\n│ Enter select · ↑/↓ move · Esc cancel │\n╰────────────────────────────────────╯\n'),
  );
  const block = new TranscriptLog(path).detectSelectedAsk();
  assert.ok(block !== null);
  assert.match(block.title, /feature-alpha.*run-alpha-1.*stage_cursor: execution/iu);
  assert.match(block.title, /cto_mapping_confirmation.*map-alpha/iu);
});
test('TranscriptLog: identifies compact imported compatibility packets by semantic identity', () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('╭─ Ask ─────────────────────────╮\n')
      + oFrame('│ CANONICAL CHECKPOINT PACKET (engine-authored; authoritative) │\n')
      + oFrame('│ workflow: spec-import profile_hash: abc stage_cursor:… │\n')
      + oFrame('├──────────────────────────────┤\n')
      + oFrame('│ ❯ ○ approve_continue          │\n│   ○ request_changes           │\n│   ○ approve_stop              │\n│   ○ Other (type your own)     │\n')
      + oFrame('├──────────────────────────────┤\n│ Enter select · ↑/↓ move · Esc cancel │\n╰────────────────────────────────────╯\n'),
  );

  const block = new TranscriptLog(path).detectSelectedAsk();
  assert.ok(block !== null, 'compact imported selector card is detected');
  assert.match(block.title, /compatibility checkpoint/iu);
  assert.deepEqual(block.options, ['approve_continue', 'request_changes', 'approve_stop', 'Other (type your own)']);
});
test('answerSelectedAsk: dispatches while the command remains blocked', async () => {
  const dir = makeDir();
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    oFrame('\u001b[2J\r\n╭─ Ask ─────────────────────────╮\r\n')
      + oFrame('│ workflow: spec-import checkpoint: import_compatibility_approval │\r\n')
      + oFrame('├──────────────────────────────┤\r\n│   ○ approve_continue          │\r\n│ ❯ ○ request_changes           │\r\n│   ○ approve_stop              │\r\n│   ○ Other (type your own)     │\r\n')
      + oFrame('│ Enter select · ↑/↓ move · Esc cancel │\r\n╰────────────────────────────────────╯\r\n'),
  );
  const block = new TranscriptLog(path).detectSelectedAsk();
  assert.ok(block !== null, 'a split-frame selected card is detected');

  let commandSettled = false;
  let releaseCommand!: () => void;
  const command = new Promise<void>(resolve => {
    releaseCommand = () => {
      commandSettled = true;
      resolve();
    };
  });
  const events: string[] = [];
  const driver = {
    pressEnter: async (): Promise<void> => { events.push('Enter'); },
    pressKey: async (key: 'ArrowUp' | 'ArrowDown'): Promise<void> => { events.push(key); },
  };

  // This models a slash-command/tool promise that cannot settle until the
  // trusted human answer is delivered. The answer must not wait on it.
  const answer = answerSelectedAsk(driver, block, 'approve_continue');
  await waitFor(() => events.length > 0, { timeoutMs: 1000, intervalMs: 1, label: 'selected answer dispatched' });
  assert.equal(commandSettled, false, 'selector navigation is dispatched before command completion');
  releaseCommand();
  await Promise.all([command, answer]);
  assert.deepEqual(events, ['ArrowUp', 'Enter']);
});
