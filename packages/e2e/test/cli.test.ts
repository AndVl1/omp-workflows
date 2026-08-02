/**
 * CLI tests: argv dispatch (--help / unknown subcommand) and arg
 * validation for bootstrap/start. No real npm link / git / omp runs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { detachLogPath, main, parseBootstrapArgs, parseInputArgs, parseMaxTime, parseStartArgs, runInput, tailLogFile } from '../src/cli.js';

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

test('cli: --help prints the 7 subcommands and exits 0', async () => {
  const { code, out } = await runMain(['--help']);
  assert.equal(code, 0);
  for (const sub of ['bootstrap', 'start', 'stop', 'transcript', 'ask', 'input', 'report']) {
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

test('cli: input parses arbitrary text and validates required positionals', () => {
  assert.throws(() => parseInputArgs([]), /missing <scratch-dir>/u);
  assert.throws(() => parseInputArgs(['/tmp/scratch']), /missing <text>/u);
  assert.deepEqual(parseInputArgs(['/tmp/scratch', '/do-work implement it']), {
    scratchDir: '/tmp/scratch',
    text: '/do-work implement it',
  });
});

test('cli: input sends text plus newline in one frame without ask state', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'ux-e2e-input-'));
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ url: 'http://127.0.0.1:1234/?token=sekret' }));
  const frames: string[] = [];
  const driver = {
    open: async () => undefined,
    type: async (text: string) => frames.push(text),
    submit: async (text: string) => frames.push(text + '\n'),
    close: async () => undefined,
  };

  const code = await runInput(
    { scratchDir, text: '/do-work implement it' },
    () => driver,
  );

  assert.equal(code, 0);
  assert.deepEqual(frames, ['/do-work implement it\n']);
  rmSync(scratchDir, { recursive: true });
});

test('cli: start --scenario normalizes to absolute path against process.cwd() (FD-R1)', () => {
  // Fix A: a relative --scenario must be resolved against the PARENT
  // process cwd at parse time, not against the scratch dir. The
  // detached child re-runs parseStartArgs with cwd = scratchDir, so
  // without normalization the relative path resolves to the wrong
  // root and loadScenario() fails. Absolute paths must pass through
  // unchanged.
  const relArgs = parseStartArgs(['/tmp/scratch', '--scenario', 'packages/e2e/scenarios/full-feature.json']);
  assert.ok(
    relArgs.scenario !== undefined && relArgs.scenario.endsWith('packages/e2e/scenarios/full-feature.json'),
    `relative --scenario must be absolute; got ${String(relArgs.scenario)}`,
  );
  assert.ok(
    relArgs.scenario === `${process.cwd()}/packages/e2e/scenarios/full-feature.json` ||
      relArgs.scenario === `${process.cwd()}/packages/e2e/scenarios/full-feature.json`.replace(/\/+/gu, '/'),
    'relative --scenario resolves against process.cwd()',
  );
  // Absolute pass-through: the input is already absolute, no change.
  const absPath = '/tmp/abs/full-feature.json';
  const absArgs = parseStartArgs(['/tmp/scratch', '--scenario', absPath]);
  assert.equal(absArgs.scenario, absPath);
  // No --scenario → undefined.
  const noArgs = parseStartArgs(['/tmp/scratch']);
  assert.equal(noArgs.scenario, undefined);
});

test('cli: parseMaxTime units', () => {
  assert.equal(parseMaxTime('30m'), 1800);
  assert.equal(parseMaxTime('1h'), 3600);
  assert.equal(parseMaxTime('90s'), 90);
  assert.equal(parseMaxTime('60'), 60);
  assert.throws(() => parseMaxTime('0m'), /positive/u);
});

test('cli: detachLogPath + tailLogFile surface child output (D2)', () => {
  // The contract: on `--detach` timeout the parent reads the tail of
  // `<scratch>/.work-state/ux-e2e/detach.log` and prints it to stderr.
  // We exercise the pure helpers — the live spawn path is covered by
  // manual QA (an actual failed detach run).
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-detach-'));
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const logPath = detachLogPath(dir);
  // Helper places the log under .work-state/ux-e2e/, NOT the scratch root.
  assert.ok(logPath.endsWith('.work-state/ux-e2e/detach.log'), `log path: ${logPath}`);
  // tailLogFile on a missing path returns '' (so the parent prints the
  // 'no output captured' message instead of a stack trace).
  assert.equal(tailLogFile(logPath, 1024), '');
  // tailLogFile on a small file returns the whole file.
  const smallBody = 'a\nb\nc\n';
  writeFileSync(logPath, smallBody);
  assert.equal(tailLogFile(logPath, 1024), smallBody);
  // tailLogFile on a file larger than maxBytes returns the LAST maxBytes.
  const bigBody = 'x'.repeat(100) + 'TAIL_MARKER\n';
  writeFileSync(logPath, bigBody);
  const tail = tailLogFile(logPath, 16);
  assert.ok(tail.endsWith('TAIL_MARKER\n'), 'tail contains the most recent bytes');
  assert.ok(tail.length < bigBody.length, 'tail is truncated to maxBytes');
  rmSync(dir, { recursive: true });
});

