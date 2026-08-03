#!/usr/bin/env node
/**
 * ux-e2e — interactive UX E2E test framework for omp + omp-workflows.
 *
 * Subcommands:
 *   bootstrap <slug> <branch>    create a scratch omp project wired to this monorepo
 *   start <scratch-dir>          start an omp PTY test session and print the terminal URL
 *   stop <scratch-dir>           stop a running session (SIGTERM -> SIGKILL its tree)
 *   transcript <scratch-dir>     render the session transcript
 *   ask <scratch-dir> [<answer>] list or answer a pending [ask_user] prompt
 *   input <scratch-dir> <text>   send arbitrary input followed by Enter
 *   report <scratch-dir>         generate the ux-e2e report (JSON + markdown)
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  assertNoLiveSession,
  killProcessTree,
  pidIsLive,
  readSessionInfo,
  startTestSession,
  type TestSession,
} from './server.js';
import { AskStateTracker, TranscriptLog, waitFor, WsDriver } from './driver.js';
import { generateReport, type ReportInput, type Verdict } from './report.js';
import { loadScenario, type ScenarioDefinition } from './scenario.js';

import { deferred } from './util.js';
const USAGE = `ux-e2e — interactive UX E2E test framework for omp + omp-workflows

Usage: ux-e2e <subcommand> [options]

Subcommands:
  bootstrap <slug> <branch>     create a scratch omp project wired to this monorepo
  start <scratch-dir>           start an omp PTY test session and print the terminal URL
  stop <scratch-dir>            stop a running session (SIGTERM -> SIGKILL its tree)
  transcript <scratch-dir>      render the session transcript
  ask <scratch-dir> [<answer>]  list or answer a pending [ask_user] prompt
  input <scratch-dir> <text>    send arbitrary input followed by Enter
  report <scratch-dir>          generate the ux-e2e report (JSON + markdown)

Run 'ux-e2e <subcommand> --help' for subcommand options.`;

function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(USAGE + '\n');
}

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

function stateDirOf(scratchDir: string): string {
  return join(scratchDir, '.work-state', 'ux-e2e');
}

interface SessionJson {
  readonly url?: unknown;
  readonly token?: unknown;
  readonly wsPath?: unknown;
  readonly started_at?: unknown;
  readonly pid?: unknown;
}

function readSessionJson(scratchDir: string): SessionJson {
  const p = join(stateDirOf(scratchDir), 'session.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SessionJson;
  } catch {
    return {};
  }
}

/** Monorepo root: default = the repo that ships this package. */
function defaultMonorepoRoot(): string {
  // dist/cli.js -> packages/e2e/dist -> packages/e2e -> packages -> root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function parseMaxTime(value: string): number {
  const m = /^(\d+)([smh])?$/u.exec(value.trim());
  if (m === null) throw new Error(`ux-e2e: cannot parse --max-time "${value}" (expected e.g. 30m, 1800s, 1h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const seconds = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  if (seconds <= 0) throw new Error('ux-e2e: --max-time must be positive');
  return seconds;
}

interface CliParsedArgs {
  readonly values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  readonly positionals: string[];
}

function parseArgsOrThrow(argv: string[], options: ParseArgsConfig['options']): CliParsedArgs {
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { values: parsed.values, positionals: parsed.positionals };
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

export interface BootstrapArgs {
  readonly slug: string;
  readonly branch: string;
  readonly workdir: string;
  readonly omp: string | undefined;
  readonly monorepo: string | undefined;
  readonly force: boolean;
}

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  const { positionals, values } = parseArgsOrThrow(argv, {
    workdir: { type: 'string' },
    omp: { type: 'string' },
    monorepo: { type: 'string' },
    force: { type: 'boolean', default: false },
  });
  const slug = positionals[0];
  const branch = positionals[1];
  if (slug === undefined) throw new Error('ux-e2e bootstrap: missing <slug> argument');
  if (branch === undefined) throw new Error('ux-e2e bootstrap: missing <branch> argument');
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(slug)) {
    throw new Error(`ux-e2e bootstrap: invalid slug "${slug}" (lowercase alphanumerics and dashes only)`);
  }
  return {
    slug,
    branch,
    workdir: typeof values.workdir === 'string' ? resolve(values.workdir) : '/tmp',
    omp: typeof values.omp === 'string' ? values.omp : undefined,
    monorepo: typeof values.monorepo === 'string' ? resolve(values.monorepo) : undefined,
    force: values.force === true,
  };
}

/** Materialize the scratch project. Returns the scratch dir path. */
export function runBootstrap(args: BootstrapArgs): string {
  const monorepo = args.monorepo ?? defaultMonorepoRoot();
  const scratchDir = join(args.workdir, `omp-ux-e2e-${args.slug}`);
  if (existsSync(scratchDir)) {
    if (!args.force) {
      throw new Error(`ux-e2e bootstrap: ${scratchDir} already exists — pass --force to re-create`);
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }
  mkdirSync(scratchDir, { recursive: true });

  execSync('git init', { cwd: scratchDir, stdio: 'inherit' });
  execSync(`git checkout -b ${shellQuote(args.branch)}`, { cwd: scratchDir, stdio: 'inherit' });

  writeFileSync(
    join(scratchDir, 'package.json'),
    JSON.stringify({ name: `omp-ux-e2e-${args.slug}`, version: '0.0.0', private: true, type: 'module' }, null, 2) + '\n',
  );

  const corePkg = join(monorepo, 'packages', 'core');
  const fullstackPkg = join(monorepo, 'packages', 'fullstack');
  if (!existsSync(join(corePkg, 'package.json')) || !existsSync(join(fullstackPkg, 'package.json'))) {
    throw new Error(`ux-e2e bootstrap: monorepo layout not found under ${monorepo} (expected packages/core and packages/fullstack)`);
  }
  // npm link, NOT file: — file: deps fail to resolve the unpublished
  // peer @oh-my-pi/pi-coding-agent with ETARGET.
  execSync(`npm link ${shellQuote(corePkg)} ${shellQuote(fullstackPkg)}`, { cwd: scratchDir, stdio: 'inherit' });

  // omp overlay: no ask timeouts, progress UI, autolearn off, no setup wizard.
  const ompDir = join(scratchDir, '.omp');
  mkdirSync(ompDir, { recursive: true });
  writeFileSync(
    join(ompDir, 'ux-e2e-overlay.json'),
    JSON.stringify(
      { ask: { timeout: 0 }, terminal: { showProgress: true }, autolearn: { enabled: false }, startup: { setupWizard: false } },
      null,
      2,
    ) + '\n',
  );

  const teamConfig = join(monorepo, '.omp', 'team.config.json');
  if (existsSync(teamConfig)) {
    cpSync(teamConfig, join(ompDir, 'team.config.json'));
  }

  // Materialize custom-TS commands into <scratch>/.omp/commands/.
  const copyScript = join(fullstackPkg, 'scripts', 'copy-commands.mjs');
  if (existsSync(copyScript)) {
    execSync(`${process.execPath} ${shellQuote(copyScript)} ${shellQuote(scratchDir)}`, { stdio: 'inherit' });
  }

  console.log(`ux-e2e bootstrap: scratch project ready at ${scratchDir}`);
  return scratchDir;
}

/** Minimal POSIX single-quote shell escaping (no single quotes in branch names). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

export interface StartArgs {
  readonly scratchDir: string;
  readonly surface: 'web' | 'text';
  readonly port: number;
  readonly cols: number;
  readonly rows: number;
  readonly detach: boolean;
  readonly force: boolean;
  readonly scenario: string | undefined;
  readonly task: string | undefined;
  readonly maxTimeSec: number;
  readonly idleMs: number;
}

export function parseStartArgs(argv: string[]): StartArgs {
  const { positionals, values } = parseArgsOrThrow(argv, {
    surface: { type: 'string' },
    port: { type: 'string' },
    cols: { type: 'string' },
    rows: { type: 'string' },
    detach: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    scenario: { type: 'string' },
    task: { type: 'string' },
    'max-time': { type: 'string' },
    'idle-ms': { type: 'string' },
  });
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e start: missing <scratch-dir> argument');
  const surface = values.surface === 'text' ? 'text' : 'web';
  return {
    scratchDir: resolve(scratchDir),
    surface,
    port: typeof values.port === 'string' ? parsePositiveInt(values.port, '--port') : 0,
    cols: typeof values.cols === 'string' ? parsePositiveInt(values.cols, '--cols') : 100,
    rows: typeof values.rows === 'string' ? parsePositiveInt(values.rows, '--rows') : 30,
    detach: values.detach === true,
    force: values.force === true,
    // Normalize --scenario against the *parent* cwd at parse time so
    // --detach works (the detached child runs with cwd = scratchDir and
    // would otherwise resolve a relative --scenario against the wrong
    // root). Already-absolute paths pass through unchanged.
    scenario:
      typeof values.scenario === 'string' ? resolve(values.scenario) : undefined,
    task: typeof values.task === 'string' ? values.task : undefined,
    maxTimeSec: typeof values['max-time'] === 'string' ? parseMaxTime(values['max-time']) : 1800,
    idleMs: typeof values['idle-ms'] === 'string' ? parsePositiveInt(values['idle-ms'], '--idle-ms') : 1_200_000,
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`ux-e2e start: ${flag} must be a non-negative integer`);
  return n;
}

function resolveTaskPrompt(taskArg: string | undefined, scenario: ScenarioDefinition | null): string | null {
  if (taskArg === undefined) {
    return scenario !== null ? scenario.task : null;
  }
  if (existsSync(taskArg)) {
    return readFileSync(taskArg, 'utf8');
  }
  return taskArg;
}

async function runStartForeground(args: StartArgs): Promise<number> {
  assertNoLiveSession(args.scratchDir, args.force);

  const scenario = args.scenario !== undefined ? loadScenario(args.scenario) : null;
  const taskPrompt = resolveTaskPrompt(args.task, scenario);
  const session = await startTestSession({
    cwd: args.scratchDir,
    surface: args.surface,
    port: args.port,
    cols: args.cols,
    rows: args.rows,
    idleMs: args.idleMs,
    maxTimeSec: args.maxTimeSec,
    taskPrompt,
    scenario: scenario !== null ? { id: scenario.id, title: scenario.title } : null,
  });
  console.log(`ux-e2e: session started — url: ${session.url}`);
  console.log(`ux-e2e: transcript: ${session.transcriptPath}`);
  return await driveForeground(session, scenario);
}

/** Foreground loop: print [ask_user] hints, exit when the PTY exits. */
async function driveForeground(session: TestSession, scenario: ScenarioDefinition | null): Promise<number> {
  const pollMs = scenario?.timing.checkpointPollMs ?? 2000;
  const log = new TranscriptLog(session.transcriptPath);
  const seenTitles = new Set<string>();
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void session.close().then(() => {
      console.log('ux-e2e: session stopped');
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  for (;;) {
    log.refresh();
    for (const block of log.askBlocks()) {
      if (seenTitles.has(`${block.index}:${block.title}`)) continue;
      seenTitles.add(`${block.index}:${block.title}`);
      console.log(`ux-e2e [ask_user #${block.index}]: ${block.title}`);
      for (const opt of block.options) console.log(`  ${opt}`);
      console.log(`ux-e2e: answer with: ux-e2e ask ${shellQuote(process.cwd())} <answer>`);
    }
    const frames = log.frames;
    const last = frames[frames.length - 1];
    if (last !== undefined && last.t === 'exit') {
      console.log(`ux-e2e: omp exited (code ${String(last.code)}); closing session`);
      await session.close();
      process.exit(0);
    }
    const { promise: ticked, resolve: tick } = deferred<void>();
    await ticked;
  }
}

/** How many bytes of the detached child's log to dump on a startup timeout. */
export const DETACH_LOG_TAIL_BYTES = 8 * 1024;

/** Path of the per-scratch detach log file. */
export function detachLogPath(scratchDir: string): string {
  return join(stateDirOf(scratchDir), 'detach.log');
}

/**
 * Read the last `maxBytes` of a file. Used to surface the real failure
 * mode of a detached child whose startup never produced a live session.
 */
export function tailLogFile(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '';
  const body = readFileSync(path, 'utf8');
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return body;
  return body.slice(-maxBytes);
}

/** --detach: run the session in a detached child, exit with the URL.
 *
 * The detached child writes its stdout/stderr DIRECTLY into `logPath` via
 * an inherited file descriptor. There is NO pipe between parent and child,
 * so when the parent (this command) exits, the child cannot crash with
 * EPIPE — the kernel-level file write path is independent of any process
 * lifetime. Previous versions used `stdio: ['ignore','pipe','pipe']` plus
 * `child.stdout.pipe(logStream)`, which left the parent holding the
 * pipe/logStream open (event loop) AND, more fatally, killed the child
 * ~3-4s after the parent's exit: the parent's stdio teardown closed the
 * pipe ends the child was still writing to, so the next `console.log()`
 * in the child triggered an unhandled 'error' on its stdout stream and
 * the process exited without a frame.
 *
 * The fd is opened in append mode so a `--detach` rerun keeps prior log
 * history. We write a header line via `writeSync` BEFORE spawning, then
 * close the parent's fd copy after spawn — the child inherited its own
 * fd during exec and continues to write into the same file.
 */
async function runStartDetached(args: StartArgs): Promise<number> {
  assertNoLiveSession(args.scratchDir, args.force);

  const stateDir = stateDirOf(args.scratchDir);
  mkdirSync(stateDir, { recursive: true });
  const logPath = detachLogPath(args.scratchDir);
  // Append so a subsequent --detach run after a crash keeps the prior
  // log entries (operators triage by timeline).
  const fd = openSync(logPath, 'a');
  try {
    writeSync(fd, `\n--- ux-e2e detached start @ ${new Date().toISOString()} ---\n`);
  } finally {
    // The header line is the only thing the parent itself writes; the
    // child writes everything else via its inherited fd copy. Closing
    // the parent's fd here means the parent holds no FDs into the log
    // file, so its event loop drains and `main()` returns as soon as
    // the session URL is known.
    closeSync(fd);
  }

  const cliPath = fileURLToPath(import.meta.url);
  const childArgs = [
    cliPath,
    'start',
    args.scratchDir,
    '--surface', args.surface,
    '--port', String(args.port),
    '--cols', String(args.cols),
    '--rows', String(args.rows),
  ];
  if (args.scenario !== undefined) childArgs.push('--scenario', args.scenario);
  if (args.task !== undefined) childArgs.push('--task', args.task);
  childArgs.push('--max-time', `${Math.round(args.maxTimeSec / 60)}m`, '--idle-ms', String(args.idleMs));

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    // fd is closed; re-open for the child so it can write straight to
    // the file. Both stdout and stderr share the same fd (the OS
    // atomically interleaves writes — fine for a log file; stdout/stderr
    // distinction is not preserved, but that's irrelevant for triage).
    stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
    cwd: args.scratchDir,
  });
  child.unref();

  // Wait for the child's session.json to appear with a live pid.
  // Cold starts (CI runners, slow disks) can exceed 15 s; keep a generous
  // deadline so the detached child has time to boot omp and write session.json.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const info = readSessionInfo(args.scratchDir);
    if (info !== null && pidIsLive(info.pid)) {
      const sessionJson = readSessionJson(args.scratchDir);
      console.log(`ux-e2e: detached session started (pid ${String(info.pid)})`);
      console.log(`ux-e2e: url: ${typeof sessionJson.url === 'string' ? sessionJson.url : 'unknown'}`);
      return 0;
    }
    if (Date.now() >= deadline) {
      console.error('ux-e2e start: timed out waiting for the detached session to start');
      const tail = tailLogFile(logPath, DETACH_LOG_TAIL_BYTES);
      if (tail.length > 0) {
        console.error(`ux-e2e start: last ${DETACH_LOG_TAIL_BYTES} bytes of ${logPath}:`);
        for (const line of tail.split('\n')) {
          console.error(`  ${line}`);
        }
      } else {
        console.error(`ux-e2e start: no output captured in ${logPath}; child may have failed before writing.`);
      }
      return 1;
    }
    const { promise: ticked, resolve: tick } = deferred<void>();
    setTimeout(tick, 250);
    await ticked;
  }
}

/* ------------------------------------------------------------------ */
/* stop                                                                */
/* ------------------------------------------------------------------ */

export interface StopArgs {
  readonly scratchDir: string;
}

export function parseStopArgs(argv: string[]): StopArgs {
  const { positionals } = parseArgsOrThrow(argv, {});
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e stop: missing <scratch-dir> argument');
  return { scratchDir: resolve(scratchDir) };
}

/**
 * Return the command line for a live process. `ps` is the process inspection
 * primitive available on supported POSIX hosts (including macOS, where
 * `/proc` is not present).
 */
function processCommandLine(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
  const command = result.stdout.trim();
  return command.length > 0 ? command : null;
}

export async function runStop(args: StopArgs): Promise<number> {
  const info = readSessionInfo(args.scratchDir);
  if (info === null) {
    console.log('ux-e2e stop: no session.json found — nothing to stop');
    return 0;
  }
  if (!pidIsLive(info.pid)) {
    console.log(`ux-e2e stop: session pid ${String(info.pid)} is not running`);
    return 0;
  }

  const commandLine = processCommandLine(info.pid as number);
  if (commandLine === null || !commandLine.includes(args.scratchDir)) {
    console.error(
      `ux-e2e stop: pid ${String(info.pid)} does not match scratch session — refusing (stale session.json?)`,
    );
    return 1;
  }

  await killProcessTree(info.pid as number);
  console.log(`ux-e2e stop: sent SIGTERM->SIGKILL to pid ${String(info.pid)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* transcript                                                          */
/* ------------------------------------------------------------------ */

export interface TranscriptArgs {
  readonly scratchDir: string;
  readonly tail: number | undefined;
  readonly follow: boolean;
}

export function parseTranscriptArgs(argv: string[]): TranscriptArgs {
  const { positionals, values } = parseArgsOrThrow(argv, {
    tail: { type: 'string' },
    follow: { type: 'boolean', default: false },
  });
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e transcript: missing <scratch-dir> argument');
  return {
    scratchDir: resolve(scratchDir),
    tail: typeof values.tail === 'string' ? parsePositiveInt(values.tail, '--tail') : undefined,
    follow: values.follow === true,
  };
}

function renderTranscript(transcriptPath: string): string {
  if (!existsSync(transcriptPath)) return '';
  const text = readFileSync(transcriptPath, 'utf8');
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const f = JSON.parse(line) as { t?: string; d?: unknown; code?: unknown; signal?: unknown; message?: unknown };
      if (f.t === 'o' && typeof f.d === 'string') out.push(f.d);
      else if (f.t === 'i' && typeof f.d === 'string') out.push(`[in] ${f.d}`);
      else if (f.t === 'exit') out.push(`[exit code=${String(f.code)}${f.signal !== undefined ? ` signal=${String(f.signal)}` : ''}]`);
      else if (f.t === 'err') out.push(`[err ${String(f.code)}${typeof f.message === 'string' ? `: ${f.message}` : ''}]`);
    } catch {
      /* skip partial lines */
    }
  }
  return out.join('');
}

export async function runTranscript(args: TranscriptArgs): Promise<number> {
  const transcriptPath = join(stateDirOf(args.scratchDir), 'transcript.jsonl');
  let rendered = renderTranscript(transcriptPath);
  process.stdout.write(args.tail !== undefined ? rendered.split('\n').slice(-args.tail).join('\n') : rendered);
  if (rendered.length === 0 || !rendered.endsWith('\n')) process.stdout.write('\n');

  if (args.follow) {
    let lastLen = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8').length : 0;
    for (;;) {
      const { promise: ticked, resolve: tick } = deferred<void>();
      setTimeout(tick, 500);
      await ticked;
      if (!existsSync(transcriptPath)) continue;
      const text = readFileSync(transcriptPath, 'utf8');
      if (text.length <= lastLen) continue;
      process.stdout.write(text.slice(lastLen));
      lastLen = text.length;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* ask                                                                 */
/* ------------------------------------------------------------------ */

export interface AskArgs {
  readonly scratchDir: string;
  readonly answer: string | undefined;
  readonly list: boolean;
  readonly timeoutMs: number;
}

export function parseAskArgs(argv: string[]): AskArgs {
  const { positionals, values } = parseArgsOrThrow(argv, {
    list: { type: 'boolean', default: false },
    timeout: { type: 'string' },
  });
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e ask: missing <scratch-dir> argument');
  return {
    scratchDir: resolve(scratchDir),
    answer: positionals[1],
    list: values.list === true,
    timeoutMs: typeof values.timeout === 'string' ? parsePositiveInt(values.timeout, '--timeout') : 120_000,
  };
}

export async function runAsk(args: AskArgs): Promise<number> {
  const sessionJson = readSessionJson(args.scratchDir);
  const url = typeof sessionJson.url === 'string' ? sessionJson.url : null;
  if (url === null) {
    console.error('ux-e2e ask: no session.json url — is a session running?');
    return 1;
  }
  const transcriptPath = join(stateDirOf(args.scratchDir), 'transcript.jsonl');
  const askStatePath = join(stateDirOf(args.scratchDir), 'ask-state.jsonl');
  const tracker = new AskStateTracker(transcriptPath, askStatePath);

  const waitForPending = async (): Promise<boolean> => {
    if (tracker.pendingBlock() !== null) return true;
    if (args.timeoutMs <= 0) return false;
    try {
      await waitFor(() => tracker.pendingBlock() !== null, { timeoutMs: args.timeoutMs, intervalMs: 500 });
      return true;
    } catch {
      return false;
    }
  };

  if (args.list || args.answer === undefined) {
    const ok = await waitForPending();
    const pending = tracker.pendingBlock();
    if (!ok || pending === null) {
      console.log('ux-e2e ask: no pending [ask_user] prompt');
      return 0;
    }
    console.log(`[ask_user #${pending.index}] ${pending.title}`);
    for (const opt of pending.options) console.log(opt);
    return 0;
  }

  const ok = await waitForPending();
  if (!ok) {
    console.error('ux-e2e ask: no pending [ask_user] prompt to answer');
    return 1;
  }
  const result = tracker.answer(args.answer);
  if (!result.ok) {
    console.error(`ux-e2e ask: refused — ${result.reason}`);
    return 1;
  }
  const driver = new WsDriver({ url, transcriptPath });
  await driver.open();
  await driver.type(args.answer);
  await driver.pressEnter();
  await driver.close();
  console.log(`ux-e2e ask: answered [ask_user #${result.block.index}] with ${JSON.stringify(args.answer)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

export interface InputArgs {
  readonly scratchDir: string;
  readonly text: string;
}

export function parseInputArgs(argv: string[]): InputArgs {
  const { positionals } = parseArgsOrThrow(argv, {});
  const scratchDir = positionals[0];
  const text = positionals[1];
  if (scratchDir === undefined) throw new Error('ux-e2e input: missing <scratch-dir> argument');
  if (text === undefined) throw new Error('ux-e2e input: missing <text> argument');
  return { scratchDir: resolve(scratchDir), text };
}

export async function runInput(
  args: InputArgs,
  createDriver: (url: string, transcriptPath: string) => Pick<WsDriver, 'open' | 'type' | 'pressEnter' | 'close'> =
    (url, transcriptPath) => new WsDriver({ url, transcriptPath }),
): Promise<number> {
  const sessionJson = readSessionJson(args.scratchDir);
  const url = typeof sessionJson.url === 'string' ? sessionJson.url : null;
  if (url === null) {
    console.error('ux-e2e input: no session.json url — is a session running?');
    return 1;
  }
  const transcriptPath = join(stateDirOf(args.scratchDir), 'transcript.jsonl');
  const driver = createDriver(url, transcriptPath);
  await driver.open();
  try {
    // LF ('\n') only inserts a line break in the editor buffer and does NOT
    // submit on modern PTYs (see WsDriver.pressEnter docs). Send the text and
    // a real Enter ('\r') so the prompt actually reaches the agent loop.
    await driver.type(args.text);
    await driver.pressEnter();
  } finally {
    await driver.close();
  }
  console.log(`ux-e2e input: sent ${JSON.stringify(args.text)} followed by Enter`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

export interface ReportArgs {
  readonly scratchDir: string;
  readonly steps: string | undefined;
  readonly mdDir: string | undefined;
  readonly copyEvidence: boolean;
}

export function parseReportArgs(argv: string[]): ReportArgs {
  const { positionals, values } = parseArgsOrThrow(argv, {
    steps: { type: 'string' },
    'md-dir': { type: 'string' },
    'copy-evidence': { type: 'boolean', default: false },
  });
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e report: missing <scratch-dir> argument');
  return {
    scratchDir: resolve(scratchDir),
    steps: typeof values.steps === 'string' ? values.steps : undefined,
    mdDir: typeof values['md-dir'] === 'string' ? values['md-dir'] : undefined,
    copyEvidence: values['copy-evidence'] === true,
  };
}

export async function runReport(args: ReportArgs): Promise<number> {
  let input: ReportInput;
  if (args.steps !== undefined) {
    if (!existsSync(args.steps)) {
      console.error(`ux-e2e report: steps file not found: ${args.steps}`);
      return 1;
    }
    const raw = JSON.parse(readFileSync(args.steps, 'utf8')) as Partial<ReportInput>;
    input = {
      steps: Array.isArray(raw.steps) ? (raw.steps as ReportInput['steps']) : [],
      defects: Array.isArray(raw.defects) ? (raw.defects as ReportInput['defects']) : [],
      agent_quality: raw.agent_quality ?? { rating: 0, rationale: 'not assessed' },
      verdict: (raw.verdict as Verdict | undefined) ?? 'CONDITIONAL',
      overall: raw.overall ?? { summary: 'Report generated from transcript only.' },
      regressions: raw.regressions ?? [],
    };
  } else {
    input = {
      steps: [],
      defects: [],
      agent_quality: { rating: 0, rationale: 'not assessed — no --steps input supplied' },
      verdict: 'CONDITIONAL',
      overall: { summary: 'Skeleton report generated from the transcript; supply --steps for a full assessment.' },
    };
  }
  const result = generateReport(args.scratchDir, input, {
    mdDir: args.mdDir,
    copyEvidence: args.copyEvidence,
  });
  for (const w of result.warnings) console.warn(`ux-e2e report: ${w}`);
  console.log(`ux-e2e report: ${result.jsonPath}`);
  console.log(`ux-e2e report: ${result.mdPath}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export type MainResult = Promise<number>;

/** Run the CLI; returns the process exit code. Exported for tests. */
export async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    printUsage(process.stdout);
    return 0;
  }
  const rest = argv.slice(1);
  try {
    switch (sub) {
      case 'bootstrap': {
        const args = parseBootstrapArgs(rest);
        runBootstrap(args);
        return 0;
      }
      case 'start': {
        const args = parseStartArgs(rest);
        return args.detach ? runStartDetached(args) : runStartForeground(args);
      }
      case 'stop': {
        const args = parseStopArgs(rest);
        return runStop(args);
      }
      case 'transcript': {
        const args = parseTranscriptArgs(rest);
        return runTranscript(args);
      }
      case 'ask': {
        const args = parseAskArgs(rest);
        return runAsk(args);
      }
      case 'input': {
        const args = parseInputArgs(rest);
        return runInput(args);
      }
      case 'report': {
        const args = parseReportArgs(rest);
        return runReport(args);
      }
      default:
        console.error(`ux-e2e: unknown subcommand "${sub}"`);
        printUsage(process.stderr);
        return 1;
    }
  } catch (err) {
    console.error(`ux-e2e: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
