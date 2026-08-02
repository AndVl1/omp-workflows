/**
 * CLI tests: argv dispatch (--help / unknown subcommand) and arg
 * validation for bootstrap/start. No real npm link / git / omp runs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { main, parseBootstrapArgs, parseMaxTime, parseStartArgs } from '../src/cli.js';

/** Run main() with console/stdout captured; returns { code, out, err }. */
async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);

  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(' '));
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
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
}

test('cli: --help prints the 6 subcommands and exits 0', async () => {
  const { code, out } = await runMain(['--help']);
  assert.equal(code, 0);
  for (const sub of ['bootstrap', 'start', 'stop', 'transcript', 'ask', 'report']) {
    assert.ok(out.includes(sub), `usage mentions ${sub}`);
  }
});

test('cli: no args prints usage and exits 0', async () => {
  const { code, out } = await runMain([]);
  assert.equal(code, 0);
  assert.ok(out.includes('Subcommands'));
});

test('cli: unknown subcommand exits 1 with an error', async () => {
  const { code, err } = await runMain(['frobnicate']);
  assert.equal(code, 1);
  assert.ok(err.includes('unknown subcommand'));
});

test('cli: bootstrap validates required args', async () => {
  assert.throws(() => parseBootstrapArgs([]), /missing <slug>/u);
  assert.throws(() => parseBootstrapArgs(['my-slug']), /missing <branch>/u);
  assert.throws(() => parseBootstrapArgs(['Bad_Slug', 'feat/x']), /invalid slug/u);

  const args = parseBootstrapArgs(['my-feature', 'feat/ux-e2e', '--workdir', '/tmp/x', '--force']);
  assert.equal(args.slug, 'my-feature');
  assert.equal(args.branch, 'feat/ux-e2e');
  assert.equal(args.workdir, '/tmp/x');
  assert.equal(args.force, true);
});

test('cli: bootstrap missing args exits 1 via main', async () => {
  const { code, err } = await runMain(['bootstrap']);
  assert.equal(code, 1);
  assert.ok(err.includes('missing <slug>'));
});

test('cli: start validates scratch-dir and options', () => {
  assert.throws(() => parseStartArgs([]), /missing <scratch-dir>/u);

  const args = parseStartArgs([
    '/tmp/scratch',
    '--surface', 'text',
    '--cols', '120',
    '--max-time', '1h',
    '--idle-ms', '5000',
    '--detach',
  ]);
  assert.equal(args.scratchDir, '/tmp/scratch');
  assert.equal(args.surface, 'text');
  assert.equal(args.cols, 120);
  assert.equal(args.maxTimeSec, 3600);
  assert.equal(args.idleMs, 5000);
  assert.equal(args.detach, true);

  assert.throws(() => parseStartArgs(['/tmp/s', '--cols', '-5']), /--cols/u);
  assert.throws(() => parseStartArgs(['/tmp/s', '--max-time', 'nope']), /--max-time/u);
});

test('cli: start missing scratch-dir exits 1 via main', async () => {
  const { code, err } = await runMain(['start']);
  assert.equal(code, 1);
  assert.ok(err.includes('missing <scratch-dir>'));
});

test('cli: parseMaxTime units', () => {
  assert.equal(parseMaxTime('30m'), 1800);
  assert.equal(parseMaxTime('1h'), 3600);
  assert.equal(parseMaxTime('90s'), 90);
  assert.equal(parseMaxTime('60'), 60);
  assert.throws(() => parseMaxTime('0m'), /positive/u);
});
