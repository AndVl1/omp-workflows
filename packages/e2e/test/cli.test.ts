import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main, parseInputArgs, parseMaxTime, parsePrepareArgs, parseStartArgs } from '../src/cli.js';

async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test('cli help advertises manifest-backed lifecycle commands', async () => {
  const { code, out } = await runMain(['--help']);
  assert.equal(code, 0);
  for (const command of ['prepare', 'doctor', 'start', 'stop', 'input', 'report', 'cleanup', 'verify']) {
    assert.match(out, new RegExp(`\\b${command}\\b`, 'u'));
  }
});

test('cli JSON mode emits only a machine-readable failure object', async () => {
  const { code, out, err } = await runMain(['doctor', '--manifest', '/path/that/does/not/exist.json', '--json']);
  assert.equal(code, 1);
  assert.equal(err, '');
  const result = JSON.parse(out) as { ok: boolean; status: string; error?: { code: string } };
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.ok(result.error?.code);
});

test('cli parses manifest start and input options and validates limits', () => {
  const start = parseStartArgs([
    '--manifest', '/tmp/run/manifest.json',
    '--session-id', 'session-2',
    '--surface', 'text',
    '--cols', '120',
    '--max-time', '1h',
    '--idle-ms', '5000',
    '--detach',
  ]);
  assert.equal(start.manifestPath, '/tmp/run/manifest.json');
  assert.equal(start.sessionId, 'session-2');
  assert.equal(start.surface, 'text');
  assert.equal(start.cols, 120);
  assert.equal(start.maxTimeSec, 3600);
  assert.equal(start.idleMs, 5000);
  assert.equal(start.detach, true);

  assert.deepEqual(parseInputArgs(['--manifest', '/tmp/run/manifest.json', '--session-id', 'session-2', '/do-work implement it']), {
    manifestPath: '/tmp/run/manifest.json',
    sessionId: 'session-2',
    text: '/do-work implement it',
    json: false,
  });
  assert.throws(() => parsePrepareArgs([]), /missing --config/u);
  assert.throws(() => parseStartArgs(['--manifest', '/tmp/run/manifest.json', '--cols', '-5']), /--cols/u);
  assert.throws(() => parseStartArgs(['--manifest', '/tmp/run/manifest.json', '--max-time', 'nope']), /--max-time/u);
  assert.equal(parseMaxTime('30m'), 1800);
  assert.equal(parseMaxTime('90s'), 90);
});
