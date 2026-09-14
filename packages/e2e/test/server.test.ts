/**
 * Server security + protocol tests. No real omp binary is required:
 * the WS echo test drives a fake shell script via node-pty and fails if the
 * PTY cannot spawn; everything else runs with noPty:true.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
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
  OmpVersionError,
  StartupAbortedError,
  StartupRecoveryError,
  pidIsLive,
  readSessionInfo,
  safeEqual,
  setProcessGroupSignalTestHook,
  setStartupPostSpawnFailureTestHook,
  signalOwnedGroupForTest,
  type SessionInfo,
  startTestSession,
} from '../src/server.js';
import { runStop } from '../src/cli.js';
import { finalizeScratchDirectory } from '../src/scratch-lifecycle.js';
import { processStartIdentity, setFsSafetyTestHooks } from '../src/fs-safety.js';

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-server-'));
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  return dir;
}
test('scratch lifecycle: preserves an observed failure and removes successful evidence', () => {
  const preserved = mkdtempSync(join(tmpdir(), 'ux-e2e-preserve-'));
  const removed = mkdtempSync(join(tmpdir(), 'ux-e2e-remove-'));
  const previousError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    assert.equal(
      finalizeScratchDirectory(preserved, {
        preserveOnFailure: true,
        testFailed: false,
        lifecycleFailed: true,
      }),
      'preserved',
    );
    assert.equal(existsSync(preserved), true, 'failed-run evidence remains available after finalization');
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

    assert.equal(
      finalizeScratchDirectory(removed, {
        preserveOnFailure: true,
        testFailed: false,
        lifecycleFailed: false,
      }),
      'removed',
    );
    assert.equal(existsSync(removed), false, 'successful evidence is cleaned even when preservation is requested');
  } finally {
    console.error = previousError;
    rmSync(preserved, { recursive: true, force: true });
    rmSync(removed, { recursive: true, force: true });
  }
});

test('scratch lifecycle: test-only env preserves successful evidence when explicitly enabled', () => {
  const preserved = mkdtempSync(join(tmpdir(), 'ux-e2e-preserve-success-'));
  const previous = process.env["OMP_UX_E2E_PRESERVE_ON_SUCCESS"];
  const previousError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  process.env["OMP_UX_E2E_PRESERVE_ON_SUCCESS"] = "1";
  try {
    assert.equal(
      finalizeScratchDirectory(preserved, {
        preserveOnFailure: true,
        testFailed: false,
        lifecycleFailed: false,
      }),
      'preserved',
    );
    assert.equal(existsSync(preserved), true, 'explicit test-only opt-in retains successful evidence');
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  } finally {
    console.error = previousError;
    if (previous === undefined) delete process.env["OMP_UX_E2E_PRESERVE_ON_SUCCESS"];
    else process.env["OMP_UX_E2E_PRESERVE_ON_SUCCESS"] = previous;
    rmSync(preserved, { recursive: true, force: true });
  }
});

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

test('server: PID reuse mismatch never signals an owned process group', () => {
  const signals: number[] = [];
  setProcessGroupSignalTestHook(pgid => signals.push(pgid));
  setFsSafetyTestHooks({ processStartIdentity: () => 'generation-B' });
  try {
    assert.equal(signalOwnedGroupForTest(4242, 4242, 'generation-A'), false);
    assert.deepEqual(signals, []);
  } finally {
    setFsSafetyTestHooks(null);
    setProcessGroupSignalTestHook(null);
  }
});

test('server: null captured identity never signals a numeric process group', () => {
  const signals: number[] = [];
  setProcessGroupSignalTestHook(pgid => signals.push(pgid));
  try {
    assert.equal(signalOwnedGroupForTest(4242, 4242, null), false);
    assert.deepEqual(signals, []);
  } finally {
    setProcessGroupSignalTestHook(null);
  }
});

test('server: retained null PTY identity blocks a live-risk restart', () => {
  const scratch = makeScratch();
  const stateDir = join(scratch, '.work-state', 'ux-e2e');
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    schema_version: 2,
    status: 'shutdown_failed',
    pid: process.pid,
    pgid: null,
    phase: 'shutdown_failed',
    probe_pid: null,
    probe_pgid: null,
    probe_start_identity: null,
    pty_start_identity: null,
    server_pid: 999_999_999,
    server_start_identity: 'dead-server-start',
    server_start_nonce: 'start',
    started_at: new Date().toISOString(),
    session_id: 'retained-null-identity',
    token: 'sekret',
    control_nonce: 'control',
    omp_version: 'omp-test',
    spawn_error: null,
    url: 'http://127.0.0.1:1234/?token=sekret',
    browser_url: 'http://127.0.0.1:1234/',
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
    shutdown_error: 'identity unavailable',
  }));
  try {
    assert.throws(
      () => assertNoLiveSession(scratch, false),
      /authenticated PTY process identity|refusing start/iu,
      'an unknown retained PTY identity is live-risk even when the probe identity is null',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
test('server: noisy omp version probe is capped and typed', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'noisy-omp.sh');
  writeFileSync(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  i=0\n  while [ "$i" -lt 300 ]; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i + 1)); done\n  exit 0\nfi\n');
  chmodSync(script, 0o755);
  try {
    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: script, token: 'sekret' }),
      error => error instanceof OmpVersionError && error.code === 'omp-version-failed',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: detached abort during delayed version probe leaves no session metadata', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'delayed-omp.sh');
  writeFileSync(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 1; printf "omp delayed\\n"; fi\n');
  chmodSync(script, 0o755);
  const controller = new AbortController();
  const startup = startTestSession({
    cwd: scratch,
    noPty: true,
    ompBinary: script,
    startupAbortSignal: controller.signal,
    serverStartNonce: 'delayed-startup-test',
  });
  // This integration test deliberately races a real child-process probe;
  // fake timers cannot interrupt spawnSync in the implementation under test.
  setTimeout(() => controller.abort(), 25).unref?.();
  try {
    await assert.rejects(startup, error => error instanceof StartupAbortedError);
    assert.equal(existsSync(join(scratch, '.work-state', 'ux-e2e', 'session.json')), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: missing and unspawnable probe errors converge for same-scratch retry', async () => {
  const scratch = makeScratch();
  const binary = join(scratch, 'probe-binary.sh');
  try {
    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: binary, token: 'missing' }),
      error => error instanceof OmpVersionError,
    );
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');
    assert.equal(readSessionInfo(scratch)?.ompVersion, null);

    writeFileSync(binary, '#!/bin/sh\nprintf "omp should not run\\n"\n');
    // Deliberately leave this fixture unspawnable. The probe must report a
    // typed error, not emit an unhandled ChildProcess error.
    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: binary, token: 'unspawnable' }),
      error => error instanceof OmpVersionError,
    );
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');

    chmodSync(binary, 0o755);
    const recovered = await startTestSession({ cwd: scratch, noPty: true, ompBinary: binary, token: 'recovered' });
    assert.equal(readSessionInfo(scratch)?.status, 'running');
    await recovered.close();
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: null probe identity retains recovery, blocks restart, and converges after natural exit', async () => {
  const scratch = makeScratch();
  const release = join(scratch, 'release-probe');
  const firstProbe = join(scratch, 'first-probe');
  const script = join(scratch, 'null-probe-omp.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ ! -f "${firstProbe}" ]; then
    touch "${firstProbe}"
    trap '' PIPE TERM
    i=0
    while [ "$i" -lt 100 ]; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx || true; i=$((i + 1)); done
    while [ ! -f "${release}" ]; do sleep 0.05; done
  fi
  printf "omp recovered\n"
  exit 0
fi
exit 0
`);
  chmodSync(script, 0o755);
  const signals: number[] = [];
  let identityCalls = 0;
  setProcessGroupSignalTestHook(pgid => signals.push(pgid));
  setFsSafetyTestHooks({
    processStartIdentity: () => {
      identityCalls += 1;
      return identityCalls === 2 ? null : undefined;
    },
  });
  const stop = async (info: SessionInfo): Promise<number> => {
    const sessionUrl = new URL(info.url ?? '');
    return await new Promise<number>((resolve, reject) => {
      const request = http.request({
        method: 'POST',
        hostname: '127.0.0.1',
        port: Number(sessionUrl.port),
        path: '/control/stop',
        headers: {
          Authorization: 'Bearer ' + (info.token ?? ''),
          'X-Ux-E2e-Nonce': info.controlNonce ?? '',
          'X-Ux-E2e-Session-Id': info.sessionId ?? '',
        },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
  };

  try {
    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: script, token: 'sekret' }),
      error => error instanceof StartupRecoveryError,
    );
    setFsSafetyTestHooks(null);
    const retained = readSessionInfo(scratch);
    assert.ok(retained !== null);
    assert.equal(retained.status, 'shutdown_failed');
    assert.ok(retained.probePid !== null);
    assert.equal(retained.probeStartIdentity, null);
    assert.deepEqual(signals, [], 'unknown probe identity never permits a process-group signal');

    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: script, token: 'retry' }),
      /prior version probe has no authenticated process identity|refusing start/iu,
    );
    assert.equal(await stop(retained), 202);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    assert.deepEqual(signals, [], 'authenticated recovery stop also refuses unsafe numeric signalling');

    writeFileSync(release, 'release\n');
    await waitFor(() => readSessionInfo(scratch)?.status === 'stopped', {
      timeoutMs: 8_000,
      intervalMs: 25,
      label: 'natural version probe exit convergence',
    });
    const stopped = readSessionInfo(scratch);
    assert.equal(stopped?.probePid, null);
    assert.equal(stopped?.probeStartIdentity, null);

    const recovered = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, token: 'recovered' });
    assert.equal(readSessionInfo(scratch)?.status, 'running');
    await recovered.close();
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');
  } finally {
    setFsSafetyTestHooks(null);
    setProcessGroupSignalTestHook(null);
    const probePid = readSessionInfo(scratch)?.probePid;
    writeFileSync(release, 'release\n');
    if (probePid !== null && probePid !== undefined) {
      await waitFor(() => !pidIsLive(probePid), {
        timeoutMs: 8_000,
        intervalMs: 25,
        label: 'null-identity probe fixture cleanup',
      }).catch(() => undefined);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: PTY exit before the controller is installed auto-stops the session', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'already-exited-omp.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp exited\n'; exit 0; fi
exit 0
`);
  chmodSync(script, 0o755);
  let session: Awaited<ReturnType<typeof startTestSession>> | null = null;
  try {
    session = await startTestSession({ cwd: scratch, ompBinary: script, token: 'sekret', idleMs: 30_000 });
    await waitFor(() => readSessionInfo(scratch)?.status === 'stopped', {
      timeoutMs: 8_000,
      intervalMs: 25,
      label: 'early PTY exit shutdown',
    });
    const stopped = readSessionInfo(scratch);
    assert.equal(stopped?.ptyExitObserved, true);
    assert.equal(stopped?.status, 'stopped');
    await assert.rejects(
      () => new Promise<number>((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${String(session?.port ?? 0)}/session?token=sekret`, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        });
        request.once('error', reject);
      }),
      /ECONNREFUSED|connect|socket hang up/iu,
      'the listener closes after a PTY exits before startup publishes running',
    );
  } finally {
    await session?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: PTY identity failure retains authenticated recovery for a stubborn PTY', async () => {
  const scratch = makeScratch();
  const release = join(scratch, 'release-pty');
  const script = join(scratch, 'stubborn-omp.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp stubborn\\n'; exit 0; fi
trap '' HUP
trap '[ -f "${release}" ] && exit 0' TERM
while :; do
  [ -f "${release}" ] && exit 0
  sleep 0.05
done
`);
  chmodSync(script, 0o755);
  let identityCalls = 0;
  setFsSafetyTestHooks({
    processStartIdentity: () => {
      identityCalls += 1;
      return identityCalls === 3 ? null : undefined;
    },
  });

  const stop = async (info: SessionInfo): Promise<number> => {
    const sessionUrl = new URL(info.url ?? '');
    return await new Promise<number>((resolve, reject) => {
      const request = http.request({
        method: 'POST',
        hostname: '127.0.0.1',
        port: Number(sessionUrl.port),
        path: '/control/stop',
        headers: {
          Authorization: `Bearer ${info.token ?? ''}`,
          'X-Ux-E2e-Nonce': info.controlNonce ?? '',
          'X-Ux-E2e-Session-Id': info.sessionId ?? '',
        },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
  };

  try {
    await assert.rejects(
      () => startTestSession({ cwd: scratch, ompBinary: script, token: 'sekret', idleMs: 30_000 }),
      error => error instanceof StartupRecoveryError,
    );
    setFsSafetyTestHooks(null);
    const failed = readSessionInfo(scratch);
    assert.ok(failed !== null);
    assert.equal(failed.status, 'shutdown_failed');
    assert.equal(failed.ptyStartIdentity, null);
    assert.ok(failed.pid !== null);
    const probe = await new Promise<number>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${String(new URL(failed.url ?? '').port)}/session?token=sekret`, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
    });
    assert.equal(probe, 200);
    assert.equal(await stop(failed), 202);
    await new Promise<void>(resolve => setTimeout(resolve, 5_500));
    writeFileSync(release, 'release\n');
    await waitFor(() => readSessionInfo(scratch)?.status === 'stopped', {
      timeoutMs: 8_000,
      intervalMs: 100,
      label: 'natural PTY exit after authenticated recovery',
    });
  } finally {
    setFsSafetyTestHooks(null);
    // A failed assertion/cancel must not erase the authenticated owner before
    // the stubborn fixture has observed its release and graceful stop.
    writeFileSync(release, 'release\n');
    const retained = readSessionInfo(scratch);
    if (retained !== null) {
      try { await stop(retained); } catch { /* the test assertion carries the failure */ }
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && readSessionInfo(scratch)?.status !== 'stopped') {
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('server: shutdown grace rejects queued input and new attachments', async () => {
  const scratch = makeScratch();
  const release = join(scratch, 'release-pty');
  const inputLog = join(scratch, 'pty-input.log');
  const script = join(scratch, 'fenced-pty.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp fenced\\n'; exit 0; fi
trap '[ -f "${release}" ] && exit 0' TERM
while :; do
  IFS= read -r line || exit 0
  printf '%s\\n' "$line" >> "${inputLog}"
done
`);
  chmodSync(script, 0o755);

  const session = await startTestSession({ cwd: scratch, ompBinary: script, token: 'sekret', idleMs: 30_000 });
  try {
    if (session.pty.mode !== 'pty') {
      throw new Error('node-pty could not spawn the fenced fake command');
    }
    const ws = await openWs(session.port, 'sekret');
    // The frame is queued before close returns, but the server cannot process
    // it until this turn yields. The controller fence must win that race.
    ws.send(JSON.stringify({ t: 'i', d: 'queued-during-close\\n' }));
    const stopping = session.close();

    await assert.rejects(stopping, /PTY graceful exit could not be proven/iu);
    assert.equal(existsSync(inputLog), false, 'queued input never reaches the PTY during shutdown grace');
    assert.equal(readSessionInfo(scratch)?.status, 'shutdown_failed');

    // A failed graceful stop remains retryable only after the fenced attempt
    // has rolled back; the PTY is then released and stopped normally.
    writeFileSync(release, 'release\n');
    await session.close();
    await session.close();
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');
  } finally {
    writeFileSync(release, 'release\n');
    await session.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
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

test('server: browser bootstrap URL exchanges once for an HttpOnly cookie and rejects replay', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());
  const bootstrap = new URL(session.browserUrl);
  assert.equal(bootstrap.searchParams.has('token'), false);
  assert.ok(bootstrap.searchParams.get('code') !== null);
  const first = await new Promise<{ status: number; cookie: string | undefined }>((resolve, reject) => {
    const request = http.get(session.browserUrl, response => {
      response.resume();
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        cookie: response.headers['set-cookie']?.[0],
      }));
    });
    request.once('error', reject);
  });
  assert.equal(first.status, 200);
  assert.match(first.cookie ?? '', /^ux_e2e_session=[^;]+; HttpOnly/u);
  const descriptor = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${String(session.port)}/session`, {
      headers: { Cookie: first.cookie },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
  });
  assert.equal(descriptor.status, 200);
  assert.deepEqual(JSON.parse(descriptor.body), { session_id: session.sessionId, ws_path: '/ws' });
  assert.doesNotMatch(descriptor.body, /sekret|code/u, 'reload descriptor contains no bearer or bootstrap credential');
  const reload = await new Promise<number>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${String(session.port)}/`, {
      headers: { Cookie: first.cookie },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
  });
  assert.equal(reload, 200, 'clean URL reload serves the terminal with its HttpOnly cookie');

  const replayStatus = await new Promise<number>((resolve, reject) => {
    const request = http.get(session.browserUrl, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
  });
  assert.equal(replayStatus, 401);

  const messages: ServerMsg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${String(session.port)}/ws`, {
    headers: { Cookie: first.cookie, Origin: `http://127.0.0.1:${String(session.port)}` },
  });
  ws.on('message', raw => messages.push(JSON.parse(raw.toString('utf8')) as ServerMsg));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await waitFor(() => messages.some(message => message.t === 's'), { timeoutMs: 2000 });
  await new Promise<void>(resolve => {
    ws.once('close', () => resolve());
    ws.close();
  });
});
test('server: consumed browser bootstrap remains readable, stoppable, and relaunchable', async () => {
  const scratch = makeScratch();
  let first: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let relaunched: Awaited<ReturnType<typeof startTestSession>> | null = null;
  try {
    first = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
    const firstStatus = await new Promise<number>((resolve, reject) => {
      const request = http.get(first?.browserUrl ?? '', response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
    });
    assert.equal(firstStatus, 200);
    const consumed = readSessionInfo(scratch);
    assert.ok(consumed !== null, 'consumed browser metadata remains readable');
    assert.equal(consumed?.browserUrl, null, 'one-time browser URL is cleared after exchange');

    assert.equal(await runStop({ scratchDir: scratch }), 0);
    const stopped = readSessionInfo(scratch);
    assert.equal(stopped?.status, 'stopped');
    relaunched = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret-relaunch' });
    assert.ok(readSessionInfo(scratch)?.browserUrl !== null, 'relaunch publishes a fresh browser URL');
  } finally {
    await relaunched?.close();
    await first?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: delayed HTTP close keeps stop and fixed-port relaunch non-success until drain', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'delayed-http-close-omp.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp delayed-close\\n'; exit 0; fi
exit 0
`);
  chmodSync(script, 0o755);
  let session: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let relaunched: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let forcedRelaunch: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let stubborn: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let socket: net.Socket | null = null;
  let stubbornSocket: net.Socket | null = null;
  let stopping: Promise<void> | null = null;
  try {
    session = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, token: 'sekret' });
    socket = net.createConnection({ host: '127.0.0.1', port: session.port });
    await new Promise<void>((resolve, reject) => {
      socket?.once('connect', resolve);
      socket?.once('error', reject);
    });
    // Keep one HTTP request incomplete so httpServer.close() remains in its
    // drain phase after the controller has already accepted shutdown.
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n');
    await new Promise<void>(resolve => setTimeout(resolve, 25));

    stopping = session.close();
    await waitFor(() => readSessionInfo(scratch)?.phase === 'draining', {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'HTTP listener drain state',
    });
    assert.equal(readSessionInfo(scratch)?.status, 'running');
    assert.equal(await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]), false, 'session close remains pending while HTTP listener drains');

    assert.equal(await runStop({ scratchDir: scratch }), 1, 'stop reports non-success while listener close is unproven');
    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: script, port: session?.port, token: 'retry' }),
      /live session|refusing start/iu,
      'fixed-port relaunch remains blocked during HTTP drain',
    );

    socket.write('\r\n');
    socket.end();
    await stopping;
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');

    relaunched = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, port: session.port, token: 'recovered' });
    assert.equal(relaunched.port, session.port, 'the exact fixed port is reusable only after close proof');
    await relaunched.close();
    relaunched = null;

    stubborn = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, port: session.port, token: 'stubborn' });
    stubbornSocket = net.createConnection({ host: '127.0.0.1', port: stubborn.port });
    await new Promise<void>((resolve, reject) => {
      stubbornSocket?.once('connect', resolve);
      stubbornSocket?.once('error', reject);
    });
    // Leave this request incomplete so closeHttpServer must force-close it
    // after the bounded graceful listener window.
    stubbornSocket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n');
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    const forcedStarted = Date.now();
    assert.equal(await runStop({ scratchDir: scratch }), 0, 'forced HTTP close still reports success only after listener closure');
    assert.ok(Date.now() - forcedStarted < 5_000, 'incomplete HTTP close is bounded');
    await waitFor(() => stubbornSocket?.destroyed === true, {
      timeoutMs: 4_000,
      intervalMs: 25,
      label: 'forced incomplete HTTP cleanup',
    });
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');

    forcedRelaunch = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, port: session.port, token: 'forced-recovered' });
    assert.equal(forcedRelaunch.port, session.port, 'fixed port is reusable after forced listener closure');
  } finally {
    socket?.destroy();
    stubbornSocket?.destroy();
    await stopping?.catch(() => undefined);
    await forcedRelaunch?.close().catch(() => undefined);
    await stubborn?.close().catch(() => undefined);
    await relaunched?.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: post-spawn rollback bounds authenticated WebSocket cleanup and permits fixed-port retry', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'rollback-ws-omp.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp rollback-ws\\n'; exit 0; fi
exit 0
`);
  chmodSync(script, 0o755);
  let socket: net.Socket | null = null;
  let fixedPort = 0;
  const signals: number[] = [];
  setProcessGroupSignalTestHook(pgid => signals.push(pgid));
  setStartupPostSpawnFailureTestHook(async context => {
    fixedPort = context.port;
    socket = net.createConnection({ host: '127.0.0.1', port: context.port });
    await new Promise<void>((resolve, reject) => {
      socket?.once('connect', resolve);
      socket?.once('error', reject);
    });
    const handshake = await new Promise<string>((resolve, reject) => {
      let body = '';
      const onData = (chunk: Buffer): void => {
        body += chunk.toString('latin1');
        if (body.includes('\r\n\r\n')) {
          socket?.off('data', onData);
          resolve(body);
        }
      };
      socket?.on('data', onData);
      socket?.once('error', reject);
      socket?.write(
        'GET /ws?token=' + context.token + ' HTTP/1.1\r\n'
        + 'Host: 127.0.0.1:' + String(context.port) + '\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Origin: ' + context.origin + '\r\n\r\n',
      );
    });
    assert.match(handshake, /HTTP\/1\.1 101 Switching Protocols/u);
    return new Error('ux-e2e: rollback test failure');
  });
  try {
    const rollbackStarted = Date.now();
    await assert.rejects(
      () => startTestSession({ cwd: scratch, noPty: true, ompBinary: script }),
      /rollback test failure/u,
    );
    assert.ok(Date.now() - rollbackStarted < 5_000, 'post-spawn rollback is bounded below the stop SLA');
    await waitFor(() => socket?.destroyed === true, {
      timeoutMs: 4_000,
      intervalMs: 25,
      label: 'post-spawn rollback WebSocket cleanup',
    });
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');
    assert.equal(readSessionInfo(scratch)?.pid, null);
    assert.deepEqual(signals, [], 'rollback WS cleanup never signals an OMP process owner');

    setStartupPostSpawnFailureTestHook(null);
    const recovered = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, port: fixedPort, token: 'recovered' });
    assert.equal(recovered.port, fixedPort, 'fixed port is reusable after rollback closure proof');
    await recovered.close();
  } finally {
    setStartupPostSpawnFailureTestHook(null);
    setProcessGroupSignalTestHook(null);
    socket?.destroy();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: stubborn authenticated WebSocket is bounded and fixed-port relaunch succeeds', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'stubborn-ws-omp.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp stubborn-ws\\n'; exit 0; fi
exit 0
`);
  chmodSync(script, 0o755);
  let session: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let relaunched: Awaited<ReturnType<typeof startTestSession>> | null = null;
  let socket: net.Socket | null = null;
  const signals: number[] = [];
  setProcessGroupSignalTestHook(pgid => signals.push(pgid));
  try {
    session = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, token: 'sekret' });
    socket = net.createConnection({ host: '127.0.0.1', port: session.port });
    await new Promise<void>((resolve, reject) => {
      socket?.once('connect', resolve);
      socket?.once('error', reject);
    });
    const handshake = await new Promise<string>((resolve, reject) => {
      let body = '';
      const onData = (chunk: Buffer): void => {
        body += chunk.toString('latin1');
        if (body.includes('\r\n\r\n')) {
          socket?.off('data', onData);
          resolve(body);
        }
      };
      socket?.on('data', onData);
      socket?.once('error', reject);
      socket?.write(
        'GET /ws?token=sekret HTTP/1.1\r\n'
        + 'Host: 127.0.0.1:' + String(session?.port ?? 0) + '\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Origin: http://127.0.0.1:' + String(session?.port ?? 0) + '\r\n\r\n',
      );
    });
    assert.match(handshake, /HTTP\/1\.1 101 Switching Protocols/u);
    // Do not answer the server's close handshake: this is an authenticated
    // peer that would otherwise keep httpServer.close() pending forever.
    const socketClosed = new Promise<void>(resolve => {
      socket?.once('close', () => resolve());
    });
    const started = Date.now();
    assert.equal(await runStop({ scratchDir: scratch }), 0);
    assert.ok(Date.now() - started < 5_000, 'authenticated stop remains bounded with a stubborn WS peer');
    await Promise.race([
      socketClosed,
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ]);
    assert.equal(socket?.destroyed, true, 'stubborn WS socket is terminated after graceful close grace');
    assert.equal(readSessionInfo(scratch)?.status, 'stopped');
    assert.deepEqual(signals, [], 'WS cleanup never signals an OMP process owner');

    relaunched = await startTestSession({ cwd: scratch, noPty: true, ompBinary: script, port: session.port, token: 'recovered' });
    assert.equal(relaunched.port, session.port, 'fixed port is reusable after WS and HTTP close proof');
  } finally {
    socket?.destroy();
    setProcessGroupSignalTestHook(null);
    await relaunched?.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('server: null browser URL without consumed bootstrap proof is rejected', async () => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  const sessionPath = join(scratch, '.work-state', 'ux-e2e', 'session.json');
  try {
    const raw = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
    raw.browser_url = null;
    raw.browser_code_expires_at = null;
    raw.browser_bootstrap_consumed = false;
    writeFileSync(sessionPath, JSON.stringify(raw) + '\n');
    assert.equal(readSessionInfo(scratch), null);
  } finally {
    await session.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});


test('server: multiple authenticated clients receive PTY output and survive temporary CLI disconnect', async t => {
  const scratch = makeScratch();
  const script = join(scratch, 'fake-multi-client.sh');
  writeFileSync(script, '#!/bin/sh\nwhile IFS= read -r line; do printf "echo:%s\\n" "$line"; done\n', { mode: 0o755 });
  const session = await startTestSession({ cwd: scratch, ompBinary: script, token: 'sekret', idleMs: 5000 });
  t.after(() => session.close());
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('node-pty could not spawn the fake multi-client command');
  }
  const firstMessages: ServerMsg[] = [];
  const secondMessages: ServerMsg[] = [];
  const first = await openWs(session.port, 'sekret', {}, message => firstMessages.push(message));
  const second = await openWs(session.port, 'sekret', {}, message => secondMessages.push(message));
  await waitFor(() => firstMessages.some(message => message.t === 's')
    && secondMessages.some(message => message.t === 's'), { timeoutMs: 2000 });

  first.send(JSON.stringify({ t: 'i', d: 'one\n' }));
  await waitFor(() => firstMessages.some(message => message.t === 'o' && message.d.includes('echo:one'))
    && secondMessages.some(message => message.t === 'o' && message.d.includes('echo:one')), {
    timeoutMs: 3000,
    label: 'broadcast first PTY output',
  });

  await new Promise<void>(resolve => {
    second.once('close', () => resolve());
    second.close();
  });
  assert.equal(first.readyState, WebSocket.OPEN, 'browser client remains open after CLI disconnect');
  first.send(JSON.stringify({ t: 'i', d: 'two\n' }));
  await waitFor(() => firstMessages.some(message => message.t === 'o' && message.d.includes('echo:two')), {
    timeoutMs: 3000,
    label: 'browser output after CLI disconnect',
  });
  await new Promise<void>(resolve => {
    first.once('close', () => resolve());
    first.close();
  });
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
  assert.equal(readSessionInfo(scratch)?.status, 'stopped', 'shutdown persists terminal lifecycle metadata for reporting');
  const error = await wsFails(session.port, 'sekret');
  assert.match(error.message, /401|ECONNREFUSED|connect/iu);
});
test('server: a stopped session can relaunch in the same long-lived process', async () => {
  const scratch = makeScratch();
  const first = await startTestSession({ cwd: scratch, noPty: true, token: 'first' });
  await first.close();
  assert.equal(readSessionInfo(scratch)?.status, 'stopped');
  const second = await startTestSession({ cwd: scratch, noPty: true, token: 'second' });
  assert.notEqual(second.sessionId, first.sessionId);
  await second.close();
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

  const session = await startTestSession({ cwd: scratch, noPty: false, ompBinary: script, token: 'sekret', idleMs: 2000 });
  t.after(() => session.close());
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('node-pty could not spawn the fake command');
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
    scenario: {
      id: 'full-feature',
      title: 'Full feature',
      selectors: { feature_id: 'feature-a', run_key: 'run-1' },
      workspace: { path: 'specs/feature-a', state_path: '.work-state/features/feature-a/state.json' },
      transcript: { checkpoints: ['.work-state/features/feature-a/checkpoint.json'], workers: ['worker.json'] },
    },
    serverStartNonce: 'test-start-nonce',
  });
  t.after(() => session.close());

  const sessionJson = JSON.parse(readFileSync(session.sessionJsonPath, 'utf8')) as Record<string, unknown>;
  assert.equal(sessionJson.schema_version, 2);
  assert.equal(sessionJson.server_pid, process.pid);
  assert.equal(sessionJson.server_start_nonce, 'test-start-nonce');
  assert.deepEqual(sessionJson.scenario, {
    id: 'full-feature',
    title: 'Full feature',
    selectors: { feature_id: 'feature-a', run_key: 'run-1' },
    workspace: { path: 'specs/feature-a', state_path: '.work-state/features/feature-a/state.json' },
    transcript: { checkpoints: ['.work-state/features/feature-a/checkpoint.json'], workers: ['worker.json'] },
  });
  assert.equal(typeof sessionJson.browser_url, 'string');
  assert.doesNotMatch(String(sessionJson.browser_url), /token=sekret/u);
  assert.equal(typeof sessionJson.omp_version, 'string');
  assert.equal(sessionJson.profile, null);
  assert.equal(sessionJson.token, 'sekret');
  assert.equal(sessionJson.wsPath, '/ws');
  assert.equal(sessionJson.task_prompt, 'do the thing');
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
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    schema_version: 2,
    status: 'running',
    pid: process.pid,
    server_pid: process.pid,
    pty_start_identity: 'test-pty-start',
    server_start_identity: processStartIdentity(process.pid),
    started_at: new Date().toISOString(),
    session_id: 'test-session',
    token: 'sekret',
    control_nonce: 'control',
    server_start_nonce: 'start',
    omp_version: 'omp-test',
    spawn_error: null,
    url: 'http://127.0.0.1:1234/?token=sekret',
    browser_url: 'http://127.0.0.1:1234/',
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
    shutdown_error: null,
  }));

  assert.throws(() => assertNoLiveSession(scratch, true), /live session/iu, 'force cannot bypass live ownership');

  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    schema_version: 2,
    status: 'running',
    pid: 999_999_999,
    pty_start_identity: 'dead-pty-start',
    server_pid: 999_999_999,
    server_start_identity: 'dead-server-start',
    started_at: new Date().toISOString(),
    session_id: 'dead-session',
    token: 'sekret',
    control_nonce: 'control',
    server_start_nonce: 'dead-start',
    omp_version: 'omp-test',
    spawn_error: null,
    url: 'http://127.0.0.1:1234/?token=sekret',
    browser_url: 'http://127.0.0.1:1234/',
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
    shutdown_error: null,
  }));
  assert.doesNotThrow(() => assertNoLiveSession(scratch, false), 'dead pid is not a live session');
  assert.ok(!pidIsLive(999_999_999));
});
test('server: session metadata requires exact v2 lifecycle fields', () => {
  const scratch = makeScratch();
  const stateDir = join(scratch, '.work-state', 'ux-e2e');
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    status: 'running',
    pid: 12345,
    pty_start_identity: 'pty-start',
    server_pid: 12345,
    server_start_identity: 'server-start',
    server_start_nonce: 'start',
    started_at: new Date().toISOString(),
    session_id: 'session',
    token: 'token',
    control_nonce: 'control',
    omp_version: 'omp-test',
    spawn_error: null,
    url: 'http://127.0.0.1:1234/?token=token',
    browser_url: 'http://127.0.0.1:1234/',
  }));
  assert.equal(readSessionInfo(scratch), null, 'schema-less metadata is not an operational session descriptor');
  assert.throws(
    () => assertNoLiveSession(scratch, false),
    /malformed or unsupported session metadata/iu,
  );
});

test('driver: waitFor timeout semantics', async () => {
  await waitFor(() => true, { timeoutMs: 100 });
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 50, intervalMs: 10 }),
    WaitTimeoutError,
  );
});

test('server: ws accepts the canonical origin', async t => {
  const scratch = makeScratch();
  const session = await startTestSession({ cwd: scratch, noPty: true, token: 'sekret' });
  t.after(() => session.close());

  const msgs: ServerMsg[] = [];
  const ws = await openWs(session.port, 'sekret', { origin: `http://127.0.0.1:${session.port}` }, m => msgs.push(m));
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


test('server: OMP startup isolates ambient plugins while preserving explicit runtime provenance', async () => {
  const scratch = makeScratch();
  const script = join(scratch, 'record-home.sh');
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp isolation\\n'; exit 0; fi
printf '%s\\n' "$HOME" > "${scratch}/child-home.txt"
if [ -e "$HOME/.omp/plugins" ]; then printf 'ambient-present\\n' > "${scratch}/ambient.txt"; fi
sleep 3
exit 0
`);
  chmodSync(script, 0o755);
  try {
    const session = await startTestSession({ cwd: scratch, ompBinary: script, token: 'sekret', idleMs: 2_000 });
    const raw = JSON.parse(readFileSync(join(scratch, '.work-state', 'ux-e2e', 'session.json'), 'utf8')) as Record<string, unknown>;
    const isolation = raw['extension_isolation'] as Record<string, unknown>;
    assert.equal(isolation['ambient_discovery_disabled'], true);
    assert.equal(typeof isolation['home'], 'string');
    assert.equal(existsSync(join(String(isolation['home']), '.omp', 'plugins')), false);
    await session.close();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
