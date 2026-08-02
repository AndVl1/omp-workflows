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
 * Skips itself when node-pty's native binding cannot load, mirroring the
 * pattern used elsewhere in server.test.ts. Manual QA still owns the
 * production-binary path; this test pins the regression in code.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { deferred } from '../src/util.js';

// node-pty is a native module; skip the test when its binding cannot
// load (matches the server.test.ts guard for the noPty fallback). This
// is the platform-specific-exception case from the ts-no-dynamic-import
// rule: the module name is fixed but its existence is platform-conditional.
async function nodePtyAvailable(): Promise<boolean> {
  try {
    await import('node-pty');
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
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    fail(new Error(`cli subprocess timed out after ${String(timeoutMs)}ms`));
  }, timeoutMs);
  child.once('exit', code => {
    clearTimeout(timer);
    done({
      code,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
      durationMs: Date.now() - startedAt,
    });
  });
  child.once('error', fail);
  return promise;
}

interface SessionJsonShape {
  pid?: unknown;
  url?: unknown;
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
  if (!(await nodePtyAvailable())) {
    t.skip('node-pty native binding is not loadable in this environment');
    return;
  }
  if (!ompAvailable()) {
    t.skip('omp binary not found on PATH — detach integration requires a real omp install');
    return;
  }

  const slug = `detach-${String(Date.now())}`;
  const realScratch = join(tmpdir(), `omp-ux-e2e-${slug}`);
  // A no-op placeholder scratch under mkdtempSync so `t.after` has a
  // known absolute path to operate on; bootstrap re-creates under its
  // own naming and we redirect cleanup to that path below.
  const placeholderScratch = mkdtempSync(join(tmpdir(), 'ux-e2e-detach-it-'));
  mkdirSync(join(placeholderScratch, '.work-state', 'ux-e2e'), { recursive: true });

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
    rmSync(placeholderScratch, { recursive: true, force: true });
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
  // Silence unused-binding noise for the placeholder.
  writeFileSync(join(placeholderScratch, '.gitkeep'), '');

  // 2. Spawn `ux-e2e start --detach` — same call a developer would make.
  const result = await runCli(
    ['start', realScratch, '--surface', 'text', '--detach', '--idle-ms', '5000', '--max-time', '30m'],
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
  assert.match(result.stdout, /ux-e2e: detached session started/u, 'parent prints the started line');
  assert.match(result.stdout, /ux-e2e: url: http/u, 'parent prints the URL line');

  // 3. session.json is populated with a live pid.
  const sessionPath = join(realScratch, '.work-state', 'ux-e2e', 'session.json');
  assert.ok(existsSync(sessionPath), 'detached child wrote session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionJsonShape;
  assert.equal(typeof session.pid, 'number', 'session.json.pid is a number');
  const pid = session.pid as number;
  assert.ok(pid > 0 && pidIsAlive(pid), `pid ${String(pid)} is alive right after parent exits`);
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