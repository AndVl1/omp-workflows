import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  readdirSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertTrustedRunRoots,
  validateProcessReceipt,
  ManifestError,
  type ProcessReceipt,
  type RunManifest,
} from './manifest.js';

export const ENV_ALLOWLIST = [
  'CI',
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM',
  'TZ',
] as const;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/iu;

export interface ManifestRoots {
  readonly run: string;
  readonly home: string;
  readonly agent: string;
  readonly workspace: string;
  readonly tmp: string;
  readonly private: string;
  readonly sessions: string;
  readonly logs: string;
  readonly evidence: string;
}

export interface SessionPaths {
  readonly root: string;
  readonly transcript: string;
  readonly log: string;
  readonly record: string;
  readonly connection: string;
  readonly lock: string;
}

export interface SessionLease {
  readonly sessionId: string;
  readonly marker: string;
  readonly paths: SessionPaths;
  readonly release: () => void;
}

export interface RunLease {
  readonly sessionId: string;
  readonly marker: string;
  readonly path: string;
  readonly release: () => void;
}
export interface RunLeaseOwnership {
  readonly runId: string;
  readonly sessionId: string;
  readonly holderPid: number;
  readonly marker: string;
  readonly ownerNonce: string;
}

export type SessionTerminationRequester = 'none' | 'owner' | 'operator' | 'recovery';

export interface SessionTermination {
  readonly requested: SessionTerminationRequester;
  readonly requested_signal?: number;
  readonly forced: boolean;
  readonly observed: boolean;
}

export interface SessionRecordView {
  readonly id: string;
  readonly status: string;
  readonly pid: number | null;
  readonly started_at: string;
  readonly start_marker?: string;
  readonly lease_marker?: string;
  readonly ready?: boolean;
  readonly readiness?: Readonly<Record<string, unknown>>;
  readonly native_signals?: readonly unknown[];
  readonly exit_code?: number;
  readonly exit_signal?: number;
  readonly termination?: SessionTermination;
  readonly process?: ProcessReceipt;
  readonly transcript_path: string;
  readonly log_path: string;
  readonly private_connection_path: string;
}

/**
 * Validate the only session outcomes that may be treated as a clean stop.
 *
 * A natural exit is code 0 without a signal and without a termination
 * request. An owner stop must carry canonical requested SIGTERM metadata.
 * Native PTY implementations report that request either as code 0/signal 15
 * or as the conventional shell code 143/signal 0. All other combinations
 * remain failed evidence, including null signals, forced termination,
 * recovery writes, and mismatched requested signals.
 */
export function isCleanSessionTermination(
  exitCode: unknown,
  exitSignal: unknown,
  termination: unknown,
  hasProcessReceipt: boolean,
): boolean {
  if (
    typeof exitCode !== 'number' ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    (exitSignal !== undefined &&
      (typeof exitSignal !== 'number' || !Number.isSafeInteger(exitSignal) || exitSignal < 0)) ||
    termination === null ||
    typeof termination !== 'object' ||
    Array.isArray(termination) ||
    typeof hasProcessReceipt !== 'boolean'
  ) return false;
  const candidate = termination as Record<string, unknown>;
  const allowedKeys = ['requested', 'requested_signal', 'forced', 'observed'];
  if (Object.keys(candidate).some(key => !allowedKeys.includes(key))) return false;
  if (
    (candidate.requested !== 'none' &&
      candidate.requested !== 'owner' &&
      candidate.requested !== 'operator' &&
      candidate.requested !== 'recovery') ||
    typeof candidate.forced !== 'boolean' ||
    typeof candidate.observed !== 'boolean' ||
    candidate.forced !== false ||
    candidate.observed !== true ||
    (candidate.requested_signal !== undefined &&
      (typeof candidate.requested_signal !== 'number' ||
        !Number.isSafeInteger(candidate.requested_signal) ||
        candidate.requested_signal <= 0))
  ) return false;
  const natural =
    exitCode === 0 &&
    exitSignal === undefined &&
    candidate.requested === 'none' &&
    candidate.requested_signal === undefined;
  const ownerSigterm =
    hasProcessReceipt &&
    candidate.requested === 'owner' &&
    candidate.requested_signal === 15 &&
    ((exitCode === 0 && exitSignal === 15) || (exitCode === 143 && exitSignal === 0));
  return natural || ownerSigterm;
}

export interface ChildEnvironmentOptions {
  readonly sessionId?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Only values produced by resolveAuthEnvironment may be supplied here. */
  readonly authEnv?: Readonly<Record<string, string>>;
  /** Harness-controlled diagnostics, never a host passthrough. */
  readonly extra?: Readonly<Record<string, string>>;
  readonly runtimeBinary?: string;
}

export interface RuntimeSnapshotCheck {
  readonly ok: boolean;
  readonly code: 'ok' | 'runtime_missing' | 'runtime_not_file' | 'runtime_symlink' | 'runtime_digest_mismatch' | 'runtime_digest_invalid';
  readonly binary: string;
  readonly digest: string | null;
  readonly expected: string | null;
  readonly message: string;
}

export class EnvironmentRefusalError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'EnvironmentRefusalError';
    this.code = code;
    this.details = details;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function configuredStateRoot(): string {
  const configured = process.env.OMP_E2E_ROOT;
  const root = configured ?? join(tmpdir(), 'omp-workflows-e2e');
  return resolve(root);
}
function canonicalForOperations(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      let result = realpathSync(cursor);
      for (const component of missing.reverse()) result = join(result, component);
      return result;
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== 'ENOENT') return resolve(path);
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}


function refusalFromManifest(error: unknown): EnvironmentRefusalError {
  if (error instanceof EnvironmentRefusalError) return error;
  if (error instanceof ManifestError) return new EnvironmentRefusalError(error.code, error.message, error.details);
  return new EnvironmentRefusalError('invalid_manifest_roots', 'manifest roots could not be trusted');
}

function assertNoSymlinkComponents(root: string, target: string, label: string): void {
  let rootAbs = resolve(root);
  let targetAbs = resolve(target);
  try {
    if (lstatSync(targetAbs).isSymbolicLink()) {
      throw new EnvironmentRefusalError('path_symlink', `${label} contains a symbolic link`, { label, path: targetAbs });
    }
  } catch (error) {
    if (error instanceof EnvironmentRefusalError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT') throw new EnvironmentRefusalError('path_unreadable', `${label} could not be inspected`, { label, path: targetAbs });
  }
  try {
    const rootStat = lstatSync(rootAbs);
    if (rootStat.isSymbolicLink()) {
      throw new EnvironmentRefusalError('path_symlink', `${label} contains a symbolic link`, { label, path: rootAbs });
    }
    if (!rootStat.isDirectory()) {
      throw new EnvironmentRefusalError('path_not_directory', `${label} root is not a directory`, { label, path: rootAbs });
    }
  } catch (error) {
    if (error instanceof EnvironmentRefusalError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT') throw new EnvironmentRefusalError('path_unreadable', `${label} could not be inspected`, { label, path: rootAbs });
  }
  if (!pathContained(rootAbs, targetAbs)) {
    const canonicalRoot = canonicalForOperations(rootAbs);
    const canonicalTarget = canonicalForOperations(targetAbs);
    if (!pathContained(canonicalRoot, canonicalTarget)) {
      throw new EnvironmentRefusalError('path_outside_run', `${label} is outside its declared run root`, { label, root: rootAbs, path: targetAbs });
    }
    rootAbs = canonicalRoot;
    targetAbs = canonicalTarget;
  }
  let current = rootAbs;
  const rel = relative(rootAbs, targetAbs);
  const components = rel === '' ? [] : rel.split(sep);
  try {
    const rootStat = lstatSync(current);
    if (rootStat.isSymbolicLink()) throw new EnvironmentRefusalError('path_symlink', `${label} contains a symbolic link`, { label, path: current });
    if (!rootStat.isDirectory()) throw new EnvironmentRefusalError('path_not_directory', `${label} root is not a directory`, { label, path: current });
  } catch (error) {
    if (error instanceof EnvironmentRefusalError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code === 'ENOENT') return;
    throw new EnvironmentRefusalError('path_unreadable', `${label} could not be inspected`, { label, path: current });
  }
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new EnvironmentRefusalError('path_symlink', `${label} contains a symbolic link`, { label, path: current });
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new EnvironmentRefusalError('path_not_directory', `${label} contains a non-directory component`, { label, path: current });
      }
    } catch (error) {
      if (error instanceof EnvironmentRefusalError) throw error;
      const code = error as NodeJS.ErrnoException;
      if (code.code === 'ENOENT') return;
      throw new EnvironmentRefusalError('path_unreadable', `${label} could not be inspected`, { label, path: current });
    }
  }
}

function ensureSafeDirectory(root: string, target: string, label: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  if (!pathContained(rootAbs, targetAbs)) {
    throw new EnvironmentRefusalError('path_outside_run', `${label} is outside its declared run root`, { label, root: rootAbs, path: targetAbs });
  }
  let current = rootAbs;
  const rel = relative(rootAbs, targetAbs);
  const components = rel === '' ? [] : rel.split(sep);
  for (const component of components) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new EnvironmentRefusalError('path_symlink', `${label} contains a symbolic link`, { label, path: current });
      if (!stat.isDirectory()) throw new EnvironmentRefusalError('path_not_directory', `${label} contains a non-directory component`, { label, path: current });
    } catch (error) {
      if (!(error instanceof EnvironmentRefusalError) && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          mkdirSync(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw new EnvironmentRefusalError('path_mkdir_failed', `${label} could not be created`, { label, path: current });
        }
      } else if (error instanceof EnvironmentRefusalError) {
        throw error;
      } else {
        throw new EnvironmentRefusalError('path_unreadable', `${label} could not be inspected`, { label, path: current });
      }
    }
    current = join(current, component);
  }
  try {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new EnvironmentRefusalError('path_symlink', `${label} contains a symbolic link`, { label, path: current });
    if (!stat.isDirectory()) throw new EnvironmentRefusalError('path_not_directory', `${label} is not a directory`, { label, path: current });
  } catch (error) {
    if (!(error instanceof EnvironmentRefusalError) && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(current, { mode: 0o700 });
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new EnvironmentRefusalError('path_symlink', `${label} was replaced during creation`, { label, path: current });
    } else if (error instanceof EnvironmentRefusalError) {
      throw error;
    } else {
      throw new EnvironmentRefusalError('path_unreadable', `${label} could not be inspected`, { label, path: current });
    }
  }
  return targetAbs;
}

export function manifestRoots(manifest: RunManifest): ManifestRoots {
  const raw = recordOf(manifest.roots);
  const required = ['run', 'home', 'agent', 'workspace', 'tmp', 'private', 'sessions', 'logs', 'evidence'] as const;
  const result: Record<string, string> = {};
  for (const name of required) {
    const value = raw[name];
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
      throw new EnvironmentRefusalError('invalid_manifest_roots', `manifest roots.${name} must be an absolute path`, { root: name });
    }
    result[name] = resolve(value);
  }
  try {
    assertTrustedRunRoots(manifest.run_id, result as unknown as ManifestRoots);
  } catch (error) {
    throw refusalFromManifest(error);
  }
  return result as unknown as ManifestRoots;
}

export function runtimeBinaryOf(manifest: RunManifest): string {
  const runtime = recordOf(manifest.runtime);
  const binary = runtime.binary;
  if (typeof binary !== 'string' || binary.length === 0 || !isAbsolute(binary)) {
    throw new EnvironmentRefusalError('invalid_runtime_binary', 'manifest runtime.binary must be an absolute snapshot path');
  }
  return resolve(binary);
}

export function pathContained(root: string, target: string): boolean {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Validate containment and reject every existing symlink in the target path. */
export function assertSafeRunPath(root: string, target: string, label = 'path'): string {
  const targetAbs = resolve(target);
  assertNoSymlinkComponents(root, targetAbs, label);
  return targetAbs;
}

export function assertPathContained(root: string, target: string, label = 'path'): string {
  return assertSafeRunPath(root, target, label);
}

export function ensureManifestRoots(manifest: RunManifest): ManifestRoots {
  const roots = manifestRoots(manifest);
  const stateRoot = canonicalForOperations(configuredStateRoot());
  const runRoot = canonicalForOperations(roots.run);
  ensureSafeDirectory(stateRoot, runRoot, 'run root');
  const ordered = [roots.home, roots.agent, roots.workspace, roots.tmp, roots.private, roots.sessions, roots.logs, roots.evidence];
  for (const root of ordered) ensureSafeDirectory(runRoot, canonicalForOperations(root), 'run root descendant');
  return roots;
}

export function sessionPaths(manifest: RunManifest, sessionId: string): SessionPaths {
  if (!SESSION_ID.test(sessionId)) {
    throw new EnvironmentRefusalError('invalid_session_id', 'session id contains unsupported path characters', { sessionId });
  }
  const roots = manifestRoots(manifest);
  const root = join(roots.sessions, sessionId);
  const privateRoot = join(roots.private, 'sessions', sessionId);
  const paths = {
    root,
    transcript: join(root, 'transcript.jsonl'),
    log: join(roots.logs, `${sessionId}.log`),
    record: join(root, 'session.json'),
    connection: join(privateRoot, 'connection.json'),
    lock: join(root, 'active.lock'),
  };
  assertSafeRunPath(roots.sessions, paths.root, 'session root');
  assertSafeRunPath(roots.sessions, paths.transcript, 'session transcript');
  assertSafeRunPath(roots.sessions, paths.record, 'session record');
  assertSafeRunPath(roots.sessions, paths.lock, 'session lock');
  assertSafeRunPath(roots.logs, paths.log, 'session log');
  assertSafeRunPath(roots.private, privateRoot, 'private session root');
  assertSafeRunPath(roots.private, paths.connection, 'private session connection');
  return paths;
}

function pidIsLive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(path: string): { pid?: unknown; marker?: unknown } | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new EnvironmentRefusalError('lock_unreadable', 'lock could not be inspected', { path });
  }
  if (stat.isSymbolicLink()) throw new EnvironmentRefusalError('lock_symlink', 'lock must not be a symbolic link', { path });
  if (!stat.isFile()) throw new EnvironmentRefusalError('lock_invalid', 'lock must be a regular file', { path });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new EnvironmentRefusalError('lock_invalid', 'lock is not valid JSON', { path });
  }
  const value = recordOf(parsed);
  if (Object.keys(value).length === 0) throw new EnvironmentRefusalError('lock_invalid', 'lock record is not an object', { path });
  return value;
}

export function acquireSessionLease(manifest: RunManifest, sessionId: string): SessionLease {
  const paths = sessionPaths(manifest, sessionId);
  const roots = manifestRoots(manifest);
  ensureSafeDirectory(roots.sessions, paths.root, 'session root');
  ensureSafeDirectory(roots.private, dirname(paths.connection), 'private session root');
  ensureSafeDirectory(roots.logs, dirname(paths.log), 'session logs root');
  const marker = `${new Date().toISOString()}:${process.pid}:${randomBytes(12).toString('hex')}`;
  const body = JSON.stringify({ session_id: sessionId, pid: process.pid, marker, acquired_at: new Date().toISOString() }) + '\n';
  try {
    const fd = openSync(paths.lock, 'wx', 0o600);
    try {
      writeSync(fd, body, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const existing = readLock(paths.lock);
    if (existing !== null && pidIsLive(existing.pid)) {
      throw new EnvironmentRefusalError('session_active', 'a live session already owns this run/session', {
        sessionId,
        pid: typeof existing.pid === 'number' ? existing.pid : null,
      });
    }
    // A stale lock is safe to remove only after its recorded owner is dead.
    try {
      unlinkSync(paths.lock);
    } catch {
      throw new EnvironmentRefusalError('session_lock_unavailable', 'session lock is not available', { sessionId });
    }
    try {
      const fd = openSync(paths.lock, 'wx', 0o600);
      try {
        writeSync(fd, body, 0, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new EnvironmentRefusalError('session_active', 'another process acquired the session lock', { sessionId });
    }
    void error;
  }
  let released = false;
  return {
    sessionId,
    marker,
    paths,
    release: () => {
      if (released) return;
      released = true;
      const current = readLock(paths.lock);
      if (current?.marker === marker) {
        try {
          unlinkSync(paths.lock);
        } catch {
          /* cleanup is idempotent; a concurrent cleaner may have removed it. */
        }
      }
    },
  };
}

function pathEquivalent(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  if (leftResolved === rightResolved) return true;
  try {
    return realpathSync(leftResolved) === realpathSync(rightResolved);
  } catch {
    return false;
  }
}

function parseSessionRecord(manifest: RunManifest, sessionId: string, value: unknown, paths: SessionPaths): SessionRecordView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record must be an object', { sessionId });
  }
  const raw = value as Record<string, unknown>;
  const allowed = ['id', 'status', 'pid', 'start_marker', 'lease_marker', 'process', 'transcript_path', 'log_path', 'private_connection_path', 'started_at', 'ready', 'readiness', 'native_signals', 'exit_code', 'exit_signal', 'termination'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new EnvironmentRefusalError('session_record_invalid', 'session record contains an unsupported field', { sessionId, field: key });
  }
  if (raw.id !== sessionId || typeof raw.id !== 'string') {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record id does not match its path', { sessionId });
  }
  const statuses = ['preparing', 'ready', 'running', 'stopped', 'failed', 'cleaned', 'stop_refused'];
  if (typeof raw.status !== 'string' || !statuses.includes(raw.status)) {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record status is invalid', { sessionId });
  }
  let pid: number | null;
  if (raw.pid === null) {
    pid = null;
  } else if (typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) && raw.pid > 0) {
    pid = raw.pid;
  } else {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record pid is invalid', { sessionId });
  }
  if (typeof raw.started_at !== 'string' || raw.started_at.length === 0) {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record started_at is required', { sessionId });
  }
  const startedAt = raw.started_at;
  let startMarker: string | undefined;
  if (raw.start_marker !== undefined) {
    if (typeof raw.start_marker !== 'string' || raw.start_marker.length === 0) {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record start_marker is invalid', { sessionId });
    }
    startMarker = raw.start_marker;
  }
  let leaseMarker: string | undefined;
  if (raw.lease_marker !== undefined) {
    if (typeof raw.lease_marker !== 'string' || raw.lease_marker.length === 0) {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record lease_marker is invalid', { sessionId });
    }
    leaseMarker = raw.lease_marker;
  }
  let ready: boolean | undefined;
  if (raw.ready !== undefined) {
    if (typeof raw.ready !== 'boolean') throw new EnvironmentRefusalError('session_record_invalid', 'session record ready is invalid', { sessionId });
    ready = raw.ready;
  }
  let readiness: Readonly<Record<string, unknown>> | undefined;
  if (raw.readiness !== undefined) {
    if (raw.readiness === null || typeof raw.readiness !== 'object' || Array.isArray(raw.readiness)) {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record readiness must be an object', { sessionId });
    }
    readiness = raw.readiness as Readonly<Record<string, unknown>>;
  }
  let nativeSignals: readonly unknown[] | undefined;
  if (raw.native_signals !== undefined) {
    if (!Array.isArray(raw.native_signals)) throw new EnvironmentRefusalError('session_record_invalid', 'session record native_signals must be an array', { sessionId });
    nativeSignals = raw.native_signals;
  }
  let exitCode: number | undefined;
  if (raw.exit_code !== undefined) {
    if (typeof raw.exit_code !== 'number' || !Number.isSafeInteger(raw.exit_code) || raw.exit_code < 0) throw new EnvironmentRefusalError('session_record_invalid', 'session record exit_code is invalid', { sessionId });
    exitCode = raw.exit_code;
  }
  let exitSignal: number | undefined;
  if (raw.exit_signal !== undefined) {
    if (typeof raw.exit_signal !== 'number' || !Number.isSafeInteger(raw.exit_signal) || raw.exit_signal < 0) throw new EnvironmentRefusalError('session_record_invalid', 'session record exit_signal is invalid', { sessionId });
    exitSignal = raw.exit_signal;
  }
  let termination: SessionTermination | undefined;
  if (raw.termination !== undefined) {
    if (raw.termination === null || typeof raw.termination !== 'object' || Array.isArray(raw.termination)) {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record termination must be an object', { sessionId });
    }
    const candidate = raw.termination as Record<string, unknown>;
    const allowedTerminationKeys = ['requested', 'requested_signal', 'forced', 'observed'];
    if (Object.keys(candidate).some(key => !allowedTerminationKeys.includes(key))) {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record termination contains unsupported fields', { sessionId });
    }
    const allowedRequesters = ['none', 'owner', 'operator', 'recovery'];
    if (!allowedRequesters.includes(String(candidate.requested)) ||
      typeof candidate.forced !== 'boolean' ||
      typeof candidate.observed !== 'boolean') {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record termination is invalid', { sessionId });
    }
    if (candidate.requested_signal !== undefined &&
      (typeof candidate.requested_signal !== 'number' || !Number.isSafeInteger(candidate.requested_signal) || candidate.requested_signal <= 0)) {
      throw new EnvironmentRefusalError('session_record_invalid', 'session record termination signal is invalid', { sessionId });
    }
    termination = {
      requested: candidate.requested as SessionTerminationRequester,
      ...(candidate.requested_signal === undefined ? {} : { requested_signal: candidate.requested_signal as number }),
      forced: candidate.forced,
      observed: candidate.observed,
    };
  }
  let transcriptPath: string | undefined;
  let logPath: string | undefined;
  let connectionPath: string | undefined;
  const recordPaths: Array<readonly [string, string, string]> = [
    ['transcript_path', paths.transcript, 'session transcript'],
    ['log_path', paths.log, 'session log'],
    ['private_connection_path', paths.connection, 'private session connection'],
  ];
  for (const [field, expected, label] of recordPaths) {
    const valueAtField = raw[field];
    if (typeof valueAtField !== 'string' || !isAbsolute(valueAtField) || !pathEquivalent(valueAtField, expected)) {
      throw new EnvironmentRefusalError('session_record_invalid', `${field} is not the prepared session path`, { sessionId, field });
    }
    const root = field === 'log_path' ? dirname(paths.log) : field === 'private_connection_path' ? dirname(paths.connection) : dirname(paths.record);
    assertSafeRunPath(root, valueAtField, label);
    if (field === 'transcript_path') transcriptPath = resolve(valueAtField);
    else if (field === 'log_path') logPath = resolve(valueAtField);
    else connectionPath = resolve(valueAtField);
  }
  if (transcriptPath === undefined || logPath === undefined || connectionPath === undefined) {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record paths are incomplete', { sessionId });
  }
  let processReceipt: ProcessReceipt | undefined;
  if (raw.process !== undefined) {
    try {
      processReceipt = validateProcessReceipt(raw.process, 'session.process');
    } catch (error) {
      if (error instanceof ManifestError) {
        throw new EnvironmentRefusalError('session_receipt_invalid', error.message, { sessionId, ...error.details });
      }
      throw error;
    }
    if (pid !== processReceipt.pid || startMarker !== processReceipt.start_marker) {
      throw new EnvironmentRefusalError('session_receipt_invalid', 'session process receipt does not match its record identity', { sessionId });
    }
    const ownerPrefix = `${manifest.run_id}:${sessionId}:`;
    if (!processReceipt.owner_nonce.startsWith(ownerPrefix) || processReceipt.owner_nonce.length <= ownerPrefix.length) {
      throw new EnvironmentRefusalError('session_receipt_invalid', 'session process receipt is not bound to this run/session', { sessionId });
    }
    if (pidIsLive(processReceipt.pid)) {
      const ownership = readRunLeaseOwnership(manifest, sessionId);
      if (ownership === null || ownership.ownerNonce !== processReceipt.owner_nonce) {
        throw new EnvironmentRefusalError('session_ownership_unverified', 'live session process has no matching private run lease', { sessionId });
      }
    }
  } else if (pid !== null) {
    throw new EnvironmentRefusalError('session_receipt_missing', 'session record has a pid without an ownership receipt', { sessionId });
  }
  if (raw.status === 'stopped' &&
    !isCleanSessionTermination(exitCode, exitSignal, termination, processReceipt !== undefined)) {
    throw new EnvironmentRefusalError('session_termination_invalid', 'stopped session has no supported clean termination tuple', { sessionId });
  }
  return {
    id: sessionId,
    status: raw.status,
    pid,
    started_at: startedAt,
    ...(startMarker === undefined ? {} : { start_marker: startMarker }),
    ...(leaseMarker === undefined ? {} : { lease_marker: leaseMarker }),
    ...(ready === undefined ? {} : { ready }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(nativeSignals === undefined ? {} : { native_signals: nativeSignals }),
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    ...(exitSignal === undefined ? {} : { exit_signal: exitSignal }),
    ...(termination === undefined ? {} : { termination }),
    ...(processReceipt === undefined ? {} : { process: processReceipt }),
    transcript_path: transcriptPath,
    log_path: logPath,
    private_connection_path: connectionPath,
  };
}

/** Validate a session lifecycle envelope against paths derived from its canonical ID. */
export function validateSessionRecordEnvelope(
  manifest: RunManifest,
  sessionId: string,
  value: unknown,
): SessionRecordView {
  return parseSessionRecord(manifest, sessionId, value, sessionPaths(manifest, sessionId));
}

export function readSessionRecord(manifest: RunManifest, sessionId: string): SessionRecordView | null {
  const paths = sessionPaths(manifest, sessionId);
  let stat: Stats;
  try {
    stat = lstatSync(paths.record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new EnvironmentRefusalError('session_record_unreadable', 'session record could not be inspected', { sessionId, path: paths.record });
  }
  if (stat.isSymbolicLink()) throw new EnvironmentRefusalError('session_record_symlink', 'session record must not be a symbolic link', { sessionId, path: paths.record });
  if (!stat.isFile()) throw new EnvironmentRefusalError('session_record_invalid', 'session record must be a regular file', { sessionId, path: paths.record });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.record, 'utf8'));
  } catch {
    throw new EnvironmentRefusalError('session_record_invalid', 'session record is not valid JSON', { sessionId, path: paths.record });
  }
  return parseSessionRecord(manifest, sessionId, parsed, paths);
}

function runLeasePath(manifest: RunManifest): string {
  const roots = manifestRoots(manifest);
  return assertSafeRunPath(roots.private, join(roots.private, 'run.active.lock'), 'run active lock');
}

function runLeaseEvidencePath(manifest: RunManifest, sessionId: string): string {
  const roots = manifestRoots(manifest);
  return assertSafeRunPath(
    roots.private,
    join(roots.private, 'sessions', sessionId, 'run-lease.json'),
    'private run lease evidence',
  );
}

function readRunLeaseRecord(
  manifest: RunManifest,
  sessionId: string,
  path: string,
): RunLeaseOwnership | null {
  if (!SESSION_ID.test(sessionId)) {
    throw new EnvironmentRefusalError('invalid_session_id', 'session id contains unsupported path characters', { sessionId });
  }
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new EnvironmentRefusalError('run_lease_unreadable', 'private run lease could not be inspected', { path });
  }
  if (stat.isSymbolicLink()) throw new EnvironmentRefusalError('run_lease_symlink', 'private run lease must not be a symbolic link', { path });
  if (!stat.isFile()) throw new EnvironmentRefusalError('run_lease_invalid', 'private run lease must be a regular file', { path });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new EnvironmentRefusalError('run_lease_invalid', 'private run lease is not valid JSON', { path });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvironmentRefusalError('run_lease_invalid', 'private run lease record is not an object', { path });
  }
  const raw = parsed as Record<string, unknown>;
  const allowed = ['run_id', 'session_id', 'pid', 'marker', 'acquired_at'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new EnvironmentRefusalError('run_lease_invalid', 'private run lease contains an unsupported field', { path, field: key });
  }
  if (raw.run_id !== manifest.run_id || raw.session_id !== sessionId || typeof raw.marker !== 'string' || raw.marker.length === 0 || typeof raw.acquired_at !== 'string' || raw.acquired_at.length === 0) {
    throw new EnvironmentRefusalError('run_lease_invalid', 'private run lease identity is invalid', { path, sessionId });
  }
  if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) {
    throw new EnvironmentRefusalError('run_lease_invalid', 'private run lease holder pid is invalid', { path, sessionId });
  }
  return {
    runId: manifest.run_id,
    sessionId,
    holderPid: raw.pid,
    marker: raw.marker,
    ownerNonce: `${manifest.run_id}:${sessionId}:${raw.marker}`,
  };
}

export function readRunLeaseOwnership(manifest: RunManifest, sessionId: string): RunLeaseOwnership | null {
  return readRunLeaseRecord(manifest, sessionId, runLeasePath(manifest));
}

/** Read the private run-lease identity retained after the active lock is released. */
export function readPersistedRunLeaseOwnership(manifest: RunManifest, sessionId: string): RunLeaseOwnership | null {
  return readRunLeaseRecord(manifest, sessionId, runLeaseEvidencePath(manifest, sessionId));
}

function sessionRecordsInRun(manifest: RunManifest): SessionRecordView[] {
  const records = new Map<string, SessionRecordView>();
  for (const listed of manifest.sessions ?? []) {
    const diskRecord = readSessionRecord(manifest, listed.id);
    if (diskRecord !== null) {
      records.set(diskRecord.id, diskRecord);
      continue;
    }
    const paths = sessionPaths(manifest, listed.id);
    records.set(listed.id, {
      id: listed.id,
      status: listed.status,
      pid: listed.pid ?? null,
      started_at: manifest.updated_at ?? manifest.created_at ?? 'manifest',
      start_marker: listed.start_marker ?? 'manifest',
      ...(listed.process === undefined ? {} : { process: listed.process }),
      transcript_path: paths.transcript,
      log_path: paths.log,
      private_connection_path: paths.connection,
    });
  }
  const roots = manifestRoots(manifest);
  if (!existsSync(roots.sessions)) return [...records.values()];
  for (const entry of readdirSync(roots.sessions, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new EnvironmentRefusalError('path_symlink', 'session root contains a symbolic link', { path: join(roots.sessions, entry.name) });
    if (!entry.isDirectory()) continue;
    const record = readSessionRecord(manifest, entry.name);
    if (record !== null) records.set(record.id, record);
  }
  return [...records.values()];
}

export function assertNoLiveSessionInRun(manifest: RunManifest): void {
  for (const record of sessionRecordsInRun(manifest)) {
    if (!pidIsLive(record.pid)) continue;
    throw new EnvironmentRefusalError('session_active', 'another live session already owns this run', {
      active_session_id: record.id,
      pid: record.pid,
    });
  }
}

export function acquireRunLease(manifest: RunManifest, sessionId: string): RunLease {
  const roots = ensureManifestRoots(manifest);
  if (!SESSION_ID.test(sessionId)) {
    throw new EnvironmentRefusalError('invalid_session_id', 'session id contains unsupported path characters', { sessionId });
  }
  const path = runLeasePath(manifest);
  const evidencePath = runLeaseEvidencePath(manifest, sessionId);
  const marker = `${new Date().toISOString()}:${process.pid}:${randomBytes(12).toString('hex')}`;
  const leaseIdentity = {
    run_id: manifest.run_id,
    session_id: sessionId,
    pid: process.pid,
    marker,
    acquired_at: new Date().toISOString(),
  };
  const body = JSON.stringify(leaseIdentity) + '\n';
  assertNoLiveSessionInRun(manifest);
  const writeLock = (): void => {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, body, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeLock();
  } catch {
    const existing = readLock(path);
    if (existing === null) {
      throw new EnvironmentRefusalError('run_lock_unavailable', 'run active lock cannot be read safely', { runId: manifest.run_id });
    }
    if (pidIsLive(existing.pid)) {
      throw new EnvironmentRefusalError('session_active', 'another live session already owns this run', {
        runId: manifest.run_id,
        pid: typeof existing.pid === 'number' ? existing.pid : null,
      });
    }
    // A stale reservation can be reclaimed only after its recorded owner is dead.
    try {
      unlinkSync(path);
    } catch {
      throw new EnvironmentRefusalError('run_lock_unavailable', 'run active lock is not available', { runId: manifest.run_id });
    }
    assertNoLiveSessionInRun(manifest);
    try {
      writeLock();
    } catch {
      throw new EnvironmentRefusalError('session_active', 'another process acquired the run active lock', { runId: manifest.run_id });
    }
  }
  try {
    atomicWriteJson(evidencePath, leaseIdentity, roots.private);
  } catch {
    try {
      if (readLock(path)?.marker === marker) unlinkSync(path);
    } catch {
      /* Preserve the original persistence failure. */
    }
    throw new EnvironmentRefusalError(
      'run_lease_evidence_unavailable',
      'private run lease identity could not be persisted',
      { sessionId },
    );
  }
  let released = false;
  return {
    sessionId,
    marker,
    path,
    release: () => {
      if (released) return;
      released = true;
      const current = readLock(path);
      if (current?.marker !== marker) return;
      try {
        unlinkSync(path);
      } catch {
        /* cleanup is idempotent; a concurrent cleaner may have removed it. */
      }
    },
  };
}

export function writeSessionRecord(manifest: RunManifest, sessionId: string, value: Readonly<Record<string, unknown>>): string {
  const paths = sessionPaths(manifest, sessionId);
  const roots = manifestRoots(manifest);
  parseSessionRecord(manifest, sessionId, value, paths);
  ensureSafeDirectory(roots.sessions, paths.root, 'session root');
  atomicWriteJson(paths.record, value, roots.sessions);
  return paths.record;
}

export function atomicWriteJson(path: string, value: unknown, root = dirname(path)): void {
  const target = assertSafeRunPath(root, path, 'atomic write target');
  ensureSafeDirectory(root, dirname(target), 'atomic write parent');
  try {
    const existing = lstatSync(target);
    if (existing.isSymbolicLink()) throw new EnvironmentRefusalError('path_symlink', 'atomic write target must not be a symbolic link', { path: target });
    if (!existing.isFile()) throw new EnvironmentRefusalError('path_invalid', 'atomic write target must be a regular file', { path: target });
  } catch (error) {
    if (error instanceof EnvironmentRefusalError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new EnvironmentRefusalError('path_unreadable', 'atomic write target could not be inspected', { path: target });
  }
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      /* best effort on filesystems without chmod. */
    }
    assertSafeRunPath(root, dirname(target), 'atomic write parent');
    try {
      if (lstatSync(target).isSymbolicLink()) {
        throw new EnvironmentRefusalError('path_symlink', 'atomic write target became a symbolic link', { path: target });
      }
    } catch (error) {
      if (error instanceof EnvironmentRefusalError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new EnvironmentRefusalError('path_unreadable', 'atomic write target could not be inspected', { path: target });
    }
    renameSync(temp, target);
  } catch (error) {
    try {
      if (existsSync(temp) && lstatSync(temp).isFile()) unlinkSync(temp);
    } catch {
      /* preserve the original write failure. */
    }
    throw error;
  }
}

const BLOCKED_CHILD_KEYS: Readonly<Record<string, true>> = {
  BASH_ENV: true,
  CDPATH: true,
  DYLD_INSERT_LIBRARIES: true,
  ENV: true,
  GIT_CONFIG_GLOBAL: true,
  GIT_CONFIG_NOSYSTEM: true,
  GIT_CONFIG_SYSTEM: true,
  LD_PRELOAD: true,
  NODE_OPTIONS: true,
  NODE_PATH: true,
  NPM_CONFIG_GLOBALCONFIG: true,
  NPM_CONFIG_USERCONFIG: true,
  OMP_CONFIG: true,
  OMP_PLUGIN_PATH: true,
  PI_EXTENSION_PATH: true,
  PYTHONPATH: true,
};

const CONTROLLED_CHILD_KEYS: Readonly<Record<string, true>> = {
  HOME: true,
  OMP_AGENT_DIR: true,
  OMP_HOME: true,
  OMP_LOG_DIR: true,
  OMP_PROJECT_DIR: true,
  OMP_SKIP_SETUP: true,
  OMP_SESSION_DIR: true,
  PATH: true,
  PI_AGENT_DIR: true,
  PI_CODING_AGENT_DIR: true,
  PWD: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  USERPROFILE: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  npm_config_cache: true,
  npm_config_prefix: true,
};

const BROKER_AUTH_KEYS: Readonly<Record<string, true>> = {
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_AUTH_BROKER_URL: true,
  OMP_AUTH_CACHE_DIR: true,
};

export function isSafeAuthEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) &&
    BLOCKED_CHILD_KEYS[key] !== true &&
    CONTROLLED_CHILD_KEYS[key] !== true &&
    (BROKER_AUTH_KEYS[key] === true ||
      (!key.startsWith('DYLD_') &&
        !key.startsWith('LD_') &&
        !key.startsWith('NODE_') &&
        !key.startsWith('OMP_') &&
        !key.startsWith('PI_')));
}

export function buildChildEnvironment(manifest: RunManifest, opts: ChildEnvironmentOptions = {}): Record<string, string> {
  const roots = ensureManifestRoots(manifest);
  const base = opts.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = base[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  const manifestBinary = runtimeBinaryOf(manifest);
  const binary = opts.runtimeBinary === undefined ? manifestBinary : resolve(opts.runtimeBinary);
  if (binary !== manifestBinary) {
    throw new EnvironmentRefusalError('runtime_binary_override', 'child runtime must match the manifest snapshot', { expected: manifestBinary, actual: binary });
  }
  const launcher = assertSafeRunPath(roots.run, join(roots.run, 'bin', 'omp'), 'run runtime launcher');
  let launcherStat: Stats;
  try {
    launcherStat = lstatSync(launcher);
  } catch {
    throw new EnvironmentRefusalError('runtime_launcher_missing', 'run-owned omp launcher is missing', { path: launcher });
  }
  if (launcherStat.isSymbolicLink() || !launcherStat.isFile() || (launcherStat.mode & 0o111) === 0) {
    throw new EnvironmentRefusalError('runtime_launcher_invalid', 'run-owned omp launcher must be an executable regular file', { path: launcher });
  }
  const shellQuotedBinary = `'${manifestBinary.replaceAll("'", "'\\''")}'`;
  const expectedLauncher = `#!/bin/sh\nexec ${shellQuotedBinary} "$@"\n`;
  let launcherBody: string;
  try {
    launcherBody = readFileSync(launcher, 'utf8');
  } catch {
    throw new EnvironmentRefusalError('runtime_launcher_invalid', 'run-owned omp launcher could not be read', { path: launcher });
  }
  if (launcherBody !== expectedLauncher) {
    throw new EnvironmentRefusalError('runtime_launcher_invalid', 'run-owned omp launcher is not pinned to the manifest runtime', { path: launcher });
  }
  const fixedPath = [dirname(launcher), dirname(binary), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index)
    .join(':');
  const sessionRoot = opts.sessionId === undefined ? roots.sessions : sessionPaths(manifest, opts.sessionId).root;
  const configHome = join(roots.home, '.config');
  const dataHome = join(roots.home, '.local', 'share');
  const stateHome = join(roots.home, '.local', 'state');
  const cacheHome = join(roots.home, '.cache');
  Object.assign(env, {
    HOME: roots.home,
    USERPROFILE: roots.home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    TMPDIR: roots.tmp,
    TMP: roots.tmp,
    TEMP: roots.tmp,
    PATH: fixedPath,
    PWD: roots.workspace,
    TERM: 'xterm-256color',
    PI_CODING_AGENT_DIR: roots.agent,
    PI_AGENT_DIR: roots.agent,
    OMP_HOME: roots.home,
    OMP_AGENT_DIR: roots.agent,
    OMP_PROJECT_DIR: roots.workspace,
    OMP_SESSION_DIR: sessionRoot,
    OMP_LOG_DIR: roots.logs,
    OMP_SKIP_SETUP: '1',
    npm_config_cache: join(cacheHome, 'npm'),
    npm_config_prefix: join(roots.tmp, 'npm-prefix'),
  });
  for (const [key, value] of Object.entries(opts.authEnv ?? {})) {
    if (value.length === 0 || !isSafeAuthEnvironmentKey(key)) {
      throw new EnvironmentRefusalError('invalid_auth_environment', 'auth environment contains an invalid or discovery-affecting variable', { key });
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (!/^OMP_E2E_[A-Z0-9_]+$/u.test(key) || value.length === 0) {
      throw new EnvironmentRefusalError('invalid_child_environment', 'extra child environment is not a harness diagnostic variable', { key });
    }
    env[key] = value;
  }
  return env;
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

export async function verifyRuntimeBinary(manifest: RunManifest): Promise<RuntimeSnapshotCheck> {
  const binary = runtimeBinaryOf(manifest);
  const runtime = recordOf(manifest.runtime);
  const expectedRaw = runtime.digest;
  const expected = typeof expectedRaw === 'string' ? expectedRaw : null;
  if (expected === null || SHA256.exec(expected) === null) {
    return { ok: false, code: 'runtime_digest_invalid', binary, digest: null, expected, message: 'manifest runtime digest is not a sha256 digest' };
  }
  if (!existsSync(binary)) {
    return { ok: false, code: 'runtime_missing', binary, digest: null, expected, message: 'manifest runtime snapshot is missing' };
  }
  let stat: Stats;
  try {
    stat = lstatSync(binary);
  } catch {
    return { ok: false, code: 'runtime_missing', binary, digest: null, expected, message: 'manifest runtime snapshot cannot be read' };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'runtime_not_file', binary, digest: null, expected, message: 'manifest runtime binary is not a regular file' };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, code: 'runtime_symlink', binary, digest: null, expected, message: 'manifest runtime binary must not be a symlink' };
  }
  const digest = await sha256File(binary);
  const expectedHex = (SHA256.exec(expected)?.[1] ?? '').toLowerCase();
  if (digest !== expectedHex) {
    return {
      ok: false,
      code: 'runtime_digest_mismatch',
      binary,
      digest,
      expected,
      message: 'manifest runtime snapshot digest does not match its contents',
    };
  }
  return { ok: true, code: 'ok', binary, digest, expected, message: 'runtime snapshot verified' };
}

export function isolationReceipt(manifest: RunManifest, sessionId: string, env: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const roots = manifestRoots(manifest);
  const observedRoots = {
    home: env.HOME === roots.home,
    agent: env.PI_CODING_AGENT_DIR === roots.agent,
    workspace: env.OMP_PROJECT_DIR === roots.workspace,
    tmp: env.TMPDIR === roots.tmp,
    session: env.OMP_SESSION_DIR === sessionPaths(manifest, sessionId).root,
  };
  return {
    kind: 'process-observation',
    session_id: sessionId,
    observed_roots: observedRoots,
    observed_environment_keys: Object.keys(env).filter(key => key.includes('OMP') || key.includes('PI') || key.startsWith('XDG_')).sort(),
    native_inventory: 'observed-only',
    full_inventory: false,
  };
}

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}
