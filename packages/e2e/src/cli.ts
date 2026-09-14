#!/usr/bin/env node
/**
 * ux-e2e — interactive UX E2E test framework for omp + omp-workflows.
 *
 * Subcommands:
 *   bootstrap <slug> <branch>    create a scratch omp project wired to this monorepo
 *   start <scratch-dir>          start an omp PTY test session and print the terminal URL
 *   stop <scratch-dir>           request an authenticated session shutdown
 *   transcript <scratch-dir>     render the session transcript
 *   ask <scratch-dir> [<answer>] list or answer a pending Ask prompt
 *   input <scratch-dir> <text>   send arbitrary input followed by Enter
 *   report <scratch-dir>         generate the ux-e2e report (JSON + markdown)
 */

import { request as httpRequest } from 'node:http';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import {
  fchmodSync,
  fstatSync,
  ftruncateSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import {
  UX_E2E_ADMISSION_LOCK,
  mintToken,
  pidIsLive,
  readSessionInfo,
  startTestSession,
  type SessionInfo,
  type TestSession,
  type TranscriptFrame,
} from './server.js';
import { answerNativeAsk, answerSelectedAsk, AskStateTracker, stripAnsi, TranscriptLog, validateSessionUrl, waitFor, waitForOmpTuiReady, WsDriver, type AskBlock, type NativeAnswerMap, type SelectedAskBlock } from './driver.js';
const CLI_QUERY_FORM_CREDENTIALS = /((?:^|[?&])(?:code|token|auth|authorization|x-ux-token|x-ux-e2e-token|x-ux-code|x-ux-e2e-code|x-ux-bootstrap-code)=)[^&\s]*/gimu;
const CLI_HEADER_CREDENTIALS = /((?:^|[,{;\r\n])\s*["']?(?:authorization|auth|token|x-ux-token|x-ux-e2e-token|x-ux-code|x-ux-e2e-code|x-ux-bootstrap-code)["']?\s*:\s*["']?(?:(?:bearer|basic)\s+)?)[^,\s"'|;}]+/gimu;

/** Redact only credential-shaped query/form fields and HTTP-style headers. */
export function redactCliCredentials(value: string): string {
  return value
    .replace(CLI_QUERY_FORM_CREDENTIALS, '$1<redacted>')
    .replace(CLI_HEADER_CREDENTIALS, '$1<redacted>');
}

function sanitizeCliError(value: unknown): string {
  return redactCliCredentials(stripAnsi(value instanceof Error ? value.message : String(value)))
    .replace(/[\n\t]/gu, ' ')
    .slice(0, 4096);
}
import {
  AGENT_DIMENSIONS,
  DEFECT_SEVERITIES,
  UX_DIMENSIONS,
  generateReport,
  type DefectSeverity,
  type ReportInput,
  type UxDimension,
} from './report.js';
import { loadScenario, type ScenarioDefinition } from './scenario.js';

import { deferred } from './util.js';
import { writeUxE2eOverlay } from './overlay.js';
import { closePinnedDirectory, closePinnedFile, openPinnedFile, pinDirectory, pinOrCreateDirectory, pinnedDirectoryIsStable, readPinnedFile, readPinnedFileFull, withPinnedExclusiveLock } from './fs-safety.js';
import { prepareRuntimeScratchProject } from './runtime.js';
const USAGE = `ux-e2e — interactive UX E2E test framework for omp + omp-workflows

Usage: ux-e2e <subcommand> [options]

Subcommands:
  bootstrap <slug> <branch>     create a scratch omp project wired to this monorepo
  start <scratch-dir>           start the OMP session server
  stop <scratch-dir>            request an authenticated session shutdown
  transcript <scratch-dir>      render the session transcript
  ask <scratch-dir> [<answer>]  list or answer a pending Ask prompt
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
}
function sessionMetadataPresent(scratchDir: string): boolean {
  const stateDir = stateDirOf(scratchDir);
  const root = pinDirectory(stateDir);
  if (root === null) {
    try {
      lstatSync(stateDir);
      return true;
    } catch {
      return false;
    }
  }
  try {
    if (readPinnedFileFull(root, 'session.json', 1024 * 1024) !== null) return true;
    try {
      lstatSync(join(stateDir, 'session.json'));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  } finally {
    closePinnedDirectory(root);
  }
}

function readSessionJson(scratchDir: string): SessionJson {
  const info = readSessionInfo(scratchDir);
  return info === null ? {} : { url: info.url, token: info.token };
}
/** Monorepo root: default = the repo that ships this package. */
function defaultMonorepoRoot(): string {
  // dist/cli.js -> packages/e2e/dist -> packages/e2e -> packages -> root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

const MAX_NODE_TIMER_MS = 2_147_483_647;
const MAX_RUNTIME_SECONDS = Math.floor(MAX_NODE_TIMER_MS / 1000);

export function parseMaxTime(value: string): number {
  const m = /^(\d+)([smh])?$/u.exec(value.trim());
  if (m === null) throw new Error(`ux-e2e: cannot parse --max-time "${value}" (expected e.g. 30m, 1800s, 1h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const seconds = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(seconds)
    || seconds <= 0 || seconds > MAX_RUNTIME_SECONDS) {
    throw new Error(`ux-e2e: --max-time must be a positive safe integer within ${String(MAX_RUNTIME_SECONDS)}s`);
  }
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
  // pinOrCreateDirectory walks from the nearest existing trusted ancestor and
  // creates missing components with O_NOFOLLOW/no-follow descriptor checks.
  const workRoot = pinOrCreateDirectory(args.workdir);
  if (workRoot === null) throw new Error('ux-e2e bootstrap: workdir is not a stable directory');
  try {
    return withPinnedExclusiveLock(workRoot, UX_E2E_ADMISSION_LOCK, () => runBootstrapUnlocked(args), 10_000);
  } finally {
    closePinnedDirectory(workRoot);
  }
}

function bootstrapScratchPath(workdir: string, slug: string): string {
  // A named omp-ux-e2e-* directory is the harness-owned suite root used by
  // the tracked E2E scenarios. Keep the historical prefixed child layout for
  // every other workdir.
  const suiteRoot = /^omp-ux-e2e-[a-z0-9][a-z0-9-]*$/u.test(basename(resolve(workdir)));
  return suiteRoot
    ? join(workdir, slug)
    : join(workdir, `omp-ux-e2e-${slug}`);
}

function runBootstrapUnlocked(args: BootstrapArgs): string {
  const monorepo = args.monorepo ?? defaultMonorepoRoot();
  const scratchDir = bootstrapScratchPath(args.workdir, args.slug);
  let scratchExists = false;
  try {
    const scratchStat = lstatSync(scratchDir);
    scratchExists = true;
    if (scratchStat.isSymbolicLink() || !scratchStat.isDirectory()) {
      throw new Error('ux-e2e bootstrap: existing scratch path is not a real directory; refusing removal');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (scratchExists) {
    const scratchRoot = pinDirectory(scratchDir);
    if (scratchRoot === null) throw new Error('ux-e2e bootstrap: scratch directory is not safely pinned');
    try {
      if (!pinnedDirectoryIsStable(scratchRoot)) {
        throw new Error('ux-e2e bootstrap: scratch directory changed during validation');
      }
      const existing = readSessionInfo(scratchDir);
      if (existing === null && sessionMetadataPresent(scratchDir)) {
        throw new Error('ux-e2e bootstrap: malformed or unsupported session metadata; refusing --force removal');
      }
      if (existing !== null
        && (pidIsLive(existing.serverPid, existing.serverStartIdentity)
          || pidIsLive(existing.pid, existing.ptyStartIdentity))) {
        throw new Error('ux-e2e bootstrap: live session owns this scratch directory; stop it with ux-e2e stop before --force');
      }
      if (!args.force) {
        throw new Error(`ux-e2e bootstrap: ${scratchDir} already exists — pass --force to re-create`);
      }
    } finally {
      closePinnedDirectory(scratchRoot);
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

  prepareRuntimeScratchProject(scratchDir, monorepo);
  writeUxE2eOverlay(scratchDir);

  console.log(`ux-e2e bootstrap: scratch project ready at ${sanitizeCliError(scratchDir)}`);
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
  readonly taskMode: 'file' | 'prompt' | undefined;
  readonly maxTimeSec: number;
  readonly idleMs: number;
  readonly startupNonce?: string;
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
    'task-prompt': { type: 'string' },
    'max-time': { type: 'string' },
    'idle-ms': { type: 'string' },
    'startup-nonce': { type: 'string' },
  });
  if (typeof values.task === 'string' && typeof values['task-prompt'] === 'string') {
    throw new Error('ux-e2e start: use either --task or --task-prompt, not both');
  }
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e start: missing <scratch-dir> argument');
  const surface = values.surface === 'text' ? 'text' : 'web';
  const taskPrompt = typeof values['task-prompt'] === 'string' ? values['task-prompt'] : undefined;
  const taskFile = typeof values.task === 'string' ? resolveTaskFileArg(values.task) : undefined;
  return {
    scratchDir: resolve(scratchDir),
    surface,
    port: typeof values.port === 'string' ? parsePositiveInt(values.port, '--port', 65_535) : 0,
    cols: typeof values.cols === 'string' ? parsePositiveInt(values.cols, '--cols', 1_000) : 100,
    rows: typeof values.rows === 'string' ? parsePositiveInt(values.rows, '--rows', 1_000) : 30,
    detach: values.detach === true,
    force: values.force === true,
    // Normalize --scenario against the *parent* cwd at parse time so
    // --detach works (the detached child runs with cwd = scratchDir and
    // would otherwise resolve a relative --scenario against the wrong
    // root). Already-absolute paths pass through unchanged.
    scenario:
      typeof values.scenario === 'string' ? resolve(values.scenario) : undefined,
    task: taskPrompt ?? taskFile,
    taskMode: taskPrompt !== undefined ? 'prompt' : taskFile !== undefined ? 'file' : undefined,
    maxTimeSec: typeof values['max-time'] === 'string' ? parseMaxTime(values['max-time']) : 1800,
    idleMs: typeof values['idle-ms'] === 'string'
      ? parsePositiveInt(values['idle-ms'], '--idle-ms')
      : 1_200_000,
    startupNonce: typeof values['startup-nonce'] === 'string' ? values['startup-nonce'] : undefined,
  };
}

function parsePositiveInt(value: string, flag: string, max = MAX_NODE_TIMER_MS): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) {
    throw new Error(`ux-e2e start: ${flag} must be a finite safe integer between 0 and ${String(max)}`);
  }
  return n;
}
function isRegularTaskFile(taskArg: string): boolean {
  try {
    const info = lstatSync(resolve(taskArg));
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 8 * 1024 * 1024;
  } catch {
    return false;
  }
}

function resolveTaskFileArg(taskArg: string): string {
  const absolute = resolve(taskArg);
  try {
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) {
      throw new Error(`ux-e2e start: --task must be a bounded regular single-link file: ${absolute}`);
    }
    return absolute;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`ux-e2e start: --task file does not exist: ${absolute}`);
    }
    throw error;
  }
}

function resolveTaskPrompt(
  taskArg: string | undefined,
  scenario: ScenarioDefinition | null,
  taskMode: StartArgs['taskMode'],
): string | null {
  if (taskArg === undefined) {
    return scenario !== null ? scenario.task : null;
  }
  if (taskMode === 'prompt') return taskArg;
  const absolute = resolve(taskArg);
  let present = false;
  try {
    const info = lstatSync(absolute);
    present = true;
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) {
      throw new Error('ux-e2e: task file is not a bounded regular single-link file');
    }
    const root = pinDirectory(dirname(absolute));
    if (root === null) throw new Error('ux-e2e: task file parent is not stable');
    try {
      const bytes = readPinnedFileFull(root, basename(absolute), 8 * 1024 * 1024);
      if (bytes === null) throw new Error('ux-e2e: task file changed during read');
      return bytes.toString('utf8');
    } finally {
      closePinnedDirectory(root);
    }
  } catch (error) {
    if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`ux-e2e: --task file does not exist: ${absolute}`);
    }
    throw error;
  }
}

async function waitForSessionReady(
  session: Pick<TestSession, 'url' | 'transcriptPath'>,
  timeoutMs = 60_000,
): Promise<void> {
  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  try {
    await driver.open();
    await waitForOmpTuiReady(driver, { timeoutMs, label: 'OMP TUI ready' });
  } finally {
    await driver.close();
  }
}

export interface DetachedStartupRuntime {
  readonly startupNonce: string;
  readonly signal: AbortSignal;
  readonly setSession: (session: TestSession) => void;
}

async function runStartForeground(args: StartArgs, startupRuntime?: DetachedStartupRuntime): Promise<number> {
  if (startupRuntime?.signal.aborted) return 1;
  await prepareStart(args);
  const scenario = args.scenario !== undefined
    ? loadScenario(args.scenario, {
        cols: String(args.cols),
        rows: String(args.rows),
        max_time: formatMaxTimeArg(args.maxTimeSec),
      })
    : null;
  const taskPrompt = resolveTaskPrompt(args.task, scenario, args.taskMode);
  const session = await startTestSession({
    cwd: args.scratchDir,
    surface: args.surface,
    port: args.port,
    cols: args.cols,
    rows: args.rows,
    idleMs: args.idleMs,
    maxTimeSec: args.maxTimeSec,
    taskPrompt,
    scenario: scenario !== null
      ? {
          id: scenario.id,
          title: scenario.title,
          ...(scenario.selectors !== undefined ? { selectors: scenario.selectors } : {}),
          ...(scenario.workspace !== undefined ? { workspace: scenario.workspace } : {}),
          ...(scenario.transcript !== undefined ? { transcript: scenario.transcript } : {}),
        }
      : null,
    ...(args.startupNonce !== undefined ? { serverStartNonce: args.startupNonce } : {}),
    ...(startupRuntime !== undefined ? { startupAbortSignal: startupRuntime.signal } : {}),
  });
  startupRuntime?.setSession(session);
  if (startupRuntime?.signal.aborted) {
    await session.close();
    return 1;
  }
  const startupInfo = readSessionInfo(args.scratchDir);
  if (startupInfo?.spawnError !== null && startupInfo?.spawnError !== undefined) {
    try {
      await session.close();
    } catch (error) {
      console.error(`ux-e2e: spawn-failure cleanup could not prove PTY exit; ownership retained: ${sanitizeCliError(error)}`);
    }
    console.error(`ux-e2e: OMP spawn failed: ${sanitizeCliError(startupInfo.spawnError)}`);
    return 1;
  }
  try {
    await waitForSessionReady(session, scenario?.timing.startupTimeoutMs);
  } catch (error) {
    try {
      await session.close();
    } catch (closeError) {
      console.error(`ux-e2e: readiness cleanup could not prove PTY exit; ownership retained: ${sanitizeCliError(closeError)}`);
    }
    throw error;
  }
  console.log(`ux-e2e: session ready — url: ${sanitizeCliError(session.browserUrl)}`);
  console.log(`ux-e2e: transcript: ${sanitizeCliError(session.transcriptPath)}`);
  return await driveForeground(session, scenario, startupRuntime?.signal);
}

/** Foreground loop: print [ask_user] hints, exit when the PTY exits. */
async function driveForeground(
  session: TestSession,
  scenario: ScenarioDefinition | null,
  startupAbortSignal?: AbortSignal,
): Promise<number> {
  const pollMs = scenario?.timing.checkpointPollMs ?? 2000;
  const stageTimeoutMs = scenario?.timing.stageTimeoutMs ?? 300_000;
  const log = new TranscriptLog(session.transcriptPath);
  const seenTitles = new Set<string>();
  let stageIndex = 0;
  let stageStartedAt = Date.now();
  let stopInFlight = false;

  const stop = (): void => {
    if (stopInFlight) return;
    stopInFlight = true;
    void session.close().then(() => {
      log.close();
      console.log('ux-e2e: session stopped');
      process.exit(0);
    }).catch(error => {
      log.close();
      stopInFlight = false;
      console.error(`ux-e2e: session stop failed; ownership retained: ${sanitizeCliError(error)}`);
      process.exitCode = 1;
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  };
  process.once('SIGINT', stop);
  const advanceScenarioStages = (): boolean => {
    if (scenario === null) return true;
    const text = stripAnsi(log.frames
      .filter(frame => frame.t === 'o')
      .map(frame => frame.d)
      .join('\n'));
    while (stageIndex < scenario.stages.length) {
      const stage = scenario.stages[stageIndex];
      if (stage === undefined) break;
      const skipped = stage.skip_if !== undefined && new RegExp(stage.skip_if, 'u').test(text);
      const matched = stage.expect !== undefined
        && stage.expect.every(expectation => new RegExp(expectation, 'u').test(text));
      if (!skipped && !matched && (stage.expect !== undefined || stage.skip_if !== undefined)) return false;
      stageIndex += 1;
      stageStartedAt = Date.now();
    }
    return true;
  };
  process.once('SIGTERM', stop);

  for (;;) {
    if (startupAbortSignal?.aborted) {
      try {
        await session.close();
      } finally {
        log.close();
      }
      return 1;
    }
    log.refresh();
    if (!advanceScenarioStages() && Date.now() - stageStartedAt >= stageTimeoutMs) {
      const stage = scenario?.stages[stageIndex];
      console.error(`ux-e2e: scenario stage timed out: ${sanitizeCliError(stage?.id ?? String(stageIndex))}`);
      try {
        await session.close();
      } finally {
        log.close();
      }
      return 1;
    }
    for (const block of log.askBlocks()) {
      if (seenTitles.has(`${block.index}:${block.title}`)) continue;
      seenTitles.add(`${block.index}:${block.title}`);
      console.log(`ux-e2e [ask_user #${block.index}]: ${stripAnsi(block.title)}`);
      for (const opt of block.options) console.log(`  ${stripAnsi(opt)}`);
      console.log(`ux-e2e: answer with: ux-e2e ask ${sanitizeCliError(shellQuote(session.scratchDir))} <answer>`);
    }
    const frames = log.frames;
    const last = frames[frames.length - 1];
    if (last !== undefined && last.t === 'exit') {
      await session.close();
      log.close();
      process.exit(0);
    }
    const { promise: ticked, resolve: tick } = deferred<void>();
    const timer = setTimeout(tick, pollMs);
    timer.unref?.();
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
 * Read the last `maxBytes` of a file through a pinned, bounded descriptor.
 */
export function tailLogFile(path: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024 * 1024) return '';
  const absolute = resolve(path);
  const root = pinDirectory(dirname(absolute));

  if (root === null) return '';
  try {
    const bytes = readPinnedFile(root, basename(absolute), maxBytes, maxBytes);
    return bytes?.toString('utf8') ?? '';
  } finally {
    closePinnedDirectory(root);
  }
}
export interface DetachedStartupAbortMessage {
  readonly type: 'ux-e2e-abort';
  readonly startup_nonce: string;
}

export function requestDetachedAbort(child: ChildProcess, startupNonce: string, timeoutMs = 1_000): Promise<boolean> {
  if (!child.connected || startupNonce.length === 0) return Promise.resolve(false);
  return new Promise(resolveResult => {
    const timer = setTimeout(() => resolveResult(false), timeoutMs);
    try {
      child.send({ type: 'ux-e2e-abort', startup_nonce: startupNonce }, error => {
        clearTimeout(timer);
        resolveResult(error === undefined);
      });
    } catch {
      clearTimeout(timer);
      resolveResult(false);
    }
  });
}

export function waitForDetachedChildExit(child: ChildProcess, timeoutMs = 8_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveResult => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolveResult(exited);
    };
    const onExit = (): void => finish(true);
    const onError = (): void => { /* wait for the definitive exit event */ };
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export function createDetachedStartupRuntime(startupNonce: string): DetachedStartupRuntime & { readonly dispose: () => void } {
  const controller = new AbortController();
  let session: TestSession | null = null;
  let closePromise: Promise<void> | null = null;
  let disposed = false;
  let capTimer: NodeJS.Timeout | null = null;
  const capDetachedLog = (): void => {
    if (capTimer !== null || typeof process.send !== 'function') return;
    // The child inherits one regular-file descriptor for both streams. Wrap
    let budget = 8 * 1024 * 1024;
    const wrap = (stream: NodeJS.WriteStream): void => {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...args: unknown[]): boolean => {
        const encoding = typeof args[0] === 'string' ? args[0] as BufferEncoding : 'utf8';
        const bytes = typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk), 'utf8');
        const callback = args.find((value): value is (error?: Error | null) => void => typeof value === 'function');
        if (budget <= 0) {
          if (callback !== undefined) callback();
          return true;
        }
        const accepted = bytes.length > budget ? bytes.subarray(0, budget) : bytes;
        budget -= accepted.length;
        if (callback !== undefined) return original(accepted, callback);
        return original(accepted);
      }) as unknown as typeof stream.write;
    };
    wrap(process.stdout);
    wrap(process.stderr);
    capTimer = setInterval(() => {
      try {
        const info = fstatSync(1);
        if (info.isFile() && info.size > 8 * 1024 * 1024) {
          ftruncateSync(1, 0);
          writeSync(1, Buffer.from('\n--- ux-e2e detached log rotated at 8 MiB ---\n', 'utf8'));
        }
      } catch {
        /* The inherited descriptor may have closed during shutdown. */
      }
    }, 250);
    capTimer.unref?.();
  };
  const closeSession = (): void => {
    if (session === null || closePromise !== null) return;
    closePromise = session.close().catch(error => {
      process.stderr.write(`ux-e2e: detached abort cleanup failed; ownership retained: ${sanitizeCliError(error)}\n`);
    });
  };
  const onMessage = (message: unknown): void => {
    if (disposed || typeof message !== 'object' || message === null) return;
    const record = message as Partial<DetachedStartupAbortMessage>;
    if (record.type !== 'ux-e2e-abort' || record.startup_nonce !== startupNonce) return;
    controller.abort();
    closeSession();
  };
  process.on('message', onMessage);
  capDetachedLog();
  return {
    startupNonce,
    signal: controller.signal,
    setSession(value: TestSession): void {
      session = value;
      if (controller.signal.aborted) closeSession();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (capTimer !== null) clearInterval(capTimer);
      capTimer = null;
      process.removeListener('message', onMessage);
      if (typeof process.disconnect === 'function' && process.connected) process.disconnect();
    },
  };
}

/** --detach: run the session in a detached child, exit with the URL.
 *
 * The detached child writes its stdout/stderr DIRECTLY into an inherited,
 * private descriptor. There is NO pipe between parent and child.
 */
function formatMaxTimeArg(seconds: number): string {
  const normalized = Math.max(1, Math.ceil(seconds));
  return normalized % 60 === 0 ? `${normalized / 60}m` : `${normalized}s`;
}

export function buildDetachedChildArgs(
  args: StartArgs,

  cliPath: string,
  startupNonce = mintToken(),
): string[] {
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
  if (args.task !== undefined) {
    const isFile = args.taskMode === 'file'
      || (args.taskMode === undefined && isRegularTaskFile(args.task));
    childArgs.push(isFile ? '--task' : '--task-prompt', args.task);
  }
  if (args.force) childArgs.push('--force');
  childArgs.push('--max-time', formatMaxTimeArg(args.maxTimeSec), '--idle-ms', String(args.idleMs), `--startup-nonce=${startupNonce}`);
  return childArgs;
}

async function runStartDetached(args: StartArgs): Promise<number> {
  await prepareStart(args);
  const scenario = args.scenario !== undefined
    ? loadScenario(args.scenario, {
        cols: String(args.cols),
        rows: String(args.rows),
        max_time: formatMaxTimeArg(args.maxTimeSec),
      })
    : null;
  const logPath = detachLogPath(args.scratchDir);
  const stateDir = stateDirOf(args.scratchDir);
  const stateRoot = pinOrCreateDirectory(stateDir);
  if (stateRoot === null) throw new Error('ux-e2e: detached session directory is not stable');
  fchmodSync(stateRoot.fd, 0o700);
  const logFile = openPinnedFile(
    stateRoot,
    basename(detachLogPath(args.scratchDir)),
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_TRUNC,
    0o600,
  );
  if (logFile === null || !pinnedDirectoryIsStable(stateRoot)) {
    if (logFile !== null) closePinnedFile(logFile);
    closePinnedDirectory(stateRoot);
    throw new Error('ux-e2e: detached log is not a private regular file');
  }
  const startupNonce = args.startupNonce ?? mintToken();
  let child: ChildProcess | null = null;
  try {
    writeSync(logFile.fd, `\n--- ux-e2e detached start @ ${new Date().toISOString()} ---\n`);
    const cliPath = fileURLToPath(import.meta.url);
    const childArgs = buildDetachedChildArgs(args, cliPath, startupNonce);
    child = spawn(process.execPath, childArgs, {
      detached: true,
      // Pass the already validated descriptor to the child. Re-opening by
      // pathname would permit a symlink/race between validation and spawn.
      stdio: ['ignore', logFile.fd, logFile.fd, 'ipc'],
      cwd: args.scratchDir,
    });
    if (child.pid === undefined) throw new Error('ux-e2e: detached child did not expose a pid');
    child.unref();
    (child.channel as { unref?: () => void } | undefined)?.unref?.();
  } catch (error) {
    closePinnedFile(logFile);
    closePinnedDirectory(stateRoot);
    throw error;
  }
  closePinnedFile(logFile);
  closePinnedDirectory(stateRoot);

  if (child === null || child.pid === undefined) throw new Error('ux-e2e: detached child did not expose a pid');
  const childPid = child.pid;
  const childEnded = new Promise<boolean>(resolveResult => {
    const done = (): void => resolveResult(true);
    child.once('exit', done);
    child.once('error', done);
  });
  const failStartup = async (message: string): Promise<number> => {
    console.error(sanitizeCliError(message));
    const exited = await abortDetachedStartup(child, args.scratchDir, startupNonce);
    if (!exited) console.error('ux-e2e start: detached child refused abort; exact-session recovery may be required');
    const tail = redactCliCredentials(stripAnsi(tailLogFile(logPath, DETACH_LOG_TAIL_BYTES)));
    if (tail.length > 0) {
      console.error(`ux-e2e start: last ${DETACH_LOG_TAIL_BYTES} bytes of ${sanitizeCliError(logPath)}:`);
      for (const line of tail.split('\n')) console.error(`  ${line}`);
    }
    return 1;
  };

async function abortDetachedStartup(child: ChildProcess, scratchDir: string, startupNonce: string): Promise<boolean> {
  await requestDetachedAbort(child, startupNonce);
  let exited = await waitForDetachedChildExit(child);
  if (exited) return true;
  const current = readSessionInfo(scratchDir);
  if (
    current !== null
    && current.serverPid === child.pid
    && current.serverStartNonce === startupNonce
    && current.url !== null
    && await requestSessionStop(current)
  ) {
    exited = await waitForDetachedChildExit(child);
  }
  return exited;
}
  // Wait for the spawned child's exact session nonce and live server pid.
  // A stale session.json from an earlier process can never satisfy this.
  const deadline = Date.now() + (scenario?.timing.startupTimeoutMs ?? 60_000);
  for (;;) {
    const info = readSessionInfo(args.scratchDir);
    if (
      info !== null
      && info.serverPid === childPid
      && info.serverStartNonce === startupNonce
      && info.url !== null
      && info.browserUrl !== null
      && info.status === 'running'
    ) {
      if (info.spawnError !== null) {
        return failStartup(`ux-e2e start: detached OMP spawn failed: ${info.spawnError}`);
      }
      if (!pidIsLive(info.serverPid, info.serverStartIdentity)) {
        return failStartup('ux-e2e start: detached server exited before readiness');
      }
      const url = info.url;
      try {
        await Promise.race([
          waitForSessionReady({
            url,
            transcriptPath: join(stateDir, 'transcript.jsonl'),
          }, scenario?.timing.startupTimeoutMs),
          childEnded.then(() => {
            throw new Error('ux-e2e: detached child exited before readiness');
          }),
        ]);
      } catch (error) {
        return failStartup(`ux-e2e start: detached OMP TUI was not ready: ${error instanceof Error ? error.message : String(error)}`);
      }
      console.log(`ux-e2e: detached session ready (pid ${String(info.serverPid)})`);
      console.log(`ux-e2e: url: ${sanitizeCliError(info.browserUrl)}`);
      return 0;
    }
    if (Date.now() >= deadline) {
      return failStartup('ux-e2e start: timed out waiting for the detached session to start');
    }
    const { promise: ticked, resolve: tick } = deferred<void>();
    const timer = setTimeout(tick, 100);
    const ended = await Promise.race([ticked.then(() => false), childEnded]);
    clearTimeout(timer);
    if (ended) return failStartup('ux-e2e start: detached child exited before session metadata');
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
 * Stop only through the live server's authenticated control endpoint.
 * session.json is an admission record, never a signal target.
 */
async function requestSessionStop(info: SessionInfo): Promise<boolean> {
  if (info.schemaVersion !== 2 || info.url === null || info.token === null
    || info.sessionId === null || info.controlNonce === null || info.serverPid === null
    || info.serverStartIdentity === null || info.serverStartNonce === null) return false;
  const sessionUrl = info.url;
  const sessionToken = info.token;
  const sessionId = info.sessionId;
  const controlNonce = info.controlNonce;
  let url: URL;
  try {
    url = validateSessionUrl(sessionUrl);
  } catch {
    return false;
  }
  return await new Promise<boolean>(resolveResult => {
    const req = httpRequest({
      method: 'POST',
      hostname: '127.0.0.1',
      port: Number(url.port),
      path: '/control/stop',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'X-Ux-E2e-Nonce': controlNonce,
        'X-Ux-E2e-Session-Id': sessionId,
      },
    }, response => {
      response.resume();
      response.once('end', () => resolveResult(response.statusCode === 202));
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolveResult(false);
    });
    req.once('error', () => resolveResult(false));
    req.end();
  });
}

function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  const stoppedRecovery = a.status === 'stopped'
    && a.pid === null
    && b.pid !== null
    && a.ptyStartIdentity === null;
  return a.schemaVersion === b.schemaVersion
    && a.sessionId === b.sessionId
    && a.serverPid === b.serverPid
    && a.serverStartIdentity === b.serverStartIdentity
    && (a.pid === b.pid || stoppedRecovery)
    && (a.ptyStartIdentity === b.ptyStartIdentity || stoppedRecovery)
    && a.startedAt === b.startedAt
    && a.serverStartNonce === b.serverStartNonce
    && a.token === b.token
    && a.controlNonce === b.controlNonce
    && a.url === b.url;
}

async function stopExactSession(
  scratchDir: string,
  expected: SessionInfo,
  alreadyRequested = false,
): Promise<void> {
  const current = readSessionInfo(scratchDir);
  if (current === null || !sameSession(current, expected)) {
    throw new Error('ux-e2e: prior session metadata changed during --force validation');
  }
  if (!alreadyRequested && !(await requestSessionStop(current))) {
    throw new Error('ux-e2e: prior session refused authenticated stop');
  }
  try {
    await waitFor(() => {
      const latest = readSessionInfo(scratchDir);
      if (latest === null) {
        if (sessionMetadataPresent(scratchDir)) return false;
        return !pidIsLive(expected.serverPid, expected.serverStartIdentity);
      }
      if (!sameSession(latest, expected)) {
        throw new Error('ux-e2e: prior session metadata changed during shutdown');
      }
      // The server writes this proof only after the authenticated controller
      // has observed the owned PTY exit. It remains authoritative even when
      // the server PID is this long-lived test runner.
      return latest.status === 'stopped'
        && latest.ptyExitObserved
        && latest.shutdownCompletedAt !== null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'prior session shutdown' });
  } catch {
    throw new Error('ux-e2e: prior session shutdown could not be proven; refusing relaunch');
  }
}
async function prepareStart(args: Pick<StartArgs, 'scratchDir' | 'force'>): Promise<void> {
  const existing = readSessionInfo(args.scratchDir);
  if (existing === null) {
    if (sessionMetadataPresent(args.scratchDir)) {
      throw new Error('ux-e2e: malformed or unsupported session metadata; refusing relaunch');
    }
    return;
  }
  const shutdownProven = existing.status === 'stopped'
    && existing.ptyExitObserved
    && existing.shutdownCompletedAt !== null;
  if (shutdownProven) return;
  const serverLive = pidIsLive(existing.serverPid, existing.serverStartIdentity);
  const ptyLive = existing.ptyStartIdentity === null
    ? pidIsLive(existing.pid, existing.probeStartIdentity)
    : pidIsLive(existing.pid, existing.ptyStartIdentity);
  if (!serverLive && !ptyLive) return;
  if (!args.force) {
    throw new Error(
      `ux-e2e: live session found (server pid ${String(existing.serverPid)}) at ${existing.path}; stop it or pass --force to override`,
    );
  }
  if (!serverLive) {
    throw new Error('ux-e2e: prior session server is unavailable while its PTY remains live; refusing relaunch');
  }
  await stopExactSession(args.scratchDir, existing);
}
export async function runStop(args: StopArgs): Promise<number> {
  const info = readSessionInfo(args.scratchDir);
  if (info === null) {
    if (sessionMetadataPresent(args.scratchDir)) {
      console.error('ux-e2e stop: malformed or unsupported session metadata — refusing');
      return 1;
    }
    console.log('ux-e2e stop: no session.json found — nothing to stop');
    return 0;
  }
  if (info.schemaVersion !== 2 || info.url === null || info.token === null
    || info.sessionId === null || info.controlNonce === null
    || info.serverPid === null || info.serverStartIdentity === null
    || info.serverStartNonce === null) {
    console.error('ux-e2e stop: session metadata is incomplete or does not match scratch session — refusing');
    return 1;
  }
  const fresh = readSessionInfo(args.scratchDir);
  if (fresh === null || !sameSession(fresh, info)) {
    console.error('ux-e2e stop: session metadata changed during validation — refusing');
    return 1;
  }
  if (fresh.status === 'stopped' && fresh.ptyExitObserved && fresh.shutdownCompletedAt !== null) {
    console.log('ux-e2e stop: no live session — nothing to stop');
    return 0;
  }
  const serverLive = pidIsLive(fresh.serverPid, fresh.serverStartIdentity);
  const ptyLive = fresh.ptyStartIdentity === null
    ? pidIsLive(fresh.pid, fresh.probeStartIdentity)
    : pidIsLive(fresh.pid, fresh.ptyStartIdentity);
  if (!serverLive && !ptyLive) {
    console.error(`ux-e2e stop: shutdown-unproven — persisted status ${fresh.status} has no live owner and no terminal shutdown proof; refusing success`);
    return 1;
  }
  if (!serverLive) {
    console.error('ux-e2e stop: authenticated session server unavailable; refusing bare PID recovery');
    return 1;
  }
  if (!(await requestSessionStop(fresh))) {
    console.error('ux-e2e stop: authenticated session server unavailable or refused stop — no process was signaled');
    return 1;
  }
  try {
    await stopExactSession(args.scratchDir, fresh, true);
  } catch (error) {
    console.error(`ux-e2e stop: shutdown could not be proven; retry with the same session metadata (${sanitizeCliError(error)})`);
    return 1;
  }
  console.log('ux-e2e stop: authenticated server stop completed');
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
    tail: typeof values.tail === 'string'
      ? parsePositiveInt(values.tail, '--tail', 8 * 1024 * 1024)
      : undefined,
    follow: values.follow === true,
  };
}

function renderTranscriptFrame(frame: TranscriptFrame): string {
  if (frame.t === 'o' && typeof frame.d === 'string') return stripAnsi(frame.d);
  if (frame.t === 'i' && typeof frame.d === 'string') return `[in] ${stripAnsi(frame.d)}`;
  if (frame.t === 'exit') return `[exit code=${String(frame.code)}${frame.signal !== undefined ? ` signal=${String(frame.signal)}` : ''}]`;
  if (frame.t === 'err') return `[err ${String(frame.code)}${typeof frame.message === 'string' ? `: ${stripAnsi(frame.message)}` : ''}]`;
  return '';
}

function renderTranscriptFrames(frames: readonly TranscriptFrame[]): string {
  return frames.map(renderTranscriptFrame).join('');
}

function renderTranscriptBytes(bytes: Buffer): string {
  const out: TranscriptFrame[] = [];
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as TranscriptFrame);
    } catch {
      /* skip partial lines */
    }
  }
  return renderTranscriptFrames(out);
}

function readTranscriptBytes(transcriptPath: string): Buffer {
  const absolute = resolve(transcriptPath);
  const root = pinDirectory(dirname(absolute));
  if (root === null) return Buffer.alloc(0);
  try {
    return readPinnedFile(root, basename(absolute), 8 * 1024 * 1024, 8 * 1024 * 1024) ?? Buffer.alloc(0);
  } finally {
    closePinnedDirectory(root);
  }
}

function renderTranscript(transcriptPath: string): string {
  return renderTranscriptBytes(readTranscriptBytes(transcriptPath));
}

export function transcriptOverlap(previous: Buffer, current: Buffer): number {
  if (previous.length === 0 || current.length === 0) return 0;
  const prefix = new Uint32Array(current.length);
  for (let index = 1; index < current.length; index += 1) {
    let matched = prefix[index - 1] ?? 0;
    while (matched > 0 && current[index] !== current[matched]) matched = prefix[matched - 1] ?? 0;
    if (current[index] === current[matched]) matched += 1;
    prefix[index] = matched;
  }
  let matched = 0;
  for (let index = 0; index < previous.length; index += 1) {
    const byte = previous[index];
    while (matched > 0 && byte !== current[matched]) matched = prefix[matched - 1] ?? 0;
    if (byte === current[matched]) matched += 1;
    if (matched === current.length) {
      if (index === previous.length - 1) return current.length;
      matched = prefix[matched - 1] ?? 0;
    }
  }
  return matched;
}

export async function runTranscript(args: TranscriptArgs): Promise<number> {
  const transcriptPath = join(stateDirOf(args.scratchDir), 'transcript.jsonl');
  const rendered = renderTranscript(transcriptPath);
  process.stdout.write(args.tail !== undefined ? rendered.split('\n').slice(-args.tail).join('\n') : rendered);
  if (rendered.length === 0 || !rendered.endsWith('\n')) process.stdout.write('\n');

  if (args.follow) {
    const log = new TranscriptLog(transcriptPath);
    log.refresh();
    for (;;) {
      const { promise: ticked, resolve: tick } = deferred<void>();
      setTimeout(tick, 500);
      await ticked;
      const added = log.refresh();
      if (added.length > 0) {
        const renderedDelta = renderTranscriptFrames(added);
        if (renderedDelta.length > 0) process.stdout.write(renderedDelta);
      }
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
  readonly answers: NativeAnswerMap | undefined;
  readonly list: boolean;
  readonly timeoutMs: number;
}

export function parseAskArgs(argv: string[]): AskArgs {
  const { positionals, values } = parseArgsOrThrow(argv, {
    list: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    answers: { type: 'string' },
  });
  const scratchDir = positionals[0];
  if (scratchDir === undefined) throw new Error('ux-e2e ask: missing <scratch-dir> argument');
  const answer = positionals[1];
  const answers = typeof values.answers === 'string' ? parseNativeAnswerMap(values.answers) : undefined;
  if (answer !== undefined && answers !== undefined) {
    throw new Error('ux-e2e ask: use either <answer> or --answers JSON, not both');
  }
  return {
    scratchDir: resolve(scratchDir),
    answer,
    answers,
    list: values.list === true,
    timeoutMs: typeof values.timeout === 'string' ? parsePositiveInt(values.timeout, '--timeout') : 120_000,
  };
}


function parseNativeAnswerMap(raw: string): NativeAnswerMap {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('ux-e2e ask: --answers must be valid JSON object, e.g. {"d101":"Approve"}');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ux-e2e ask: --answers must be a JSON object keyed by native question id');
  }
  const result: Record<string, string> = {};
  for (const [id, answer] of Object.entries(value)) {
    if (id.length === 0 || typeof answer !== 'string' || answer.trim().length === 0) {
      throw new Error('ux-e2e ask: --answers values must be non-empty strings keyed by question id');
    }
    result[id] = answer;
  }
  return result;
}

export async function runAsk(args: AskArgs): Promise<number> {
  const sessionInfo = readSessionInfo(args.scratchDir);
  if (sessionInfo === null || sessionInfo.url === null) {
    console.error('ux-e2e ask: no session.json url — is a session running?');
    return 1;
  }
  const url = sessionInfo.url;
  const transcriptPath = join(stateDirOf(args.scratchDir), 'transcript.jsonl');
  const askStatePath = join(stateDirOf(args.scratchDir), 'ask-state.jsonl');
  const tracker = new AskStateTracker(transcriptPath, askStatePath, {
    sessionId: sessionInfo.sessionId ?? undefined,
    leaseMs: args.timeoutMs > 0 ? Math.max(args.timeoutMs, 30_000) : 120_000,
  });
  const log = new TranscriptLog(transcriptPath);
  try {
    const pendingAsk = (): AskBlock | SelectedAskBlock | null => {
      const legacy = tracker.pendingBlock();
      const selected = log.pendingSelectedAsk();
      if (legacy === null) return selected;
      if (selected === null) return legacy;
      return selected.frameStart >= legacy.frameStart ? selected : legacy;
    };
    const waitForPending = async (): Promise<boolean> => {
      if (pendingAsk() !== null) return true;
      if (args.timeoutMs <= 0) return false;
      try {
        await waitFor(() => pendingAsk() !== null, { timeoutMs: args.timeoutMs, intervalMs: 500 });
        return true;
      } catch {
        return false;
      }
    };

    if (args.list || (args.answer === undefined && args.answers === undefined)) {
      const ok = await waitForPending();
      const pending = pendingAsk();
      if (!ok || pending === null) {
        console.log('ux-e2e ask: no pending Ask prompt');
        return 0;
      }
      console.log('[ask #' + pending.index + '] ' + stripAnsi(pending.title));
      if (pending.surface === 'native') {
        for (const question of pending.questions) {
          console.log(question.id + ': ' + stripAnsi(question.prompt));
          for (const option of question.options) {
            console.log('  ' + stripAnsi(option.label) + (option.description === undefined ? '' : ' — ' + stripAnsi(option.description)));
          }
        }
      } else {
        for (const opt of pending.options) console.log(stripAnsi(opt));
      }
      return 0;
    }

    if (!(await waitForPending())) {
      console.error('ux-e2e ask: no pending Ask prompt to answer');
      return 1;
    }
    const pending = pendingAsk();
    if (pending === null) {
      console.error('ux-e2e ask: no pending Ask prompt to answer');
      return 1;
    }
    if (pending.surface === 'selector') {
      if (args.answers !== undefined) {
        console.error('ux-e2e: selected Ask requires one positional option label, not --answers JSON');
        return 1;
      }
      const cursor = log.transcriptCursor();
      const driver = new WsDriver({ url, transcriptPath });
      let delivered = false;
      try {
        await driver.open();
        // The pending selector itself is the readiness proof here: while an
        // Ask card is active the welcome screen is intentionally absent, so
        // waiting for the startup-only TUI marker would deadlock delivery.
        await answerSelectedAsk(driver, pending, args.answer ?? '');
        await waitFor(
          () => log.hasTerminalAfter(cursor),
          { timeoutMs: args.timeoutMs, intervalMs: 250, label: 'selected Ask delivery observation' },
        );
        delivered = true;
      } catch (error) {
        console.error('ux-e2e: selected Ask delivery failed — ' + sanitizeCliError(error));
      } finally {
        await driver.close();
      }
      if (!delivered) return 1;
      console.log('ux-e2e: answered [ask #' + pending.index + ']');
      return 0;
    }

    const reservationResult = args.answers !== undefined
      ? tracker.reserve(JSON.stringify(args.answers))
      : tracker.reserve(args.answer ?? '');
    if (!reservationResult.ok) {
      console.error('ux-e2e: refused — ' + reservationResult.reason);
      return 1;
    }
    let reservation = reservationResult.reservation;
    const driver = new WsDriver({ url, transcriptPath });
    let delivered = false;
    try {
      await driver.open();
      // The reserved pending Ask is the readiness proof; the startup-only
      // welcome screen is not present while the native card is displayed.
      const refreshed = tracker.refreshReservation(reservation);
      if (refreshed === null) throw new Error('Ask prompt changed before input delivery');
      reservation = refreshed;
      driver.setReservation(reservation.id);
      try {
        if (reservation.block.surface === 'native') {
          await answerNativeAsk(driver, reservation.block, args.answers ?? args.answer);
        } else {
          driver.beginInputSequence?.(2);
          try {
            await driver.type(args.answer ?? '');
            await driver.pressEnter();
          } finally {
            driver.endInputSequence?.();
          }
        }
      } finally {
        driver.setReservation(null);
      }
      await waitFor(
        () => tracker.observedAfter(reservation),
        { timeoutMs: args.timeoutMs, intervalMs: 250, label: 'Ask delivery observation' },
      );
      delivered = true;
    } catch (error) {
      console.error('ux-e2e ask: delivery failed — ' + sanitizeCliError(error));
    } finally {
      await driver.close();
    }
    if (!delivered) {
      const deliveryState = tracker.deliveryState(reservation);
      if (deliveryState === 'none') {
        tracker.cancelReservation(reservation);
      } else {
        console.error('ux-e2e ask: delivery state is ' + deliveryState + '; refusing resend without observed commit');
      }
      return 1;
    }
    const committed = tracker.commitReservation(reservation);
    if (!committed.ok) {
      if (tracker.deliveryState(reservation) === 'none') tracker.cancelReservation(reservation);
      console.error('ux-e2e: delivery observed but commit failed — ' + committed.reason);
      return 1;
    }
    console.log('ux-e2e: answered [ask #' + committed.block.index + ']');
    return 0;
  } finally {
    log.close();
    tracker.close();
  }
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
  try {
    await driver.open();
    if (typeof (driver as Partial<Pick<WsDriver, 'readScreen'>>).readScreen === 'function') {
      await waitForOmpTuiReady(driver as unknown as Pick<WsDriver, 'readScreen'>);
    }
    // LF ('\n') only inserts a line break in the editor buffer and does NOT
    // submit on modern PTYs (see WsDriver.pressEnter docs). Send the text and
    // a real Enter ('\r') so the prompt actually reaches the agent loop.
    await driver.type(args.text);
    await driver.pressEnter();
  } finally {
    await driver.close();
  }
  console.log(`ux-e2e input: sent ${String(args.text.length)} characters followed by Enter`);
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
const REPORT_MAX_ITEMS = 4096;
const REPORT_MAX_TEXT = 8192;
const REPORT_MAX_EVIDENCE_REF = 2048;
const TERMINAL_CONTROL = /(?:\u001b|\u0000|[\u0007\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f])/u;

function reportRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function reportKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new Error(`${label} contains unknown field "${key}"`);
  }
}

function reportText(value: unknown, label: string, max = REPORT_MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || TERMINAL_CONTROL.test(value)) {
    throw new Error(`${label} must be bounded text without terminal controls`);
  }
  return value;
}

function reportTextArray(value: unknown, label: string, max = REPORT_MAX_ITEMS, itemMax = REPORT_MAX_TEXT): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => reportText(item, `${label}[${String(index)}]`, itemMax));
}

function reportNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${String(min)} and ${String(max)}`);
  }
  return value;
}

function validateReportInputJson(value: unknown): ReportInput {
  const root = reportRecord(value, 'steps JSON');
  reportKeys(root, ['steps', 'defects', 'agent_quality', 'verdict', 'overall', 'regressions'], 'steps JSON');
  const rawSteps = root['steps'] === undefined ? [] : root['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length > REPORT_MAX_ITEMS) throw new Error('steps must be a bounded array');
  const rawDefects = root['defects'] === undefined ? [] : root['defects'];
  if (!Array.isArray(rawDefects) || rawDefects.length > REPORT_MAX_ITEMS) throw new Error('defects must be a bounded array');
  const ids = new Set<string>();
  const steps = rawSteps.map((value, index) => {
    const record = reportRecord(value, `steps[${String(index)}]`);
    reportKeys(record, ['id', 'name', 'order', 'ratings', 'defects', 'screenshots', 'transcript_excerpt', 'notes'], `steps[${String(index)}]`);
    const id = record['id'] === undefined ? undefined : reportText(record['id'], `steps[${String(index)}].id`, 128);
    if (id !== undefined && ids.has(id)) throw new Error(`duplicate report id "${id}"`);
    if (id !== undefined) ids.add(id);
    const ratingsRecord = reportRecord(record['ratings'], `steps[${String(index)}].ratings`);
    reportKeys(ratingsRecord, UX_DIMENSIONS, `steps[${String(index)}].ratings`);
    const ratings: Record<string, number> = {};
    for (const dimension of Object.keys(ratingsRecord)) ratings[dimension] = reportNumber(ratingsRecord[dimension], `${dimension} rating`, 1, 5);
    const defects = reportTextArray(record['defects'], `steps[${String(index)}].defects`, REPORT_MAX_ITEMS, 128);
    const screenshots = reportTextArray(record['screenshots'], `steps[${String(index)}].screenshots`, REPORT_MAX_ITEMS, REPORT_MAX_EVIDENCE_REF);
    const transcriptExcerpt = record['transcript_excerpt'] === undefined
      ? undefined
      : reportText(record['transcript_excerpt'], `steps[${String(index)}].transcript_excerpt`);
    const notes = record['notes'] === undefined ? undefined : reportText(record['notes'], `steps[${String(index)}].notes`);
    return {
      ...(id === undefined ? {} : { id }),
      name: reportText(record['name'], `steps[${String(index)}].name`),
      order: reportNumber(record['order'], `steps[${String(index)}].order`, 0, Number.MAX_SAFE_INTEGER),
      ratings,
      defects,
      screenshots,
      ...(transcriptExcerpt === undefined ? {} : { transcript_excerpt: transcriptExcerpt }),
      ...(notes === undefined ? {} : { notes }),
    };
  });
  const defects = rawDefects.map((value, index) => {
    const record = reportRecord(value, `defects[${String(index)}]`);
    reportKeys(record, ['id', 'severity', 'dimension', 'title', 'step', 'evidence', 'repro', 'notes'], `defects[${String(index)}]`);
    const id = record['id'] === undefined ? undefined : reportText(record['id'], `defects[${String(index)}].id`, 128);
    if (id !== undefined && ids.has(id)) throw new Error(`duplicate report id "${id}"`);
    if (id !== undefined) ids.add(id);
    const severity = record['severity'];
    if (typeof severity !== 'string' || !DEFECT_SEVERITIES.includes(severity as (typeof DEFECT_SEVERITIES)[number])) {
      throw new Error(`defects[${String(index)}].severity is unknown`);
    }
    const dimension = record['dimension'];
    if (typeof dimension !== 'string' || !UX_DIMENSIONS.includes(dimension as (typeof UX_DIMENSIONS)[number])) {
      throw new Error(`defects[${String(index)}].dimension is unknown`);
    }
    const repro = record['repro'] === undefined ? undefined : reportText(record['repro'], `defects[${String(index)}].repro`);
    const notes = record['notes'] === undefined ? undefined : reportText(record['notes'], `defects[${String(index)}].notes`);
    return {
      ...(id === undefined ? {} : { id }),
      severity: severity as DefectSeverity,
      dimension: dimension as UxDimension,
      title: reportText(record['title'], `defects[${String(index)}].title`),
      step: reportText(record['step'], `defects[${String(index)}].step`, 128),
      evidence: reportTextArray(record['evidence'], `defects[${String(index)}].evidence`, REPORT_MAX_ITEMS, REPORT_MAX_EVIDENCE_REF),
      ...(repro === undefined ? {} : { repro }),
      ...(notes === undefined ? {} : { notes }),
    };
  });
  const quality = root['agent_quality'] === undefined
    ? { rating: 0, rationale: 'not assessed' }
    : reportRecord(root['agent_quality'], 'agent_quality');
  reportKeys(quality, ['rating', 'rationale', 'dimensions'], 'agent_quality');
  const qualityDimensions = quality['dimensions'] === undefined ? undefined : reportRecord(quality['dimensions'], 'agent_quality.dimensions');
  if (qualityDimensions !== undefined) reportKeys(qualityDimensions, AGENT_DIMENSIONS, 'agent_quality.dimensions');
  const dimensions = qualityDimensions === undefined ? undefined : Object.fromEntries(
    Object.entries(qualityDimensions).map(([key, item]) => [key, reportNumber(item, `agent_quality.dimensions.${key}`, 0, 5)]),
  );
  const agentQuality = {
    rating: reportNumber(quality['rating'], 'agent_quality.rating', 0, 5),
    rationale: reportText(quality['rationale'], 'agent_quality.rationale'),
    ...(dimensions === undefined ? {} : { dimensions }),
  };
  const verdict = root['verdict'] === undefined ? 'CONDITIONAL' : root['verdict'];
  if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'CONDITIONAL') throw new Error('verdict is unknown');
  const overall = root['overall'] === undefined ? { summary: 'Report generated from transcript only.' } : reportRecord(root['overall'], 'overall');
  reportKeys(overall, ['summary', 'recommendation', 'score'], 'overall');
  const recommendation = overall['recommendation'];
  if (recommendation !== undefined && recommendation !== 'ship' && recommendation !== 'fix-high' && recommendation !== 'rework') {
    throw new Error('recommendation is unknown');
  }
  return {
    steps,
    defects,
    agent_quality: agentQuality,
    verdict,
    overall: {
      summary: reportText(overall['summary'], 'overall.summary'),
      ...(recommendation === undefined ? {} : { recommendation }),
      ...(overall['score'] === undefined ? {} : { score: reportNumber(overall['score'], 'overall.score', 1, 5) }),
    },
    regressions: root['regressions'] === undefined ? [] : reportTextArray(root['regressions'], 'regressions'),
  };
}
function readBoundedJson(path: string): unknown | null {
  const absolute = resolve(path);
  const root = pinDirectory(dirname(absolute));
  if (root === null) return null;
  try {
    const bytes = readPinnedFileFull(root, basename(absolute), 8 * 1024 * 1024);
    if (bytes === null) return null;
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    closePinnedDirectory(root);
  }
}

export async function runReport(args: ReportArgs): Promise<number> {
  let input: ReportInput;
  if (args.steps !== undefined) {
    const raw = readBoundedJson(args.steps);
    if (raw === null) {
      console.error(`ux-e2e report: steps file unavailable or invalid: ${sanitizeCliError(args.steps)}`);
      return 1;
    }
    try {
      input = validateReportInputJson(raw);
    } catch (error) {
      console.error(`ux-e2e report: invalid --steps JSON (${sanitizeCliError(error)})`);
      return 1;
    }
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
  for (const w of result.warnings) console.warn(`ux-e2e report: ${sanitizeCliError(w)}`);
  console.log(`ux-e2e report: ${sanitizeCliError(result.jsonPath)}`);
  console.log(`ux-e2e report: ${sanitizeCliError(result.mdPath)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export type MainResult = Promise<number>;

/** Run the CLI; returns the process exit code. Exported for tests. */
export async function main(argv: string[], startupRuntime?: DetachedStartupRuntime): Promise<number> {
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
        return args.detach ? runStartDetached(args) : runStartForeground(args, startupRuntime);
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
        console.error(`ux-e2e: unknown subcommand "${sanitizeCliError(sub)}"`);
        printUsage(process.stderr);
        return 1;
    }
  } catch (err) {
    console.error(`ux-e2e: ${sanitizeCliError(err)}`);
    return 1;
  }
}
function detachedRuntimeFromArgv(argv: string[]): (DetachedStartupRuntime & { readonly dispose: () => void }) | undefined {
  if (argv[0] !== 'start') return undefined;
  try {
    const parsed = parseStartArgs(argv.slice(1));
    return parsed.startupNonce === undefined ? undefined : createDetachedStartupRuntime(parsed.startupNonce);
  } catch {
    return undefined;
  }
}


if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const startupRuntime = detachedRuntimeFromArgv(process.argv.slice(2));
  void main(process.argv.slice(2), startupRuntime).then(code => {
    startupRuntime?.dispose();
    process.exitCode = code;
  }, error => {
    startupRuntime?.dispose();
    console.error(`ux-e2e: ${sanitizeCliError(error)}`);
    process.exitCode = 1;
  });
}
