import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as pty from 'node-pty';

import { generateReport } from '../src/report.js';
import { waitFor } from '../src/driver.js';
import { prepareRun } from '../src/prepare.js';
import { readSessionRecord } from '../src/server.js';
import { cleanupRun } from '../src/verify.js';
import { createPrepareRunFixture } from './fixtures/prepare-run.js';

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = resolve(TEST_DIR, '..', 'dist', 'cli.js');

function runCli(args: string[], timeoutMs = 30_000): CliResult {
  const result = spawnSync(process.execPath, [DIST_CLI, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
}

function nodePtyAvailable(): boolean {
  try {
    const probe = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: process.env,
    });
    probe.onData(() => undefined);
    probe.onExit(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function httpReachable(url: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

test('detach: manifest CLI returns while its isolated session survives and accepts input', async t => {
  if (!existsSync(DIST_CLI)) {
    t.skip('built e2e CLI is unavailable; package integration builds it before running this test');
    return;
  }
  if (!nodePtyAvailable()) {
    t.skip('node-pty native binding cannot start a disposable PTY process');
    return;
  }

  const fixture = createPrepareRunFixture();
  const runId = 'detached-run';
  const manifestPath = join(fixture.stateRoot, 'runs', runId, 'manifest.json');
  const previousRoot = process.env.OMP_E2E_ROOT;
  process.env.OMP_E2E_ROOT = fixture.stateRoot;
  const sessionId = 'detached-process-probe';
  t.after(async () => {
    try {
      if (existsSync(manifestPath)) {
        runCli(['stop', '--manifest', manifestPath, '--session-id', sessionId, '--json']);
        const cleanup = await cleanupRun({ manifestPath });
        assert.equal(cleanup.ok, true, 'detached fixture still owns a live process');
      }
      fixture.cleanup();
    } finally {
      if (previousRoot === undefined) delete process.env.OMP_E2E_ROOT;
      else process.env.OMP_E2E_ROOT = previousRoot;
    }
  });
  const prepared = await prepareRun(fixture.configPath, runId);
  assert.ok(prepared.ok && prepared.manifest !== undefined, `prepare failed: ${prepared.error?.code ?? 'unknown'}`);

  const started = runCli([
    'start',
    '--manifest', manifestPath,
    '--session-id', sessionId,
    '--surface', 'text',
    '--detach',
    '--idle-ms', '300000',
    '--max-time', '30m',
    '--json',
  ]);
  assert.equal(started.error, undefined, started.error?.message);
  assert.equal(started.code, 0, started.stdout ? JSON.stringify(parseObject(started.stdout).error ?? 'start failed') : started.stderr);
  const startResult = parseObject(started.stdout);
  assert.equal(startResult.ok, true);
  assert.equal(startResult.status, 'running');
  assert.equal(startResult.session_id, sessionId);

  const session = readSessionRecord(prepared.manifest, sessionId);
  assert.ok(session !== null && typeof session.pid === 'number' && session.pid > 0);
  const privateConnection = parseObject(readFileSync(session.privateConnectionPath, 'utf8'));
  const url = privateConnection.url;
  const token = privateConnection.token;
  assert.ok(typeof url === 'string' && typeof token === 'string');
  assert.equal(await httpReachable(url), true, 'detached session remains available after parent exit');
  assert.equal(started.stdout.includes(token), false);

  const sent = runCli([
    'input',
    '--manifest', manifestPath,
    '--session-id', sessionId,
    '--text', 'detached-input-probe',
    '--json',
  ]);
  assert.equal(sent.error, undefined, sent.error?.message);
  assert.equal(sent.code, 0, sent.stderr);
  const inputResult = parseObject(sent.stdout);
  assert.equal(inputResult.status, 'sent');
  await waitFor(() => readFileSync(session.transcriptPath, 'utf8').includes('FIXTURE_ECHO:detached-input-probe'), {
    timeoutMs: 5000,
    label: 'detached runtime receives manifest-backed input',
  });

  const stopped = runCli(['stop', '--manifest', manifestPath, '--session-id', sessionId, '--json']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(sent.stdout.includes(token), false);
  const final = readSessionRecord(prepared.manifest!, sessionId);
  assert.ok(final !== null);
  assert.equal(final.status, 'stopped');
  assert.ok(
    (final.exit_code === 0 && (final.exit_signal === undefined || final.exit_signal === 15)) ||
      (final.exit_code === 143 && final.exit_signal === 0),
  );
  assert.ok(final.termination !== undefined);
  assert.equal(final.termination.requested, 'owner');
  assert.equal(final.termination.requested_signal, 15);
  assert.equal(final.termination.forced, false);
  assert.equal(final.termination.observed, true);
  const finalFrames = readFileSync(final.transcriptPath, 'utf8')
    .split(/\r?\n/u)
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { ts?: string; t?: string; code?: number; signal?: number });
  const exits = finalFrames.filter(frame => frame.t === 'exit');
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.code, final.exit_code);
  assert.equal(exits[0]?.signal, final.exit_signal);
  const report = generateReport(manifestPath, {
    steps: [],
    defects: [],
    agent_quality: { rating: 4, rationale: 'detached lifecycle' },
    verdict: 'PASS',
    overall: { summary: 'detached lifecycle' },
  }, { sessionId });
  assert.equal(parseObject(readFileSync(report.jsonPath, 'utf8')).verdict, 'PASS');
});
