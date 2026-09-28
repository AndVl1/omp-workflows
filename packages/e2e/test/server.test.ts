import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { waitFor, WaitTimeoutError } from '../src/driver.js';
import { verifyPackageArtifact } from '../src/artifacts.js';
import { verifyRuntimeSnapshot } from '../src/runtime.js';
import { deferred } from '../src/util.js';
import { mintToken, pidIsLive, readSessionRecord, safeEqual, startTestSession, type ServerMsg, type TestSession } from '../src/server.js';
import { createIsolatedRunFixture } from './fixtures/isolated-run.js';

function openWs(
  port: number,
  token: string,
  opts: { origin?: string } = {},
  onMessage?: (msg: ServerMsg) => void,
): Promise<WebSocket> {
  const { promise, resolve, reject } = deferred<WebSocket>();
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    opts.origin !== undefined ? { origin: opts.origin } : undefined,
  );
  if (onMessage !== undefined) {
    ws.on('message', raw => {
      try {
        onMessage(JSON.parse(raw.toString('utf8')) as ServerMsg);
      } catch {
        /* Ignore incomplete protocol frames. */
      }
    });
  }
  ws.once('open', () => resolve(ws));
  ws.once('error', err => reject(err));
  return promise;
}

function wsFails(port: number, token: string, opts: { origin?: string } = {}): Promise<Error> {
  const { promise, resolve, reject } = deferred<Error>();
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
  assert.ok(a.length >= 32);
  assert.notEqual(a, b);
  assert.ok(safeEqual(a, a));
  assert.ok(!safeEqual(a, b));
  assert.ok(!safeEqual(a, a.slice(0, 10)));
});

test('server: serves terminal assets from the isolated session', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'assets', noPty: true, token: 'test-token' });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  const response = await new Promise<{ status: number; body: string; contentType: string }>((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${String(session.port)}/page.js?cb=1`, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(res.headers['content-type'] ?? ''),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  assert.equal(response.status, 200);
  assert.match(response.contentType, /javascript/u);
  assert.match(response.body, /window\.__uxTerm/u);
});

test('server: rejects missing and wrong bearer tokens', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'auth', noPty: true, token: 'session-secret' });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  assert.match((await wsFails(session.port, '')).message, /401|unexpected server response/iu);
  assert.match((await wsFails(session.port, 'wrong-token')).message, /401|unexpected server response/iu);
});

test('server: reconnect works only while that session is active', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'reconnect', noPty: true, token: 'session-secret' });
  let sessionClosed = false;
  t.after(async () => {
    if (!sessionClosed) await session.close();
    fixture.cleanup();
  });

  const firstMessages: ServerMsg[] = [];
  const first = await openWs(session.port, 'session-secret', {}, message => firstMessages.push(message));
  await waitFor(() => firstMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  await first.close();

  const reconnectMessages: ServerMsg[] = [];
  const reconnect = await openWs(session.port, 'session-secret', {}, message => reconnectMessages.push(message));
  await waitFor(() => reconnectMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  await reconnect.close();

  await session.close();
  sessionClosed = true;
  assert.match((await wsFails(session.port, 'session-secret')).message, /401|ECONNREFUSED|connect/iu);
});

test('server: a competing attachment replaces the prior socket', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'replace', noPty: true, token: 'session-secret' });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  const firstMessages: ServerMsg[] = [];
  const first = await openWs(session.port, 'session-secret', {}, message => firstMessages.push(message));
  await waitFor(() => firstMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  const firstClosed = deferred<{ readonly code: number; readonly reason: string }>();
  first.once('close', (code, reason) => firstClosed.resolve({ code, reason: reason.toString('utf8') }));

  const secondMessages: ServerMsg[] = [];
  const second = await openWs(session.port, 'session-secret', {}, message => secondMessages.push(message));
  await waitFor(() => secondMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  const close = await firstClosed.promise;
  assert.equal(close.code, 1000);
  assert.equal(close.reason, 'replaced by newer connection');
  await second.close();
});

test('server: direct launch rechecks immutable artifacts after prior integrity checks', async t => {
  const fixture = createIsolatedRunFixture();
  t.after(() => fixture.cleanup());

  const runtimeRoot = dirname(dirname(fixture.manifest.runtime.binary));
  const runtime = verifyRuntimeSnapshot(runtimeRoot);
  assert.equal(runtime.digest, fixture.manifest.runtime.digest);
  const core = verifyPackageArtifact(fixture.manifest.artifacts.core.root);
  const fullstack = verifyPackageArtifact(fixture.manifest.artifacts.fullstack.root);
  assert.equal(core.digest, fixture.manifest.artifacts.core.digest);
  assert.equal(fullstack.digest, fixture.manifest.artifacts.fullstack.digest);
  const extensionPath = `${fixture.manifest.artifacts.fullstack.root}/dist/index.js`;
  writeFileSync(extensionPath, Buffer.concat([readFileSync(extensionPath), Buffer.from('\n// tampered after integrity checks\n')]));

  await assert.rejects(
    startTestSession({ manifest: fixture.manifest, sessionId: 'tampered', noPty: true }),
    /cache_integrity_failure/u,
  );
});

test('server: rejects mismatched origins and ports', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'origin', noPty: true, token: 'session-secret' });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  assert.match((await wsFails(session.port, 'session-secret', { origin: 'http://evil.example' })).message, /403|unexpected server response/iu);
  assert.match((await wsFails(session.port, 'session-secret', { origin: `http://localhost:${session.port + 1}` })).message, /403|unexpected server response/iu);
});

test('server: enforces inbound rate limits', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({
    manifest: fixture.manifest,
    sessionId: 'limits',
    noPty: true,
    token: 'session-secret',
    rateLimit: { maxMessages: 2, windowMs: 1000 },
    idleMs: 3000,
  });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  const messages: ServerMsg[] = [];
  const ws = await openWs(session.port, 'session-secret', {}, message => messages.push(message));
  await waitFor(() => messages.some(message => message.t === 's'), { timeoutMs: 2000 });
  for (let i = 0; i < 5; i += 1) ws.send(JSON.stringify({ t: 'r', cols: 80, rows: 24 }));
  await waitFor(() => messages.some(message => message.t === 'err' && message.code === 'rate-limited'), { timeoutMs: 2000 });
  assert.ok(messages.some(message => message.t === 'err' && message.code === 'rate-limited'));
  await ws.close();
});

test('server: session records keep bearer metadata private and paths run-owned', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'metadata', noPty: true, token: 'private-session-token' });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  const record = JSON.parse(readFileSync(session.sessionJsonPath, 'utf8')) as Record<string, unknown>;
  assert.equal(record['id'], 'metadata');
  assert.equal(record['transcript_path'], session.transcriptPath);
  assert.equal(record['log_path'], session.logPath);
  assert.doesNotMatch(JSON.stringify(record), /private-session-token/u);
  assert.equal(JSON.parse(readFileSync(session.privateConnectionPath, 'utf8')).token, 'private-session-token');
  assert.ok(session.transcriptPath.startsWith(fixture.manifest.roots.sessions));
  assert.ok(session.logPath.startsWith(fixture.manifest.roots.logs));
});

test('server: a live session cannot be taken over', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'active', noPty: true });
  t.after(async () => {
    await session.close();
    fixture.cleanup();
  });

  await assert.rejects(
    startTestSession({ manifest: fixture.manifest, sessionId: 'active', noPty: true }),
    /live session|session_active|session_exists/u,
  );
});

test('server: session restart preserves workspace state and prior transcript', async t => {
  const fixture = createIsolatedRunFixture();
  let first: TestSession | undefined;
  let second: TestSession | undefined;
  let firstClosed = false;
  t.after(async () => {
    if (second !== undefined) await second.close();
    if (first !== undefined && !firstClosed) await first.close();
    fixture.cleanup();
  });
  first = await startTestSession({ manifest: fixture.manifest, sessionId: 'session-one', token: 'first-token', idleMs: 5000 });
  if (first.pty.mode !== 'pty') {
    await first.close();
    firstClosed = true;
    t.skip('node-pty did not provide a PTY for the process-level restart probe');
    return;
  }

  await waitFor(() => readFileSync(first.transcriptPath, 'utf8').includes('FIXTURE_READY'), { timeoutMs: 3000 });
  const firstMessages: ServerMsg[] = [];
  const firstWs = await openWs(first.port, first.token, {}, message => firstMessages.push(message));
  await waitFor(() => firstMessages.some(message => message.t === 'o' && message.d.includes('FIXTURE_READY')), { timeoutMs: 3000 });
  firstWs.send(JSON.stringify({ t: 'i', d: 'before-restart\n' }));
  await waitFor(() => readFileSync(first.transcriptPath, 'utf8').includes('FIXTURE_ECHO:before-restart'), { timeoutMs: 3000 });
  await firstWs.close();
  await first.close();
  firstClosed = true;

  const priorTranscript = readFileSync(first.transcriptPath, 'utf8');
  const statePath = `${fixture.manifest.roots.workspace}/workflow-state.json`;
  writeFileSync(statePath, JSON.stringify({ stage: 'implementation', run: fixture.manifest.run_id }));

  second = await startTestSession({ manifest: fixture.manifest, sessionId: 'session-two', token: 'second-token', idleMs: 5000 });
  assert.notEqual(second.transcriptPath, first.transcriptPath);
  assert.notEqual(second.logPath, first.logPath);
  assert.equal(readFileSync(statePath, 'utf8'), JSON.stringify({ stage: 'implementation', run: fixture.manifest.run_id }));
  assert.equal(readFileSync(first.transcriptPath, 'utf8'), priorTranscript);

  await waitFor(() => readFileSync(second.transcriptPath, 'utf8').includes('FIXTURE_READY'), { timeoutMs: 3000 });
  const secondMessages: ServerMsg[] = [];
  const secondWs = await openWs(second.port, second.token, {}, message => secondMessages.push(message));
  await waitFor(() => secondMessages.some(message => message.t === 'o' && message.d.includes('FIXTURE_READY')), { timeoutMs: 3000 });
  secondWs.send(JSON.stringify({ t: 'i', d: 'after-restart\n' }));
  await waitFor(() => readFileSync(second.transcriptPath, 'utf8').includes('FIXTURE_ECHO:after-restart'), { timeoutMs: 3000 });
  await secondWs.close();
  assert.ok(readFileSync(first.transcriptPath, 'utf8').includes('before-restart'));
  assert.ok(!readFileSync(second.transcriptPath, 'utf8').includes('before-restart'));
});

test('driver: waitFor resolves and reports timeout semantics', async () => {
  await waitFor(() => true, { timeoutMs: 100 });
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 50, intervalMs: 10 }),
    WaitTimeoutError,
  );
});

test('server: authenticated loopback stop owns clean terminal evidence', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'owner-stop', token: 'session-secret', surface: 'text' });
  t.after(async () => {
    await session.close().catch(() => undefined);
    fixture.cleanup();
  });
  if (session.pty.mode !== 'pty') {
    t.skip('node-pty did not provide a PTY for owner stop route');
    return;
  }
  await waitFor(() => readFileSync(session.transcriptPath, 'utf8').includes('FIXTURE_READY'), { timeoutMs: 3000 });
  const endpoint = `http://127.0.0.1:${String(session.port)}/__ux-e2e/stop`;
  const post = async (token: string, body: Readonly<Record<string, unknown>>, origin?: string): Promise<Response> => {
    return await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(origin === undefined ? {} : { origin }),
      },
      body: JSON.stringify(body),
    });
  };
  assert.equal((await post('wrong-token', { run_id: session.runId, session_id: session.sessionId })).status, 401);
  assert.equal((await post(session.token, { run_id: 'wrong-run', session_id: session.sessionId })).status, 400);
  assert.equal((await post(session.token, { run_id: session.runId, session_id: session.sessionId }, 'http://evil.example')).status, 403);
  const live = readSessionRecord(fixture.manifest, session.sessionId);
  assert.ok(live !== null && live.status !== 'stopped' && typeof live.pid === 'number' && pidIsLive(live.pid));
  const response = await post(session.token, { run_id: session.runId, session_id: session.sessionId });
  assert.equal(response.status, 200);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(result.run_id, session.runId);
  assert.equal(result.session_id, session.sessionId);
  assert.equal(result.status, 'stopped');
  const stopped = readSessionRecord(fixture.manifest, session.sessionId);
  assert.ok(stopped !== null);
  assert.equal(result.exit_code, stopped.exit_code);
  assert.equal(stopped.status, 'stopped');
  assert.ok(
    (stopped.exit_code === 0 && (stopped.exit_signal === undefined || stopped.exit_signal === 15)) ||
      (stopped.exit_code === 143 && stopped.exit_signal === 0),
  );
  assert.ok(stopped.termination !== undefined);
  assert.equal(stopped.termination.requested, 'owner');
  assert.equal(stopped.termination.requested_signal, 15);
  assert.equal(stopped.termination.forced, false);
  assert.equal(stopped.termination.observed, true);
  const exits = readFileSync(session.transcriptPath, 'utf8')
    .split(/\r?\n/u)
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { t?: string; code?: number; signal?: number })
    .filter(frame => frame.t === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.code, stopped.exit_code);
  assert.equal(exits[0]?.signal, stopped.exit_signal);
});

test('server: unexpected PTY signal preserves failed observed evidence', async t => {
  const fixture = createIsolatedRunFixture();
  const session = await startTestSession({ manifest: fixture.manifest, sessionId: 'unexpected-exit', token: 'session-secret', surface: 'text' });
  t.after(async () => {
    await session.close().catch(() => undefined);
    fixture.cleanup();
  });
  if (session.pty.mode !== 'pty' || session.pty.pid === null) {
    t.skip('node-pty did not provide a PTY for signal evidence');
    return;
  }
  await waitFor(() => readFileSync(session.transcriptPath, 'utf8').includes('FIXTURE_READY'), { timeoutMs: 3000 });
  process.kill(session.pty.pid, 'SIGKILL');
  await waitFor(() => readSessionRecord(fixture.manifest, session.sessionId)?.status === 'failed', {
    timeoutMs: 3000,
    label: 'unexpected PTY signal is persisted as failed',
  });
  const failed = readSessionRecord(fixture.manifest, session.sessionId);
  assert.ok(failed !== null);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.termination !== undefined);
  assert.equal(failed.termination.requested, 'none');
  assert.equal(failed.termination.forced, false);
  assert.equal(failed.termination.observed, true);
  assert.ok(failed.exit_code !== 0 || failed.exit_signal !== undefined);
});
