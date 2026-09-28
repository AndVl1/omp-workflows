import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { connect } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { deferred } from './util.js';

import { readManifest, verifyManifest } from './manifest.js';
import type { RunManifest } from './manifest.js';
import { readSessionRecord, verifyRuntimeBinary, type SessionRecordView } from './environment.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DIGEST_RE = /^(?:sha256:)?([a-f0-9]{64})$/iu;
const LOOPBACK_BIND_RE = /^127\.0\.0\.1:([0-9]{1,5})$/u;
export const HOST_PROFILE_ENV = [
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const;
const PROCESS_INSPECT_ENV = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'C',
  LC_ALL: 'C',
} as const;
const PS_BINARY = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps';
const LSOF_BINARY = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
const POLL_INTERVAL_MS = 100;
const STARTUP_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 15_000;

export type ManagedBrokerStatus = 'started' | 'reused';
export type ManagedBrokerState = 'running' | 'stopped' | 'unowned' | 'failed';

export interface ManagedBrokerResult {
  readonly status: ManagedBrokerStatus;
  readonly url: string;
  readonly token: string;
  readonly provider: string;
}

export interface ManagedBrokerStatusResult {
  readonly status: ManagedBrokerState;
  readonly url?: string;
}

/** Errors from the host-profile broker manager. Messages intentionally contain no secret values. */
export class ManagedBrokerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ManagedBrokerError';
    this.code = code;
  }
}

interface HostProfile {
  readonly profile: string | null;
  readonly configRoot: string;
  readonly agentDir: string;
  readonly storePath: string;
  readonly tokenPath: string;
  readonly profileFingerprint: string;
  readonly storeFingerprint: string;
}

interface BindInfo {
  readonly bind: string;
  readonly port: number;
  readonly url: string;
}

interface ValidatedManifest {
  readonly provider: 'openai-codex' | 'xai-oauth';
  readonly bind: BindInfo;
  readonly profile: HostProfile;
  readonly runtimeBinary: string;
  readonly runtimeDigest: string;
  readonly argv: readonly string[];
}

interface ManagedBrokerReceipt {
  readonly version: 1;
  readonly owner_nonce: string;
  readonly pid: number;
  readonly pgid: number | null;
  readonly start_marker: string;
  readonly executable: string;
  readonly executable_digest: string;
  readonly argv: readonly string[];
  readonly argv_digest: string;
  readonly cwd: string;
  readonly bind: string;
  readonly url: string;
  readonly provider: 'openai-codex' | 'xai-oauth';
  readonly profile_fingerprint: string;
  readonly store_fingerprint: string;
}

interface ProcessObservation {
  readonly pid: number;
  readonly pgid: number | null;
  readonly startMarker: string;
  readonly command: string;
  readonly cwd: string;
}

interface ReceiptRead {
  readonly kind: 'missing' | 'invalid' | 'unsafe' | 'valid';
  readonly receipt?: ManagedBrokerReceipt;
}

interface ManagerPaths {
  readonly root: string;
  readonly receipt: string;
  readonly lock: string;
  readonly clients: string;
}

interface LockHandle {
  readonly release: () => void;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = DIGEST_RE.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isOwnedByCurrentUser(stat: Stats): boolean {
  const uid = currentUid();
  return uid === undefined || stat.uid === uid;
}

function isSecureMode(stat: Stats): boolean {
  return (stat.mode & 0o777) === 0o600;
}

function profileFromEnvironment(): string | null {
  const selected = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
  const normalized = selected?.trim();
  if (normalized === undefined || normalized.length === 0 || normalized === 'default') return null;
  if (!PROFILE_NAME_RE.test(normalized) || normalized === '.' || normalized === '..' || normalized.endsWith('.')) {
    throw new ManagedBrokerError('invalid_host_profile', 'active host profile name is invalid');
  }
  return normalized;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const missing: string[] = [];
    let cursor = absolute;
    for (;;) {
      try {
        let result = realpathSync(cursor);
        for (const component of missing.reverse()) result = join(result, component);
        return result;
      } catch {
        const parent = dirname(cursor);
        if (parent === cursor) return absolute;
        missing.push(basename(cursor));
        cursor = parent;
      }
    }
  }
}

function xdgAppRoot(name: 'XDG_DATA_HOME' | 'XDG_STATE_HOME' | 'XDG_CACHE_HOME', profile: string | null): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const base = process.env[name];
  if (base === undefined || base.length === 0) return null;
  const appRoot = join(base, 'omp');
  if (profile !== null) {
    const profileRoot = join(appRoot, 'profiles', profile);
    return existsSync(profileRoot) ? profileRoot : null;
  }
  return existsSync(appRoot) ? appRoot : null;
}

function currentHostProfile(): HostProfile {
  const home = homedir();
  const profile = profileFromEnvironment();
  const configDir = process.env.PI_CONFIG_DIR || '.omp';
  const configRoot = resolve(join(home, configDir, ...(profile === null ? [] : ['profiles', profile])));
  const defaultAgentDir = join(configRoot, 'agent');
  const configuredAgent = process.env.PI_CODING_AGENT_DIR;
  const agentDir = profile === null && configuredAgent !== undefined && configuredAgent.length > 0
    ? resolve(configuredAgent)
    : defaultAgentDir;

  let storePath = join(agentDir, 'agent.db');
  if (agentDir === defaultAgentDir) {
    const xdgData = xdgAppRoot('XDG_DATA_HOME', profile);
    if (xdgData !== null) storePath = join(xdgData, 'agent.db');
  }
  const tokenPath = join(configRoot, 'auth-broker.token');
  const canonicalConfigRoot = canonicalPath(configRoot);
  const canonicalStorePath = canonicalPath(storePath);
  const profileFingerprint = digestText(JSON.stringify({
    version: 1,
    profile,
    config_root: canonicalConfigRoot,
    agent_db: canonicalStorePath,
  }));
  const storeFingerprint = digestText(`agent-db\0${canonicalStorePath}`);
  return {
    profile,
    configRoot,
    agentDir,
    storePath,
    tokenPath,
    profileFingerprint,
    storeFingerprint,
  };
}

/** Return the non-secret identity of the currently effective native host profile. */
export function hostAuthProfileFingerprint(): string {
  return currentHostProfile().profileFingerprint;
}

function parseBind(value: unknown): BindInfo {
  if (typeof value !== 'string') throw new ManagedBrokerError('invalid_broker_bind', 'native host broker bind is invalid');
  const match = LOOPBACK_BIND_RE.exec(value);
  const port = match === null ? 0 : Number(match[1]);
  if (match === null || port < 1 || port > 65535) {
    throw new ManagedBrokerError('unsafe_broker_bind', 'native host broker must use a specific IPv4 loopback bind');
  }
  return { bind: value, port, url: `http://${value}` };
}

function modelProvider(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const text = model.trim();
  if (text.length === 0) return null;
  const slash = text.indexOf('/');
  return slash < 0 ? text : text.slice(0, slash);
}

function authForManifest(manifest: RunManifest): { provider: 'openai-codex' | 'xai-oauth'; bind: BindInfo; profileFingerprint: string } {
  const auth = objectOf((manifest as unknown as { auth?: unknown }).auth);
  if (auth.mode !== 'native-host-broker') {
    throw new ManagedBrokerError('native_broker_required', 'manifest must opt into native-host-broker authentication');
  }
  if (auth.start_local !== true) {
    throw new ManagedBrokerError('native_broker_start_not_explicit', 'native host broker requires explicit local start');
  }
  if (auth.provider !== 'openai-codex' && auth.provider !== 'xai-oauth') {
    throw new ManagedBrokerError('native_broker_provider_invalid', 'native host broker provider is invalid');
  }
  const fingerprint = normalizedDigest(auth.profile_fingerprint);
  if (fingerprint === null) {
    throw new ManagedBrokerError('native_broker_profile_invalid', 'native host broker profile fingerprint is invalid');
  }
  return {
    provider: auth.provider,
    bind: parseBind(auth.bind),
    profileFingerprint: fingerprint,
  };
}

async function validateManifest(manifest: RunManifest): Promise<ValidatedManifest> {
  const auth = authForManifest(manifest);
  const profile = currentHostProfile();
  if (auth.profileFingerprint !== profile.profileFingerprint) {
    throw new ManagedBrokerError('native_broker_profile_mismatch', 'manifest host profile fingerprint does not match the current profile');
  }
  if (modelProvider((manifest as unknown as { model?: unknown }).model) !== auth.provider) {
    throw new ManagedBrokerError('native_broker_provider_mismatch', 'selected model provider does not match native host broker provider');
  }
  const runtime = await verifyRuntimeBinary(manifest);
  if (!runtime.ok || runtime.digest === null) {
    throw new ManagedBrokerError('native_broker_runtime_unverified', 'manifest runtime binary could not be verified');
  }
  const runtimeBinary = manifest.runtime.binary;
  const argv = [runtimeBinary, 'auth-broker', 'serve', `--bind=${auth.bind.bind}`] as const;
  return {
    provider: auth.provider,
    bind: auth.bind,
    profile,
    runtimeBinary,
    runtimeDigest: runtime.digest,
    argv,
  };
}

function configuredE2eRoot(): string {
  return resolve(process.env.OMP_E2E_ROOT ?? join(tmpdir(), 'omp-workflows-e2e'));
}

function assertDirectory(path: string, label: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ManagedBrokerError('broker_manager_state_unavailable', `${label} is unavailable`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
    throw new ManagedBrokerError('broker_manager_state_untrusted', `${label} is not a trusted directory`);
  }
}

function managerRoot(create: boolean): string {
  const stateRoot = configuredE2eRoot();
  if (create) {
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    } catch {
      throw new ManagedBrokerError('broker_manager_state_unavailable', 'E2E state root is unavailable');
    }
  }
  if (!existsSync(stateRoot)) {
    if (create) throw new ManagedBrokerError('broker_manager_state_unavailable', 'E2E state root is unavailable');
  } else {
    assertDirectory(stateRoot, 'E2E state root');
  }
  const root = join(stateRoot, 'broker-manager');
  if (create) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch {
      throw new ManagedBrokerError('broker_manager_state_unavailable', 'broker manager directory is unavailable');
    }
    try {
      // The manager directory is intentionally private even when the caller's state root is shared.
      const stat = lstatSync(root);
      if ((stat.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
    } catch {
      throw new ManagedBrokerError('broker_manager_state_untrusted', 'broker manager directory is unavailable');
    }
  }
  if (!existsSync(root)) return root;
  assertDirectory(root, 'broker manager directory');
  try {
    if ((lstatSync(root).mode & 0o777) !== 0o700) throw new Error('private mode required');
  } catch {
    throw new ManagedBrokerError('broker_manager_state_untrusted', 'broker manager directory is not private');
  }
  return canonicalPath(root);
}

function managerPaths(profile: HostProfile, createRoot: boolean): ManagerPaths {
  const root = managerRoot(createRoot);
  const key = profile.profileFingerprint;
  return {
    root,
    receipt: join(root, `${key}.receipt.json`),
    lock: join(root, `${key}.lock`),
    clients: join(root, `${key}.clients.json`),
  };
}

function secureDirectory(path: string): boolean {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return false; }
  return stat.isDirectory() && !stat.isSymbolicLink() && isOwnedByCurrentUser(stat) && (stat.mode & 0o022) === 0;
}

function secureAuthRoots(profile: HostProfile): boolean {
  return secureDirectory(profile.configRoot) && secureDirectory(dirname(profile.configRoot));
}

function readSecureFile(path: string): { kind: 'missing' | 'error' | 'unsafe' | 'ok'; text?: string; stat?: Stats } {
  let linkStat: Stats;
  try {
    linkStat = lstatSync(path);
  } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error' };
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || !isOwnedByCurrentUser(linkStat) || !isSecureMode(linkStat)) {
    return { kind: 'unsafe', stat: linkStat };
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch {
    return { kind: 'error' };
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isSymbolicLink() || !stat.isFile() || !isOwnedByCurrentUser(stat) || !isSecureMode(stat)) {
      return { kind: 'unsafe', stat };
    }
    return { kind: 'ok', text: readFileSync(fd, 'utf8'), stat };
  } catch {
    return { kind: 'error' };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function readManagedBrokerTokenFromProfile(profile: HostProfile): string | null {
  if (!secureAuthRoots(profile)) return null;
  const file = readSecureFile(profile.tokenPath);
  if (file.kind !== 'ok' || file.text === undefined) return null;
  const token = file.text.trim();
  return token.length > 0 ? token : null;
}

/** Read only the native host token; this function never starts or contacts a broker. */
export function readManagedBrokerToken(manifest: RunManifest): string | null {
  try {
    const auth = authForManifest(manifest);
    const profile = currentHostProfile();
    if (auth.profileFingerprint !== profile.profileFingerprint) return null;
    return readManagedBrokerTokenFromProfile(profile);
  } catch {
    return null;
  }
}

function parseReceipt(value: unknown): ManagedBrokerReceipt | null {
  const raw = objectOf(value);
  const digest = normalizedDigest(raw.executable_digest);
  const profileFingerprint = normalizedDigest(raw.profile_fingerprint);
  const storeFingerprint = normalizedDigest(raw.store_fingerprint);
  const argv = raw.argv;
  const pgid = raw.pgid;
  if (
    raw.version !== 1 ||
    typeof raw.owner_nonce !== 'string' || !/^[a-f0-9]{16,128}$/iu.test(raw.owner_nonce) ||
    typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid < 1 ||
    !(pgid === null || (typeof pgid === 'number' && Number.isInteger(pgid) && pgid > 0)) ||
    typeof raw.start_marker !== 'string' || raw.start_marker.length === 0 || raw.start_marker.length > 256 ||
    typeof raw.executable !== 'string' || !isAbsolute(raw.executable) ||
    digest === null || profileFingerprint === null || storeFingerprint === null ||
    !Array.isArray(argv) || argv.length !== 4 || argv.some(item => typeof item !== 'string' || item.length === 0) ||
    typeof raw.argv_digest !== 'string' || digestText(JSON.stringify(argv)) !== normalizedDigest(raw.argv_digest) ||
    typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) ||
    typeof raw.bind !== 'string' || LOOPBACK_BIND_RE.test(raw.bind) === false ||
    raw.url !== `http://${raw.bind}` ||
    (raw.provider !== 'openai-codex' && raw.provider !== 'xai-oauth')
  ) return null;
  return {
    version: 1,
    owner_nonce: raw.owner_nonce,
    pid: raw.pid,
    pgid: pgid === null ? null : pgid,
    start_marker: raw.start_marker,
    executable: raw.executable,
    executable_digest: digest,
    argv: argv as string[],
    argv_digest: normalizedDigest(raw.argv_digest) as string,
    cwd: raw.cwd,
    bind: raw.bind,
    url: raw.url,
    provider: raw.provider,
    profile_fingerprint: profileFingerprint,
    store_fingerprint: storeFingerprint,
  };
}

function readReceipt(path: string): ReceiptRead {
  const file = readSecureFile(path);
  if (file.kind === 'missing') return { kind: 'missing' };
  if (file.kind === 'unsafe') return { kind: 'unsafe' };
  if (file.kind !== 'ok' || file.text === undefined) return { kind: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(file.text);
    const receipt = parseReceipt(parsed);
    return receipt === null ? { kind: 'invalid' } : { kind: 'valid', receipt };
  } catch {
    return { kind: 'invalid' };
  }
}

function atomicWriteSecureJson(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomBytes(12).toString('hex')}.tmp`);
  const text = `${JSON.stringify(value)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const existing = readReceipt(path);
    if (existing.kind === 'unsafe') throw new ManagedBrokerError('broker_receipt_untrusted', 'manager receipt is not a trusted file');
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    if (error instanceof ManagedBrokerError) throw error;
    throw new ManagedBrokerError('broker_receipt_write_failed', 'manager receipt could not be written');
  }
}

function removeReceipt(path: string): void {
  const read = readReceipt(path);
  if (read.kind === 'missing') return;
  if (read.kind !== 'valid' && read.kind !== 'invalid') throw new ManagedBrokerError('broker_receipt_untrusted', 'manager receipt is not a trusted file');
  try { unlinkSync(path); } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT') throw new ManagedBrokerError('broker_receipt_remove_failed', 'manager receipt could not be removed');
  }
}

function psField(pid: number, field: string): string | null {
  const result = spawnSync(PS_BINARY, ['-ww', '-p', String(pid), '-o', field], {
    encoding: 'utf8',
    env: PROCESS_INSPECT_ENV,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

function processStartMarker(pid: number): string | null {
  return psField(pid, 'lstart=');
}

function processCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    // Linux procps accepts `cwd` as an output field but reports `-`, not the
    // process directory. Read the kernel's process-specific link instead.
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  const ps = psField(pid, 'cwd=');
  if (ps !== null && ps !== '(unknown)') return ps;
  const result = spawnSync(LSOF_BINARY, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    env: PROCESS_INSPECT_ENV,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const line = result.stdout.split('\n').find(item => item.startsWith('n'));
  return line === undefined || line.slice(1).length === 0 ? null : line.slice(1);
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const status = psField(pid, 'stat=');
    return status === null || !status.startsWith('Z');
  } catch (error) {
    const code = error as NodeJS.ErrnoException;
    return code.code === 'EPERM';
  }
}

function processObservation(pid: number): ProcessObservation | null {
  if (!pidIsLive(pid)) return null;
  const startMarker = processStartMarker(pid);
  const pgidText = psField(pid, 'pgid=');
  const command = psField(pid, 'command=');
  const cwd = processCwd(pid);
  if (startMarker === null || pgidText === null || command === null || cwd === null) return null;
  const parsedPgid = Number.parseInt(pgidText, 10);
  if (!Number.isInteger(parsedPgid) || parsedPgid < 1) return null;
  return { pid, pgid: parsedPgid, startMarker, command, cwd: resolve(cwd) };
}

function commandMatches(observed: string, receipt: Pick<ManagedBrokerReceipt, 'argv' | 'executable'>): boolean {
  if (!observed.includes(receipt.executable)) return false;
  return receipt.argv.slice(1).every(argument => observed.includes(argument));
}

function processMatchesReceipt(receipt: ManagedBrokerReceipt): ProcessObservation | null {
  const observed = processObservation(receipt.pid);
  if (observed === null) return null;
  if (observed.startMarker !== receipt.start_marker) return null;
  if (receipt.pgid === null || observed.pgid !== receipt.pgid) return null;
  if (resolve(receipt.executable) !== resolve(receipt.argv[0] ?? '')) return null;
  if (!commandMatches(observed.command, receipt)) return null;
  if (resolve(receipt.cwd) !== observed.cwd) return null;
  return observed;
}

function processMatchesExpected(observed: ProcessObservation, argv: readonly string[], executable: string, cwd: string): boolean {
  return observed.pid > 0 &&
    resolve(executable) === resolve(argv[0] ?? '') &&
    commandMatches(observed.command, { argv, executable }) &&
    resolve(observed.cwd) === resolve(cwd);
}

function sleep(ms: number): Promise<void> {
  const pending = deferred<void>();
  setTimeout(() => pending.resolve(), ms);
  return pending.promise;
}

function portIsOccupied(port: number): Promise<boolean> {
  const pending = deferred<boolean>();
  let settled = false;
  const socket = connect({ host: '127.0.0.1', port });
  const finish = (occupied: boolean): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    pending.resolve(occupied);
  };
  socket.once('connect', () => finish(true));
  socket.once('error', error => {
    const code = error as NodeJS.ErrnoException;
    finish(code.code === 'ECONNREFUSED' || code.code === 'EHOSTUNREACH' ? false : true);
  });
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(true));
  return pending.promise;
}

async function healthRequest(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/v1/healthz`, { method: 'GET', signal: controller.signal });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      return false;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return false;
    }
    const record = objectOf(body);
    return record.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function bearerRequest(url: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/v1/credentials/disabled`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    // Do not consume or serialize this response: a broker error body can contain credentials.
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return response.status === 200 || response.status === 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function brokerReady(url: string, token: string): Promise<boolean> {
  return await healthRequest(url) && await bearerRequest(url, token);
}

export function hostProfileEnvironment(
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_PROFILE_ENV) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  if (env.HOME === undefined) env.HOME = homedir();
  return env;
}

function lockOwnerPath(lock: string): string {
  return join(lock, 'owner.json');
}

function lockOwner(lock: string, nonce: string): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    nonce,
    pid: process.pid,
    start_marker: processStartMarker(process.pid) ?? 'unavailable',
  };
}

function lockOwnerIsLive(lock: string): boolean {
  const owner = readSecureFile(lockOwnerPath(lock));
  if (owner.kind !== 'ok' || owner.text === undefined) return true;
  try {
    const raw = objectOf(JSON.parse(owner.text));
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid < 1 || typeof raw.start_marker !== 'string') return true;
    if (!pidIsLive(raw.pid)) return false;
    const marker = processStartMarker(raw.pid);
    return marker === null || marker === raw.start_marker;
  } catch {
    return true;
  }
}

function removeStaleLock(lock: string): void {
  const owner = lockOwnerPath(lock);
  const stat = (() => {
    try { return lstatSync(lock); } catch { return null; }
  })();
  if (stat === null) return;
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
    throw new ManagedBrokerError('broker_lock_untrusted', 'broker manager lock is not trusted');
  }
  try { unlinkSync(owner); } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT') throw new ManagedBrokerError('broker_lock_busy', 'broker manager lock is busy');
  }
  try { rmdirSync(lock); } catch { throw new ManagedBrokerError('broker_lock_busy', 'broker manager lock is busy'); }
}

function acquireManagerLock(path: string): LockHandle {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      const nonce = randomBytes(16).toString('hex');
      atomicWriteSecureJson(lockOwnerPath(path), lockOwner(path, nonce));
      return {
        release: () => {
          const owner = readSecureFile(lockOwnerPath(path));
          if (owner.kind !== 'ok' || owner.text === undefined) return;
          try {
            const raw = objectOf(JSON.parse(owner.text));
            if (raw.nonce !== nonce) return;
          } catch {
            return;
          }
          try { unlinkSync(lockOwnerPath(path)); } catch { return; }
          try { rmdirSync(path); } catch { /* another process replaced the lock; leave it alone */ }
        },
      };
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== 'EEXIST') throw new ManagedBrokerError('broker_lock_failed', 'broker manager lock could not be acquired');
      if (lockOwnerIsLive(path)) throw new ManagedBrokerError('broker_lock_busy', 'another broker manager operation is active');
      removeStaleLock(path);
    }
  }
  throw new ManagedBrokerError('broker_lock_busy', 'another broker manager operation is active');
}
async function acquireManagerLockEventually(path: string): Promise<LockHandle> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return acquireManagerLock(path);
    } catch (error) {
      if (!(error instanceof ManagedBrokerError) || error.code !== 'broker_lock_busy' || Date.now() >= deadline) throw error;
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function makeReceipt(validated: ValidatedManifest, observation: ProcessObservation, ownerNonce: string, root: string): ManagedBrokerReceipt {
  return {
    version: 1,
    owner_nonce: ownerNonce,
    pid: observation.pid,
    pgid: observation.pgid,
    start_marker: observation.startMarker,
    executable: validated.runtimeBinary,
    executable_digest: validated.runtimeDigest,
    argv: validated.argv,
    argv_digest: digestText(JSON.stringify(validated.argv)),
    cwd: root,
    bind: validated.bind.bind,
    url: validated.bind.url,
    provider: validated.provider,
    profile_fingerprint: validated.profile.profileFingerprint,
    store_fingerprint: validated.profile.storeFingerprint,
  };
}

function receiptMatchesManifestAtRoot(receipt: ManagedBrokerReceipt, validated: ValidatedManifest, root: string): boolean {
  return receipt.executable === validated.runtimeBinary &&
    receipt.executable_digest === validated.runtimeDigest &&
    JSON.stringify(receipt.argv) === JSON.stringify(validated.argv) &&
    receipt.argv_digest === digestText(JSON.stringify(validated.argv)) &&
    receipt.cwd === root &&
    receipt.bind === validated.bind.bind &&
    receipt.url === validated.bind.url &&
    receipt.provider === validated.provider &&
    receipt.profile_fingerprint === validated.profile.profileFingerprint &&
    receipt.store_fingerprint === validated.profile.storeFingerprint;
}

async function terminateOwnedProcess(receipt: ManagedBrokerReceipt): Promise<void> {
  const initial = processMatchesReceipt(receipt);
  if (initial === null) return;
  const signalTarget = receipt.pgid === receipt.pid ? -receipt.pgid : receipt.pid;
  try { process.kill(signalTarget, 'SIGTERM'); } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ESRCH') throw new ManagedBrokerError('broker_stop_failed', 'managed broker could not be stopped');
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidIsLive(receipt.pid)) return;
    const observed = processMatchesReceipt(receipt);
    if (observed === null) throw new ManagedBrokerError('broker_stop_identity_changed', 'managed broker process identity changed');
    await sleep(POLL_INTERVAL_MS);
  }
  const final = processMatchesReceipt(receipt);
  if (final === null) {
    if (!pidIsLive(receipt.pid)) return;
    throw new ManagedBrokerError('broker_stop_identity_changed', 'managed broker process identity changed');
  }
  try { process.kill(signalTarget, 'SIGKILL'); } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ESRCH') throw new ManagedBrokerError('broker_stop_failed', 'managed broker could not be stopped');
  }
  const killDeadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < killDeadline && pidIsLive(receipt.pid)) {
    await sleep(POLL_INTERVAL_MS);
  }
  if (pidIsLive(receipt.pid)) throw new ManagedBrokerError('broker_stop_failed', 'managed broker did not stop');
}

function sessionProcessLive(value: unknown): boolean | null {
  const session = objectOf(value);
  const status = session.status;
  const active = status === 'preparing' || status === 'ready' || status === 'running';
  const stopped = status === 'stopped' || status === 'failed' || status === 'cleaned' || status === 'stop_refused';
  if (!active && !stopped) return null;

  if (session.process === undefined) {
    if (status === 'running' || status === 'ready') return null;
    return session.pid === undefined || session.pid === null ? false : null;
  }
  const process = objectOf(session.process);
  const pid = process.pid;
  const marker = process.start_marker;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof marker !== 'string' || marker.length === 0) return null;
  if (!pidIsLive(pid)) return false;
  const observed = processStartMarker(pid);
  if (observed === null) return null;
  return observed === marker;
}

function sessionLeaseMatches(manifest: RunManifest, sessionId: string, ownerNonce: string): boolean {
  if (!secureDirectory(manifest.roots.private)) return false;
  const lease = readSecureFile(join(manifest.roots.private, 'run.active.lock'));
  if (lease.kind !== 'ok' || lease.text === undefined) return false;
  try {
    const raw = objectOf(JSON.parse(lease.text));
    return raw.run_id === manifest.run_id &&
      raw.session_id === sessionId &&
      typeof raw.marker === 'string' &&
      ownerNonce === `${manifest.run_id}:${sessionId}:${raw.marker}` &&
      typeof raw.pid === 'number' &&
      Number.isSafeInteger(raw.pid) &&
      raw.pid > 0 &&
      typeof raw.acquired_at === 'string' &&
      raw.acquired_at.length > 0;
  } catch {
    return false;
  }
}

function liveDiskRunClient(manifest: RunManifest): boolean | null {
  const sessions = manifest.sessions;
  if (!Array.isArray(sessions)) return null;
  const listedIds = new Set<string>();
  for (const session of sessions) {
    const id = objectOf(session).id;
    if (typeof id !== 'string' || id.length === 0 || listedIds.has(id)) return null;
    listedIds.add(id);
    const state = sessionProcessLive(session);
    if (state === null) return null;
    if (state) return true;
  }

  const sessionsRoot = manifest.roots.sessions;
  let rootStat: Stats;
  try {
    rootStat = lstatSync(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return null;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !isOwnedByCurrentUser(rootStat) || (rootStat.mode & 0o022) !== 0) return null;

  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
    const sessionId = entry.name;
    const sessionRoot = join(sessionsRoot, sessionId);
    if (!secureDirectory(sessionRoot)) return null;

    const recordPath = join(sessionRoot, 'session.json');
    const recordFile = readSecureFile(recordPath);
    if (recordFile.kind === 'missing') {
      if (!listedIds.has(sessionId)) return null;
      continue;
    }
    if (recordFile.kind !== 'ok') return null;

    let record: SessionRecordView | null;
    try {
      record = readSessionRecord(manifest, sessionId);
    } catch {
      return null;
    }
    if (record === null) return null;
    const state = sessionProcessLive(record);
    if (state === null) return null;
    if (state) {
      if (record.process === undefined || !sessionLeaseMatches(manifest, sessionId, record.process.owner_nonce)) return null;
      return true;
    }
  }
  return false;
}

function readLiveClientRegistry(path: string): boolean | null {
  const file = readSecureFile(path);
  if (file.kind === 'missing') return false;
  if (file.kind !== 'ok' || file.text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(file.text);
    if (!Array.isArray(parsed)) return null;
    let live = false;
    for (const entry of parsed) {
      const client = objectOf(entry);
      const pid = client.pid;
      if (
        typeof client.run_id !== 'string' ||
        client.run_id.length === 0 ||
        typeof pid !== 'number' ||
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        typeof client.start_marker !== 'string' ||
        client.start_marker.length === 0
      ) return null;
      if (pidIsLive(pid)) {
        const observed = processStartMarker(pid);
        if (observed === null) return null;
        if (observed === client.start_marker) live = true;
      }
    }
    return live;
  } catch {
    return null;
  }
}

function liveRegisteredRunClient(manifest: RunManifest, profileFingerprint: string): boolean | null {
  try {
    verifyManifest(manifest, { trustedRoot: configuredE2eRoot() });
  } catch {
    return null;
  }
  const ownClients = liveDiskRunClient(manifest);
  if (ownClients !== false) return ownClients;
  const registry = readLiveClientRegistry(managerPaths(currentHostProfile(), false).clients);
  if (registry === null || registry) return registry;

  const runsRoot = join(configuredE2eRoot(), 'runs');
  let runsStat: Stats;
  try {
    runsStat = lstatSync(runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return null;
  }
  if (!runsStat.isDirectory() || runsStat.isSymbolicLink() || !isOwnedByCurrentUser(runsStat) || (runsStat.mode & 0o022) !== 0) return null;
  let entries: Dirent[];
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return null;
    if (!entry.isDirectory()) continue;
    const candidateRoot = join(runsRoot, entry.name);
    if (!secureDirectory(candidateRoot)) return null;
    if (resolve(candidateRoot) === resolve(manifest.roots.run)) continue;
    const candidatePath = join(candidateRoot, 'manifest.json');
    const candidateFile = readSecureFile(candidatePath);
    if (candidateFile.kind === 'missing') continue;
    if (candidateFile.kind !== 'ok' || candidateFile.text === undefined) return null;
    let raw: Record<string, unknown>;
    try {
      raw = objectOf(JSON.parse(candidateFile.text));
    } catch {
      return null;
    }
    const auth = objectOf(raw.auth);
    if (auth.mode !== 'native-host-broker') {
      if (auth.mode === 'none' || auth.mode === 'api-key-env' || auth.mode === 'broker') continue;
      return null;
    }
    const candidateFingerprint = normalizedDigest(auth.profile_fingerprint);
    if (candidateFingerprint === null) return null;
    if (candidateFingerprint !== profileFingerprint) continue;

    let candidate: RunManifest;
    try {
      candidate = readManifest(candidatePath, { trustedRoot: configuredE2eRoot() });
    } catch {
      return null;
    }
    const clients = liveDiskRunClient(candidate);
    if (clients === null || clients) return clients;
  }
  return false;
}

async function waitForStartedBroker(validated: ValidatedManifest, paths: ManagerPaths, childPid: number): Promise<{ receipt: ManagedBrokerReceipt; token: string }> {
  const ownerNonce = randomBytes(16).toString('hex');
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let receipt: ManagedBrokerReceipt | null = null;
  while (Date.now() < deadline) {
    const observed = processObservation(childPid);
    if (observed !== null && processMatchesExpected(observed, validated.argv, validated.runtimeBinary, paths.root)) {
      if (receipt === null) {
        receipt = makeReceipt(validated, observed, ownerNonce, paths.root);
        atomicWriteSecureJson(paths.receipt, receipt);
      }
      const token = readManagedBrokerTokenFromProfile(validated.profile);
      if (token !== null && await brokerReady(validated.bind.url, token)) return { receipt, token };
    } else if (!pidIsLive(childPid)) {
      throw new ManagedBrokerError('broker_start_failed', 'native broker process exited before readiness');
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ManagedBrokerError('broker_start_timeout', 'native broker did not become ready');
}

function spawnManagedBroker(validated: ValidatedManifest, paths: ManagerPaths): number {
  const environment = hostProfileEnvironment();
  // The broker is deliberately started from the manager root. Forward the
  // validated absolute agent directory so a host-relative setting cannot
  // resolve differently in that changed working directory.
  environment.PI_CODING_AGENT_DIR = validated.profile.agentDir;
  const child = spawn(validated.runtimeBinary, validated.argv.slice(1), {
    cwd: paths.root,
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (child.pid === undefined || child.pid < 1) throw new ManagedBrokerError('broker_start_failed', 'native broker process could not be started');
  child.unref();
  return child.pid;
}

function removeOwnedReceiptAfterFailure(path: string): void {
  try { removeReceipt(path); } catch { /* preserve the original startup error */ }
}

async function ensureUnderLock(validated: ValidatedManifest, paths: ManagerPaths): Promise<ManagedBrokerResult> {
  const read = readReceipt(paths.receipt);
  if (read.kind === 'unsafe') throw new ManagedBrokerError('broker_receipt_untrusted', 'manager receipt is not a trusted file');
  if (read.kind === 'valid' && read.receipt !== undefined) {
    if (!receiptMatchesManifestAtRoot(read.receipt, validated, paths.root)) {
      throw new ManagedBrokerError('broker_receipt_mismatch', 'manager receipt does not match the requested runtime or profile');
    }
    if (processMatchesReceipt(read.receipt) !== null) {
      const token = readManagedBrokerTokenFromProfile(validated.profile);
      if (token !== null && await brokerReady(validated.bind.url, token)) {
        return { status: 'reused', url: validated.bind.url, token, provider: validated.provider };
      }
      throw new ManagedBrokerError('broker_unhealthy', 'registered native broker is not healthy');
    }
    if (await portIsOccupied(validated.bind.port)) {
      throw new ManagedBrokerError('broker_port_unowned', 'configured broker port is occupied by an unowned listener');
    }
    removeReceipt(paths.receipt);
  } else if (read.kind === 'invalid') {
    if (await portIsOccupied(validated.bind.port)) throw new ManagedBrokerError('broker_port_unowned', 'configured broker port is occupied by an unowned listener');
    removeReceipt(paths.receipt);
  } else if (await portIsOccupied(validated.bind.port)) {
    throw new ManagedBrokerError('broker_port_unowned', 'configured broker port is occupied by an unowned listener');
  }

  const childPid = spawnManagedBroker(validated, paths);
  let startedReceipt: ManagedBrokerReceipt | null = null;
  try {
    const started = await waitForStartedBroker(validated, paths, childPid);
    startedReceipt = started.receipt;
    return { status: 'started', url: validated.bind.url, token: started.token, provider: validated.provider };
  } catch (error) {
    if (startedReceipt !== null) {
      try { await terminateOwnedProcess(startedReceipt); } catch { /* preserve original failure */ }
      removeOwnedReceiptAfterFailure(paths.receipt);
    } else {
      const observation = processObservation(childPid);
      if (observation !== null && processMatchesExpected(observation, validated.argv, validated.runtimeBinary, paths.root)) {
        const temporaryReceipt = makeReceipt(validated, observation, randomBytes(16).toString('hex'), paths.root);
        try { await terminateOwnedProcess(temporaryReceipt); } catch { /* preserve original failure */ }
      }
      removeOwnedReceiptAfterFailure(paths.receipt);
    }
    if (error instanceof ManagedBrokerError) throw error;
    throw new ManagedBrokerError('broker_start_failed', 'native broker could not be started');
  }
}

/** Ensure exactly one manager-owned native broker for the effective host profile. */
export async function ensureManagedBroker(manifest: RunManifest): Promise<ManagedBrokerResult> {
  const validated = await validateManifest(manifest);
  const paths = managerPaths(validated.profile, true);
  const lock = await acquireManagerLockEventually(paths.lock);
  try {
    return await ensureUnderLock(validated, paths);
  } finally {
    lock.release();
  }
}

/** Inspect broker ownership and readiness without starting, stopping, or changing native auth state. */
export async function managedBrokerStatus(manifest: RunManifest): Promise<ManagedBrokerStatusResult> {
  const validated = await validateManifest(manifest);
  const paths = managerPaths(validated.profile, false);
  const read = readReceipt(paths.receipt);
  if (read.kind === 'valid' && read.receipt !== undefined) {
    if (!receiptMatchesManifestAtRoot(read.receipt, validated, paths.root)) return { status: 'failed', url: validated.bind.url };
    if (processMatchesReceipt(read.receipt) === null) {
      return { status: await portIsOccupied(validated.bind.port) ? 'unowned' : 'stopped', url: validated.bind.url };
    }
    const token = readManagedBrokerTokenFromProfile(validated.profile);
    if (token !== null && await brokerReady(validated.bind.url, token)) return { status: 'running', url: validated.bind.url };
    return { status: 'failed', url: validated.bind.url };
  }
  if (read.kind === 'unsafe' || read.kind === 'invalid') return { status: 'failed', url: validated.bind.url };
  if (await portIsOccupied(validated.bind.port)) return { status: 'unowned', url: validated.bind.url };
  return { status: 'stopped', url: validated.bind.url };
}

/** Stop only a matching manager-owned broker, and never an external listener. */
export async function stopManagedBroker(manifest: RunManifest): Promise<void> {
  const validated = await validateManifest(manifest);
  const paths = managerPaths(validated.profile, false);
  if (!existsSync(paths.root)) return;
  const lock = await acquireManagerLockEventually(paths.lock);
  try {
    const read = readReceipt(paths.receipt);
    if (read.kind === 'missing') {
      if (await portIsOccupied(validated.bind.port)) throw new ManagedBrokerError('broker_port_unowned', 'configured broker port is occupied by an unowned listener');
      return;
    }
    if (read.kind !== 'valid' || read.receipt === undefined) {
      throw new ManagedBrokerError('broker_receipt_untrusted', 'manager receipt is not a trusted file');
    }
    if (!receiptMatchesManifestAtRoot(read.receipt, validated, paths.root)) {
      throw new ManagedBrokerError('broker_receipt_mismatch', 'manager receipt does not match the requested runtime or profile');
    }
    const clients = liveRegisteredRunClient(manifest, validated.profile.profileFingerprint);
    if (clients === null) throw new ManagedBrokerError('broker_clients_untrusted', 'registered broker clients are not trusted');
    if (clients) throw new ManagedBrokerError('broker_clients_live', 'a registered E2E run still uses the managed broker');
    if (processMatchesReceipt(read.receipt) === null) {
      if (await portIsOccupied(validated.bind.port)) throw new ManagedBrokerError('broker_port_unowned', 'configured broker port is occupied by an unowned listener');
      removeReceipt(paths.receipt);
      return;
    }
    await terminateOwnedProcess(read.receipt);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (await portIsOccupied(validated.bind.port)) {
      if (Date.now() >= deadline) throw new ManagedBrokerError('broker_stop_failed', 'managed broker listener did not stop');
      await sleep(POLL_INTERVAL_MS);
    }
    removeReceipt(paths.receipt);
  } finally {
    lock.release();
  }
}
