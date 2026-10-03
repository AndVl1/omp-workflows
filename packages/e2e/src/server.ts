/**
 * UX E2E test server — localhost HTTP+WS bridge to a real omp PTY session.
 *
 * Hosts one HTTP+WS server on a loopback address with an ephemeral port,
 * serves a browser page (xterm) that talks to a single PTY running omp
 * with the omp-workflows plugin, and appends every PTY output frame to a
 * server-side `transcript.jsonl` — the evidence backbone for the report.
 *
 * Security posture (ported from @pi-harness/web-terminal, MIT):
 *   - session-scoped 256-bit token in `?token=` (URL-safe base64), valid only
 *     while the localhost-only session is alive;
 *   - Origin header (when present) must match the server's own origin,
 *     Host header must match exactly;
 *   - X-Frame-Options: DENY, Referrer-Policy: no-referrer, strict CSP;
 *   - per-connection rate limiter caps inbound messages per rolling window;
 *   - idle timer closes the session after no inbound traffic;
 *   - process-tree kill on shutdown (SIGTERM -> SIGKILL);
 *   - 64 KiB max inbound WS frame; no file API exposed.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { IPty } from 'node-pty';
import { WebSocketServer, type WebSocket as WS } from 'ws';

import { verifyPackageArtifact } from './artifacts.js';
import { verifyManifest, type ProcessReceipt, type RunManifest } from './manifest.js';
import {
  assertSafeRunPath,
  acquireRunLease,
  acquireSessionLease,
  buildChildEnvironment,
  ensureManifestRoots,
  isolationReceipt,
  isCleanSessionTermination,
  manifestRoots,
  readSessionRecord as readManifestSessionRecord,
  readRunLeaseOwnership,
  runtimeBinaryOf,
  sessionPaths,
  verifyRuntimeBinary,
  writeSessionRecord,
  type RunLease,
  type SessionPaths,
  type SessionTermination,
} from './environment.js';
import { providerRequiredForManifest, resolveLaunchAuthEnvironment, type AuthResolution } from './auth.js';
import { probeProviderFreeRuntime, verifyRuntimeSnapshot, writeProviderFreeCatalog, type RuntimeSnapshot } from './runtime.js';


import { deferred } from './util.js';
/** Max inbound WS frame size (defense-in-depth; the browser never needs more). */
export const MAX_INBOUND_WS_BYTES = 64 * 1024;
/**
 * Host variables which are never allowed to cross the PTY boundary. The
 * manifest-aware launch path uses buildChildEnvironment; this compatibility
 * helper remains deliberately restrictive for callers that exercise the
 * PTY seam directly.
 */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

const SAFE_PTY_BASE_KEYS = new Set([
  'CI',
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM',
  'TZ',
]);

/**
 * Build a deliberately small environment for direct PTY seam callers.
 * Manifest launches use buildChildEnvironment, which additionally pins all
 * run roots. No host OMP/PI/config/module variables are copied here.
 */
export function buildPtyEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> | undefined,
  _opts: { readonly keepProxyEnv?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_PTY_BASE_KEYS) {
    const value = baseEnv[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (SAFE_PTY_BASE_KEYS.has(key) && value.length > 0) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  return env;
}

/** Session evidence stays private and must never follow a substituted symlink. */
export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;

function sessionFile(path: string, body: string, root: string, append: boolean): void {
  assertSafeRunPath(root, path, 'session evidence');
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW |
    (append ? fsConstants.O_APPEND : fsConstants.O_EXCL);
  const fd = openSync(path, flags, SESSION_FILE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('session evidence is not a regular file');
    fchmodSync(fd, SESSION_FILE_MODE);
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

function writeSessionFile(path: string, body: string, root: string): void {
  sessionFile(path, body, root, false);
}

function appendSessionFile(path: string, body: string, root: string): void {
  sessionFile(path, body, root, true);
}

/**
 * Strip ANSI escapes and lone C0 control chars from a value destined for
 * a JSON file (session.json / report). Keeps \t \n \r at the byte level
 * (they're harmless in JSON) but drops the ESC (0x1b) sequence and
 * embedded BEL/BS/VT/FF that downstream renderers can mishandle.
 */
export function sanitizeForJson(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
}
/* ------------------------------------------------------------------ */
/* Token primitives                                                    */
/* ------------------------------------------------------------------ */

const TOKEN_BYTES = 32;

/** Convert raw bytes to a URL-safe base64 string (no padding). */
function toUrlSafeBase64(buf: Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

/** Mint a fresh 256-bit URL-safe token. */
export function mintToken(): string {
  return toUrlSafeBase64(randomBytes(TOKEN_BYTES));
}

/**
 * Constant-time string comparison. Both inputs are UTF-8 encoded; a
 * length mismatch still performs a dummy comparison to keep timing flat.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Rate limiting + idle timer                                          */
/* ------------------------------------------------------------------ */

export interface RateLimitOptions {
  /** Max inbound messages per `windowMs`. Default 200. */
  readonly maxMessages?: number;
  /** Window length in ms. Default 1000. */
  readonly windowMs?: number;
}

/** Rolling-window inbound message rate limiter (per connection). */
export class RateLimiter {
  readonly #maxMessages: number;
  readonly #windowMs: number;
  readonly #samples: number[] = [];

  constructor(opts: RateLimitOptions = {}) {
    this.#maxMessages = opts.maxMessages ?? 200;
    this.#windowMs = opts.windowMs ?? 1000;
  }

  /** Record one inbound event. Returns true if the limit is respected. */
  record(now: number = Date.now()): boolean {
    const cutoff = now - this.#windowMs;
    while (this.#samples.length > 0 && (this.#samples[0] ?? 0) <= cutoff) {
      this.#samples.shift();
    }
    if (this.#samples.length >= this.#maxMessages) return false;
    this.#samples.push(now);
    return true;
  }

  /** Number of messages observed in the current window. */
  observed(now: number = Date.now()): number {
    const cutoff = now - this.#windowMs;
    let n = 0;
    for (const t of this.#samples) if (t > cutoff) n += 1;
    return n;
  }
}

export interface IdleTimerOptions {
  /** Idle window in ms; default 5 minutes. */
  readonly idleMs?: number;
  /** Invoked when the timer fires — typically closes the socket. */
  readonly onIdle: () => void;
}

/** Idle timer — resets on every `bump()`, fires `onIdle` after `idleMs` of silence. */
export class IdleTimer {
  readonly #idleMs: number;
  readonly #onIdle: () => void;
  #handle: NodeJS.Timeout | null = null;
  #fired = false;

  constructor(opts: IdleTimerOptions) {
    this.#idleMs = opts.idleMs ?? 5 * 60 * 1000;
    this.#onIdle = opts.onIdle;
  }

  /** Reset the idle countdown. Safe to call from any context. */
  bump(): void {
    if (this.#fired) return;
    if (this.#handle !== null) clearTimeout(this.#handle);
    const h = setTimeout(() => {
      this.#fired = true;
      this.#onIdle();
    }, this.#idleMs);
    if (typeof (h as { unref?: () => void }).unref === 'function') {
      (h as { unref: () => void }).unref();
    }
    this.#handle = h;
  }

  /** Stop counting and fire `onIdle` immediately (used on explicit shutdown). */
  fireNow(): void {
    if (this.#fired) return;
    this.#fired = true;
    if (this.#handle !== null) clearTimeout(this.#handle);
    this.#onIdle();
  }

  /** True if the idle timeout has already fired. */
  get fired(): boolean {
    return this.#fired;
  }
}

/* ------------------------------------------------------------------ */
/* Process-tree kill                                                   */
/* ------------------------------------------------------------------ */

export interface KillProcessTreeOptions {
  /** Time to wait between SIGTERM and SIGKILL. Default 500ms. */
  readonly graceMs?: number;
  /** Both a private run lease and a matching live process receipt are mandatory. */
  readonly manifest: RunManifest;
  readonly sessionId: string;
  readonly receipt: ProcessReceipt;
  readonly executablePath?: string;
  readonly executableDigest?: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  /** Invoked after a verified SIGTERM is sent to the owned process group. */
  readonly onSignalStarted?: () => void;
}

interface ProcessGroupMember {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startMarker: string;
}

interface ProcessGroupSnapshot {
  readonly pgid: number;
  readonly members: readonly ProcessGroupMember[];
}

function processGroupMembers(pgid: number): ProcessGroupMember[] | null {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 0) return null;
  try {
    const raw = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,pgid=,lstart='], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      timeout: 1500,
      maxBuffer: 1024 * 1024,
    });
    const members: ProcessGroupMember[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 8) continue;
      const observedPid = Number(fields[0]);
      const observedPpid = Number(fields[1]);
      const observedPgid = Number(fields[2]);
      if (!Number.isInteger(observedPid) || !Number.isInteger(observedPpid) || !Number.isInteger(observedPgid) || observedPgid !== pgid) continue;
      members.push({
        pid: observedPid,
        ppid: observedPpid,
        pgid: observedPgid,
        startMarker: fields.slice(3, 8).join(' '),
      });
    }
    return members;
  } catch {
    return null;
  }
}
function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}


function memberWasOwnedByLeader(member: ProcessGroupMember, byPid: ReadonlyMap<number, ProcessGroupMember>, leaderPid: number): boolean {
  if (member.pid === leaderPid) return true;
  const visited = new Set<number>();
  let parentPid = member.ppid;
  while (parentPid !== leaderPid) {
    if (visited.has(parentPid)) return false;
    visited.add(parentPid);
    const parent = byPid.get(parentPid);
    if (parent === undefined) return false;
    parentPid = parent.ppid;
  }
  return true;
}

function snapshotProcessGroup(receipt: ProcessReceipt): ProcessGroupSnapshot {
  if (receipt.pgid === null || receipt.pgid !== receipt.pid) throw new Error('process_identity_ambiguous');
  const members = processGroupMembers(receipt.pgid);
  if (members === null) throw new Error('process_identity_ambiguous');
  const leader = members.find(member => member.pid === receipt.pid);
  if (leader === undefined || leader.startMarker !== receipt.start_marker || leader.pgid !== receipt.pgid) {
    throw new Error('process_identity_ambiguous');
  }
  const byPid = new Map(members.map(member => [member.pid, member] as const));
  if (members.some(member => !memberWasOwnedByLeader(member, byPid, receipt.pid))) {
    throw new Error('process_identity_ambiguous');
  }
  return { pgid: receipt.pgid, members };
}

function groupMatchesSnapshot(snapshot: ProcessGroupSnapshot, current: readonly ProcessGroupMember[]): boolean {
  return current.every(member => snapshot.members.some(expected =>
    expected.pid === member.pid &&
    expected.pgid === member.pgid &&
    expected.startMarker === member.startMarker));
}


export interface KillProcessTreeResult {
  readonly forced: boolean;
}

/** Stop only a process group whose recorded identity still matches its live process. */
export async function killProcessTree(pid: number, opts: KillProcessTreeOptions): Promise<KillProcessTreeResult> {
  const runtime = await verifyRuntimeBinary(opts.manifest);
  if (!runtime.ok ||
    opts.receipt.executable_digest !== runtime.digest ||
    opts.receipt.executable_digest !== opts.manifest.runtime.digest ||
    !Number.isInteger(pid) || pid <= 0 || opts.receipt.pid !== pid ||
    opts.receipt.pgid !== pid) {
    throw new Error('process_identity_ambiguous');
  }

  /*
   * A dead leader cannot prove that a still-existing process group is ours:
   * the PID and group ID may already have been reused.  A typed receipt is
   * still sufficient to confirm that the group is gone, but never sufficient
   * to signal an unobserved survivor.
   */
  if (!pidIsLive(pid)) {
    const members = processGroupMembers(opts.receipt.pgid);
    if (members === null || members.length > 0 || processGroupExists(opts.receipt.pgid)) throw new Error('process_identity_ambiguous');
    return { forced: false };
  }

  const ownership = readRunLeaseOwnership(opts.manifest, opts.sessionId);
  if (ownership === null || ownership.ownerNonce !== opts.receipt.owner_nonce ||
    !verifyProcessReceipt(opts.receipt, opts)) {
    throw new Error('process_identity_ambiguous');
  }
  const snapshot = snapshotProcessGroup(opts.receipt);
  const graceMs = opts.graceMs ?? 500;
  try {
    process.kill(-snapshot.pgid, 'SIGTERM');
    opts.onSignalStarted?.();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('process_signal_failed');
  }
  const { promise: slept, resolve: finishSleep } = deferred<void>();
  setTimeout(finishSleep, graceMs);
  await slept;

  const current = processGroupMembers(snapshot.pgid);
  if (current === null) throw new Error('process_identity_ambiguous');
  if (current.length === 0) {
    if (processGroupExists(snapshot.pgid)) throw new Error('process_identity_ambiguous');
    return { forced: false };
  }
  if (pidIsLive(pid) && (!verifyProcessReceipt(opts.receipt, opts) || !current.some(member => member.pid === pid && member.startMarker === opts.receipt.start_marker))) {
    throw new Error('process_identity_ambiguous');
  }
  try {
    process.kill(-snapshot.pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('process_signal_failed');
  }

  const waitMs = Math.max(250, Math.min(graceMs, 1000));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { promise: poll, resolve: finishPoll } = deferred<void>();
    setTimeout(finishPoll, 25);
    await poll;
    const remaining = processGroupMembers(snapshot.pgid);
    if (remaining === null) throw new Error('process_identity_ambiguous');
    if (remaining.length === 0) {
      if (!processGroupExists(snapshot.pgid)) return { forced: true };
      if (Date.now() >= deadline) throw new Error('process_still_live');
      continue;
    }
    if (!groupMatchesSnapshot(snapshot, remaining)) throw new Error('process_identity_ambiguous');
    if (Date.now() >= deadline) throw new Error('process_still_live');
  }
}

/* ------------------------------------------------------------------ */
/* omp launch arguments                                                */
/* ------------------------------------------------------------------ */

export interface OmpLaunchConfig {
  /** Optional run-owned profile name; never a host profile path. */
  readonly ompProfile?: string;
  readonly model?: string | null;
  readonly maxTimeSec: number;
  readonly approvalMode: string;
  /** Explicit extension from the immutable fullstack artifact. */
  readonly extensionPath: string;
  /** Session-specific state directory inside the prepared run. */
  readonly sessionDir: string;
}

/** Opt in only the prepared fixture observer, never ambient project extensions. */
function resolveNativeObserverPath(workspaceRoot: string): string | null {
  const candidate = join(workspaceRoot, '.omp', 'extensions', 'live-native-evidence.ts');
  const observerPath = assertSafeRunPath(workspaceRoot, candidate, 'live native observer extension');
  try {
    const stat = lstatSync(observerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('native_observer_path_invalid');
    }
    return observerPath;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Build the interactive omp argument vector. Runtime identity is supplied
 * separately by startTestSession from manifest.runtime.binary; this function
 * never emits a host config, user overlay, PATH-selected executable, or
 * non-interactive flag.
 */
export function buildOmpArgs(cfg: OmpLaunchConfig): string[] {
  const maxMinutes = Math.max(1, Math.round(cfg.maxTimeSec / 60));
  const args: string[] = [];
  if (typeof cfg.ompProfile === "string" && cfg.ompProfile.length > 0) {
    args.push("--profile", cfg.ompProfile);
  }
  if (typeof cfg.model === 'string' && cfg.model.length > 0) {
    args.push('--model', cfg.model);
  }
  args.push(
    '--no-extensions',
    '--extension', cfg.extensionPath,
    '--session-dir', cfg.sessionDir,
    '--hide-thinking',
    '--max-time', `${maxMinutes}m`,
    '--approval-mode', cfg.approvalMode,
  );
  return args;
}


/* ------------------------------------------------------------------ */
/* Session types                                                       */
/* ------------------------------------------------------------------ */

export interface ScenarioRef {
  readonly id: string;
  readonly title?: string;
}

export interface TestSessionOptions {
  /** Resolved, verified run manifest. Host scratch directories are rejected. */
  readonly manifest: RunManifest;
  /** New identity for this session; generated when omitted. */
  readonly sessionId?: string;
  /** Driving surface: 'web' (xterm in browser) or 'text' (WS transcript). */
  readonly surface?: 'web' | 'text';
  readonly scenario?: ScenarioRef | null;
  readonly port?: number;
  readonly cols?: number;
  readonly rows?: number;
  readonly idleMs?: number;
  readonly rateLimit?: RateLimitOptions;
  readonly ompProfile?: string;
  readonly maxTimeSec?: number;
  readonly approvalMode?: string;
  readonly token?: string;
  /** Test-only transport seam; production launches always use a PTY. */
  readonly noPty?: boolean;
}

export type { ProcessReceipt } from './manifest.js';

interface ProcessProbe {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startMarker: string;
  readonly command: string;
  readonly cwd: string | null;
}


function digestArgv(binary: string, argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([binary, ...argv])).digest('hex');
}

function probeProcess(pid: number): ProcessProbe | null {
  if (process.platform === 'win32') return null;
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      timeout: 1500,
      maxBuffer: 32 * 1024,
    }).trim();
    const line = raw.split('\n').find(entry => entry.trim().length > 0);
    if (line === undefined) return null;
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 9) return null;
    const observedPid = Number(fields[0]);
    const observedPpid = Number(fields[1]);
    const observedPgid = Number(fields[2]);
    const startMarker = fields.slice(3, 8).join(' ');
    const command = fields.slice(8).join(' ');
    let cwd: string | null = null;
    try {
      const cwdRaw = execFileSync(process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        timeout: 1500,
        maxBuffer: 16 * 1024,
      });
      const cwdLine = cwdRaw.split('\n').find(entry => entry.startsWith('n'));
      cwd = cwdLine === undefined ? null : cwdLine.slice(1);
    } catch {
      cwd = null;
    }
    if (!Number.isInteger(observedPid) || !Number.isInteger(observedPpid) || !Number.isInteger(observedPgid)) return null;
    return { pid: observedPid, ppid: observedPpid, pgid: observedPgid, startMarker, command, cwd };
  } catch {
    return null;
  }
}

function verifyProcessReceipt(receipt: ProcessReceipt, opts: KillProcessTreeOptions): boolean {
  if (process.platform === 'win32' || receipt.pgid !== receipt.pid || !pidIsLive(receipt.pid)) return false;
  const probe = probeProcess(receipt.pid);
  if (probe === null || probe.pid !== receipt.pid || probe.pgid !== receipt.pgid) return false;
  if (probe.startMarker !== receipt.start_marker) return false;
  if (opts.executablePath !== undefined) {
    const executable = opts.executablePath;
    const direct = probe.command === executable || probe.command.startsWith(`${executable} `);
    const interpreted = ['node', 'bun', 'sh', 'bash'].some(name =>
      probe.command.startsWith(`/bin/${name} ${executable} `) ||
      probe.command.startsWith(`/usr/bin/${name} ${executable} `) ||
      probe.command === `/bin/${name} ${executable}` ||
      probe.command === `/usr/bin/${name} ${executable}` ||
      probe.command.startsWith(`${name} ${executable} `) ||
      probe.command === `${name} ${executable}`);
    if (!direct && !interpreted) return false;
  }
  if (opts.executableDigest !== undefined && receipt.executable_digest !== opts.executableDigest) return false;
  if (opts.argv !== undefined) {
    if (digestArgv(opts.executablePath ?? '', opts.argv) !== receipt.argv_digest) return false;
    for (const arg of opts.argv) {
      if (!probe.command.includes(arg)) return false;
    }
  }
  if (opts.cwd !== undefined) {
    if (probe.cwd === null) return false;
    try {
      if (realpathSync(probe.cwd) !== realpathSync(opts.cwd)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Handle to a running test session. */
export interface TestSession {
  readonly host: '127.0.0.1';
  readonly publicHost: string;
  readonly port: number;
  readonly runId: string;
  readonly sessionId: string;
  /** Runtime-only bearer; persisted only in private connection metadata. */
  readonly token: string;
  readonly url: string;
  readonly wsPath: string;
  readonly transcriptPath: string;
  readonly logPath: string;
  readonly sessionJsonPath: string;
  readonly privateConnectionPath: string;
  readonly readiness: Readonly<Record<string, unknown>>;
  readonly pty: { readonly pid: number | null; readonly cols: number; readonly rows: number; readonly mode: 'pty' | 'noPty' };
  /** Stop the session; failed close options preserve non-clean evidence. */
  readonly close: (options?: SessionCloseOptions) => Promise<void>;
}

/** One line of the server-side transcript.jsonl (evidence backbone). */
export type TranscriptFrame =
  | { readonly ts: string; readonly t: 'o'; readonly d: string }
  | { readonly ts: string; readonly t: 'i'; readonly d: string }
  | { readonly ts: string; readonly t: 'exit'; readonly code: number; readonly signal?: number }
  | { readonly ts: string; readonly t: 'err'; readonly code: string; readonly message?: string };

/* ------------------------------------------------------------------ */
/* Session records and ownership                                       */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  readonly runId: string;
  readonly sessionId: string;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly startMarker: string | null;
  readonly status: string | null;
  readonly ready: boolean;
  readonly path: string;
  readonly transcriptPath: string;
  readonly logPath: string;
  readonly privateConnectionPath: string;
  readonly process?: ProcessReceipt;
  readonly exit_code?: number;
  readonly exit_signal?: number;
  readonly termination?: SessionTermination;
  readonly readiness?: Readonly<Record<string, unknown>>;
}

function runIdOf(manifest: RunManifest): string {
  return manifest.run_id;
}

function generatedSessionId(): string {
  return `session-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

/** Read the independent session record for a resolved run. */
export function readSessionRecord(manifest: RunManifest, sessionId: string): SessionInfo | null {
  const record = readManifestSessionRecord(manifest, sessionId);
  if (record === null) return null;
  const paths = sessionPaths(manifest, sessionId);
  const pid = typeof record.pid === 'number' ? record.pid : null;
  const startedAt = typeof record.started_at === 'string' ? record.started_at : null;
  const startMarker = typeof record.start_marker === 'string' ? record.start_marker : null;
  const status = typeof record.status === 'string' ? record.status : null;
  return {
    runId: runIdOf(manifest),
    sessionId,
    pid,
    startedAt,
    startMarker,
    status,
    ready: record.ready === true,
    path: paths.record,
    transcriptPath: paths.transcript,
    logPath: paths.log,
    privateConnectionPath: paths.connection,
    ...(record.process !== undefined && typeof record.process === 'object' ? { process: record.process as ProcessReceipt } : {}),
    ...(record.exit_code === undefined ? {} : { exit_code: record.exit_code }),
    ...(record.exit_signal === undefined ? {} : { exit_signal: record.exit_signal }),
    ...(record.termination === undefined ? {} : { termination: record.termination }),
    ...(record.readiness === undefined ? {} : { readiness: record.readiness }),
  };
}


/** True if the pid refers to a live process on this host. */
export function pidIsLive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse every live session. There is intentionally no force takeover:
 * cleanup must first establish ownership and stop the selected session.
 */
export function assertNoLiveSession(manifest: RunManifest, sessionId: string): void {
  const info = readSessionRecord(manifest, sessionId);
  if (info === null) return;
  if (pidIsLive(info.pid)) {
    throw new Error(`ux-e2e: live session found (pid ${String(info.pid)}) at ${info.path}; stop it before starting another session`);
  }
}

export function assertSessionOwnership(manifest: RunManifest, sessionId: string): SessionInfo {
  const info = readSessionRecord(manifest, sessionId);
  if (info === null) throw new Error(`ux-e2e: session ${sessionId} has no registered record`);
  if (info.pid === null || !pidIsLive(info.pid)) {
    throw new Error(`ux-e2e: session ${sessionId} process is not live`);
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* HTTP security headers + CSP                                         */
/* ------------------------------------------------------------------ */

/**
 * Hardening headers applied to every HTTP response. Frame deny + referrer
 * policy are first-class defenses; CSP is layered on top in `cspHeader`.
 */
export function securityHeaders(host: string, port: number): Readonly<Record<string, string>> {
  return {
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': cspHeader(`http://${host}:${port}`),
  };
}

/**
 * Strict CSP — full set, ported from @pi-harness/web-terminal origin.ts.
 * The page only loads its own bundle (`'self'`); inline `style` attributes
 * are required by xterm.js so `'unsafe-inline'` is allowed in `style-src`
 * but never in `script-src` or `connect-src`. `connect-src` includes the
 * same-origin WS so a malicious page cannot convince the browser to open
 * an arbitrary WS upgrade using a stolen token.
 */
export function cspHeader(selfOrigin: string): string {
  let wsSelf = '';
  try {
    const u = new URL(selfOrigin);
    wsSelf = u.protocol === 'https:' ? `wss://${u.host}` : `ws://${u.host}`;
  } catch {
    /* keep connect-src minimal on parse failure */
  }
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' " + wsSelf,
    "object-src 'none'",
    "manifest-src 'self'",
  ].join('; ');
}
/* ------------------------------------------------------------------ */
/* Static assets (terminal page + vendored xterm)                      */
/* ------------------------------------------------------------------ */

interface VendorAssets {
  readonly terminalHtml: string;
  readonly pageJs: string;
  readonly xtermJs: string;
  readonly xtermCss: string;
  readonly addonFitJs: string;
}

const require = createRequire(import.meta.url);

const assetCache = new Map<string, Buffer>();

function resolveVendorAssets(): VendorAssets {
  // NOTE: @xterm/xterm ships its stylesheet under `css/xterm.css`, NOT
  // `lib/xterm.css` (verified against 5.5.0). The JS bundles live in `lib/`.
  return {
    terminalHtml: fileURLToPath(new URL('../assets/terminal.html', import.meta.url)),
    pageJs: fileURLToPath(new URL('../assets/page.js', import.meta.url)),
    xtermJs: require.resolve('@xterm/xterm/lib/xterm.js'),
    xtermCss: require.resolve('@xterm/xterm/css/xterm.css'),
    addonFitJs: require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
  };
}


function serveFile(res: ServerResponse, path: string, contentType: string): void {
  let body = assetCache.get(path);
  if (body === undefined) {
    try {
      body = readFileSync(path);
      assetCache.set(path, body);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('not found');
      return;
    }
  }
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const qIdx = raw.indexOf('?');
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  return path === '' ? '/' : path;
}

/* ------------------------------------------------------------------ */
/* WS auth + session attach                                            */
/* ------------------------------------------------------------------ */

/** Outbound WS messages to the browser. */
export type ServerMsg =
  | { readonly t: 's'; readonly ok: true }
  | { readonly t: 'o'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number; readonly signal?: number }
  | { readonly t: 'err'; readonly code: string; readonly message: string };

/** Inbound WS messages from the browser. */
type ClientMsg =
  | { readonly t: 'i'; readonly d: string }
  | { readonly t: 'r'; readonly cols: number; readonly rows: number };

function send(ws: WS, msg: ServerMsg): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function readToken(req: IncomingMessage): string | null {
  if (req.url === undefined) return null;
  try {
    const u = new URL(req.url, 'http://placeholder.invalid/');
    const t = u.searchParams.get('token');
    return t !== null && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Origin / Host verification — ported from @pi-harness/web-terminal
 * `isLocalhostOrigin`. The server is bound to 127.0.0.1; the browser may
 * connect via `localhost` (or `[::1]`) instead — both refer to the same
 * loopback interface, so we accept them as long as the port matches.
 * Non-loopback hosts are NEVER aliased. The Origin header (when sent by
 * a browser) is checked in full; the Host header is the fallback for
 * curl / ws clients that omit Origin.
 */
const LOOPBACK_ALIASES = new Set(['127.0.0.1', 'localhost', '::1']);
const ALIAS_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const BRACKETED_V6 = /^\[([0-9a-fA-F:]+)\](?::(\d+))?$/u;
const HOST_PORT = /^([^:\[]+)(?::(\d+))?$/u;

/** Parse `host[:port]` where host may be IPv4, IPv6, or a DNS name. */
export function parseHostPort(value: string): { hostname: string; port: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const v6 = BRACKETED_V6.exec(trimmed);
  if (v6 !== null) {
    const host = v6[1] ?? '';
    const port = v6[2] ?? '';
    return { hostname: host, port };
  }
  const m = HOST_PORT.exec(trimmed);
  if (m === null) return null;
  return { hostname: m[1] ?? '', port: m[2] ?? '' };
}

export function originAllowed(req: IncomingMessage, expectedOrigin: string): boolean {
  let expectedHost = '';
  let expectedHostname = '';
  let expectedPort = '';
  let expectedProtocol = '';
  try {
    const u = new URL(expectedOrigin);
    expectedHost = u.host;
    expectedHostname = u.hostname;
    expectedProtocol = u.protocol;
    expectedPort = u.port;
  } catch {
    return false;
  }
  const origin = req.headers.origin;
  let candidateHost = '';
  let candidateHostname = '';
  let candidatePort = '';
  let candidateProto = '';
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const ou = new URL(origin);
      candidateHost = ou.host;
      candidateHostname = ou.hostname;
      candidateProto = ou.protocol;
      candidatePort = ou.port;
    } catch {
      return false;
    }
  } else {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
    const parsed = parseHostPort(hostHeader);
    if (parsed === null) return false;
    candidateHost = hostHeader;
    candidateHostname = parsed.hostname;
    candidatePort = parsed.port;
  }
  if (candidateHost.length === 0) return false;
  // 1) Exact match (existing behaviour).
  if (candidateHost === expectedHost) return true;
  // 2) Loopback alias — localhost <-> 127.0.0.1 <-> ::1 — ports must match.
  if (
    LOOPBACK_ALIASES.has(candidateHostname) &&
    LOOPBACK_ALIASES.has(expectedHostname) &&
    candidatePort === expectedPort &&
    ALIAS_PROTOCOLS.has(candidateProto || expectedProtocol) &&
    ALIAS_PROTOCOLS.has(expectedProtocol)
  ) {
    return true;
  }
  return false;
}

export type AttachResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no-token' | 'bad-token' | 'bad-origin' | 'closed' };

export interface SessionCloseOptions {
  readonly code: number;
  readonly signal?: number;
  readonly status: 'failed' | 'stopped';
  readonly reason: string;
}

interface SessionControllerOptions {
  readonly pty: IPty | null;
  readonly spawnError: string | null;
  readonly idleMs: number;
  readonly transcriptPath: string;
  readonly runRoot: string;
  readonly killOptions?: KillProcessTreeOptions;
  readonly onStatus?: (
    status: string,
    exit?: { readonly code: number; readonly signal?: number },
    termination?: SessionTermination,
  ) => void;
  readonly onClosed?: (result: { readonly ok: boolean }) => void;
}

class SessionController {
  readonly #opts: SessionControllerOptions;
  readonly #idler: IdleTimer;
  #attachedWs: WS | null = null;
  #closed = false;
  #notified = false;
  #closePromise: Promise<void> | null = null;
  #closing = false;
  #terminalCommitted = false;
  #killStarted = false;
  #observedPtyExit: { readonly code: number; readonly signal?: number } | null = null;
  readonly #ptyExitDone = deferred<{ readonly code: number; readonly signal?: number }>();
  #failureOverride: SessionCloseOptions | null = null;
  #ptyReady = false;
  #evidenceFailed = false;
  readonly #replayOutput: string[] = [];
  #replayLength = 0;
  constructor(opts: SessionControllerOptions) {
    this.#opts = opts;
    this.#idler = new IdleTimer({
      idleMs: opts.idleMs,
      onIdle: () => {
        if (this.#closed) return;
        const message = `no inbound traffic for ${opts.idleMs}ms`;
        if (this.#attachedWs !== null) {
          send(this.#attachedWs, { t: 'err', code: 'idle-timeout', message });
        }
        this.#append({ ts: new Date().toISOString(), t: 'err', code: 'idle-timeout', message });
        void this.close({ code: 124, status: 'failed', reason: 'idle timeout' }).catch(() => undefined);
      },
    });
    opts.pty?.onData(data => this.#handlePtyData(data));
    opts.pty?.onExit(({ exitCode, signal }) => this.#handlePtyExit(exitCode, signal));
    this.#idler.bump();
  }

  get closed(): boolean {
    return this.#closed;
  }

  attach(ws: WS): void {
    if (this.#closed) {
      ws.close(1001, 'session closed');
      return;
    }
    const previous = this.#attachedWs;
    if (previous !== null && previous !== ws) {
      try {
        previous.close(1000, 'replaced by newer connection');
      } catch {
        /* The previous socket may already be closing. */
      }
    }
    this.#attachedWs = ws;
    this.#idler.bump();
    send(ws, { t: 's', ok: true });
    if (this.#replayLength > 0) {
      send(ws, { t: 'o', d: `\u001b[2J\u001b[H${this.#replayOutput.join('')}` });
    }
    if (this.#opts.pty === null && this.#opts.spawnError !== null) {
      send(ws, { t: 'err', code: 'spawn-failed', message: this.#opts.spawnError });
      this.#append({ ts: new Date().toISOString(), t: 'err', code: 'spawn-failed', message: this.#opts.spawnError });
      void this.close({ code: 1, status: 'failed', reason: 'spawn failed' }).catch(() => undefined);
    }
  }

  detach(ws: WS): void {
    if (this.#attachedWs === ws) this.#attachedWs = null;
  }

  handleMessage(ws: WS, raw: unknown, limiter: RateLimiter): void {
    if (this.#closed || this.#attachedWs !== ws) return;
    this.#idler.bump();
    if (!limiter.record()) {
      send(ws, { t: 'err', code: 'rate-limited', message: 'too many messages' });
      this.#append({ ts: new Date().toISOString(), t: 'err', code: 'rate-limited' });
      ws.close(1008, 'rate limited');
      return;
    }
    let msg: ClientMsg;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      if (text.length > MAX_INBOUND_WS_BYTES) return;
      msg = JSON.parse(text) as ClientMsg;
    } catch {
      return;
    }
    if (this.#opts.pty === null) return;
    if (msg.t === 'i') {
      this.#append({ ts: new Date().toISOString(), t: 'i', d: msg.d });
      try {
        this.#opts.pty.write(msg.d);
      } catch {
        /* PTY may be dying — best-effort. */
      }
    } else if (msg.t === 'r' && msg.cols > 0 && msg.rows > 0) {
      try {
        this.#opts.pty.resize(Math.min(msg.cols, 1000), Math.min(msg.rows, 1000));
      } catch {
        /* resize can fail if the PTY is closing. */
      }
    }
  }

  async close(options: SessionCloseOptions = { code: 0, status: 'stopped', reason: 'session closed' }): Promise<void> {
    if (this.#closePromise !== null) {
      if (options.status === 'failed' && !this.#terminalCommitted) this.#failureOverride = options;
      return this.#closePromise;
    }
    if (this.#terminalCommitted) return;
    this.#closePromise = this.#closeNow(options);
    return this.#closePromise;
  }

  async #closeNow(options: SessionCloseOptions): Promise<void> {
    this.#closing = true;
    this.#closed = true;
    this.#idler.fireNow();
    const ws = this.#attachedWs;
    this.#attachedWs = null;
    let killError: unknown = null;
    let killResult: KillProcessTreeResult = { forced: false };
    let observed = this.#observedPtyExit;
    if (this.#opts.pty !== null) {
      try {
        const killOptions = this.#opts.killOptions;
        if (killOptions === undefined) throw new Error('process_identity_missing');
        killResult = await killProcessTree(this.#opts.pty.pid, {
          ...killOptions,
          onSignalStarted: () => { this.#killStarted = true; },
        });
      } catch (error) {
        killError = error;
      }
      observed = await this.#awaitPtyExit();
      if (killError === null && observed === null) killError = new Error('pty_exit_unobserved');
    }
    const effective = this.#failureOverride ?? options;
    const exit = observed ?? {
      code: effective.code === 0 ? 1 : effective.code,
      ...(effective.signal === undefined ? {} : { signal: effective.signal }),
    };
    const termination = this.#terminationFor(
      effective,
      killResult.forced,
      observed !== null || this.#opts.pty === null,
    );
    const cleanStop = killError === null &&
      effective.status === 'stopped' &&
      isCleanSessionTermination(exit.code, exit.signal, termination, this.#opts.killOptions !== undefined);
    const status = killError !== null ? 'stop_refused' : cleanStop ? 'stopped' : 'failed';
    const terminal = {
      ts: new Date().toISOString(),
      t: 'exit',
      code: exit.code,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    } as const;
    this.#append(terminal);
    if (ws !== null) {
      send(ws, { t: 'exit', code: terminal.code, ...(terminal.signal === undefined ? {} : { signal: terminal.signal }) });
      try {
        ws.close(killError === null ? 1000 : 1011, effective.reason);
      } catch {
        /* ignore. */
      }
    }
    this.#terminalCommitted = true;
    this.#opts.onStatus?.(status, terminal, termination);
    this.#notifyClosed(killError === null);
    if (killError !== null) throw killError;
  }

  #terminationFor(
    options: SessionCloseOptions,
    forced: boolean,
    observed: boolean,
  ): SessionTermination {
    const requested: SessionTermination['requested'] = options.status === 'stopped'
      ? 'owner'
      : options.signal === undefined ? 'owner' : 'operator';
    return {
      requested,
      requested_signal: options.signal ?? 15,
      forced,
      observed,
    };
  }

  async #awaitPtyExit(timeoutMs = 2_000): Promise<{ readonly code: number; readonly signal?: number } | null> {
    if (this.#observedPtyExit !== null) return this.#observedPtyExit;
    const timeout = deferred<void>();
    const timer = setTimeout(() => timeout.resolve(), timeoutMs);
    try {
      return await Promise.race([
        this.#ptyExitDone.promise,
        timeout.promise.then(() => null),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #handlePtyData(data: string): void {
    if (this.#closed) return;
    const replayLimit = 256 * 1024;
    if (data.length >= replayLimit) {
      this.#replayOutput.length = 0;
      this.#replayOutput.push(data.slice(-replayLimit));
      this.#replayLength = replayLimit;
    } else {
      this.#replayOutput.push(data);
      this.#replayLength += data.length;
      while (this.#replayLength > replayLimit) {
        this.#replayLength -= this.#replayOutput.shift()!.length;
      }
    }
    this.#append({ ts: new Date().toISOString(), t: 'o', d: data });
    if (!this.#ptyReady && data.length > 0) {
      this.#ptyReady = true;
      this.#opts.onStatus?.('running');
    }
    if (this.#attachedWs !== null) send(this.#attachedWs, { t: 'o', d: data });
  }

  #handlePtyExit(exitCode: number, signal: number | undefined): void {
    if (this.#terminalCommitted) return;
    const observed = { code: exitCode, ...(signal === undefined ? {} : { signal }) };
    this.#observedPtyExit = observed;
    this.#ptyExitDone.resolve(observed);
    if (this.#closing) {
      if (!this.#killStarted) {
        this.#failureOverride = {
          ...observed,
          status: 'failed',
          reason: 'pty exited before requested close',
        };
      }
      return;
    }
    this.#closed = true;
    const frame = {
      ts: new Date().toISOString(),
      t: 'exit',
      code: exitCode,
      ...(signal !== undefined ? { signal } : {}),
    } as const;
    this.#append(frame);
    if (this.#attachedWs !== null) {
      send(this.#attachedWs, { t: 'exit', code: exitCode, ...(signal === undefined ? {} : { signal }) });
      this.#attachedWs.close(1000, 'pty exited');
    }
    this.#attachedWs = null;
    this.#idler.fireNow();
    this.#terminalCommitted = true;
    this.#opts.onStatus?.(
      isCleanSessionTermination(
        exitCode,
        signal,
        { requested: 'none', forced: false, observed: true },
        this.#opts.killOptions !== undefined,
      ) && this.#ptyReady && !this.#evidenceFailed ? 'stopped' : 'failed',
      { code: exitCode, ...(signal === undefined ? {} : { signal }) },
      { requested: 'none', forced: false, observed: true },
    );
    this.#notifyClosed(true);
  }

  #notifyClosed(ok: boolean): void {
    if (this.#notified) return;
    this.#notified = true;
    this.#opts.onClosed?.({ ok });
  }

  #append(frame: TranscriptFrame): void {
    try {
      appendSessionFile(this.#opts.transcriptPath, JSON.stringify(frame) + '\n', this.#opts.runRoot);
    } catch {
      this.#evidenceFailed = true;
      this.#opts.onStatus?.('failed');
      if (!this.#closing && !this.#terminalCommitted) {
        void this.close({ code: 1, status: 'failed', reason: 'transcript failure' }).catch(() => undefined);
      }
    }
  }
}

export const INTERNAL_STOP_PATH = '/__ux-e2e/stop';

function stopJson(res: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readStopBody(req: IncomingMessage): Promise<Readonly<Record<string, unknown>> | null> {
  const pending = deferred<Readonly<Record<string, unknown>> | null>();
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  const finish = (value: Readonly<Record<string, unknown>> | null): void => {
    if (settled) return;
    settled = true;
    pending.resolve(value);
  };
  req.on('data', chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > 16 * 1024) {
      finish(null);
      req.resume();
      return;
    }
    chunks.push(buffer);
  });
  req.on('error', () => finish(null));
  req.on('end', () => {
    if (settled) return;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(null);
        return;
      }
      finish(parsed as Readonly<Record<string, unknown>>);
    } catch {
      finish(null);
    }
  });
  return pending.promise;
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
    const content = readFileSync(record.transcript_path, 'utf8');
    const frames: Array<Record<string, unknown>> = [];
    for (const line of content.split(/\r?\n/u)) {
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

async function handleStopRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manifest: RunManifest,
  sessionId: string,
  expectedToken: string,
  expectedHost: string,
  controller: SessionController | null,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== INTERNAL_STOP_PATH) {
    stopJson(res, req.method === 'POST' ? 404 : 405, { ok: false, error: 'stop_route_unavailable' });
    return;
  }
  if (req.headers.host !== expectedHost || req.headers.origin !== undefined) {
    stopJson(res, 403, { ok: false, error: 'stop_origin_rejected' });
    return;
  }
  const authorization = req.headers.authorization;
  if (
    typeof authorization !== 'string' ||
    !authorization.startsWith('Bearer ') ||
    authorization.length <= 'Bearer '.length ||
    !safeEqual(authorization.slice('Bearer '.length), expectedToken)
  ) {
    stopJson(res, 401, { ok: false, error: 'stop_authorization_rejected' });
    return;
  }
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    stopJson(res, 400, { ok: false, error: 'stop_request_invalid' });
    return;
  }
  const body = await readStopBody(req);
  if (
    body === null ||
    Object.keys(body).some(key => key !== 'run_id' && key !== 'session_id') ||
    body.run_id !== manifest.run_id ||
    body.session_id !== sessionId
  ) {
    stopJson(res, 400, { ok: false, error: 'stop_identity_rejected' });
    return;
  }
  if (controller === null) {
    stopJson(res, 409, { ok: false, error: 'stop_owner_unavailable' });
    return;
  }
  try {
    await controller.close();
  } catch {
    stopJson(res, 409, { ok: false, error: 'stop_refused' });
    return;
  }
  if (!cleanSessionEvidence(manifest, sessionId)) {
    stopJson(res, 409, { ok: false, error: 'stop_evidence_incomplete' });
    return;
  }
  const stopped = readManifestSessionRecord(manifest, sessionId);
  stopJson(res, 200, {
    ok: true,
    run_id: manifest.run_id,
    session_id: sessionId,
    status: 'stopped',
    exit_code: stopped?.exit_code,
  });
}

interface AttachOptions {
  readonly origin: string;
  readonly rateLimit: Required<RateLimitOptions>;
  readonly controller: SessionController;
}

/** Authenticate a WS upgrade and attach it to the live PTY session. */
export function attachSession(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  expectedToken: string,
  opts: AttachOptions,
): AttachResult {
  const token = readToken(req);
  if (token === null) return { ok: false, reason: 'no-token' };
  if (!safeEqual(token, expectedToken)) return { ok: false, reason: 'bad-token' };
  if (!originAllowed(req, opts.origin)) return { ok: false, reason: 'bad-origin' };
  if (opts.controller.closed) return { ok: false, reason: 'closed' };

  wss.handleUpgrade(req, socket, head, ws => {
    const limiter = new RateLimiter(opts.rateLimit);
    opts.controller.attach(ws);
    ws.on('message', raw => opts.controller.handleMessage(ws, raw, limiter));
    ws.on('close', () => opts.controller.detach(ws));
    ws.on('error', () => opts.controller.detach(ws));
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Server bootstrap                                                    */
/* ------------------------------------------------------------------ */

async function resolveOmpVersion(binary: string, env: Readonly<Record<string, string>>, cwd: string): Promise<string> {
  const { promise, resolve: done, reject: fail } = deferred<string>();
  const child = spawn(binary, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env },
    cwd,
    timeout: 5000,
  });
  let out = '';
  if (child.stdout !== null) {
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
  }
  child.on('error', err => fail(err));
  child.on('close', code => {
    if (code === 0) done(out);
    else fail(new Error(`--version exited with code ${String(code)}`));
  });
  const stdout = await promise;
  const first = stdout.trim().split(/\r?\n/u)[0];
  if (first === undefined || first.length === 0) throw new Error('runtime version probe returned no version');
  return sanitizeForJson(first);
}

function processReceiptFor(
  pid: number,
  manifest: RunManifest,
  sessionId: string,
  binary: string,
  argv: readonly string[],
  ownerNonce: string,
): ProcessReceipt {
  const probe = probeProcess(pid);
  if (probe === null || probe.pid !== pid || probe.pgid !== pid) {
    throw new Error('process_identity_unavailable');
  }
  const roots = manifestRoots(manifest);
  const cwdRelative = relative(roots.run, roots.workspace);
  if (cwdRelative.startsWith('..') || cwdRelative === '') {
    throw new Error('process_cwd_outside_run');
  }
  return {
    pid,
    pgid: probe.pgid,
    start_marker: probe.startMarker,
    executable_digest: manifest.runtime.digest,
    argv_digest: digestArgv(binary, argv),
    cwd_relative: cwdRelative,
    owner_nonce: `${runIdOf(manifest)}:${sessionId}:${ownerNonce}`,
  };
}

function recordFor(
  sessionId: string,
  status: string,
  paths: SessionPaths,
  startedAt: string,
  marker: string,
  receipt: ProcessReceipt | null,
): Record<string, unknown> {
  return {
    id: sessionId,
    status,
    start_marker: receipt?.start_marker ?? marker,
    ...(receipt === null ? { pid: null } : { pid: receipt.pid, process: receipt }),
    transcript_path: paths.transcript,
    log_path: paths.log,
    private_connection_path: paths.connection,
    started_at: startedAt,
    lease_marker: marker,
  };
}

function appendLog(path: string, message: string, runRoot: string): void {
  appendSessionFile(path, `${new Date().toISOString()} ${sanitizeForJson(message)}\n`, runRoot);
}

function runtimeSnapshotRootOf(binary: string): string {
  let cursor = dirname(binary);
  for (;;) {
    if (existsSync(join(cursor, 'runtime.json'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('cache_integrity_failure: runtime cache metadata could not be located');
}

function verifyLaunchIntegrity(manifest: RunManifest, runtimeBinary: string) {
  try {
    const runtime = verifyRuntimeSnapshot(runtimeSnapshotRootOf(runtimeBinary));
    if (runtime.binary !== runtimeBinary) {
      throw new Error('cache_integrity_failure: runtime snapshot binary does not match manifest');
    }
    if (runtime.digest !== manifest.runtime.digest) {
      throw new Error('cache_integrity_failure: runtime binary digest does not match manifest');
    }
    const core = verifyPackageArtifact(manifest.artifacts.core.root);
    const fullstack = verifyPackageArtifact(manifest.artifacts.fullstack.root);
    if (core.digest !== manifest.artifacts.core.digest || fullstack.digest !== manifest.artifacts.fullstack.digest) {
      throw new Error('cache_integrity_failure: package artifact digest does not match manifest');
    }
    return runtime;
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(String(error));
    let code: string | null = null;
    if ('code' in error && typeof error.code === 'string') code = error.code;
    if (code === null || error.message.startsWith(`${code}:`)) throw error;
    throw new Error(`${code}: ${error.message}`);
  }
}

/**
 * Start a session from a resolved manifest. The runtime executable, cwd,
 * roots, and auth transport are all derived from the manifest; no host PATH,
 * config, profile, or environment overlay is consulted.
 */
export async function startTestSession(opts: TestSessionOptions): Promise<TestSession> {
  const manifest = opts.manifest;
  if (manifest === undefined || manifest === null) throw new Error('ux-e2e: startTestSession requires a resolved manifest');
  verifyManifest(manifest);
  if (!['ready', 'running', 'stopped'].includes(manifest.status)) {
    throw new Error(`ux-e2e: run is not launchable in status ${manifest.status}`);
  }
  const roots = ensureManifestRoots(manifest);
  if (!existsSync(roots.workspace)) throw new Error('workspace_missing');
  const runtimeBinary = runtimeBinaryOf(manifest);
  const auth: AuthResolution = await resolveLaunchAuthEnvironment(manifest, {
    providerRequired: providerRequiredForManifest(manifest),
    requireRefreshOwnership: true,
  });
  const sessionId = opts.sessionId ?? generatedSessionId();
  const paths = sessionPaths(manifest, sessionId);
  if (readManifestSessionRecord(manifest, sessionId) !== null) {
    throw new Error(`session_exists:${sessionId}`);
  }
  const lease = acquireSessionLease(manifest, sessionId);
  let runLease: RunLease;
  try {
    runLease = acquireRunLease(manifest, sessionId);
  } catch (error) {
    lease.release();
    throw error;
  }
  const releaseLeases = (): void => {
    lease.release();
    runLease.release();
  };
  const surface = opts.surface ?? 'web';
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;
  const idleMs = opts.idleMs ?? 1_200_000;
  const rateLimit: Required<RateLimitOptions> = {
    maxMessages: opts.rateLimit?.maxMessages ?? 200,
    windowMs: opts.rateLimit?.windowMs ?? 1000,
  };
  const maxTimeSec = opts.maxTimeSec ?? 1800;
  const approvalMode = opts.approvalMode ?? 'yolo';
  const token = opts.token ?? mintToken();
  const startedAt = new Date().toISOString();
  const launchModel = manifest.auth.mode === 'none' && manifest.model === null
    ? 'e2e-offline/no-request'
    : manifest.model;
  let env: Record<string, string>;
  let args: string[];
  let runtimeCheck: RuntimeSnapshot;
  try {
    env = buildChildEnvironment(manifest, { sessionId, authEnv: auth.env, runtimeBinary });
    const nativeObserverPath = resolveNativeObserverPath(roots.workspace);
    args = buildOmpArgs({
      ompProfile: opts.ompProfile,
      model: launchModel,
      maxTimeSec,
      approvalMode,
      sessionDir: paths.root,
      extensionPath: join(manifest.artifacts.fullstack.root, 'dist', 'index.js'),
    });
    if (nativeObserverPath !== null) args.push('--extension', nativeObserverPath);
    runtimeCheck = verifyLaunchIntegrity(manifest, runtimeBinary);
    writeSessionFile(paths.transcript, '', roots.run);
    writeSessionFile(paths.log, '', roots.run);
    writeSessionRecord(manifest, sessionId, recordFor(sessionId, 'preparing', paths, startedAt, lease.marker, null));
  } catch (error) {
    releaseLeases();
    throw error;
  }
  let runtimeVersion: string;
  try {
    runtimeVersion = await resolveOmpVersion(runtimeBinary, env, roots.workspace);
  } catch (error) {
    writeSessionRecord(manifest, sessionId, recordFor(sessionId, 'failed', paths, startedAt, lease.marker, null));
    appendLog(paths.log, `runtime probe failed: ${error instanceof Error ? error.message : String(error)}`, roots.run);
    releaseLeases();
    throw new Error('unsupported_runtime');
  }
  if (runtimeVersion !== manifest.runtime.version &&
    runtimeVersion !== `omp/${manifest.runtime.version}` &&
    !runtimeVersion.endsWith(` ${manifest.runtime.version}`) &&
    !runtimeVersion.endsWith(` v${manifest.runtime.version}`)) {
    writeSessionRecord(manifest, sessionId, recordFor(sessionId, 'failed', paths, startedAt, lease.marker, null));
    appendLog(paths.log, 'runtime version did not match the prepared manifest', roots.run);
    releaseLeases();
    throw new Error('unsupported_runtime: version mismatch');
  }
  let nativeCommands: readonly { readonly name: string; readonly source: string }[] = [];
  if (opts.noPty !== true) {
    try {
      const extensionPath = join(manifest.artifacts.fullstack.root, 'dist', 'index.js');
      if (!existsSync(extensionPath)) throw new Error('prepared fullstack extension entrypoint is missing');
      const probeRoot = join(roots.tmp, 'native-readiness', sessionId);
      const probeHome = join(probeRoot, 'home');
      const probeAgent = join(probeRoot, 'agent');
      mkdirSync(probeHome, { recursive: true, mode: 0o700 });
      writeProviderFreeCatalog(probeAgent);
      const probe = probeProviderFreeRuntime(runtimeBinary, {
        homeRoot: probeHome,
        agentRoot: probeAgent,
        projectRoot: roots.workspace,
        tmpRoot: roots.tmp,
        extensionPath,
        expectedCommands: ['do-work', 'cto'],
        pathEnv: env.PATH,
        timeoutMs: 20_000,
      });
      if (!probe.capabilities.supported) throw new Error('declared extension command signals were not observed from an isolated native RPC process');
      nativeCommands = (probe.commands ?? []).filter(command => command.source === 'extension' && (command.name === 'do-work' || command.name === 'cto'));
    } catch {
      writeSessionRecord(manifest, sessionId, recordFor(sessionId, 'failed', paths, startedAt, lease.marker, null));
      appendLog(paths.log, 'native extension readiness refused the prepared session', roots.run);
      releaseLeases();
      throw new Error('plugin_readiness_failed');
    }
  }
  const readiness = {
    runtime: {
      binary: runtimeBinary,
      version: runtimeVersion,
      digest: runtimeCheck.digest,
    },
    model: launchModel,
    auth: auth.redacted,
    isolation: isolationReceipt(manifest, sessionId, env),
    native_inventory: 'observed-only',
    full_inventory: false,
    native_signals: nativeCommands,
    typed_rpc_ready: opts.noPty !== true,
  } satisfies Readonly<Record<string, unknown>>;

  let assets: VendorAssets;
  try {
    assets = resolveVendorAssets();
  } catch (error) {
    writeSessionRecord(manifest, sessionId, recordFor(sessionId, 'failed', paths, startedAt, lease.marker, null));
    appendLog(paths.log, `asset resolution failed: ${error instanceof Error ? error.message : String(error)}`, roots.run);
    releaseLeases();
    throw error;
  }

  const host = '127.0.0.1';
  const publicHost = host;
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_WS_BYTES });
  const { promise: listening, resolve: bound, reject: bindFailed } = deferred<void>();
  httpServer.once('error', bindFailed);
  httpServer.listen(opts.port ?? 0, host, () => bound());
  try {
    await listening;
  } catch (error) {
    releaseLeases();
    throw error;
  }
  const addr = httpServer.address();
  if (addr === null || typeof addr === 'string') {
    releaseLeases();
    throw new Error('ux-e2e: failed to resolve bound port');
  }
  const boundPort = addr.port;
  const origin = `http://${publicHost}:${boundPort}`;
  const wsPath = '/ws';
  const url = `http://${publicHost}:${boundPort}/?token=${encodeURIComponent(token)}`;
  writeSessionFile(paths.connection, JSON.stringify({ session_id: sessionId, token, url, ws_path: wsPath }) + '\n', roots.run);
  appendLog(paths.log, `session ${sessionId} listening on ${boundPort}`, roots.run);


  let ptyProc: IPty | null = null;
  let spawnError: string | null = null;
  let spawnReceiptGap = false;
  let processReceipt: ProcessReceipt | null = null;
  if (opts.noPty !== true) {
    // Only the explicit noPty test seam may start without a native PTY.
    // Production must fail closed rather than advertise a running session.
    try {
      const ptyMod = await import('node-pty');
      ptyProc = ptyMod.spawn(runtimeBinary, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: roots.workspace,
        env,
      });
      processReceipt = processReceiptFor(ptyProc.pid, manifest, sessionId, runtimeBinary, args, runLease.marker);
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      spawnReceiptGap = ptyProc !== null;
      try {
        ptyProc?.kill();
      } catch {
        /* best effort; the process was not admitted without a receipt. */
      }
      ptyProc = null;
      appendLog(paths.log, `spawn refused: ${spawnError}`, roots.run);
    }
  }
  writeSessionRecord(manifest, sessionId, {
    ...recordFor(sessionId, spawnError === null ? (opts.noPty === true ? 'running' : 'ready') : (spawnReceiptGap ? 'stop_refused' : 'failed'), paths, startedAt, lease.marker, processReceipt),
    ready: false,
    readiness,
    native_signals: nativeCommands,
  });
  if (spawnError !== null) {
    releaseLeases();
    wss.close();
    await new Promise<void>(resolveClosed => { httpServer.close(() => resolveClosed()); });
    throw new Error(`pty_spawn_failed: ${sanitizeForJson(spawnError)}`);
  }

  let controller: SessionController | null = null;
  httpServer.on('request', (req, res) => {
    const headers = securityHeaders(publicHost, boundPort);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const path = pathnameOf(req);
    if (path === INTERNAL_STOP_PATH) {
      void handleStopRequest(req, res, manifest, sessionId, token, `${publicHost}:${String(boundPort)}`, controller)
        .catch(() => {
          if (!res.headersSent) stopJson(res, 500, { ok: false, error: 'stop_owner_error' });
        });
      return;
    }
    if (path === '/') {
      serveFile(res, assets.terminalHtml, 'text/html; charset=utf-8');
      return;
    }
    if (path === '/page.js') {
      serveFile(res, assets.pageJs, 'application/javascript; charset=utf-8');
      return;
    }
    if (path === '/xterm.js') {
      serveFile(res, assets.xtermJs, 'application/javascript; charset=utf-8');
      return;
    }
    if (path === '/xterm.css') {
      serveFile(res, assets.xtermCss, 'text/css; charset=utf-8');
      return;
    }
    if (path === '/addon-fit.js') {
      serveFile(res, assets.addonFitJs, 'application/javascript; charset=utf-8');
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  });

  let ptyOutputSeen = false;
  const onStatus = (
    status: string,
    exit?: { readonly code: number; readonly signal?: number },
    termination?: SessionTermination,
  ): void => {
    if (status === 'running') ptyOutputSeen = true;
    writeSessionRecord(manifest, sessionId, {
      ...recordFor(sessionId, status, paths, startedAt, lease.marker, processReceipt),
      ready: ptyOutputSeen,
      readiness,
      native_signals: nativeCommands,
      ...(exit === undefined ? {} : { exit_code: exit.code, ...(exit.signal === undefined ? {} : { exit_signal: exit.signal }) }),
      ...(termination === undefined ? {} : { termination }),
    });
  };
  let transportClose: Promise<void> | null = null;
  const closeTransport = (): Promise<void> => {
    if (transportClose !== null) return transportClose;
    const started = (async () => {
      wss.clients.forEach(c => {
        try {
          c.close(1001, 'server shutting down');
        } catch {
          /* ignore. */
        }
      });
      wss.close();
      const { promise: closed, resolve: done } = deferred<void>();
      httpServer.close(() => done());
      await closed;
    })();
    transportClose = started;
    return started;
  };
  controller = new SessionController({
    pty: ptyProc,
    spawnError,
    idleMs,
    transcriptPath: paths.transcript,
    runRoot: roots.run,
    killOptions: processReceipt === null || ptyProc === null
      ? undefined
      : {
          manifest,
          sessionId,
          receipt: processReceipt,
          executablePath: runtimeBinary,
          executableDigest: manifest.runtime.digest,
          argv: args,
          cwd: roots.workspace,
        },
    onStatus,
    onClosed: ({ ok }) => {
      try {
        if (ok) releaseLeases();
      } catch {
        /* Keep the lease for fail-closed cleanup if its record is unreadable. */
      } finally {
        void closeTransport().catch(() => undefined);
      }
    },
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const result = attachSession(req, socket, head, wss, token, {
      origin,
      rateLimit,
      controller,
    });
    if (!result.ok) {
      const reason = result.reason;
      const status = reason === 'bad-origin' ? 403 : 401;
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${reason.length}\r\n\r\n${reason}`,
      );
      socket.destroy();
    }
  });

  let closePromise: Promise<void> | null = null;
  const close = (options?: SessionCloseOptions): Promise<void> => {
    if (closePromise !== null) {
      if (options?.status === 'failed') {
        return controller?.close(options) ?? closePromise;
      }
      return closePromise;
    }
    closePromise = (async () => {
      try {
        await controller?.close(options);
      } finally {
        await closeTransport();
      }
    })();
    return closePromise;
  };

  return {
    host,
    publicHost,
    port: boundPort,
    runId: runIdOf(manifest),
    sessionId,
    token,
    url,
    wsPath,
    transcriptPath: paths.transcript,
    logPath: paths.log,
    sessionJsonPath: paths.record,
    privateConnectionPath: paths.connection,
    readiness,
    pty: {
      pid: ptyProc?.pid ?? null,
      cols,
      rows,
      mode: ptyProc !== null ? 'pty' : 'noPty',
    },
    close,
  };
}
