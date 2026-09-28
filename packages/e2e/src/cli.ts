#!/usr/bin/env node
/** Manifest-only ux-e2e lifecycle CLI. */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  assertNoLiveSession,
  killProcessTree,
  pidIsLive,
  readSessionRecord,
  startTestSession,
  type KillProcessTreeResult,
  type SessionInfo,
  type TestSession,
} from './server.js';
import {
  AskStateTracker,
  requestSessionStop,
  SessionStopError,
  TranscriptLog,
  waitFor,
  WsDriver,
} from './driver.js';
import { generateReport, type ReportInput, type Verdict } from './report.js';
import { readManifest, verifyManifest, type RunManifest, type SessionRecord } from './manifest.js';
import {
  ENV_ALLOWLIST,
  isCleanSessionTermination,
  isSafeAuthEnvironmentKey,
  pathContained,
  readSessionRecord as readManifestSessionRecord,
  writeSessionRecord,
} from './environment.js';
import { doctorRun, prepareRun } from './prepare.js';
import { cleanupRun, verifyRun } from './verify.js';
import {
  ensureManagedBroker,
  hostProfileEnvironment,
  managedBrokerStatus,
  readManagedBrokerToken,
  stopManagedBroker,
} from './broker.js';
import { deferred } from './util.js';

const USAGE = `ux-e2e — isolated manifest-backed E2E lifecycle

Usage: ux-e2e <subcommand> [options]

Subcommands:
  prepare --config <file> --run <id> [--json]
  doctor --manifest <file> [--json]
  start --manifest <file> [--detach] [--session-id <id>] [--json]
  stop --manifest <file> [--session-id <id>] [--json]
  input --manifest <file> <text> [--session-id <id>] [--json]
  ask --manifest <file> [<answer>] [--list] [--json]
  transcript --manifest <file> [--follow] [--json]
  report --manifest <file> [--steps <file>] [--json]
  cleanup --manifest <file> [--keep-failed] [--json]
  verify --manifest <file> --suite isolation|live-smoke [--keep-failed] [--json]
  auth-broker ensure|status|stop --manifest <file> [--json]

A scratch directory or bootstrap command is no longer accepted. Prepare a new
run from a secret-free config, then use its manifest for every lifecycle command.`;

interface CliParsedArgs {
  readonly values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  readonly positionals: string[];
}

interface JsonOption {
  readonly json: boolean;
}

interface PrepareArgs extends JsonOption {
  readonly configPath: string;
  readonly runId: string;
}

interface DoctorArgs extends JsonOption {
  readonly manifestPath: string;
}

interface StartArgs extends JsonOption {
  readonly manifestPath: string;
  readonly sessionId: string | undefined;
  readonly surface: 'web' | 'text';
  readonly port: number;
  readonly cols: number;
  readonly rows: number;
  readonly detach: boolean;
  readonly maxTimeSec: number;
  readonly idleMs: number;
}

interface StopArgs extends JsonOption {
  readonly manifestPath: string;
  readonly sessionId: string | undefined;
}

interface InputArgs extends JsonOption {
  readonly manifestPath: string;
  readonly sessionId: string | undefined;
  readonly text: string;
}

interface AskArgs extends JsonOption {
  readonly manifestPath: string;
  readonly sessionId: string | undefined;
  readonly answer: string | undefined;
  readonly list: boolean;
  readonly timeoutMs: number;
}

interface TranscriptArgs extends JsonOption {
  readonly manifestPath: string;
  readonly sessionId: string | undefined;
  readonly tail: number | undefined;
  readonly follow: boolean;
}

interface ReportArgs extends JsonOption {
  readonly manifestPath: string;
  readonly sessionId: string | undefined;
  readonly stepsPath: string | undefined;
  readonly mdDir: string | undefined;
  readonly copyEvidence: boolean;
}

interface CleanupArgs extends JsonOption {
  readonly manifestPath: string;
  readonly keepFailed: boolean;
}

interface VerifyArgs extends JsonOption {
  readonly manifestPath: string;
  readonly suite: 'isolation' | 'live-smoke';
  readonly keepFailed: boolean;
  readonly sessionId: string | undefined;
}

export class CliError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(`${USAGE}\n`);
}

function parseArgsOrThrow(argv: string[], options: ParseArgsConfig['options']): CliParsedArgs {
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { values: parsed.values, positionals: parsed.positionals };
}

function stringValue(values: CliParsedArgs['values'], key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(values: CliParsedArgs['values'], key: string): boolean {
  return values[key] === true;
}

function parsePositiveInt(value: string, flag: string, allowZero = false): number {
  const number = Number(value);
  if (!Number.isInteger(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new CliError('invalid_argument', `${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return number;
}

export function parseMaxTime(value: string): number {
  const match = /^(\d+)([smh])?$/u.exec(value.trim());
  if (match === null) throw new CliError('invalid_argument', `cannot parse --max-time "${value}" (expected e.g. 30m, 1800s, 1h)`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const seconds = unit === 'h' ? amount * 3600 : unit === 'm' ? amount * 60 : amount;
  if (seconds <= 0) throw new CliError('invalid_argument', '--max-time must be positive');
  return seconds;
}

function hasLegacyScratch(argv: readonly string[]): boolean {
  return argv.some(value => value === '--scratch' || value === '--scratch-dir' || value === '--scratchDir');
}

function migrationError(subcommand: string): CliError {
  return new CliError(
    'legacy_scratch_unsupported',
    `ux-e2e ${subcommand} no longer accepts scratch directories or bootstrap state; run prepare --config <file> --run <id> first and pass --manifest <path>`,
  );
}

function requiredManifest(values: CliParsedArgs['values'], positionals: readonly string[], subcommand: string): string {
  if (positionals.length > 0) throw migrationError(subcommand);
  const manifest = stringValue(values, 'manifest');
  if (manifest !== undefined) return resolve(manifest);
  throw new CliError('missing_argument', `ux-e2e ${subcommand}: missing --manifest <file>`);
}

function requiredString(values: CliParsedArgs['values'], key: string, subcommand: string): string {
  const value = stringValue(values, key);
  if (value === undefined || value.length === 0) throw new CliError('missing_argument', `ux-e2e ${subcommand}: missing --${key}`);
  return value;
}

function sessionIdValue(values: CliParsedArgs['values']): string | undefined {
  return stringValue(values, 'session-id') ?? stringValue(values, 'session');
}

export function parsePrepareArgs(argv: string[]): PrepareArgs {
  const { values, positionals } = parseArgsOrThrow(argv, {
    config: { type: 'string' },
    run: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  if (positionals.length > 0) throw migrationError('prepare');
  return { configPath: resolve(requiredString(values, 'config', 'prepare')), runId: requiredString(values, 'run', 'prepare'), json: booleanValue(values, 'json') };
}

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, json: { type: 'boolean', default: false } });
  return { manifestPath: requiredManifest(values, positionals, 'doctor'), json: booleanValue(values, 'json') };
}

export function parseStartArgs(argv: string[]): StartArgs {
  const { values, positionals } = parseArgsOrThrow(argv, {
    manifest: { type: 'string' },
    'session-id': { type: 'string' },
    session: { type: 'string' },
    surface: { type: 'string' },
    port: { type: 'string' },
    cols: { type: 'string' },
    rows: { type: 'string' },
    detach: { type: 'boolean', default: false },
    'max-time': { type: 'string' },
    'idle-ms': { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  if (hasLegacyScratch(argv) || (stringValue(values, 'manifest') === undefined && positionals.length > 0)) throw migrationError('start');
  const surface = stringValue(values, 'surface');
  if (surface !== undefined && surface !== 'web' && surface !== 'text') throw new CliError('invalid_argument', '--surface must be web or text');
  return {
    manifestPath: requiredManifest(values, positionals, 'start'),
    sessionId: sessionIdValue(values),
    surface: surface === 'text' ? 'text' : 'web',
    port: stringValue(values, 'port') === undefined ? 0 : parsePositiveInt(stringValue(values, 'port')!, '--port', true),
    cols: stringValue(values, 'cols') === undefined ? 100 : parsePositiveInt(stringValue(values, 'cols')!, '--cols'),
    rows: stringValue(values, 'rows') === undefined ? 30 : parsePositiveInt(stringValue(values, 'rows')!, '--rows'),
    detach: booleanValue(values, 'detach'),
    maxTimeSec: stringValue(values, 'max-time') === undefined ? 1800 : parseMaxTime(stringValue(values, 'max-time')!),
    idleMs: stringValue(values, 'idle-ms') === undefined ? 1_200_000 : parsePositiveInt(stringValue(values, 'idle-ms')!, '--idle-ms'),
    json: booleanValue(values, 'json'),
  };
}

export function parseStopArgs(argv: string[]): StopArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, 'session-id': { type: 'string' }, session: { type: 'string' }, json: { type: 'boolean', default: false } });
  return { manifestPath: requiredManifest(values, positionals, 'stop'), sessionId: sessionIdValue(values), json: booleanValue(values, 'json') };
}

export function parseInputArgs(argv: string[]): InputArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, 'session-id': { type: 'string' }, session: { type: 'string' }, text: { type: 'string' }, json: { type: 'boolean', default: false } });
  const text = stringValue(values, 'text') ?? positionals[0];
  if (text === undefined) throw new CliError('missing_argument', 'ux-e2e input: missing <text> (or --text)');
  if (stringValue(values, 'manifest') === undefined && positionals.length > 0) throw migrationError('input');
  return { manifestPath: requiredManifest(values, [], 'input'), sessionId: sessionIdValue(values), text, json: booleanValue(values, 'json') };
}

export function parseAskArgs(argv: string[]): AskArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, 'session-id': { type: 'string' }, session: { type: 'string' }, answer: { type: 'string' }, list: { type: 'boolean', default: false }, timeout: { type: 'string' }, json: { type: 'boolean', default: false } });
  const answer = stringValue(values, 'answer') ?? positionals[0];
  if (stringValue(values, 'manifest') === undefined && positionals.length > 0) throw migrationError('ask');
  return { manifestPath: requiredManifest(values, [], 'ask'), sessionId: sessionIdValue(values), answer, list: booleanValue(values, 'list'), timeoutMs: stringValue(values, 'timeout') === undefined ? 120_000 : parsePositiveInt(stringValue(values, 'timeout')!, '--timeout', true), json: booleanValue(values, 'json') };
}

export function parseTranscriptArgs(argv: string[]): TranscriptArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, 'session-id': { type: 'string' }, session: { type: 'string' }, tail: { type: 'string' }, follow: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } });
  return { manifestPath: requiredManifest(values, positionals, 'transcript'), sessionId: sessionIdValue(values), tail: stringValue(values, 'tail') === undefined ? undefined : parsePositiveInt(stringValue(values, 'tail')!, '--tail', true), follow: booleanValue(values, 'follow'), json: booleanValue(values, 'json') };
}

export function parseReportArgs(argv: string[]): ReportArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, 'session-id': { type: 'string' }, session: { type: 'string' }, steps: { type: 'string' }, 'md-dir': { type: 'string' }, 'copy-evidence': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } });
  return { manifestPath: requiredManifest(values, positionals, 'report'), sessionId: sessionIdValue(values), stepsPath: stringValue(values, 'steps'), mdDir: stringValue(values, 'md-dir'), copyEvidence: booleanValue(values, 'copy-evidence'), json: booleanValue(values, 'json') };
}

export function parseCleanupArgs(argv: string[]): CleanupArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, 'keep-failed': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } });
  return { manifestPath: requiredManifest(values, positionals, 'cleanup'), keepFailed: booleanValue(values, 'keep-failed'), json: booleanValue(values, 'json') };
}

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const { values, positionals } = parseArgsOrThrow(argv, { manifest: { type: 'string' }, suite: { type: 'string' }, 'keep-failed': { type: 'boolean', default: false }, 'session-id': { type: 'string' }, session: { type: 'string' }, json: { type: 'boolean', default: false } });
  const suite = stringValue(values, 'suite');
  if (suite !== 'isolation' && suite !== 'live-smoke') throw new CliError('invalid_argument', 'verify requires --suite isolation or --suite live-smoke');
  return { manifestPath: requiredManifest(values, positionals, 'verify'), suite, keepFailed: booleanValue(values, 'keep-failed'), sessionId: sessionIdValue(values), json: booleanValue(values, 'json') };
}

let outputManifest: RunManifest | undefined;

function redactText(value: string, manifest?: RunManifest): string {
  let redacted = value.replace(/([?&](?:token|access_token|api_key|apikey|secret|password)=)[^&\s]+/giu, '$1[REDACTED]');
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
  redacted = redacted.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_KEY]');
  if (manifest !== undefined) {
    const refs = manifest.auth.mode === 'api-key-env'
      ? manifest.auth.keys.map(key => process.env[key.env_name]).filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
      : manifest.auth.mode === 'broker'
        ? [process.env[manifest.auth.token_env]].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
        : manifest.auth.mode === 'native-host-broker'
          ? (() => {
              try {
                const token = readManagedBrokerToken(manifest);
                return token === null ? [] : [token];
              } catch {
                return [];
              }
            })()
          : [];
    for (const secret of refs) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function sanitizeValue(value: unknown, manifest?: RunManifest, key = ''): unknown {
  if (typeof value === 'string') return redactText(value, manifest);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, manifest));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:token|secret|password|bearer|refresh_token|api_key|apikey)$/iu.test(name) || /(?:credential|private_key)/iu.test(name)) continue;
    if (name === 'url' && typeof child === 'string' && /[?&](?:token|access_token)=/iu.test(child)) continue;
    result[name] = sanitizeValue(child, manifest, key === '' ? name : `${key}.${name}`);
  }
  return result;
}

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(sanitizeValue(value, outputManifest))}\n`);
}

function outputHuman(message: string, manifest?: RunManifest): void {
  process.stdout.write(`${redactText(message, manifest)}\n`);
}

function progress(message: string, manifest?: RunManifest): void {
  process.stderr.write(`ux-e2e: ${redactText(message, manifest)}\n`);
}

function loadVerifiedManifest(manifestPath: string): RunManifest {
  let manifest: RunManifest;
  try {
    manifest = readManifest(manifestPath);
    verifyManifest(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'manifest_invalid';
    throw new CliError(code, message);
  }
  outputManifest = manifest;
  return manifest;
}

function nextSessionId(): string {
  return `session-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function sessionIds(manifest: RunManifest): string[] {
  const ids = new Set(manifest.sessions.map(session => session.id));
  if (existsSync(manifest.roots.sessions)) {
    for (const entry of readdirSync(manifest.roots.sessions, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  return [...ids];
}

function statusFromInfo(info: SessionInfo): SessionRecord['status'] {
  if (info.status === 'preparing' || info.status === 'ready' || info.status === 'running' ||
    info.status === 'stopped' || info.status === 'failed' || info.status === 'cleaned' || info.status === 'stop_refused') {
    return info.status;
  }
  return 'failed';
}

function sessionRecordFromDisk(manifest: RunManifest, id: string): SessionRecord | null {
  const info = readSessionRecord(manifest, id);
  if (info === null) return null;
  const listed = manifest.sessions.find(session => session.id === id);
  return {
    ...(listed ?? { id }),
    id,
    status: statusFromInfo(info),
    ...(info.pid === null ? {} : { pid: info.pid }),
    ...(info.startMarker === null ? {} : { start_marker: info.startMarker }),
    ...(info.process === undefined ? {} : { process: info.process }),
    transcript_path: info.transcriptPath,
    log_path: info.logPath,
    private_connection_path: info.privateConnectionPath,
  };
}

function validatedSessionInfos(manifest: RunManifest): SessionInfo[] {
  const infos: SessionInfo[] = [];
  for (const id of sessionIds(manifest)) {
    const info = readSessionRecord(manifest, id);
    if (info !== null) infos.push(info);
  }
  return infos;
}

function activeSessionInfos(manifest: RunManifest): SessionInfo[] {
  return validatedSessionInfos(manifest)
    .filter(info => (info.status === 'ready' || info.status === 'running') && pidIsLive(info.pid));
}

function terminalSessionInfos(manifest: RunManifest): SessionInfo[] {
  return validatedSessionInfos(manifest)
    .filter(info => info.status === 'stopped' || info.status === 'failed' || info.status === 'stop_refused' || info.status === 'cleaned')
    .sort((left, right) => {
      const leftAt = left.startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.startedAt);
      const rightAt = right.startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.startedAt);
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt;
      if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(rightAt) ? 1 : -1;
      if (left.startedAt !== right.startedAt) return (right.startedAt ?? '').localeCompare(left.startedAt ?? '');
      return left.sessionId.localeCompare(right.sessionId);
    });
}

type SessionSelectionAction = 'input' | 'ask' | 'transcript';

function selectedSession(manifest: RunManifest, sessionId: string | undefined, action: SessionSelectionAction): SessionRecord {
  if (sessionId !== undefined) {
    const selected = sessionRecordFromDisk(manifest, sessionId);
    if (selected === null) throw new CliError('session_missing', `session ${sessionId} is not registered in the manifest`);
    if ((action === 'input' || action === 'ask')) {
      const info = readSessionRecord(manifest, sessionId);
      if (info === null || !((info.status === 'ready' || info.status === 'running') && pidIsLive(info.pid))) {
        throw new CliError('session_not_active', `session ${sessionId} is not an active session`);
      }
    }
    return selected;
  }
  if (action === 'input' || action === 'ask') {
    const active = activeSessionInfos(manifest);
    if (active.length === 0) throw new CliError('session_missing', 'manifest has no active session; run start first');
    if (active.length > 1) throw new CliError('session_ambiguous', 'manifest has multiple active sessions; pass --session-id');
    return sessionRecordFromDisk(manifest, active[0]!.sessionId)!;
  }
  const active = activeSessionInfos(manifest);
  if (active.length > 1) throw new CliError('session_ambiguous', 'manifest has multiple active sessions; pass --session-id');
  if (active.length === 1) return sessionRecordFromDisk(manifest, active[0]!.sessionId)!;
  const terminal = terminalSessionInfos(manifest)[0];
  if (terminal !== undefined) return sessionRecordFromDisk(manifest, terminal.sessionId)!;
  throw new CliError('session_missing', 'manifest has no session; run start first');
}

function sessionInfo(manifest: RunManifest, sessionId: string | undefined, action: SessionSelectionAction): SessionInfo {
  const selected = selectedSession(manifest, sessionId, action);
  const info = readSessionRecord(manifest, selected.id);
  if (info === null) throw new CliError('session_record_missing', `session ${selected.id} has no readable session record`);
  return info;
}

interface PrivateConnection {
  readonly url: string;
  readonly token: string;
}

function privateConnection(info: SessionInfo): PrivateConnection {
  try {
    const raw = JSON.parse(readFileSync(info.privateConnectionPath, 'utf8')) as Record<string, unknown>;
    if (typeof raw.url !== 'string' || typeof raw.token !== 'string' || raw.token.length === 0 ||
      raw.session_id !== info.sessionId || raw.ws_path !== '/ws') {
      throw new Error('invalid connection record');
    }
    const parsed = new URL(raw.url);
    const port = Number(parsed.port);
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' &&
      parsed.username === '' && parsed.password === '' && parsed.pathname === '/' &&
      parsed.hash === '' && Number.isInteger(port) && port > 0 && port <= 65535 &&
      parsed.searchParams.getAll('token').length === 1 && parsed.searchParams.get('token') === raw.token) {
      return { url: parsed.toString(), token: raw.token };
    }
  } catch {
    /* Missing or tampered private metadata never supplies a remote URL. */
  }
  throw new CliError('session_connection_invalid', 'private session connection metadata is unavailable or unsafe');
}

function connectionUrl(info: SessionInfo): string {
  return privateConnection(info).url;
}

function cleanSessionEvidence(manifest: RunManifest, sessionId: string): boolean {
  try {
    const record = readManifestSessionRecord(manifest, sessionId);
    const termination = record?.termination;
    if (
      record === null ||
      record.status !== 'stopped' ||
      record.ready !== true ||
      termination === undefined ||
      termination.observed !== true ||
      termination.forced !== false ||
      record.readiness?.typed_rpc_ready !== true
    ) return false;
    if (!isCleanSessionTermination(record.exit_code, record.exit_signal, termination, record.process !== undefined)) return false;
    const frames: Array<Record<string, unknown>> = [];
    for (const line of readFileSync(record.transcript_path, 'utf8').split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const frame = parsed as Record<string, unknown>;
      if (typeof frame.ts !== 'string' || frame.ts.length === 0) return false;
      if (frame.t === 'o' || frame.t === 'i') {
        if (typeof frame.d !== 'string') return false;
      } else if (frame.t === 'err') {
        if (typeof frame.code !== 'string' || ('message' in frame && typeof frame.message !== 'string')) return false;
      } else if (frame.t === 'exit') {
        if (typeof frame.code !== 'number' || !Number.isSafeInteger(frame.code) || frame.code < 0 ||
          ('signal' in frame && (typeof frame.signal !== 'number' || !Number.isSafeInteger(frame.signal) || frame.signal < 0))) return false;
      } else {
        return false;
      }
      frames.push(frame);
    }
    const exits = frames.filter(frame => frame.t === 'exit');
    if (exits.length !== 1 || frames[frames.length - 1] !== exits[0]) return false;
    const exit = exits[0]!;
    const signalAllowed = !Object.prototype.hasOwnProperty.call(exit, 'signal')
      ? record.exit_signal === undefined
      : record.exit_signal !== undefined && exit.signal === record.exit_signal;
    return exit.code === record.exit_code && signalAllowed;
  } catch {
    return false;
  }
}


export async function runPrepare(args: PrepareArgs): Promise<number> {
  const result = await prepareRun(args.configPath, args.runId);
  const payload = { ok: result.ok, status: result.status, ...(result.manifestPath === undefined ? {} : { manifest_path: result.manifestPath }), ...(result.manifest === undefined ? {} : { manifest: result.manifest }), ...(result.nextCommand === undefined ? {} : { next_command: result.nextCommand }), ...(result.error === undefined ? {} : { error: result.error }) };
  if (args.json) outputJson(payload);
  else outputHuman(result.ok ? `prepared ${result.manifestPath ?? args.runId}; next: ${result.nextCommand ?? 'doctor'}` : `prepare failed: ${result.error?.message ?? 'unknown error'}`);
  return result.ok ? 0 : 1;
}

export async function runDoctor(args: DoctorArgs): Promise<number> {
  const result = await doctorRun(args.manifestPath);
  const payload = { ok: result.ok, status: result.status, ...(result.manifestPath === undefined ? {} : { manifest_path: result.manifestPath }), ...(result.manifest === undefined ? {} : { manifest: result.manifest }), ...(result.checks === undefined ? {} : { checks: result.checks }), ...(result.nextCommand === undefined ? {} : { next_command: result.nextCommand }), ...(result.error === undefined ? {} : { error: result.error }) };
  if (args.json) outputJson(payload);
  else outputHuman(result.ok ? `doctor passed; next: ${result.nextCommand ?? 'start'}` : `doctor ${result.status}: ${result.error?.message ?? 'blocked'}`);
  return result.ok ? 0 : 1;
}

async function driveForeground(session: TestSession, manifest: RunManifest): Promise<number> {
  const log = new TranscriptLog(session.transcriptPath);
  let stopping = false;
  const stop = (signal: number, code: number): void => {
    if (stopping) return;
    stopping = true;
    void session.close({ code, signal, status: 'failed', reason: 'operator interrupted session' }).catch(() => undefined);
  };
  const onSigint = (): void => stop(2, 130);
  const onSigterm = (): void => stop(15, 143);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    for (;;) {
      log.refresh();
      if (stopping) return 130;
      const last = log.frames[log.frames.length - 1];
      if (last !== undefined && last.t === 'exit') {
        const info = readSessionRecord(manifest, session.sessionId);
        if (info?.status === 'failed' || info?.status === 'stop_refused') return last.code === 0 ? 1 : last.code;
        return last.code;
      }
      const { promise, resolve: tick } = deferred<void>();
      setTimeout(tick, 500);
      await promise;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    await session.close();
  }
}

export const DETACH_LOG_TAIL_BYTES = 8 * 1024;

export function detachLogPath(manifest: RunManifest): string {
  return join(manifest.roots.logs, 'detach.log');
}

export function tailLogFile(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '';
  const body = readFileSync(path, 'utf8');
  return Buffer.byteLength(body, 'utf8') <= maxBytes ? body : body.slice(-maxBytes);
}

async function runStartForeground(args: StartArgs, manifest: RunManifest, sessionId: string): Promise<number> {
  const active = manifest.sessions.find(session => session.status === 'running');
  if (active !== undefined) {
    const info = readSessionRecord(manifest, active.id);
    if (info !== null && pidIsLive(info.pid)) assertNoLiveSession(manifest, active.id);
  }
  const session = await startTestSession({
    manifest,
    sessionId,
    surface: args.surface,
    port: args.port,
    cols: args.cols,
    rows: args.rows,
    idleMs: args.idleMs,
    maxTimeSec: args.maxTimeSec,
    scenario: { id: manifest.scenario.id },
  });
  if (args.json) outputJson({ ok: true, status: 'running', run_id: session.runId, session_id: session.sessionId, transcript_path: session.transcriptPath, log_path: session.logPath, next_command: `ux-e2e stop --manifest ${args.manifestPath} --session-id ${session.sessionId}` });
  else outputHuman(`session ${session.sessionId} started; terminal URL: ${session.url}; transcript: ${session.transcriptPath}`, manifest);
  return await driveForeground(session, manifest);
}

async function waitForDetached(manifest: RunManifest, sessionId: string, timeoutMs = 60_000): Promise<SessionInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readSessionRecord(manifest, sessionId);
    if (info?.status === 'failed' || info?.status === 'stop_refused') {
      throw new CliError('session_start_failed', `session ${sessionId} failed before native readiness`);
    }
    if (info?.status === 'running' && info.ready && pidIsLive(info.pid)) {
      const { promise, resolve: settle } = deferred<void>();
      setTimeout(settle, 350);
      await promise;
      const stable = readSessionRecord(manifest, sessionId);
      if (stable?.status === 'running' && stable.ready && pidIsLive(stable.pid)) return stable;
    }
    if (Date.now() >= deadline) throw new CliError('session_start_timeout', `timed out waiting for session ${sessionId}`);
    const { promise, resolve: tick } = deferred<void>();
    setTimeout(tick, 250);
    await promise;
  }
}

export function buildDetachedWorkerEnvironment(
  manifest: RunManifest,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', ...ENV_ALLOWLIST]) {
    const value = baseEnv[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  if (manifest.auth.mode === 'native-host-broker') {
    Object.assign(env, hostProfileEnvironment(baseEnv));
  }
  env.OMP_E2E_ROOT = resolve(manifest.roots.run, '..', '..');
  const authNames = manifest.auth.mode === 'api-key-env'
    ? manifest.auth.keys.map(key => key.env_name)
    : manifest.auth.mode === 'broker'
      ? [manifest.auth.token_env]
      : [];
  for (const name of authNames) {
    if (!isSafeAuthEnvironmentKey(name)) {
      throw new CliError('invalid_auth_environment', 'manifest authentication environment is not allowed for a detached worker');
    }
    const value = baseEnv[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}

async function runStartDetached(args: StartArgs, manifest: RunManifest, sessionId: string): Promise<number> {
  const cliPath = fileURLToPath(import.meta.url);
  const childArgs = [cliPath, 'start', '--manifest', args.manifestPath, '--session-id', sessionId, '--surface', args.surface, '--port', String(args.port), '--cols', String(args.cols), '--rows', String(args.rows), '--max-time', `${args.maxTimeSec}s`, '--idle-ms', String(args.idleMs)];
  const logPath = detachLogPath(manifest);
  const fd = openSync(logPath, 'a');
  try {
    writeSync(fd, `\n--- ux-e2e detached start @ ${new Date().toISOString()} ---\n`);
  } finally {
    closeSync(fd);
  }
  const stdoutFd = openSync(logPath, 'a');
  const stderrFd = openSync(logPath, 'a');
  const workerEnv = buildDetachedWorkerEnvironment(manifest);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, childArgs, {
      detached: true,
      // The supervisor resolves native host-profile paths; keep the caller's
      // cwd so relative profile selectors retain their prepared meaning.
      cwd: process.cwd(),
      env: workerEnv,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  child.unref();
  const info = await waitForDetached(manifest, sessionId);
  // Validate the private record before offering a handoff, without exposing
  // the bearer URL in JSON or logs controlled by the invoking shell.
  connectionUrl(info);
  if (args.json) outputJson({ ok: true, status: 'running', run_id: manifest.run_id, session_id: sessionId, connection_path: info.privateConnectionPath, next_command: `ux-e2e stop --manifest ${args.manifestPath} --session-id ${sessionId}` });
  else outputHuman(`detached session ${sessionId} started; open the localhost URL in private connection file ${info.privateConnectionPath}`, manifest);
  return 0;
}

export async function runStart(args: StartArgs): Promise<number> {
  const readiness = await doctorRun(args.manifestPath);
  if (!readiness.ok) {
    throw new CliError(readiness.error?.code ?? 'run_not_ready', readiness.error?.message ?? 'prepared run did not pass integrity and auth checks');
  }
  const manifest = readiness.manifest ?? loadVerifiedManifest(args.manifestPath);
  if (manifest.status === 'cleaned' || manifest.status === 'finalized') throw new CliError('run_not_startable', `run status ${manifest.status} cannot start a new session`);
  const sessionId = args.sessionId ?? nextSessionId();
  for (const existingId of sessionIds(manifest)) {
    if (existingId === sessionId) continue;
    const info = readSessionRecord(manifest, existingId);
    if (info !== null && pidIsLive(info.pid)) {
      throw new CliError('session_active', `live session ${existingId} must be stopped before starting another session`);
    }
  }
  return args.detach ? runStartDetached(args, manifest, sessionId) : runStartForeground(args, manifest, sessionId);
}

export async function runStop(args: StopArgs): Promise<number> {
  const manifest = loadVerifiedManifest(args.manifestPath);
  let selectedIds: string[];
  if (args.sessionId !== undefined) {
    if (sessionRecordFromDisk(manifest, args.sessionId) === null) {
      throw new CliError('session_missing', `session ${args.sessionId} is not registered in the manifest`);
    }
    selectedIds = [args.sessionId];
  } else {
    const active = activeSessionInfos(manifest);
    if (active.length > 1) throw new CliError('session_ambiguous', 'manifest has multiple active sessions; pass --session-id');
    selectedIds = active.length === 0 ? [] : [active[0]!.sessionId];
  }
  if (selectedIds.length === 0) {
    if (args.json) outputJson({ ok: true, status: 'stopped', stopped: [] });
    else outputHuman('no active session', manifest);
    return 0;
  }
  const stopped: string[] = [];
  for (const sessionId of selectedIds) {
    let info = readSessionRecord(manifest, sessionId);
    if (info === null) throw new CliError('session_record_missing', `session ${sessionId} has no readable session record`);
    if (info.status === 'stopped' && cleanSessionEvidence(manifest, sessionId)) {
      stopped.push(sessionId);
      continue;
    }
    if (info.status === 'failed' || info.status === 'stop_refused' || info.status === 'cleaned') {
      throw new CliError('session_failed', `session ${sessionId} does not have a clean terminal outcome`);
    }
    let ownerUnavailable = false;
    try {
      const connection = privateConnection(info);
      await requestSessionStop({
        url: connection.url,
        token: connection.token,
        request: { run_id: manifest.run_id, session_id: sessionId },
      });
    } catch (error) {
      if (error instanceof SessionStopError && error.kind === 'refused') {
        throw new CliError('stop_refused', 'session owner rejected the stop request');
      }
      if (error instanceof SessionStopError && error.kind === 'unavailable') {
        ownerUnavailable = true;
      } else if (error instanceof CliError && error.code === 'session_connection_invalid') {
        ownerUnavailable = true;
      } else {
        throw new CliError('stop_failed', 'session stop request failed');
      }
    }
    if (!ownerUnavailable) {
      info = readSessionRecord(manifest, sessionId);
      if (info !== null && info.status === 'stopped' && cleanSessionEvidence(manifest, sessionId)) {
        stopped.push(sessionId);
        continue;
      }
      throw new CliError('stop_evidence_incomplete', 'session owner did not persist complete clean stop evidence');
    }

    info = readSessionRecord(manifest, sessionId);
    if (info !== null && info.status === 'stopped' && cleanSessionEvidence(manifest, sessionId)) {
      stopped.push(sessionId);
      continue;
    }
    if (info === null) throw new CliError('session_record_missing', `session ${sessionId} has no readable session record`);
    if (info.status === 'failed' || info.status === 'stop_refused' || info.status === 'cleaned') {
      throw new CliError('session_failed', `session ${sessionId} does not have a clean terminal outcome`);
    }
    if (info.process === undefined || info.pid === null) {
      throw new CliError('process_identity_ambiguous', `session ${sessionId} has no verified process ownership receipt`);
    }
    const cwd = resolve(manifest.roots.run, info.process.cwd_relative);
    if (!pathContained(manifest.roots.run, cwd)) {
      throw new CliError('process_cwd_outside_run', `session ${sessionId} cwd is outside the run root`);
    }
    let recovery: KillProcessTreeResult;
    try {
      recovery = await killProcessTree(info.pid, {
        manifest,
        sessionId,
        receipt: info.process,
        executablePath: manifest.runtime.binary,
        executableDigest: manifest.runtime.digest,
        cwd,
      });
    } catch {
      throw new CliError('stop_recovery_failed', 'session owner was unreachable and verified recovery failed');
    }
    try {
      const record = readManifestSessionRecord(manifest, sessionId);
      if (record === null) throw new Error('session_record_missing');
      writeSessionRecord(manifest, sessionId, {
        ...record,
        status: 'failed',
        exit_code: record.exit_code ?? info.exit_code ?? 1,
        termination: {
          requested: 'recovery',
          requested_signal: 15,
          forced: recovery.forced,
          observed: false,
        },
      });
    } catch {
      throw new CliError('stop_recovery_failed', 'session owner was unreachable and failed evidence could not be persisted');
    }
    throw new CliError('stop_owner_unreachable', 'session owner was unreachable; recovered session is recorded as failed');
  }
  if (args.json) outputJson({ ok: true, status: 'stopped', stopped });
  else outputHuman(`stopped sessions: ${stopped.join(', ')}`, manifest);
  return 0;
}

export async function runInput(args: InputArgs, createDriver: (url: string, transcriptPath: string) => Pick<WsDriver, 'open' | 'type' | 'pressEnter' | 'close'> = (url, transcriptPath) => new WsDriver({ url, transcriptPath })): Promise<number> {
  const manifest = loadVerifiedManifest(args.manifestPath);
  const info = sessionInfo(manifest, args.sessionId, 'input');
  const url = connectionUrl(info);
  const driver = createDriver(url, info.transcriptPath);
  await driver.open();
  try {
    await driver.type(args.text);
    await driver.pressEnter();
  } finally {
    await driver.close();
  }
  if (args.json) outputJson({ ok: true, status: 'sent', session_id: info.sessionId });
  else outputHuman(`input sent to session ${info.sessionId}`, manifest);
  return 0;
}

export async function runAsk(args: AskArgs): Promise<number> {
  const manifest = loadVerifiedManifest(args.manifestPath);
  const info = sessionInfo(manifest, args.sessionId, 'ask');
  const url = connectionUrl(info);
  const askStatePath = join(join(info.transcriptPath, '..'), 'ask-state.jsonl');
  const tracker = new AskStateTracker(info.transcriptPath, askStatePath);
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
  const found = await waitForPending();
  const pending = tracker.pendingBlock();
  if (args.list || args.answer === undefined) {
    if (args.json) outputJson({ ok: true, status: pending === null ? 'none' : 'pending', session_id: info.sessionId, ...(pending === null ? {} : { prompt: pending }) });
    else if (pending === null || !found) outputHuman('no pending [ask_user] prompt', manifest);
    else outputHuman(`[ask_user #${pending.index}] ${pending.title}\n${pending.options.join('\n')}`, manifest);
    return 0;
  }
  if (!found || pending === null) throw new CliError('ask_prompt_missing', 'no pending [ask_user] prompt to answer');
  const result = tracker.answer(args.answer);
  if (!result.ok) throw new CliError('ask_refused', result.reason);
  const driver = new WsDriver({ url, transcriptPath: info.transcriptPath });
  await driver.open();
  try {
    await driver.type(args.answer);
    await driver.pressEnter();
  } finally {
    await driver.close();
  }
  if (args.json) outputJson({ ok: true, status: 'answered', session_id: info.sessionId, prompt_index: result.block.index });
  else outputHuman(`answered [ask_user #${result.block.index}] in session ${info.sessionId}`, manifest);
  return 0;
}

function renderTranscript(path: string, manifest?: RunManifest): string {
  if (!existsSync(path)) return '';
  const out: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const frame = JSON.parse(line) as { t?: string; d?: unknown; code?: unknown; signal?: unknown; message?: unknown };
      if (frame.t === 'o' && typeof frame.d === 'string') out.push(redactText(frame.d, manifest));
      else if (frame.t === 'i' && typeof frame.d === 'string') out.push(`[in] ${redactText(frame.d, manifest)}`);
      else if (frame.t === 'exit') out.push(`[exit code=${String(frame.code)}${frame.signal === undefined ? '' : ` signal=${String(frame.signal)}`}]
`);
      else if (frame.t === 'err') out.push(`[err ${String(frame.code)}${typeof frame.message === 'string' ? `: ${redactText(frame.message, manifest)}` : ''}]\n`);
    } catch {
      /* Ignore a partially written final JSONL frame. */
    }
  }
  return out.join('');
}

export async function runTranscript(args: TranscriptArgs): Promise<number> {
  const manifest = loadVerifiedManifest(args.manifestPath);
  const info = sessionInfo(manifest, args.sessionId, 'transcript');
  const rendered = renderTranscript(info.transcriptPath, manifest);
  const text = args.tail === undefined ? rendered : rendered.split('\n').slice(-args.tail).join('\n');
  if (args.json) outputJson({ ok: true, status: 'ok', session_id: info.sessionId, transcript: text });
  else process.stdout.write(`${text}${text.length === 0 || !text.endsWith('\n') ? '\n' : ''}`);
  if (args.follow) {
    let lastLength = existsSync(info.transcriptPath) ? readFileSync(info.transcriptPath, 'utf8').length : 0;
    for (;;) {
      const { promise, resolve: tick } = deferred<void>();
      setTimeout(tick, 500);
      await promise;
      if (!existsSync(info.transcriptPath)) continue;
      const current = readFileSync(info.transcriptPath, 'utf8');
      if (current.length <= lastLength) continue;
      const delta = redactText(current.slice(lastLength), manifest);
      if (args.json) progress(delta, manifest);
      else process.stdout.write(delta);
      lastLength = current.length;
    }
  }
  return 0;
}

function readReportInput(path: string | undefined, manifest: RunManifest): ReportInput {
  if (path === undefined) {
    const verdict: Verdict = manifest.status === 'failed' ? 'FAIL' : 'CONDITIONAL';
    return { steps: [], defects: [], agent_quality: { rating: 0, rationale: 'not assessed' }, verdict, overall: { summary: 'Report generated from registered manifest/session evidence.' } };
  }
  if (!existsSync(path)) throw new CliError('steps_missing', `steps file not found: ${path}`);
  let raw: Partial<ReportInput>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReportInput>;
  } catch {
    throw new CliError('steps_invalid', `steps file is not valid JSON: ${path}`);
  }
  return { steps: Array.isArray(raw.steps) ? raw.steps : [], defects: Array.isArray(raw.defects) ? raw.defects : [], agent_quality: raw.agent_quality ?? { rating: 0, rationale: 'not assessed' }, verdict: raw.verdict ?? 'CONDITIONAL', overall: raw.overall ?? { summary: 'Report generated from registered manifest/session evidence.' }, regressions: raw.regressions ?? [] };
}

export async function runReport(args: ReportArgs): Promise<number> {
  const manifest = loadVerifiedManifest(args.manifestPath);
  const input = readReportInput(args.stepsPath, manifest);
  const result = generateReport(args.manifestPath, input, { mdDir: args.mdDir, copyEvidence: args.copyEvidence, sessionId: args.sessionId });
  if (args.json) outputJson({ ok: true, status: 'reported', report: result });
  else outputHuman(`report JSON: ${result.jsonPath}\nreport Markdown: ${result.mdPath}`, manifest);
  for (const warning of result.warnings) progress(warning, manifest);
  return 0;
}

export async function runCleanup(args: CleanupArgs): Promise<number> {
  const result = await cleanupRun({ manifestPath: args.manifestPath, keepFailed: args.keepFailed });
  if (args.json) outputJson({ ok: result.ok, status: result.status, removed: result.removed, retained: result.retained, ...(result.error === undefined ? {} : { error: result.error }) });
  else outputHuman(result.ok ? `cleanup ${result.status}; retained: ${result.retained.join(', ')}` : `cleanup refused: ${result.error?.message ?? 'unknown error'}`);
  return result.ok ? 0 : 1;
}

export async function runVerify(args: VerifyArgs): Promise<number> {
  const result = await verifyRun({ manifestPath: args.manifestPath, suite: args.suite, keepFailed: args.keepFailed, sessionId: args.sessionId });
  if (args.json) outputJson(result);
  else outputHuman(`${args.suite}: ${result.status}${result.errors.length === 0 ? '' : ` — ${result.errors.map(error => error.message).join('; ')}`}`);
  return result.status === 'passed' ? 0 : 1;
}

export async function runAuthBroker(argv: string[]): Promise<number> {
  const action = argv[0];
  if (action !== 'ensure' && action !== 'status' && action !== 'stop') {
    throw new CliError('invalid_argument', 'auth-broker requires ensure, status, or stop');
  }
  const { values, positionals } = parseArgsOrThrow(argv.slice(1), {
    manifest: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const manifest = loadVerifiedManifest(requiredManifest(values, positionals, 'auth-broker'));
  if (manifest.auth.mode !== 'native-host-broker') throw new CliError('auth_mode_invalid', 'managed broker requires native-host-broker authorization');
  const json = booleanValue(values, 'json');
  if (action === 'ensure') {
    const broker = await ensureManagedBroker(manifest);
    const payload = { ok: true, status: broker.status, url: broker.url, provider: broker.provider };
    if (json) outputJson(payload);
    else outputHuman(`native broker ${broker.status} at ${broker.url}`, manifest);
    return 0;
  }
  if (action === 'stop') {
    await stopManagedBroker(manifest);
    if (json) outputJson({ ok: true, status: 'stopped' });
    else outputHuman('managed native broker stopped', manifest);
    return 0;
  }
  const status = await managedBrokerStatus(manifest);
  if (json) outputJson({ ok: status.status === 'running', ...status });
  else outputHuman(`managed native broker: ${status.status}`, manifest);
  return status.status === 'running' ? 0 : 1;
}

export type MainResult = Promise<number>;

export async function main(argv: string[]): Promise<number> {
  outputManifest = undefined;
  const jsonRequested = argv.includes('--json');
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    if (jsonRequested) outputJson({ ok: true, usage: USAGE });
    else printUsage(process.stdout);
    return 0;
  }
  try {
    if (hasLegacyScratch(argv)) throw migrationError(subcommand);
    if (subcommand === 'bootstrap') throw migrationError('bootstrap');
    switch (subcommand) {
      case 'prepare': return await runPrepare(parsePrepareArgs(argv.slice(1)));
      case 'doctor': return await runDoctor(parseDoctorArgs(argv.slice(1)));
      case 'start': return await runStart(parseStartArgs(argv.slice(1)));
      case 'stop': return await runStop(parseStopArgs(argv.slice(1)));
      case 'input': return await runInput(parseInputArgs(argv.slice(1)));
      case 'ask': return await runAsk(parseAskArgs(argv.slice(1)));
      case 'transcript': return await runTranscript(parseTranscriptArgs(argv.slice(1)));
      case 'report': return await runReport(parseReportArgs(argv.slice(1)));
      case 'cleanup': return await runCleanup(parseCleanupArgs(argv.slice(1)));
      case 'verify': return await runVerify(parseVerifyArgs(argv.slice(1)));
      case 'auth-broker': return await runAuthBroker(argv.slice(1));
      default:
        throw new CliError('unknown_subcommand', `unknown subcommand "${subcommand}"`);
    }
  } catch (error) {
    const detail = error instanceof CliError ? { code: error.code, message: error.message, details: error.details } : { code: 'cli_failed', message: error instanceof Error ? error.message : String(error) };
    if (jsonRequested) outputJson({ ok: false, error: detail });
    else process.stderr.write(`ux-e2e: ${redactText(detail.message)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
