/**
 * Detach integration test — exercise the full `ux-e2e start --detach`
 * round-trip end to end:
 *
 *   1. Bootstrap a real scratch project (npm-linked to this monorepo).
 *   2. Spawn `node dist/cli.js start <scratch> --detach` as a subprocess
 *      — this is exactly what a developer / CI shell would run.
 *   3. Assert the parent exits quickly (was hanging indefinitely before
 *      the fix — pipes held the event loop open after the URL was
 *      printed).
 *   4. Read the URL + pid from `<scratch>/.work-state/ux-e2e/session.json`.
 *   5. Wait ~5s past the historical crash window (~3-4s) and re-check:
 *      the pid is STILL alive AND the HTTP port is still listening.
 *      Pre-fix the child died with EPIPE when the parent tore down its
 *      pipes, which manifested as ECONNREFUSED on the port within ~4s.
 *   6. Drive `ux-e2e input` to prove the PTY actually accepts frames.
 *   7. `ux-e2e stop` for a clean teardown — no `pkill` / signal-by-name
 *      (per the safety contract).
 *
 * The test fails closed when node-pty or omp is unavailable; it never
 * substitutes the noPty runtime fallback.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { waitFor } from '../src/driver.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { deferred } from '../src/util.js';

// node-pty is a native module; fail closed when its binding cannot create a
// PTY (an installed but unusable native binding otherwise downgrades
// startTestSession to its noPty fallback). This is the platform-specific
// exception case from the ts-no-dynamic-import rule: the module name is fixed
// but its native executable is platform-conditional.
async function nodePtyAvailable(): Promise<boolean> {
  try {
    const pty = await import('node-pty');
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/c', 'exit 0'] : ['-c', 'exit 0'];
    const probe = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: process.env,
    });
    probe.onData(() => {});
    probe.onExit(() => {});
    return true;
  } catch {
    return false;
  }
}

/** True when an `omp` binary is reachable (CI runners usually lack it). */
function ompAvailable(): boolean {
  try {
    const r = spawnSync('omp', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Spawn `node dist/cli.js <args>` and wait for it to exit. */
function runCli(args: string[], timeoutMs = 90_000): Promise<CliResult> {
  const { promise, resolve: done, reject: fail } = deferred<CliResult>();
  const startedAt = Date.now();
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const child: ChildProcess = spawn(process.execPath, [DIST_CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => chunks.push(c));
  child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
  const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (code: number | null): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    done({
      code,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
      durationMs: Date.now() - startedAt,
    });
  };
  const failOnce = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    fail(error);
  };
  child.once('close', finish);
  child.once('error', error => failOnce(error instanceof Error ? error : new Error(String(error))));
  timer = setTimeout(() => {
    void (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* process already exited */ }
      }
      let timeout: NodeJS.Timeout | undefined;
      const exited = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 45_000);
        void closed.then(() => {
          if (timeout !== undefined) clearTimeout(timeout);
          resolve(true);
        });
      });
      if (!(await exited)) {
        failOnce(new Error(`cli subprocess did not exit gracefully within 45000ms after SIGTERM`));
        return;
      }
      failOnce(new Error(`cli subprocess timed out after ${String(timeoutMs)}ms`));
    })();
  }, timeoutMs);
  return promise;
}

interface SessionJsonShape {
  pid?: unknown;
  url?: unknown;
  server_start_nonce?: unknown;
}

/** HEAD-style probe: returns true if the URL responds at all (any status). */
function httpReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  const { promise, resolve: done } = deferred<boolean>();
  const req = http.get(url, { timeout: timeoutMs }, res => {
    res.resume();
    // Any HTTP response — even 401 / 403 — proves the listener is up.
    // ECONNREFUSED manifests as an 'error' event with no response.
    done(true);
  });
  req.on('error', () => done(false));
  req.on('timeout', () => {
    req.destroy();
    done(false);
  });
  return promise;
}

const DIST_CLI = resolve(import.meta.dirname, '..', 'dist', 'cli.js');

test('detach: parent exits fast and detached child survives past the EPIPE window', async t => {
  assert.ok(await nodePtyAvailable(), 'node-pty native binding is required for detach integration');
  assert.ok(ompAvailable(), 'omp binary is required for detach integration');

  const slug = `detach-${String(Date.now())}`;
  const realScratch = join(tmpdir(), `omp-ux-e2e-${slug}`);

  t.after(async () => {
    // Best-effort stop — also covers the failure path (child never
    // came up). --force tolerates a dead pid in session.json.
    try {
      const { runStop } = await import('../src/cli.js');
      await runStop({ scratchDir: realScratch });
    } catch {
      /* swallow — cleanup must never throw */
    }
    rmSync(realScratch, { recursive: true, force: true });
  });

  // 1. Bootstrap a real scratch project wired to this monorepo. Uses
  //    runBootstrap (same code path the CLI uses) so we know the scratch
  //    is in a state `start` can consume.
  const { runBootstrap } = await import('../src/cli.js');
  runBootstrap({
    slug,
    branch: 'feat/agent-model-roles',
    workdir: tmpdir(),
    omp: undefined,
    monorepo: undefined,
    force: true,
  });
  assert.ok(existsSync(realScratch), `bootstrap produced ${realScratch}`);

  // 2. Spawn `ux-e2e start --detach` — same call a developer would make.
  const result = await runCli(
    ['start', realScratch, '--surface', 'text', '--detach', '--idle-ms', '30000', '--max-time', '30m', '--startup-nonce=-XYZ'],
    90_000,
  );

  assert.equal(result.code, 0, `parent exit code 0 (stderr: ${result.stderr})`);
  // The parent used to hang >60s because pipe → logStream held the event
  // loop open. After the fix it returns as soon as the URL is known.
  // Generous bound (65s) covers the 60s cold-start deadline on slow CI.
  assert.ok(
    result.durationMs < 65_000,
    `parent returned within the startup deadline; actual ${String(result.durationMs)}ms`,
  );
  assert.match(result.stdout, /ux-e2e: detached session (?:started|ready)/u, `parent prints the detached session line (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}, code=${String(result.code)})`);
  assert.match(result.stdout, /ux-e2e: url: http/u, `parent prints the URL line (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}, code=${String(result.code)})`);

  // 3. session.json is populated with a live pid.
  const sessionPath = join(realScratch, '.work-state', 'ux-e2e', 'session.json');
  assert.ok(existsSync(sessionPath), 'detached child wrote session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionJsonShape;
  assert.equal(typeof session.pid, 'number', 'session.json.pid is a number');
  const pid = session.pid as number;
  assert.equal(session.server_start_nonce, '-XYZ', 'detached metadata preserves a dash-prefixed startup nonce');
  assert.equal(typeof session.url, 'string', 'session.json.url is a string');
  const url = session.url as string;

  // 4. Wait past the historical ~3-4s EPIPE crash window. Pre-fix the
  //    child died and ECONNREFUSED. Post-fix the pid + the HTTP port
  //    both stay up. Real-time wait is required here — this is an
  //    integration test against the platform's process lifecycle, not
  //    a unit test that can use fake timers; the test fails fast (~5s)
  //    if the regression returns.
  const waitMs = 5_500;
  await new Promise(r => setTimeout(r, waitMs));
  assert.ok(
    pidIsAlive(pid),
    `pid ${String(pid)} STILL alive ${String(waitMs)}ms after parent exit (would have died with EPIPE pre-fix)`,
  );
  assert.ok(
    await httpReachable(url),
    `HTTP port for ${url} is listening ${String(waitMs)}ms after parent exit (ECONNREFUSED pre-fix)`,
  );

  // 5. Drive a real input frame through `ux-e2e input` to prove the
  //    PTY is functionally alive, not just nominally up.
  const inputRes = await runCli(['input', realScratch, '/do-work detach-survival-probe'], 10_000);
  assert.equal(inputRes.code, 0, `input accepts frames (stderr: ${inputRes.stderr})`);
  assert.match(inputRes.stdout, /sent .* followed by Enter/u);

  // eslint-disable-next-line no-console
  console.log(
    `[detach-it] parent exited in ${String(result.durationMs)}ms; pid ${String(pid)} survived ${String(waitMs)}ms; input round-trip ok`,
  );
  const stopResult = await runCli(['stop', realScratch], 30_000);
  assert.equal(stopResult.code, 0, `authenticated stop exits 0 (stderr: ${stopResult.stderr})`);
  assert.match(stopResult.stdout, /authenticated server stop completed/u, 'stop reports authenticated shutdown completion');
  await waitFor(() => !pidIsAlive(pid), { timeoutMs: 5_000, intervalMs: 50, label: 'detached child exit after authenticated stop' });
  const stopped = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
  assert.equal(stopped['schema_version'], 2);
  assert.equal(stopped['status'], 'stopped');
  assert.equal(stopped['pty_exit_observed'], true);
  assert.equal(typeof stopped['shutdown_completed_at'], 'string');
  assert.equal(stopped['stopped_at'], stopped['finished_at']);
});

/** Test seam: pidIsAlive is called from two distinct wait points; both
 *  need the same process.kill(pid, 0) semantics. Inlining would
 *  duplicate the try/catch. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}