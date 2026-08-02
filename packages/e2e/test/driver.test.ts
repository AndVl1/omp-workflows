/**
 * Driver tests: TranscriptLog [ask_user] detection, AskStateTracker
 * pending/guard semantics, and waitFor timeout behavior.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';

import { deferred } from '../src/util.js';
import { AskStateTracker, TranscriptLog, waitFor, WaitTimeoutError, WsDriver } from '../src/driver.js';
import { startTestSession } from '../src/server.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'ux-e2e-driver-'));
}

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

test('WsDriver: submit sends text plus newline in one input frame', async t => {
  const dir = makeDir();
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const script = join(dir, 'capture-input.sh');
  writeFileSync(script, '#!/bin/sh\nwhile IFS= read -r line; do printf "got:%s\\n" "$line"; done\n', { mode: 0o755 });
  const session = await startTestSession({ cwd: dir, ompBinary: script, token: 'sekret', idleMs: 2000 });
  t.after(() => session.close());
  if (session.pty.mode !== 'pty') {
    t.skip('node-pty could not spawn the input capture command');
    return;
  }

  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  await driver.open();
  await driver.submit('run command');
  await waitFor(() => readFileSync(session.transcriptPath, 'utf8').includes('"d":"run command\\n"'), {
    timeoutMs: 2000,
  });
  await driver.close();

  assert.ok(readFileSync(session.transcriptPath, 'utf8').includes('"d":"run command\\n"'));
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
