/**
 * Server security + protocol tests. No real omp binary is required:
 * the WS echo test drives a fake shell script via node-pty (skipped when
 * node-pty cannot spawn), everything else runs with noPty:true.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { deferred } from '../src/util.js';

import { waitFor, WaitTimeoutError } from '../src/driver.js';
import {
  assertNoLiveSession,
  buildOmpArgs,
  checkHostOmpConfig,
  mintToken,
  pidIsLive,
  safeEqual,
  safePtyEnv,
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
  opts: { origin?: string; cookie?: string } = {},
  onMessage?: (msg: ServerMsg) => void,
): Promise<WebSocket> {
  const { promise, resolve, reject } = deferred<WebSocket>();
  const headers = opts.cookie === undefined ? undefined : { Cookie: opts.cookie };
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws${opts.cookie === undefined ? `?token=${encodeURIComponent(token)}` : ''}`,
    {
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(headers === undefined ? {} : { headers }),
    },
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
    userConfigDefaultPath: '/tmp/scratch/.omp/ux-e2e-overlay.user.json',
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

test('server: buildOmpArgs omits --profile when ompProfile is unset (default = inherit host profile)', () => {
  // The default ux-e2e launch has NO `--profile` flag — omp inherits
  // the host's default profile (`~/.omp/agent/`) so `modelRoles`,
  // `models.db`, and credentials all resolve there. An explicit
  // `ompProfile` is opt-in only (the next test).
  const args = buildOmpArgs({
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/tmp/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/tmp/scratch/.omp/agent',
    hostConfigPath: '/Users/test/.omp/agent/config.yml',
    userConfigDefaultPath: '/tmp/scratch/.omp/ux-e2e-overlay.user.json',
  });
  assert.ok(!args.includes('--profile'), 'no --profile flag when ompProfile is unset');
  assert.deepEqual(args, [
    '--config', '/Users/test/.omp/agent/config.yml',
    '--config', '/tmp/scratch/.omp/ux-e2e-overlay.json',
    '--session-dir', '/tmp/scratch/.omp/agent',
    '--hide-thinking',
    '--max-time', '30m',
    '--approval-mode', 'yolo',
  ]);
  assert.ok(!args.includes('-p') && !args.includes('--print'));
  assert.ok(!args.includes('--no-pty'));
});


test('server: buildOmpArgs prepends host config (D4 — model inheritance)', () => {
  // omp merges `--config` overlays in argv order with later overlays
  // overriding earlier ones for duplicate keys (verified against
  // `omp v17.2.3 --help`). The ux-e2e overlay must come AFTER the
  // host config so its overrides win, but the host's `modelRoles` (not
  // touched by the overlay) survives — preventing the "No model
  // selected" boot state.
  const args = buildOmpArgs({
    ompProfile: 'ux-e2e-test',
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/scratch/.omp/agent',
    hostConfigPath: '/Users/test/.omp/agent/config.yml',
    userConfigDefaultPath: '/scratch/.omp/ux-e2e-overlay.user.json',
  });
  // Two `--config` flags in the right order: host first, overlay second.
  // (`userConfigPath` is unset here, so the third `--config` is NOT emitted.)
  const configIdx = args.reduce<number[]>((acc, v, i) => (v === '--config' ? [...acc, i] : acc), []);
  assert.equal(configIdx.length, 2, 'emits exactly two --config flags when userConfigPath is unset');
  assert.equal(args[configIdx[0] + 1], '/Users/test/.omp/agent/config.yml', 'host config is first');
  assert.equal(args[configIdx[1] + 1], '/scratch/.omp/ux-e2e-overlay.json', 'overlay is second (wins on conflict)');
  // Sanity: still never passes -p/--print/--no-pty.
  assert.ok(!args.includes('-p') && !args.includes('--print'));
  assert.ok(!args.includes('--no-pty'));
});

test('server: buildOmpArgs appends user config as the THIRD --config overlay (after ux-e2e overlay)', () => {
  // When the operator has dropped `<scratch>/.omp/ux-e2e-overlay.user.json`
  // into the scratch dir, the harness emits a third `--config` AFTER the
  // standard ux-e2e overlay so the user's keys win on conflict — letting
  // a test run pin, e.g., `modelRoles.default` (active session model)
  // without touching the host config or the regenerated standard overlay.
  // omp merges `--config` overlays in argv order and later overrides
  // earlier on duplicate keys (verified against `omp v17.2.3 --help`).
  const args = buildOmpArgs({
    ompProfile: 'ux-e2e-test',
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/scratch/.omp/agent',
    hostConfigPath: '/Users/test/.omp/agent/config.yml',
    userConfigDefaultPath: '/scratch/.omp/ux-e2e-overlay.user.json',
    userConfigPath: '/scratch/.omp/ux-e2e-overlay.user.json',
  });
  // Three `--config` flags in the right order:
  //   1. host config (modelRoles survives)
  //   2. ux-e2e overlay (regenerated every start)
  //   3. user overlay (highest priority — wins on conflict)
  const configIdx = args.reduce<number[]>((acc, v, i) => (v === '--config' ? [...acc, i] : acc), []);
  assert.equal(configIdx.length, 3, 'emits three --config flags when userConfigPath is set');
  assert.equal(args[configIdx[0] + 1], '/Users/test/.omp/agent/config.yml', 'host config is first');
  assert.equal(args[configIdx[1] + 1], '/scratch/.omp/ux-e2e-overlay.json', 'ux-e2e overlay is second');
  assert.equal(args[configIdx[2] + 1], '/scratch/.omp/ux-e2e-overlay.user.json', 'user overlay is third (highest priority)');
  // Sanity: still never passes -p/--print/--no-pty.
  assert.ok(!args.includes('-p') && !args.includes('--print'));
  assert.ok(!args.includes('--no-pty'));
});

test('server: buildOmpArgs omits the THIRD --config when userConfigPath is unset (no file present)', () => {
  // Absence of the user file is the normal case — the harness must NOT
  // emit a dangling `--config` with `undefined` or an empty path. The
  // default path is still recorded in the contract for diagnostics but
  // never emitted as `--config <default-path>` unless the file exists.
  const args = buildOmpArgs({
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/scratch/.omp/agent',
    hostConfigPath: '/Users/test/.omp/agent/config.yml',
    userConfigDefaultPath: '/scratch/.omp/ux-e2e-overlay.user.json',
  });
  const configIdx = args.reduce<number[]>((acc, v, i) => (v === '--config' ? [...acc, i] : acc), []);
  assert.equal(configIdx.length, 2, 'emits exactly two --config flags when userConfigPath is unset');
  assert.equal(args[configIdx[0] + 1], '/Users/test/.omp/agent/config.yml');
  assert.equal(args[configIdx[1] + 1], '/scratch/.omp/ux-e2e-overlay.json');
  // Default path is referenced via the contract but never emitted as `--config`.
  assert.ok(!args.includes('/scratch/.omp/ux-e2e-overlay.user.json'),
    'user default path is not emitted when userConfigPath is unset');
});

test('server: buildOmpArgs treats empty-string userConfigPath as unset', () => {
  // Defensive: a caller (e.g. a CLI flag) might pass an empty string
  // instead of `undefined`; the contract must treat that the same way.
  const args = buildOmpArgs({
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/scratch/.omp/agent',
    userConfigDefaultPath: '/scratch/.omp/ux-e2e-overlay.user.json',
    userConfigPath: '',
  });
  const configIdx = args.reduce<number[]>((acc, v, i) => (v === '--config' ? [...acc, i] : acc), []);
  assert.equal(configIdx.length, 1, 'empty userConfigPath is treated as unset');
  assert.equal(args[configIdx[0] + 1], '/scratch/.omp/ux-e2e-overlay.json');
});

test('server: checkHostOmpConfig warns on missing or empty modelRoles', () => {
  // Missing file → path:null + warning.
  const missing = checkHostOmpConfig('/nonexistent/omp/config.yml');
  assert.equal(missing.path, null);
  assert.match(missing.warning ?? '', /not found/u);
  // File with a populated modelRoles → path + no warning.
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-hostcfg-'));
  const goodPath = join(dir, 'good.yml');
  writeFileSync(goodPath, 'modelRoles:\n  default: anthropic/claude-sonnet-4.5\n');
  const good = checkHostOmpConfig(goodPath);
  assert.equal(good.path, goodPath);
  assert.equal(good.warning, null);
  // File with `modelRoles:` but no value → warning.
  const emptyPath = join(dir, 'empty.yml');
  writeFileSync(emptyPath, 'modelRoles:\ntheme: dark\n');
  const empty = checkHostOmpConfig(emptyPath);
  assert.equal(empty.path, emptyPath);
  assert.match(empty.warning ?? '', /modelRoles/u);
  // File with no modelRoles key at all → warning.
  const noKeyPath = join(dir, 'nokey.yml');
  writeFileSync(noKeyPath, 'theme: dark\n');
  const noKey = checkHostOmpConfig(noKeyPath);
  assert.equal(noKey.path, noKeyPath);
  assert.match(noKey.warning ?? '', /no 'modelRoles' key/u);
  rmSync(dir, { recursive: true });

});
test('server: safe PTY env excludes unrelated host credentials and secrets', () => {
  const env = safePtyEnv({
    PATH: '/bin',
    HOME: '/home/test',
    OPENCODE_API_KEY: 'opencode-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require=evil',
  });
  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/home/test',
  });
});

test('server: HTTP serves /page.js with cache-buster query (D1)', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());

  // `/page.js?cb=1` must return 200 + the actual page.js bytes.
  // The query string stripping happens in `pathnameOf(req)`, so a
  // cache-buster like `?cb=...` does not change the route.
  const ok = await new Promise<{ status: number; body: string; ctype: string }>((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${String(session.port)}/page.js?cb=1`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          ctype: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  assert.equal(ok.status, 200, '/page.js?cb=1 returns 200');
  assert.match(ok.ctype, /javascript/u, 'content-type is JS');
  assert.match(ok.body, /window\.__uxTerm/u, 'served body is the actual page.js (not 404 fallback)');
  assert.equal(new URL(session.browserUrl).search, '', 'browserUrl carries no bearer query');
  const tokenScript = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${String(session.port)}/session-token.js`, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  assert.equal(tokenScript.status, 404, '/session-token.js is not a bearer-token endpoint');

  // Also exercise the static /xterm.js, /xterm.css, /addon-fit.js routes
  // for symmetry (these were already present; just keep them covered).
  for (const p of ['/xterm.js', '/xterm.css', '/addon-fit.js']) {
    const got = await new Promise<number>((res, rej) => {
      const r = http.get(`http://127.0.0.1:${String(session.port)}${p}`, (r2) => {
        r2.resume();
        res(r2.statusCode ?? 0);
      });
      r.on('error', rej);
    });
    assert.equal(got, 200, `${p} returns 200`);
  }

  // And an unknown path stays 404.
  const missing = await new Promise<number>((res, rej) => {
    const r = http.get(`http://127.0.0.1:${String(session.port)}/no-such-asset.js`, (r2) => {
      r2.resume();
      res(r2.statusCode ?? 0);
    });
    r.on('error', rej);
  });
  assert.equal(missing, 404);
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

test('server: session-scoped token — reconnect is accepted until the session closes', async () => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });

  const firstMessages: ServerMsg[] = [];
  const first = await openWs(session.port, 'sekret', {}, message => firstMessages.push(message));
  await waitFor(() => firstMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  await first.close();

  const reconnectMessages: ServerMsg[] = [];
  const reconnect = await openWs(session.port, 'sekret', {}, message => reconnectMessages.push(message));
  await waitFor(() => reconnectMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  await reconnect.close();

  await session.close();
  const error = await wsFails(session.port, 'sekret');
  assert.match(error.message, /401|ECONNREFUSED|connect/iu);
});

test('server: ws accepts the browser HttpOnly session cookie without a URL token', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const messages: ServerMsg[] = [];
  const ws = await openWs(session.port, 'ignored', { cookie: 'ux-e2e-token=sekret' }, message => messages.push(message));
  await waitFor(() => messages.some(message => message.t === 's'), { timeoutMs: 2000 });
  await ws.close();
});

test('server: ws rejects a mismatched Origin', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const err = await wsFails(session.port, 'sekret', { origin: 'http://evil.example' });
  assert.match(err.message, /403|unexpected server response/iu);
  const exactHostWrongScheme = await wsFails(session.port, 'sekret', { origin: `https://127.0.0.1:${String(session.port)}` });
  assert.match(exactHostWrongScheme.message, /403|unexpected server response/iu);
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

  await ws.close();

  const reconnectMessages: ServerMsg[] = [];
  const reconnect = await openWs(session.port, 'sekret', {}, message => reconnectMessages.push(message));
  await waitFor(() => reconnectMessages.some(message => message.t === 's'), { timeoutMs: 2000 });
  reconnect.send(JSON.stringify({ t: 'i', d: 'again\n' }));
  await waitFor(
    () => reconnectMessages.some(message => message.t === 'o' && message.d.includes('echo:again')),
    { timeoutMs: 5000, label: 'pty echo after reconnect' },
  );
  await reconnect.close();
  const transcript = readFileSync(session.transcriptPath, 'utf8');
  assert.ok(transcript.includes('echo:hello'), 'transcript.jsonl contains output before disconnect');
  assert.ok(transcript.includes('echo:again'), 'same PTY accepts input after reconnect');
  assert.ok(transcript.includes('"t":"i"'), 'transcript.jsonl records input frames');
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
  // user_config block is always present — `path` is null when the file
  // is absent (the normal case), `default_path` always points at the
  // canonical <scratch>/.omp/ux-e2e-overlay.user.json location.
  const userConfig = sessionJson.user_config as { path: string | null; default_path: string };
  assert.equal(userConfig.path, null, 'user_config.path is null when file is absent');
  assert.equal(
    userConfig.default_path,
    join(scratch, '.omp', 'ux-e2e-overlay.user.json'),
    'user_config.default_path always points at the canonical location',
  );
});

test('server: session.json records user_config.path when the user overlay file is present', async t => {
  // When the operator drops `<scratch>/.omp/ux-e2e-overlay.user.json`
  // into the scratch dir, the harness must record the resolved path in
  // session.json under `user_config.path` for diagnostics — even when
  // running in `noPty` mode (where no PTY is spawned but the file's
  // presence is still observable).
  const scratch = makeScratch();
  mkdirSync(join(scratch, '.omp'), { recursive: true });
  const userOverlayPath = join(scratch, '.omp', 'ux-e2e-overlay.user.json');
  writeFileSync(
    userOverlayPath,
    'modelRoles:\n  default: anthropic/claude-sonnet-4.5\n',
  );
  const session = await startTestSession({
    cwd: scratch,
    noPty: true,
    token: 'sekret',
    taskPrompt: 'pin the model',
  });
  t.after(() => session.close());

  const sessionJson = JSON.parse(readFileSync(session.sessionJsonPath, 'utf8')) as Record<string, unknown>;
  const userConfig = sessionJson.user_config as { path: string | null; default_path: string };
  assert.equal(userConfig.path, userOverlayPath, 'user_config.path is the resolved user overlay');
  assert.equal(userConfig.default_path, userOverlayPath);
  rmSync(userOverlayPath);
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
