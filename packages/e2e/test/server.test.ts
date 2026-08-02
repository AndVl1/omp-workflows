/**
 * Server security + protocol tests. No real omp binary is required:
 * the WS echo test drives a fake shell script via node-pty (skipped when
 * node-pty cannot spawn), everything else runs with noPty:true.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { waitFor, WaitTimeoutError } from '../src/driver.js';
import {
  assertNoLiveSession,
  buildOmpArgs,
  mintToken,
  pidIsLive,
  safeEqual,
  startTestSession,
  type ServerMsg,
} from '../src/server.js';

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-server-'));
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  return dir;
}

function openWs(
  port: number,
  token: string,
  opts: { origin?: string } = {},
  onMessage?: (msg: ServerMsg) => void,
): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    opts.origin !== undefined ? { origin: opts.origin } : undefined,
  );
  if (onMessage !== undefined) {
    // Attach BEFORE open resolves — the server's {t:'s'} ack can arrive
    // before the client's 'open' event, and late listeners would miss it.
    ws.on('message', raw => {
      try {
        onMessage(JSON.parse(raw.toString('utf8')) as ServerMsg);
      } catch {
        /* ignore partial frames */
      }
    });
  }
  ws.once('open', () => resolve(ws));
  ws.once('error', err => reject(err));
  return promise;
}

function wsFails(port: number, token: string, opts: { origin?: string } = {}): Promise<Error> {
  const { promise, resolve, reject } = Promise.withResolvers<Error>();
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    opts.origin !== undefined ? { origin: opts.origin } : undefined,
  );
  ws.once('open', () => reject(new Error('expected the connection to be rejected, but it opened')));
  ws.once('error', err => resolve(err instanceof Error ? err : new Error(String(err))));
  return promise;
}

test('server: mintToken/safeEqual primitives', () => {
  const a = mintToken();
  const b = mintToken();
  assert.ok(a.length >= 32, 'token should be URL-safe base64 of 32 bytes');
  assert.notEqual(a, b, 'two tokens must differ');
  assert.ok(safeEqual(a, a), 'equal strings match');
  assert.ok(!safeEqual(a, b), 'different strings do not match');
  assert.ok(!safeEqual(a, a.slice(0, 10)), 'length mismatch fails');
});

test('server: buildOmpArgs matches the launch contract', () => {
  const args = buildOmpArgs({
    ompProfile: 'ux-e2e-test',
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/tmp/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/tmp/scratch/.omp/agent',
  });
  assert.deepEqual(args, [
    '--profile', 'ux-e2e-test',
    '--config', '/tmp/scratch/.omp/ux-e2e-overlay.json',
    '--session-dir', '/tmp/scratch/.omp/agent',
    '--hide-thinking',
    '--max-time', '30m',
    '--approval-mode', 'yolo',
  ]);
  assert.ok(!args.includes('-p') && !args.includes('--print'), 'never passes -p/--print');
  assert.ok(!args.includes('--no-pty'), 'never passes --no-pty');
});

test('server: ws rejects a missing token', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const err = await wsFails(session.port, '');
  assert.match(err.message, /401|unexpected server response/iu);
});

test('server: ws rejects a wrong token', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const err = await wsFails(session.port, 'wrong-token');
  assert.match(err.message, /401|unexpected server response/iu);
});

test('server: single-use token — replay is rejected', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());

  const msgs: ServerMsg[] = [];
  const ws = await openWs(session.port, 'sekret', {}, m => msgs.push(m));
  await waitFor(() => msgs.some(m => m.t === 's'), { timeoutMs: 2000 });
  await ws.close();

  const err = await wsFails(session.port, 'sekret');
  assert.match(err.message, /401|unexpected server response/iu);
});

test('server: ws rejects a mismatched Origin', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const err = await wsFails(session.port, 'sekret', { origin: 'http://evil.example' });
  assert.match(err.message, /403|unexpected server response/iu);
});

test('server: rate limit kicks the client', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({
    cwd: scratch,
    noPty: true,
    token: 'sekret',
    rateLimit: { maxMessages: 2, windowMs: 1000 },
  });
  t.after(() => session.close());

  const msgs: ServerMsg[] = [];
  const ws = await openWs(session.port, 'sekret', {}, m => msgs.push(m));
  await waitFor(() => msgs.some(m => m.t === 's'), { timeoutMs: 2000 });
  for (let i = 0; i < 5; i += 1) {
    ws.send(JSON.stringify({ t: 'r', cols: 80, rows: 24 }));
  }
  await waitFor(() => msgs.some(m => m.t === 'err' && m.code === 'rate-limited'), { timeoutMs: 2000 });
  const limiterErr = msgs.find(m => m.t === 'err' && m.code === 'rate-limited');
  assert.ok(limiterErr !== undefined && limiterErr.t === 'err');
});

test('server: idle timer closes the session', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret', idleMs: 150 });
  t.after(() => session.close());

  const msgs: ServerMsg[] = [];
  const ws = await openWs(session.port, 'sekret', {}, m => msgs.push(m));
  await waitFor(() => msgs.some(m => m.t === 'err' && m.code === 'idle-timeout'), { timeoutMs: 3000 });
  const idleErr = msgs.find(m => m.t === 'err' && m.code === 'idle-timeout');
  assert.ok(idleErr !== undefined && idleErr.t === 'err');
});

test('server: ws echo roundtrip through a fake PTY command', async t => {
  const scratch = makeScratch();
  const script = join(scratch, 'fake-echo.sh');
  writeFileSync(
    script,
    '#!/bin/sh\nwhile IFS= read -r line; do\n  printf "echo:%s\\n" "$line"\ndone\n',
  );
  chmodSync(script, 0o755);

  let session;
  try {
    session = await startTestSession({ cwd: scratch, noPty: false, ompBinary: script, token: 'sekret', idleMs: 2000 });
  } catch (err) {
    t.skip(`node-pty unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  t.after(() => session.close());

  if (session.pty.mode !== 'pty') {
    t.skip('node-pty could not spawn the fake command');
    return;
  }

  const msgs: ServerMsg[] = [];
  const ws = await openWs(session.port, 'sekret', {}, m => msgs.push(m));
  await waitFor(() => msgs.some(m => m.t === 's'), { timeoutMs: 2000 });

  ws.send(JSON.stringify({ t: 'i', d: 'hello\n' }));
  await waitFor(
    () => msgs.some(m => m.t === 'o' && typeof m.d === 'string' && m.d.includes('echo:hello')),
    { timeoutMs: 5000, label: 'pty echo' },
  );

  // Server-side transcript got the frames — the evidence backbone.
  const transcript = readFileSync(session.transcriptPath, 'utf8');
  assert.ok(transcript.includes('echo:hello'), 'transcript.jsonl contains the pty output');
  assert.ok(transcript.includes('"t":"i"'), 'transcript.jsonl records the input frame');

  await ws.close();
});

test('server: session.json + pty metadata written', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({
    cwd: scratch,
    noPty: true,
    token: 'sekret',
    taskPrompt: 'do the thing',
    scenario: { id: 'full-feature', title: 'Full feature' },
  });
  t.after(() => session.close());

  const sessionJson = JSON.parse(readFileSync(session.sessionJsonPath, 'utf8')) as Record<string, unknown>;
  assert.equal(sessionJson.token, 'sekret');
  assert.equal(sessionJson.wsPath, '/ws');
  assert.equal(sessionJson.task_prompt, 'do the thing');
  assert.deepEqual(sessionJson.scenario, { id: 'full-feature', title: 'Full feature' });
  assert.equal(session.pty.mode, 'noPty');
  assert.ok(session.url.includes(`token=sekret`), 'url embeds the token');
});

test('server: concurrency guard refuses a live session without --force', () => {
  const scratch = makeScratch();
  const stateDir = join(scratch, '.work-state', 'ux-e2e');
  // process.pid is live by definition.
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

  assert.throws(() => assertNoLiveSession(scratch, false), /live session/iu);
  assert.doesNotThrow(() => assertNoLiveSession(scratch, true), '--force overrides');

  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ pid: 999_999_999, started_at: new Date().toISOString() }));
  assert.doesNotThrow(() => assertNoLiveSession(scratch, false), 'dead pid is not a live session');
  assert.ok(!pidIsLive(999_999_999));
});

test('driver: waitFor timeout semantics', async () => {
  await waitFor(() => true, { timeoutMs: 100 });
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 50, intervalMs: 10 }),
    WaitTimeoutError,
  );
});

test('server: ws accepts a localhost client (loopback alias)', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());

  const msgs: ServerMsg[] = [];
  const ws = await openWs(session.port, 'sekret', { origin: `http://localhost:${session.port}` }, m => msgs.push(m));
  await waitFor(() => msgs.some(m => m.t === 's'), { timeoutMs: 2000 });
  await ws.close();
});

test('server: ws rejects a mismatched port on the loopback alias', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  // origin is on the wrong port — must NOT be aliased through.
  const err = await wsFails(session.port, 'sekret', { origin: `http://localhost:${session.port + 1}` });
  assert.match(err.message, /403|unexpected server response/iu);
});
