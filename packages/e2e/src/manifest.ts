/**
 * Resolved, secret-free identity for an isolated E2E run.
 *
 * This module deliberately contains no discovery or launch policy.  It is the
 * boundary between preparation and the lifecycle/launch code: readers must
 * validate a manifest before using any path or process receipt in it.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface ManifestReadOptions {
  /**
   * Trusted state root containing `runs/<run_id>/manifest.json`.
   *
   * This is primarily useful to callers that already have an isolated
   * disposable state root (for example, a fixture). Production callers
   * should leave it unset so OMP_E2E_ROOT is the trust anchor.
   */
  readonly trustedRoot?: string;
}

export type RunStatus = 'preparing' | 'ready' | 'running' | 'stopped' | 'finalized' | 'cleaned' | 'failed';
export type SessionStatus = 'preparing' | 'ready' | 'running' | 'stopped' | 'failed' | 'cleaned' | 'stop_refused';
export type AuthMode = 'none' | 'api-key-env' | 'broker';

export interface RuntimeCapabilities {
  readonly supported: boolean;
  readonly command_signals?: readonly string[];
  readonly broker_env?: readonly string[];
  readonly provider_free_probe?: boolean;
  /** A process receipt is evidence of what was observed, not a full inventory. */
  readonly native_inventory?: 'observed-only' | 'unavailable';
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeIdentity {
  /** Always the immutable cache snapshot used by the run, never a PATH lookup. */
  readonly binary: string;
  readonly version: string;
  readonly digest: string;
  readonly platform: string;
  readonly capabilities?: RuntimeCapabilities;
}

export interface ArtifactIdentity {
  /** Immutable package/runtime closure root. */
  readonly root: string;
  readonly digest: string;
  readonly version?: string;
  readonly files?: readonly string[];
}

export interface ArtifactSet {
  readonly core: ArtifactIdentity;
  readonly fullstack: ArtifactIdentity;
}

export interface RunRoots {
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

export interface ApiKeyReference {
  readonly provider: string;
  readonly env_name: string;
}

export interface NoneAuth {
  readonly mode: 'none';
}

export interface ApiKeyAuth {
  readonly mode: 'api-key-env';
  readonly keys: readonly ApiKeyReference[];
}

export interface BrokerAuth {
  readonly mode: 'broker';
  readonly broker_url: string;
  readonly token_env: string;
  readonly refresh_owner_verified?: boolean;
}

/** Explicit opt-in to use the installed omp's current host OAuth store via its native broker. */
export interface NativeHostBrokerAuth {
  readonly mode: 'native-host-broker';
  readonly provider: 'openai-codex' | 'xai-oauth';
  readonly start_local: true;
  readonly bind: string;
  readonly profile_fingerprint: string;
}

export type ManifestAuth = NoneAuth | ApiKeyAuth | BrokerAuth | NativeHostBrokerAuth;

export interface ScenarioIdentity {
  readonly id: string;
  readonly path: string;
  readonly digest: string;
}

export interface ProcessReceipt {
  readonly pid: number;
  readonly pgid: number | null;
  readonly start_marker: string;
  readonly executable_digest: string;
  readonly argv_digest: string;
  /** Relative to roots.run; absolute cwd values are intentionally not exported. */
  readonly cwd_relative: string;
  readonly owner_nonce: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly status: SessionStatus;
  readonly pid?: number | null;
  readonly start_marker?: string;
  readonly process?: ProcessReceipt;
  readonly transcript_path: string;
  readonly log_path: string;
  readonly private_connection_path: string;
}

export interface ManifestErrorDetails {
  readonly field?: string;
  readonly path?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly [key: string]: unknown;
}

export class ManifestError extends Error {
  readonly code: string;
  readonly details: ManifestErrorDetails;

  constructor(code: string, message: string, details: ManifestErrorDetails = {}) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
    this.details = details;
  }
}

export interface RunManifest {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly input_digest: string;
  readonly status: RunStatus;
  readonly runtime: RuntimeIdentity;
  readonly artifacts: ArtifactSet;
  readonly roots: RunRoots;
  readonly auth: ManifestAuth;
  readonly model: string | null;
  readonly scenario: ScenarioIdentity;
  readonly sessions: readonly SessionRecord[];
  readonly errors?: readonly { readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> }[];
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly config_path?: string;
  readonly receipts?: readonly Readonly<Record<string, unknown>>[];
}

const DIGEST_RE = /^(?:sha256:)?([a-f0-9]{64})$/iu;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('manifest_invalid', `${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError('manifest_invalid', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function digest(value: unknown, field: string): string {
  const text = string(value, field);
  if (DIGEST_RE.exec(text) === null) {
    throw new ManifestError('manifest_invalid', `${field} must be a sha256 digest`, { field, actual: text });
  }
  return text.replace(/^sha256:/iu, '').toLowerCase();
}

function absolutePath(value: unknown, field: string): string {
  const text = string(value, field);
  if (!isAbsolute(text)) {
    throw new ManifestError('manifest_invalid', `${field} must be absolute`, { field, actual: text });
  }
  return resolve(text);
}

function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function trustRoot(options: ManifestReadOptions = {}): string {
  const configured = options.trustedRoot ?? process.env.OMP_E2E_ROOT;
  const root = configured ?? join(tmpdir(), 'omp-workflows-e2e');
  return resolve(root);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function equivalentPath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return leftResolved === rightResolved || canonicalPath(leftResolved) === canonicalPath(rightResolved);
}

function assertNoSymlinkComponents(root: string, target: string, field: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  try {
    if (lstatSync(targetResolved).isSymbolicLink()) {
      throw new ManifestError('manifest_symlink_path', `${field} contains a symbolic link`, { field, path: targetResolved });
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT') throw new ManifestError('manifest_path_unreadable', `${field} could not be inspected`, { field, path: targetResolved });
  }
  let rootChecked = rootResolved;
  let targetChecked = targetResolved;
  if (!contained(rootChecked, targetChecked)) {
    const canonicalRoot = canonicalPath(rootChecked);
    const canonicalTarget = canonicalPath(targetChecked);
    if (!contained(canonicalRoot, canonicalTarget)) {
      throw new ManifestError('manifest_path_outside_run', `${field} escaped its trusted root`, { field, root: rootResolved, path: targetResolved });
    }
    rootChecked = canonicalRoot;
    targetChecked = canonicalTarget;
  }
  try {
    const rootStat = lstatSync(rootChecked);
    if (rootStat.isSymbolicLink()) {
      throw new ManifestError('manifest_symlink_path', `${field} contains a symbolic link`, { field, path: rootChecked });
    }
    if (!rootStat.isDirectory()) {
      throw new ManifestError('manifest_path_not_directory', `${field} root is not a directory`, { field, path: rootChecked });
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code === 'ENOENT') return;
    throw new ManifestError('manifest_path_unreadable', `${field} could not be inspected`, { field, path: rootChecked });
  }
  let current = rootChecked;
  const rel = relative(rootChecked, targetChecked);
  const components = rel === '' ? [] : rel.split(sep);
  for (const component of components) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ManifestError('manifest_symlink_path', `${field} contains a symbolic link`, { field, path: current });
      }
    } catch (error) {
      if (error instanceof ManifestError) throw error;
      const code = error as NodeJS.ErrnoException;
      if (code.code === 'ENOENT') return;
      throw new ManifestError('manifest_path_unreadable', `${field} could not be inspected`, { field, path: current });
    }
  }
}

const ROOT_NAMES = ['run', 'home', 'agent', 'workspace', 'tmp', 'private', 'sessions', 'logs', 'evidence'] as const;

export function expectedRunRoots(runId: string, options: ManifestReadOptions = {}): RunRoots {
  const id = assertId(runId, 'run_id');
  const run = join(trustRoot(options), 'runs', id);
  return {
    run,
    home: join(run, 'home'),
    agent: join(run, 'home', '.omp', 'agent'),
    workspace: join(run, 'workspace'),
    tmp: join(run, 'tmp'),
    private: join(run, 'private'),
    sessions: join(run, 'sessions'),
    logs: join(run, 'logs'),
    evidence: join(run, 'evidence'),
  };
}

export function assertTrustedRunRoots(runId: string, roots: RunRoots, options: ManifestReadOptions = {}): void {
  const expected = expectedRunRoots(runId, options);
  const stateRoot = trustRoot(options);
  assertNoSymlinkComponents(stateRoot, join(stateRoot, 'runs'), 'trusted E2E runs root');
  for (const name of ROOT_NAMES) {
    if (!equivalentPath(roots[name], expected[name])) {
      throw new ManifestError('manifest_path_untrusted', `roots.${name} is not the prepared run location`, {
        field: `roots.${name}`,
        expected: expected[name],
        actual: roots[name],
      });
    }
    assertNoSymlinkComponents(expected.run, roots[name], `roots.${name}`);
  }
  assertNoSymlinkComponents(stateRoot, expected.run, 'trusted E2E run root');
}

function assertTrustedManifestPath(path: string, runId: string, options: ManifestReadOptions, requireExisting: boolean): string {
  const expected = join(expectedRunRoots(runId, options).run, 'manifest.json');
  const candidate = resolve(path);
  if (!equivalentPath(candidate, expected)) {
    throw new ManifestError('manifest_path_untrusted', 'manifest path is not the configured run manifest', {
      path: candidate,
      expected,
    });
  }
  const stateRoot = trustRoot(options);
  assertNoSymlinkComponents(stateRoot, expectedRunRoots(runId, options).run, 'trusted E2E run root');
  assertNoSymlinkComponents(expectedRunRoots(runId, options).run, expected, 'manifest path');
  try {
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new ManifestError('manifest_symlink_path', 'manifest path must not be a symbolic link', { path: candidate });
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT' || requireExisting) {
      throw new ManifestError('manifest_unreadable', 'manifest path could not be inspected', { path: candidate });
    }
  }
  return expected;
}

function pathWithinAny(target: string, roots: readonly string[]): boolean {
  return roots.some(root => contained(root, target));
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ManifestError('manifest_unknown_field', `${field}.${key} is not supported`, { field: `${field}.${key}` });
    }
  }
}

function assertId(value: unknown, field: string): string {
  const text = string(value, field);
  if (!ID_RE.test(text)) throw new ManifestError('manifest_invalid', `${field} contains unsupported characters`, { field });
  return text;
}

function validateRoots(value: unknown): RunRoots {
  const raw = record(value, 'roots');
  assertKnownKeys(raw, [...ROOT_NAMES], 'roots');
  const result = {
    run: absolutePath(raw.run, 'roots.run'),
    home: absolutePath(raw.home, 'roots.home'),
    agent: absolutePath(raw.agent, 'roots.agent'),
    workspace: absolutePath(raw.workspace, 'roots.workspace'),
    tmp: absolutePath(raw.tmp, 'roots.tmp'),
    private: absolutePath(raw.private, 'roots.private'),
    sessions: absolutePath(raw.sessions, 'roots.sessions'),
    logs: absolutePath(raw.logs, 'roots.logs'),
    evidence: absolutePath(raw.evidence, 'roots.evidence'),
  } satisfies RunRoots;
  for (const name of ROOT_NAMES) {
    if (name !== 'run' && !contained(result.run, result[name])) {
      throw new ManifestError('manifest_path_outside_run', `roots.${name} must be under roots.run`, { field: `roots.${name}`, root: result.run });
    }
  }
  return result;
}

function validateAuth(value: unknown): ManifestAuth {
  const raw = record(value, 'auth');
  const mode = raw.mode;
  if (mode === 'none') {
    assertKnownKeys(raw, ['mode'], 'auth');
    return { mode: 'none' };
  }
  if (mode === 'api-key-env') {
    assertKnownKeys(raw, ['mode', 'keys'], 'auth');
    if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
      throw new ManifestError('manifest_invalid', 'auth.keys must contain at least one provider reference', { field: 'auth.keys' });
    }
    const keys = raw.keys.map((item, index) => {
      const entry = record(item, `auth.keys[${index}]`);
      assertKnownKeys(entry, ['provider', 'env_name'], `auth.keys[${index}]`);
      const provider = assertId(entry.provider, `auth.keys[${index}].provider`);
      const envName = string(entry.env_name, `auth.keys[${index}].env_name`);
      if (!ENV_RE.test(envName)) throw new ManifestError('manifest_invalid', 'auth env_name is not a valid environment variable', { field: `auth.keys[${index}].env_name` });
      return { provider, env_name: envName };
    });
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key.env_name)) throw new ManifestError('manifest_invalid', 'auth.keys must not repeat an environment variable', { field: 'auth.keys', env_name: key.env_name });
      seen.add(key.env_name);
    }
    return { mode: 'api-key-env', keys };
  }
  if (mode === 'broker') {
    assertKnownKeys(raw, ['mode', 'broker_url', 'token_env', 'refresh_owner_verified'], 'auth');
    const brokerUrl = string(raw.broker_url, 'auth.broker_url');
    let parsed: URL;
    try {
      parsed = new URL(brokerUrl);
    } catch {
      throw new ManifestError('manifest_invalid', 'auth.broker_url must be a URL', { field: 'auth.broker_url' });
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:'))) {
      throw new ManifestError('manifest_unsafe_auth_endpoint', 'broker endpoint must be TLS or loopback HTTP without credentials/query', { field: 'auth.broker_url' });
    }
    const tokenEnv = string(raw.token_env, 'auth.token_env');
    if (!ENV_RE.test(tokenEnv)) throw new ManifestError('manifest_invalid', 'auth.token_env is not a valid environment variable', { field: 'auth.token_env' });
    if (raw.refresh_owner_verified !== undefined && typeof raw.refresh_owner_verified !== 'boolean') {
      throw new ManifestError('manifest_invalid', 'auth.refresh_owner_verified must be boolean', { field: 'auth.refresh_owner_verified' });
    }
    return {
      mode: 'broker',
      broker_url: parsed.toString().replace(/\/$/u, ''),
      token_env: tokenEnv,
      ...(raw.refresh_owner_verified === undefined ? {} : { refresh_owner_verified: raw.refresh_owner_verified }),
    };
  }
  if (mode === 'native-host-broker') {
    assertKnownKeys(raw, ['mode', 'provider', 'start_local', 'bind', 'profile_fingerprint'], 'auth');
    if (raw.provider !== 'openai-codex' && raw.provider !== 'xai-oauth') {
      throw new ManifestError('manifest_invalid', 'auth.provider must be openai-codex or xai-oauth', { field: 'auth.provider' });
    }
    if (raw.start_local !== true) throw new ManifestError('manifest_invalid', 'native host broker requires explicit start_local: true', { field: 'auth.start_local' });
    const bind = string(raw.bind, 'auth.bind');
    const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(bind);
    const port = match === null ? 0 : Number(match[1]);
    if (port < 1 || port > 65535) throw new ManifestError('manifest_unsafe_auth_endpoint', 'native host broker must bind a specific IPv4 loopback port', { field: 'auth.bind' });
    return { mode, provider: raw.provider, start_local: true, bind, profile_fingerprint: digest(raw.profile_fingerprint, 'auth.profile_fingerprint') };
  }
  throw new ManifestError('manifest_invalid', 'auth.mode must be none, api-key-env, broker, or native-host-broker', { field: 'auth.mode' });
}

function validateRuntime(value: unknown): RuntimeIdentity {
  const raw = record(value, 'runtime');
  assertKnownKeys(raw, ['binary', 'version', 'digest', 'platform', 'capabilities'], 'runtime');
  const binary = absolutePath(raw.binary, 'runtime.binary');
  if (SCHEME_RE.test(binary)) throw new ManifestError('manifest_invalid', 'runtime.binary must be a local path', { field: 'runtime.binary' });
  const version = string(raw.version, 'runtime.version');
  const runtimeDigest = digest(raw.digest, 'runtime.digest');
  const platform = string(raw.platform, 'runtime.platform');
  let capabilities: RuntimeCapabilities | undefined;
  if (raw.capabilities !== undefined) {
    const caps = record(raw.capabilities, 'runtime.capabilities');
    if (typeof caps.supported !== 'boolean') throw new ManifestError('manifest_invalid', 'runtime.capabilities.supported must be boolean', { field: 'runtime.capabilities.supported' });
    capabilities = { ...caps, supported: caps.supported } as RuntimeCapabilities;
  }
  return { binary, version, digest: runtimeDigest, platform, ...(capabilities === undefined ? {} : { capabilities }) };
}

function validateArtifact(value: unknown, field: string): ArtifactIdentity {
  const raw = record(value, field);
  assertKnownKeys(raw, ['root', 'digest', 'version', 'files'], field);
  const root = absolutePath(raw.root, `${field}.root`);
  const artifactDigest = digest(raw.digest, `${field}.digest`);
  const version = raw.version === undefined ? undefined : string(raw.version, `${field}.version`);
  let files: readonly string[] | undefined;
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files)) throw new ManifestError('manifest_invalid', `${field}.files must be an array`, { field: `${field}.files` });
    files = raw.files.map((entry, index) => string(entry, `${field}.files[${index}]`));
  }
  return { root, digest: artifactDigest, ...(version === undefined ? {} : { version }), ...(files === undefined ? {} : { files }) };
}

function validateScenario(value: unknown, roots: RunRoots, field = 'scenario'): ScenarioIdentity {
  const raw = record(value, field);
  assertKnownKeys(raw, ['id', 'path', 'digest'], field);
  const id = assertId(raw.id, `${field}.id`);
  const path = absolutePath(raw.path, `${field}.path`);
  if (!pathWithinAny(path, [roots.run])) {
    throw new ManifestError('manifest_path_outside_run', `${field}.path must be in the run root`, { field: `${field}.path`, path });
  }
  return { id, path, digest: digest(raw.digest, `${field}.digest`) };
}

export function validateProcessReceipt(value: unknown, field = 'process'): ProcessReceipt {
  const processRaw = record(value, field);
  assertKnownKeys(processRaw, ['pid', 'pgid', 'start_marker', 'executable_digest', 'argv_digest', 'cwd_relative', 'owner_nonce'], field);
  if (typeof processRaw.pid !== 'number' || !Number.isSafeInteger(processRaw.pid) || processRaw.pid <= 0) {
    throw new ManifestError('manifest_invalid', `${field}.pid is invalid`, { field: `${field}.pid` });
  }
  if (processRaw.pgid !== null && processRaw.pgid !== undefined && (typeof processRaw.pgid !== 'number' || !Number.isSafeInteger(processRaw.pgid) || processRaw.pgid <= 0)) {
    throw new ManifestError('manifest_invalid', `${field}.pgid is invalid`, { field: `${field}.pgid` });
  }
  const cwdRelative = string(processRaw.cwd_relative, `${field}.cwd_relative`);
  if (isAbsolute(cwdRelative) || cwdRelative.split(/[\\/]/u).includes('..')) {
    throw new ManifestError('manifest_invalid', `${field}.cwd_relative must be relative and contained`, { field: `${field}.cwd_relative` });
  }
  return {
    pid: processRaw.pid,
    pgid: processRaw.pgid === undefined ? null : processRaw.pgid,
    start_marker: string(processRaw.start_marker, `${field}.start_marker`),
    executable_digest: digest(processRaw.executable_digest, `${field}.executable_digest`),
    argv_digest: digest(processRaw.argv_digest, `${field}.argv_digest`),
    cwd_relative: cwdRelative,
    owner_nonce: string(processRaw.owner_nonce, `${field}.owner_nonce`),
  };
}

function validateSession(value: unknown, roots: RunRoots, index: number, runId: string): SessionRecord {
  const field = `sessions[${index}]`;
  const raw = record(value, field);
  assertKnownKeys(raw, ['id', 'status', 'pid', 'start_marker', 'process', 'transcript_path', 'log_path', 'private_connection_path'], field);
  const id = assertId(raw.id, `${field}.id`);
  const status = raw.status;
  if (status !== 'preparing' && status !== 'ready' && status !== 'running' && status !== 'stopped' && status !== 'failed' && status !== 'cleaned' && status !== 'stop_refused') {
    throw new ManifestError('manifest_invalid', `${field}.status is invalid`, { field: `${field}.status` });
  }
  if (raw.pid !== undefined && raw.pid !== null && (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0)) {
    throw new ManifestError('manifest_invalid', `${field}.pid must be a positive integer or null`, { field: `${field}.pid` });
  }
  const startMarker = raw.start_marker === undefined ? undefined : string(raw.start_marker, `${field}.start_marker`);
  const transcript = absolutePath(raw.transcript_path, `${field}.transcript_path`);
  const log = absolutePath(raw.log_path, `${field}.log_path`);
  const connection = absolutePath(raw.private_connection_path, `${field}.private_connection_path`);
  const expectedTranscript = join(roots.sessions, id, 'transcript.jsonl');
  const expectedLog = join(roots.logs, `${id}.log`);
  const expectedConnection = join(roots.private, 'sessions', id, 'connection.json');
  if (!equivalentPath(transcript, expectedTranscript)) throw new ManifestError('manifest_path_outside_run', `${field}.transcript_path is not the session transcript`, { field });
  if (!equivalentPath(log, expectedLog)) throw new ManifestError('manifest_path_outside_run', `${field}.log_path is not the session log`, { field });
  if (!equivalentPath(connection, expectedConnection)) throw new ManifestError('manifest_path_outside_run', `${field}.private_connection_path is not the session connection`, { field });
  let processReceipt: ProcessReceipt | undefined;
  if (raw.process !== undefined) {
    processReceipt = validateProcessReceipt(raw.process, `${field}.process`);
    if (raw.pid !== processReceipt.pid) {
      throw new ManifestError('manifest_process_receipt_invalid', `${field}.pid does not match process.pid`, { field });
    }
    if (startMarker !== processReceipt.start_marker) {
      throw new ManifestError('manifest_process_receipt_invalid', `${field}.start_marker does not match process.start_marker`, { field });
    }
    if (!processReceipt.owner_nonce.startsWith(`${runId}:${id}:`) || processReceipt.owner_nonce.length <= `${runId}:${id}:`.length) {
      throw new ManifestError('manifest_process_receipt_invalid', `${field}.process.owner_nonce is not bound to this run/session`, { field });
    }
    const cwd = resolve(roots.run, processReceipt.cwd_relative);
    if (!contained(roots.run, cwd)) {
      throw new ManifestError('manifest_process_receipt_invalid', `${field}.process.cwd_relative escaped the run root`, { field });
    }
  } else if (raw.pid !== undefined && raw.pid !== null) {
    throw new ManifestError('manifest_process_receipt_missing', `${field}.pid has no process ownership receipt`, { field });
  }
  return {
    id,
    status,
    ...(raw.pid === undefined ? {} : { pid: raw.pid as number | null }),
    ...(startMarker === undefined ? {} : { start_marker: startMarker }),
    ...(processReceipt === undefined ? {} : { process: processReceipt }),
    transcript_path: transcript,
    log_path: log,
    private_connection_path: connection,
  };
}

export function verifyManifest(manifest: RunManifest, options: ManifestReadOptions = {}): void {
  try {
    const value = record(manifest, 'manifest');
    assertKnownKeys(value, ['schema_version', 'run_id', 'input_digest', 'status', 'runtime', 'artifacts', 'roots', 'auth', 'model', 'scenario', 'sessions', 'errors', 'created_at', 'updated_at', 'config_path', 'receipts'], 'manifest');
    if (value.schema_version !== MANIFEST_SCHEMA_VERSION) throw new ManifestError('manifest_schema_unsupported', 'manifest schema_version is unsupported', { field: 'schema_version', expected: MANIFEST_SCHEMA_VERSION, actual: value.schema_version });
    const runId = assertId(value.run_id, 'run_id');
    digest(value.input_digest, 'input_digest');
    const status = value.status;
    if (status !== 'preparing' && status !== 'ready' && status !== 'running' && status !== 'stopped' && status !== 'finalized' && status !== 'cleaned' && status !== 'failed') throw new ManifestError('manifest_invalid', 'status is invalid', { field: 'status' });
    const roots = validateRoots(value.roots);
    assertTrustedRunRoots(runId, roots, options);
    validateRuntime(value.runtime);
    const artifacts = record(value.artifacts, 'artifacts');
    assertKnownKeys(artifacts, ['core', 'fullstack'], 'artifacts');
    validateArtifact(artifacts.core, 'artifacts.core');
    validateArtifact(artifacts.fullstack, 'artifacts.fullstack');
    validateAuth(value.auth);
    if (value.model !== null && value.model !== undefined && typeof value.model !== 'string') throw new ManifestError('manifest_invalid', 'model must be a string or null', { field: 'model' });
    validateScenario(value.scenario, roots);
    if (!Array.isArray(value.sessions)) throw new ManifestError('manifest_invalid', 'sessions must be an array', { field: 'sessions' });
    const sessionIds = new Set<string>();
    for (const [index, session] of value.sessions.entries()) {
      const validated = validateSession(session, roots, index, runId);
      if (sessionIds.has(validated.id)) throw new ManifestError('manifest_invalid', 'session ids must be unique', { field: `sessions[${index}].id` });
      sessionIds.add(validated.id);
    }
    if (value.errors !== undefined) {
      if (!Array.isArray(value.errors)) throw new ManifestError('manifest_invalid', 'errors must be an array', { field: 'errors' });
      for (const [index, error] of value.errors.entries()) {
        const entry = record(error, `errors[${index}]`);
        assertKnownKeys(entry, ['code', 'message', 'details'], `errors[${index}]`);
        string(entry.code, `errors[${index}].code`);
        string(entry.message, `errors[${index}].message`);
        if (entry.details !== undefined) record(entry.details, `errors[${index}].details`);
      }
    }
    for (const field of ['created_at', 'updated_at'] as const) {
      if (value[field] !== undefined) string(value[field], field);
    }
    if (value.config_path !== undefined) {
      const configPath = string(value.config_path, 'config_path');
      if (!isAbsolute(configPath)) throw new ManifestError('manifest_invalid', 'config_path must be absolute', { field: 'config_path' });
    }
    if (value.receipts !== undefined && !Array.isArray(value.receipts)) throw new ManifestError('manifest_invalid', 'receipts must be an array', { field: 'receipts' });
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError('manifest_invalid', 'manifest validation failed');
  }
}

function runIdFromManifestPath(path: string, options: ManifestReadOptions): string {
  const stateRoot = trustRoot(options);
  const runsRoot = join(stateRoot, 'runs');
  assertNoSymlinkComponents(stateRoot, runsRoot, 'trusted E2E runs root');
  const candidate = canonicalPath(path);
  const relativePath = relative(canonicalPath(runsRoot), candidate);
  const parts = relativePath === '' ? [] : relativePath.split(sep);
  if (parts.length !== 2 || parts[1] !== 'manifest.json') {
    throw new ManifestError('manifest_path_untrusted', 'manifest path must be runs/<run_id>/manifest.json', { path: resolve(path) });
  }
  return assertId(parts[0], 'run_id');
}

export function readManifest(path: string, options: ManifestReadOptions = {}): RunManifest {
  const runId = runIdFromManifestPath(path, options);
  const manifestPath = assertTrustedManifestPath(path, runId, options, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new ManifestError('manifest_unreadable', 'manifest could not be read', { path: manifestPath, cause: error instanceof Error ? error.message : String(error) });
  }
  try {
    const raw = record(parsed, 'manifest');
    if (raw.run_id !== runId) {
      throw new ManifestError('manifest_path_untrusted', 'manifest run_id does not match its trusted path', { path: manifestPath, expected: runId, actual: raw.run_id });
    }
    verifyManifest(parsed as RunManifest, options);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError('manifest_invalid', 'manifest validation failed', { path: manifestPath });
  }
  return parsed as RunManifest;
}

/** Internal/publicly useful atomic writer used by prepare and lifecycle callers. */
export function writeManifest(path: string, manifest: RunManifest, options: ManifestReadOptions = {}): void {
  verifyManifest(manifest, options);
  const manifestPath = assertTrustedManifestPath(path, manifest.run_id, options, false);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(expectedRunRoots(manifest.run_id, options).run, dirname(manifestPath), 'manifest parent');
  const temporary = `${manifestPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // chmod is best-effort on filesystems that do not expose POSIX modes.
    }
    try {
      if (lstatSync(manifestPath).isSymbolicLink()) {
        throw new ManifestError('manifest_symlink_path', 'manifest destination must not be a symbolic link', { path: manifestPath });
      }
    } catch (error) {
      if (error instanceof ManifestError) throw error;
      const code = error as NodeJS.ErrnoException;
      if (code.code !== 'ENOENT') throw new ManifestError('manifest_unreadable', 'manifest destination could not be inspected', { path: manifestPath });
    }
    renameSync(temporary, manifestPath);
  } catch (error) {
    try {
      if (existsSync(temporary) && lstatSync(temporary).isFile()) unlinkSync(temporary);
    } catch {
      // Cleanup is best-effort; preserve the original write failure.
    }
    throw error;
  }
}

export function manifestDigest(manifest: RunManifest): string {
  const normalized = JSON.stringify(manifest);
  return createHash('sha256').update(normalized).digest('hex');
}

/** Check that a manifest path is the expected run's manifest without following an untrusted path. */
export function assertManifestPath(path: string, runRoot: string): void {
  const expected = join(resolve(runRoot), 'manifest.json');
  const resolved = resolve(path);
  if (!equivalentPath(resolved, expected)) {
    throw new ManifestError('manifest_path_outside_run', 'manifest path is not the run manifest', { path: resolved, runRoot: resolve(runRoot) });
  }
  try {
    const rootStat = lstatSync(resolve(runRoot));
    if (rootStat.isSymbolicLink()) throw new ManifestError('manifest_symlink_path', 'manifest run root must not be a symbolic link', { runRoot: resolve(runRoot) });
    if (!rootStat.isDirectory()) throw new ManifestError('manifest_path_unreadable', 'manifest run root is not a directory', { runRoot: resolve(runRoot) });
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ManifestError('manifest_path_unreadable', 'manifest run root could not be inspected', { runRoot: resolve(runRoot) });
  }
  assertNoSymlinkComponents(resolve(runRoot), expected, 'manifest path');
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new ManifestError('manifest_symlink_path', 'manifest path must not be a symbolic link', { path: resolved });
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code !== 'ENOENT') throw new ManifestError('manifest_unreadable', 'manifest path could not be inspected', { path: resolved });
  }
}

/** Remove only a manifest temp file left by an interrupted atomic write. */
export function removeManifestTemp(path: string): void {
  if (!path.endsWith('.tmp')) return;
  try {
    if (existsSync(path) && lstatSync(path).isFile()) unlinkSync(path);
  } catch {
    // Addressed cleanup is idempotent; a concurrent cleanup may have won.
  }
}
