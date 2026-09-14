/**
 * CLI tests: argv dispatch (--help / unknown subcommand) and arg
 * validation for bootstrap/start. No real npm link / git / omp runs.
 */

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildDetachedChildArgs, detachLogPath, main, parseAskArgs, parseBootstrapArgs, parseInputArgs, parseMaxTime, parseStartArgs, redactCliCredentials, runAsk, runBootstrap, runInput, runStop, tailLogFile, transcriptOverlap } from '../src/cli.js';
import { assertNoLiveSession, startTestSession } from '../src/server.js';

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

test('cli: startup-failure output redacts live browserUrl credentials in errors and log tails', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'ux-e2e-startup-redaction-'));
  const logPath = detachLogPath(scratchDir);
  mkdirSync(join(scratchDir, '.work-state', 'ux-e2e'), { recursive: true });
  const encodedCode = 'bootstrap/encoded?secret';
  const unencodedCode = 'bootstrap-plain-secret';
  const browserUrl = `http://127.0.0.1:43210/?code=${encodeURIComponent(encodedCode)}`;
  const secondBrowserUrl = `http://127.0.0.1:43210/?ready=1&code=${unencodedCode}`;
  const formCode = 'form-bootstrap-secret';
  const token = 'header-token-secret';
  const authorization = 'authorization-secret';
  const startupFailure = [
    `ux-e2e start: detached OMP TUI was not ready: ${browserUrl}`,
    secondBrowserUrl,
    `code=${formCode}&token=${token}`,
    `"authorization": "Bearer ${authorization}"`,
    `x-ux-token: ${token}`,
    'ordinary source code=must-remain-visible',
    "const token: string = 'ordinary-code-prose';",
  ].join('\n');
  writeFileSync(logPath, startupFailure);
  const cliError = await runMain([browserUrl]);
  assert.equal(cliError.code, 1);
  assert.match(cliError.err, /code=<redacted>/u);
  assert.equal(cliError.err.includes(encodedCode), false);

  const redactedError = redactCliCredentials(`startup failed: ${browserUrl}`);
  const redactedTail = redactCliCredentials(tailLogFile(logPath, 64 * 1024));
  assert.match(redactedError, /code=<redacted>/u);
  assert.match(redactedTail, /<redacted>/u);
  for (const secret of [encodedCode, unencodedCode, formCode, token, authorization]) {
    assert.equal(redactedError.includes(secret), false, `startup error omits ${secret}`);
    assert.equal(redactedTail.includes(secret), false, `startup tail omits ${secret}`);
  }
  assert.match(redactedTail, /const token: string = 'ordinary-code-prose';/u);
  assert.match(redactedTail, /ordinary source code=must-remain-visible/u);
  rmSync(scratchDir, { recursive: true, force: true });
});

test('cli: --help prints the 7 subcommands and exits 0', async () => {
  const { code, out } = await runMain(['--help']);
  assert.equal(code, 0);
  for (const sub of ['bootstrap', 'start', 'stop', 'transcript', 'ask', 'input', 'report']) {
    assert.ok(out.includes(sub), `usage mentions ${sub}`);
  }
});

test('cli: ask --list enumerates a pending host selector checkpoint', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'ux-e2e-cli-ask-selector-'));
  const session = await startTestSession({ cwd: scratchDir, surface: 'text', noPty: true, token: 'selector-test-token' });
  try {
    appendFileSync(session.transcriptPath, JSON.stringify({ ts: '2026-08-02T00:00:00.000Z', t: 'o', d: [
      '╭─ Ask ─────────────────────────╮\r\n',
      '│ workflow: constitution approval checkpoint │\r\n',
      '├──────────────────────────────┤\r\n',
      '│ ❯ ○ approve_continue          │\r\n',
      '│   ○ request_changes           │\r\n',
      '│   ○ approve_stop              │\r\n',
      '├──────────────────────────────┤\r\n',
      '│ Enter select · ↑/↓ move · Esc cancel │\r\n',
      '╰────────────────────────────────────╯\r\n',
    ].join('') }) + '\n');
    const listed = await runMain(['ask', scratchDir, '--list', '--timeout', '1000']);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /selected checkpoint/u);
    assert.match(listed.out, /approve_continue/u);
    assert.doesNotMatch(listed.out, /no pending/u);
  } finally {
    await session.close();
    rmSync(scratchDir, { recursive: true, force: true });
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
test('cli: report --steps rejects unknown fields, unsafe text, duplicate ids, and unknown severity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-report-input-'));
  const inputPath = join(dir, 'steps.json');
  try {
    const cases = [
      { extra: true },
      {
        steps: [{
          id: 'S1',
          name: 'step',
          order: 1,
          ratings: {},
          defects: [],
          screenshots: [],
          unexpected: true,
        }],
      },
      {
        steps: [{
          id: 'same',
          name: 'step',
          order: 1,
          ratings: {},
          defects: [],
          screenshots: [],
        }],
        defects: [{
          id: 'same',
          severity: 'MEDIUM',
          dimension: 'layout',
          title: 'bad',
          step: 'same',
          evidence: [],
        }],
      },
      {
        steps: [],
        defects: [{
          severity: 'UNKNOWN',
          dimension: 'layout',
          title: 'bad',
          step: 'S1',
          evidence: [],
        }],
      },
      {
        steps: [{
          name: '\u001b[31munsafe',
          order: 1,
          ratings: {},
          defects: [],
          screenshots: [],
        }],
      },
    ];
    for (const value of cases) {
      writeFileSync(inputPath, `${JSON.stringify(value)}\n`);
      const result = await runMain(['report', dir, '--steps', inputPath]);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes('invalid --steps JSON'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('cli: bootstrap creates a missing nested workdir through descriptor-safe components', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ux-e2e-bootstrap-parent-'));
  const workdir = join(parent, 'missing', 'components');
  try {
    const scratch = runBootstrap({
      slug: 'nested',
      branch: 'feat/nested',
      workdir,
      omp: undefined,
      monorepo: resolve(process.cwd(), '../..'),
      force: false,
    });
    assert.equal(scratch, join(workdir, 'omp-ux-e2e-nested'));
    assert.equal(existsSync(join(scratch, 'package.json')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test('cli: named omp-ux-e2e suite roots nest slugs while generic workdirs keep legacy prefixes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ux-e2e-bootstrap-suite-'));
  const suiteRoot = join(parent, 'omp-ux-e2e-readable-spec-workflow');
  const legacyRoot = join(parent, 'generic-workdir');
  mkdirSync(suiteRoot);
  mkdirSync(legacyRoot);
  try {
    const nested = runBootstrap({
      slug: 's01-native',
      branch: 'feat/s01-native',
      workdir: suiteRoot,
      omp: undefined,
      monorepo: resolve(process.cwd(), '../..'),
      force: false,
    });
    assert.equal(nested, join(suiteRoot, 's01-native'));
    assert.equal(existsSync(join(nested, 'package.json')), true);

    const legacy = runBootstrap({
      slug: 'legacy',
      branch: 'feat/legacy',
      workdir: legacyRoot,
      omp: undefined,
      monorepo: resolve(process.cwd(), '../..'),
      force: false,
    });
    assert.equal(legacy, join(legacyRoot, 'omp-ux-e2e-legacy'));
    assert.equal(existsSync(join(legacy, 'package.json')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('cli: named suite roots reject symlink and existing-directory collisions', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ux-e2e-bootstrap-collision-'));
  const suiteRoot = join(parent, 'omp-ux-e2e-readable-spec-workflow');
  const victim = join(parent, 'victim');
  mkdirSync(suiteRoot);
  mkdirSync(victim);
  writeFileSync(join(victim, 'sentinel.txt'), 'keep\n');
  try {
    symlinkSync(victim, join(suiteRoot, 'symlink-target'), 'dir');
    assert.throws(
      () => runBootstrap({
        slug: 'symlink-target',
        branch: 'feat/symlink-target',
        workdir: suiteRoot,
        omp: undefined,
        monorepo: resolve(process.cwd(), '../..'),
        force: true,
      }),
      /existing scratch path is not a real directory/u,
    );
    assert.equal(existsSync(join(victim, 'sentinel.txt')), true);

    mkdirSync(join(suiteRoot, 'existing-target'));
    assert.throws(
      () => runBootstrap({
        slug: 'existing-target',
        branch: 'feat/existing-target',
        workdir: suiteRoot,
        omp: undefined,
        monorepo: resolve(process.cwd(), '../..'),
        force: false,
      }),
      /already exists/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test('cli: detached start forwards force, exact sub-minute max-time, and task file path', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'ux-e2e-detached-args-'));
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const taskPath = join(scratchDir, 'task.md');
  const liveOwnerPid = process.ppid;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(taskPath, 'do the task\n');
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    schema_version: 2,
    status: 'running',
    session_id: 'existing-session',
    server_pid: liveOwnerPid,
    server_start_identity: 'test-server-start',
    server_start_nonce: 'start',
    pid: liveOwnerPid,
    pty_start_identity: 'test-pty-start',
    url: 'http://127.0.0.1:1234/?token=redacted',
    token: 'redacted',
    control_nonce: 'control',
    omp_version: 'omp-test',
    spawn_error: null,
    started_at: new Date().toISOString(),
    browser_url: 'http://127.0.0.1:1234/',
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
    shutdown_error: null,
  }));
  try {
    assert.doesNotThrow(() => assertNoLiveSession(scratchDir, true));
    const args = parseStartArgs([
      scratchDir,
      '--detach',
      '--force',
      '--task', taskPath,
      '--max-time', '7s',
      '--idle-ms', '3000',
    ]);
    const startupNonce = 'detached-start-test-nonce';
    const childArgs = buildDetachedChildArgs(args, '/tmp/cli.js', startupNonce);
    assert.ok(childArgs.includes('--force'), 'detached child receives --force');
    const maxTime = childArgs.indexOf('--max-time');
    assert.ok(maxTime >= 0);
    assert.equal(childArgs[maxTime + 1], '7s', 'sub-minute max-time stays exact');
    assert.equal(childArgs[childArgs.indexOf('--task') + 1], taskPath, 'task file is absolute for detached cwd');
    assert.ok(childArgs.includes(`--startup-nonce=${startupNonce}`), 'detached child receives unique startup nonce as an equals-form option');
    const dashNonceArgs = parseStartArgs([scratchDir, '--startup-nonce=-XYZ']);
    assert.equal(dashNonceArgs.startupNonce, '-XYZ', 'equals-form startup nonce survives parseArgs');
    const dashChildArgs = buildDetachedChildArgs(dashNonceArgs, '/tmp/cli.js', '-XYZ');
    assert.ok(dashChildArgs.includes('--startup-nonce=-XYZ'), 'dash-prefixed startup nonce remains an option value');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('cli: transcript overlap stays linear for an 8 MiB near-overlap', () => {
  const size = 8 * 1024 * 1024;
  const previous = Buffer.alloc(size, 0x62);
  const current = Buffer.alloc(size, 0x61);
  current[size - 1] = 0x62;
  const started = Date.now();
  assert.equal(transcriptOverlap(previous, current), 0);
  assert.ok(Date.now() - started < 5000, 'worst-case overlap completes within the bound');
});

test('cli: transcript overlap handles equality, full suffix-prefix, and no overlap', () => {
  assert.equal(transcriptOverlap(Buffer.from('abc'), Buffer.from('abc')), 3);
  assert.equal(transcriptOverlap(Buffer.from('xxabc'), Buffer.from('abc')), 3);
  assert.equal(transcriptOverlap(Buffer.from('abc'), Buffer.from('xyz')), 0);
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

test('cli: input sends text plus Enter keypress without ask state', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'ux-e2e-input-'));
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    status: 'running',
    schema_version: 2,
    pid: process.pid,
    pty_start_identity: 'test-pty-start',
    server_pid: process.pid,
    server_start_identity: 'test-server-start',
    started_at: new Date().toISOString(),
    omp_version: 'omp-test',
    spawn_error: null,
    session_id: 'test-session',
    token: 'sekret',
    control_nonce: 'control',
    server_start_nonce: 'start',
    url: 'http://127.0.0.1:1234/?token=sekret',
    browser_url: 'http://127.0.0.1:1234/',
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
    shutdown_error: null,
  }));
  const frames: string[] = [];
  const driver = {
    open: async () => undefined,
    type: async (text: string) => frames.push(text),
    pressEnter: async () => frames.push('\r'),
    close: async () => undefined,
  };

  const code = await runInput(
    { scratchDir, text: '/do-work implement it' },
    () => driver,
  );

  assert.equal(code, 0);
  assert.deepEqual(frames, ['/do-work implement it', '\r']);
  rmSync(scratchDir, { recursive: true });
});

test('cli: stop refuses an unproven persisted shutdown even when no owner is live', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'ux-e2e-stop-stale-'));
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    schema_version: 2,
    status: 'shutdown_failed',
    pid: null,
    pty_start_identity: null,
    server_pid: process.pid,
    server_start_identity: 'test-server-start',
    started_at: new Date().toISOString(),
    session_id: 'test-session',
    token: 'sekret',
    control_nonce: 'control',
    server_start_nonce: 'start',
    omp_version: 'omp-test',
    spawn_error: null,
    url: 'http://127.0.0.1:54321/?token=sekret',
    browser_url: 'http://127.0.0.1:54321/',
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
    shutdown_error: 'ux-e2e: PTY graceful exit could not be proven',
  }));

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    const code = await runStop({ scratchDir });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /shutdown-unproven/u);
  } finally {
    console.error = originalError;
    rmSync(scratchDir, { recursive: true });
  }
});
test('cli: stop accepts absent metadata and a proven stopped lifecycle', async () => {
  const absentScratch = mkdtempSync(join(tmpdir(), 'ux-e2e-stop-absent-'));
  const stoppedScratch = mkdtempSync(join(tmpdir(), 'ux-e2e-stop-stopped-'));
  const stateDir = join(stoppedScratch, '.work-state', 'ux-e2e');
  const finishedAt = new Date().toISOString();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify({
    schema_version: 2,
    status: 'stopped',
    pid: null,
    pty_start_identity: null,
    server_pid: process.pid,
    server_start_identity: 'test-server-start',
    started_at: finishedAt,
    session_id: 'test-session',
    token: 'sekret',
    control_nonce: 'control',
    server_start_nonce: 'start',
    omp_version: 'omp-test',
    spawn_error: null,
    url: 'http://127.0.0.1:54321/?token=sekret',
    browser_url: 'http://127.0.0.1:54321/',
    pty_exit_observed: true,
    shutdown_completed_at: finishedAt,
    stopped_at: finishedAt,
    finished_at: finishedAt,
    shutdown_error: null,
  }));
  try {
    assert.equal(await runStop({ scratchDir: absentScratch }), 0);
    assert.equal(await runStop({ scratchDir: stoppedScratch }), 0);
  } finally {
    rmSync(absentScratch, { recursive: true, force: true });
    rmSync(stoppedScratch, { recursive: true, force: true });
  }
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

