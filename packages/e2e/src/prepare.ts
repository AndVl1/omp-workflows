/** Prepare/doctor entrypoints for a deterministic isolated run. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ManifestError,
  MANIFEST_SCHEMA_VERSION,
  type ApiKeyAuth,
  type BrokerAuth,
  type ManifestAuth,
  type RunManifest,
  type RunRoots,
  type RunStatus,
  type RuntimeCapabilities,
  type NativeHostBrokerAuth,
  type NoneAuth,
  writeManifest,
  readManifest,
} from './manifest.js';
import {
  buildPackageArtifact,
  materializeDependencyClosure,
  materializeDependencyRoots,
  snapshotSource,
  verifyPackageArtifact,
  type PackageArtifact,
  type PackageDependencyRoot,
  type SourceSnapshot,
} from './artifacts.js';
import {
  inspectInstalledRuntime,
  probeProviderFreeRuntime,
  snapshotRuntime,
  verifyRuntimeSnapshot,
  writeProviderFreeCatalog,
  type RuntimeProbe,
  type RuntimeSnapshot,
} from './runtime.js';
import { checkBrokerConnection } from './auth.js';
import { hostAuthProfileFingerprint } from './broker.js';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DEFAULT_TIMEOUT_MS = 5_000;
const PREPARE_ENV_ALLOWLIST = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;
const SECRET_ENV_NAME_RE = /(?:api[_-]?key|token|secret|password|credential|bearer|private[_-]?key|cookie|proxy)/iu;
const OUTPUT_SECRET_RE = /((?:authorization|api[_-]?key|token|secret|password|credential|bearer|private[_-]?key|cookie|proxy)\s*["']?\s*[:=]\s*)((?:Bearer|Basic)\s+[^\s,;}\]]+|"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const OUTPUT_TOKEN_RE = /\b(?:sk|pk|rk|xai|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{4,}\b/giu;
const OUTPUT_OPAQUE_RE = /\b[A-Za-z0-9][A-Za-z0-9+\/_=-]{23,}\b/gu;
const SUBPROCESS_OUTPUT_LIMIT = 8_000;

export interface PrepareConfig {
  readonly schema_version: 1;
  readonly runtime: { readonly binary?: string };
  readonly artifacts: {
    readonly core: { readonly source: string };
    readonly fullstack: { readonly source: string };
  };
  readonly fixture?: { readonly source: string };
  readonly scenario: { readonly id: string; readonly path: string };
  readonly model: string | null;
  readonly auth: ManifestAuth;
  readonly timeout_ms?: number;
  readonly retention?: 'keep' | 'cleanup';
}

export interface PrepareError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PrepareResult {
  readonly ok: boolean;
  readonly status: RunStatus | 'blocked';
  readonly manifest?: RunManifest;
  readonly manifestPath?: string;
  readonly nextCommand?: string;
  readonly error?: PrepareError;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly status: RunStatus | 'blocked';
  readonly manifest?: RunManifest;
  readonly manifestPath?: string;
  readonly nextCommand?: string;
  readonly error?: PrepareError;
  readonly checks?: Readonly<Record<string, boolean | string>>;
}

export interface PrepareState {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly status: 'preparing' | 'failed';
  readonly input_digest: string;
  readonly run_root: string;
  readonly cleanup_paths: readonly string[];
  readonly lock_marker: string;
  readonly error?: PrepareError;
}

interface RawConfig {
  readonly schema_version?: unknown;
  readonly runtime?: unknown;
  readonly artifacts?: unknown;
  readonly fixture?: unknown;
  readonly scenario?: unknown;
  readonly model?: unknown;
  readonly auth?: unknown;
  readonly timeout_ms?: unknown;
  readonly retention?: unknown;
}

interface LockHandle {
  readonly path: string;
  readonly marker: string;
  readonly release: () => void;
}

function prepareError(code: string, message: string, details: Readonly<Record<string, unknown>> = {}): ManifestError {
  return new ManifestError(code, message, details);
}

function errorResult(error: unknown, manifestPath?: string): PrepareResult {
  if (error instanceof ManifestError) {
    return { ok: false, status: 'failed', ...(manifestPath === undefined ? {} : { manifestPath }), error: { code: error.code, message: error.message, details: error.details } };
  }
  return { ok: false, status: 'failed', ...(manifestPath === undefined ? {} : { manifestPath }), error: { code: 'prepare_failed', message: error instanceof Error ? error.message : String(error) } };
}

function doctorError(error: unknown, manifestPath: string, manifest?: RunManifest): DoctorResult {
  if (error instanceof ManifestError) return { ok: false, status: manifest?.status ?? 'failed', manifestPath, ...(manifest === undefined ? {} : { manifest }), error: { code: error.code, message: error.message, details: error.details } };
  return { ok: false, status: manifest?.status ?? 'failed', manifestPath, ...(manifest === undefined ? {} : { manifest }), error: { code: 'doctor_failed', message: error instanceof Error ? error.message : String(error) } };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw prepareError('config_invalid', `${field} must be an object`, { field });
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw prepareError('config_invalid', `${field} must be a non-empty string`, { field });
  return value;
}

function requireId(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ID_RE.test(text)) throw prepareError('config_invalid', `${field} contains unsupported characters`, { field });
  return text;
}


function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw prepareError('config_unknown_field', `${field}.${key} is not supported`, { field: `${field}.${key}` });
    if (/(?:secret|token|password|credential|bearer|api[_-]?key|private[_-]?key)/iu.test(key)) throw prepareError('config_secret_forbidden', `${field}.${key} may not contain a secret value`, { field: `${field}.${key}` });
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function pathContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function redactSubprocessOutput(value: string, limit = SUBPROCESS_OUTPUT_LIMIT): string {
  let filtered = value;
  const inheritedSecrets = Object.entries(process.env)
    .filter((entry): entry is [string, string] => SECRET_ENV_NAME_RE.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length >= 4)
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of inheritedSecrets) filtered = filtered.replaceAll(secret, '[REDACTED]');
  filtered = filtered
    .replace(OUTPUT_SECRET_RE, '$1[REDACTED]')
    .replace(OUTPUT_TOKEN_RE, '[REDACTED]')
    .replace(OUTPUT_OPAQUE_RE, '[REDACTED]');
  if (filtered.length <= limit) return filtered;
  return `…${filtered.slice(-limit)}`;
}

function inheritedPrepareEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PREPARE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  return env;
}

function executablePath(extra: readonly string[] = []): string {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return [...extra, dirname(process.execPath), '/usr/bin', '/bin']
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index)
    .join(delimiter);
}

function assertNoSymlinkComponents(root: string, target: string, field: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (!pathContained(rootResolved, targetResolved)) {
    throw prepareError('partial_state_invalid', `${field} escaped its expected root`, { field, root: rootResolved, path: targetResolved });
  }
  try {
    const rootStat = lstatSync(rootResolved);
    if (rootStat.isSymbolicLink()) throw prepareError('partial_state_symlink', `${field} contains a symbolic link`, { field, path: rootResolved });
    if (!rootStat.isDirectory()) throw prepareError('partial_state_invalid', `${field} root is not a directory`, { field, path: rootResolved });
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw prepareError('partial_state_unreadable', `${field} could not be inspected`, { field, path: rootResolved });
  }
  let current = rootResolved;
  const relativePath = relative(rootResolved, targetResolved);
  const components = relativePath === '' ? [] : relativePath.split(sep);
  for (const component of components) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw prepareError('partial_state_symlink', `${field} contains a symbolic link`, { field, path: current });
      if (!stat.isDirectory()) throw prepareError('partial_state_invalid', `${field} contains a non-directory path component`, { field, path: current });
    } catch (error) {
      if (error instanceof ManifestError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw prepareError('partial_state_unreadable', `${field} could not be inspected`, { field, path: current });
    }
  }
}

function assertNoSymlinksInTree(path: string, field: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw prepareError('partial_state_unreadable', `${field} could not be inspected`, { field, path });
  }
  if (stat.isSymbolicLink()) throw prepareError('partial_state_symlink', `${field} contains a symbolic link`, { field, path });
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    throw prepareError('partial_state_unreadable', `${field} could not be inspected`, { field, path });
  }
  for (const entry of entries) assertNoSymlinksInTree(join(path, entry), field);
}



function packageRootFromConfig(configPath: string): string {
  let cursor = dirname(configPath);
  for (;;) {
    if (existsSync(join(cursor, 'packages', 'core', 'package.json')) && existsSync(join(cursor, 'packages', 'fullstack', 'package.json'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return dirname(configPath);
}

function resolveDeclaredPath(value: unknown, field: string, configDir: string, repositoryRoot: string): string {
  const raw = requireString(value, field);
  if (raw.startsWith('~')) throw prepareError('config_external_path', `${field} must not use home expansion`, { field });
  const candidate = resolve(configDir, raw);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw prepareError('config_path_missing', `${field} does not exist`, { field, path: candidate });
  }
  if (!pathContained(configDir, real) && !pathContained(repositoryRoot, real)) throw prepareError('config_external_path', `${field} points outside the declared checkout`, { field, path: real });
  return real;
}

function parseAuth(value: unknown): ManifestAuth {
  const raw = requireRecord(value, 'auth');
  const mode = raw.mode;
  if (mode === 'none') {
    assertKnownKeys(raw, ['mode'], 'auth');
    return { mode: 'none' } satisfies NoneAuth;
  }
  if (mode === 'api-key-env') {
    assertKnownKeys(raw, ['mode', 'keys'], 'auth');
    if (!Array.isArray(raw.keys) || raw.keys.length === 0) throw prepareError('config_invalid', 'auth.keys must not be empty', { field: 'auth.keys' });
    const keys = raw.keys.map((item, index) => {
      const entry = requireRecord(item, `auth.keys[${index}]`);
      assertKnownKeys(entry, ['provider', 'env_name'], `auth.keys[${index}]`);
      const provider = requireId(entry.provider, `auth.keys[${index}].provider`);
      const envName = requireString(entry.env_name, `auth.keys[${index}].env_name`);
      if (!ENV_RE.test(envName)) throw prepareError('config_invalid', 'auth env_name is not a valid environment variable', { field: `auth.keys[${index}].env_name` });
      return { provider, env_name: envName };
    });
    return { mode: 'api-key-env', keys } satisfies ApiKeyAuth;
  }
  if (mode === 'broker') {
    assertKnownKeys(raw, ['mode', 'broker_url', 'token_env', 'refresh_owner_verified'], 'auth');
    const endpoint = requireString(raw.broker_url, 'auth.broker_url');
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw prepareError('config_invalid', 'auth.broker_url must be a URL', { field: 'auth.broker_url' });
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:'))) throw prepareError('config_unsafe_auth_endpoint', 'external broker endpoint requires TLS and must not carry credentials/query', { field: 'auth.broker_url' });
    const tokenEnv = requireString(raw.token_env, 'auth.token_env');
    if (!ENV_RE.test(tokenEnv)) throw prepareError('config_invalid', 'auth.token_env is not a valid environment variable', { field: 'auth.token_env' });
    if (raw.refresh_owner_verified !== undefined && typeof raw.refresh_owner_verified !== 'boolean') throw prepareError('config_invalid', 'auth.refresh_owner_verified must be boolean', { field: 'auth.refresh_owner_verified' });
    return {
      mode: 'broker',
      broker_url: parsed.toString().replace(/\/$/u, ''),
      token_env: tokenEnv,
      ...(raw.refresh_owner_verified === undefined ? {} : { refresh_owner_verified: raw.refresh_owner_verified }),
    } satisfies BrokerAuth;
  }
  if (mode === 'native-host-broker') {
    assertKnownKeys(raw, ['mode', 'provider', 'start_local', 'bind'], 'auth');
    if (raw.provider !== 'openai-codex' && raw.provider !== 'xai-oauth') throw prepareError('config_invalid', 'auth.provider must be openai-codex or xai-oauth', { field: 'auth.provider' });
    if (raw.start_local !== true) throw prepareError('config_invalid', 'using current omp authorization requires explicit start_local: true', { field: 'auth.start_local' });
    const bind = requireString(raw.bind, 'auth.bind');
    const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(bind);
    const port = match === null ? 0 : Number(match[1]);
    if (port < 1 || port > 65535) throw prepareError('config_unsafe_auth_endpoint', 'native broker must bind a specific IPv4 loopback port', { field: 'auth.bind' });
    return { mode, provider: raw.provider, start_local: true, bind, profile_fingerprint: hostAuthProfileFingerprint() } satisfies NativeHostBrokerAuth;
  }
  throw prepareError('config_invalid', 'auth.mode must be none, api-key-env, broker, or native-host-broker', { field: 'auth.mode' });
}

function parseConfig(raw: unknown, configPath: string): PrepareConfig {
  const value = requireRecord(raw, 'config');
  assertKnownKeys(value, ['schema_version', 'runtime', 'artifacts', 'fixture', 'scenario', 'model', 'auth', 'timeout_ms', 'retention'], 'config');
  if (value.schema_version !== 1) throw prepareError('config_schema_unsupported', 'config schema_version must be 1', { field: 'schema_version' });
  const configDir = dirname(configPath);
  const repositoryRoot = packageRootFromConfig(configPath);
  const runtimeRaw = requireRecord(value.runtime, 'runtime');
  assertKnownKeys(runtimeRaw, ['binary'], 'runtime');
  const runtime = { ...(runtimeRaw.binary === undefined ? {} : { binary: requireString(runtimeRaw.binary, 'runtime.binary') }) };
  const artifactsRaw = requireRecord(value.artifacts, 'artifacts');
  assertKnownKeys(artifactsRaw, ['core', 'fullstack'], 'artifacts');
  const coreRaw = requireRecord(artifactsRaw.core, 'artifacts.core');
  const fullstackRaw = requireRecord(artifactsRaw.fullstack, 'artifacts.fullstack');
  assertKnownKeys(coreRaw, ['source'], 'artifacts.core');
  assertKnownKeys(fullstackRaw, ['source'], 'artifacts.fullstack');
  const artifacts = {
    core: { source: resolveDeclaredPath(coreRaw.source, 'artifacts.core.source', configDir, repositoryRoot) },
    fullstack: { source: resolveDeclaredPath(fullstackRaw.source, 'artifacts.fullstack.source', configDir, repositoryRoot) },
  };
  let fixture: { source: string } | undefined;
  if (value.fixture !== undefined) {
    const fixtureRaw = requireRecord(value.fixture, 'fixture');
    assertKnownKeys(fixtureRaw, ['source'], 'fixture');
    fixture = { source: resolveDeclaredPath(fixtureRaw.source, 'fixture.source', configDir, repositoryRoot) };
  }
  const scenarioRaw = requireRecord(value.scenario, 'scenario');
  assertKnownKeys(scenarioRaw, ['id', 'path'], 'scenario');
  const scenarioPath = resolveDeclaredPath(scenarioRaw.path, 'scenario.path', configDir, repositoryRoot);
  if (!lstatSync(scenarioPath).isFile()) throw prepareError('config_invalid', 'scenario.path must be a regular file', { field: 'scenario.path', path: scenarioPath });
  const scenario = {
    id: requireId(scenarioRaw.id, 'scenario.id'),
    path: scenarioPath,
  };
  if (typeof value.model !== 'string' && value.model !== null) throw prepareError('config_invalid', 'model must be a string or null', { field: 'model' });
  const auth = parseAuth(value.auth);
  if (auth.mode === 'native-host-broker' && (typeof value.model !== 'string' || !value.model.startsWith(`${auth.provider}/`))) {
    throw prepareError('config_invalid', 'selected model provider must match the native host broker provider', { field: 'model', provider: auth.provider });
  }
  let timeout: number | undefined;
  if (value.timeout_ms !== undefined) {
    if (typeof value.timeout_ms !== 'number' || !Number.isFinite(value.timeout_ms) || value.timeout_ms <= 0) throw prepareError('config_invalid', 'timeout_ms must be a positive number', { field: 'timeout_ms' });
    timeout = Math.floor(value.timeout_ms);
  }
  let retention: 'keep' | 'cleanup' | undefined;
  if (value.retention !== undefined) {
    if (value.retention !== 'keep' && value.retention !== 'cleanup') throw prepareError('config_invalid', 'retention must be keep or cleanup', { field: 'retention' });
    retention = value.retention;
  }
  return {
    schema_version: 1,
    runtime,
    artifacts,
    ...(fixture === undefined ? {} : { fixture }),
    scenario,
    model: value.model as string | null,
    auth,
    ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    ...(retention === undefined ? {} : { retention }),
  };
}

function stateRoot(): string {
  const explicit = process.env.OMP_E2E_ROOT;
  return resolve(explicit ?? join(tmpdir(), 'omp-workflows-e2e'));
}

interface RunPathSet {
  readonly run: string;
  readonly manifest: string;
  readonly partial: string;
  readonly lock: string;
  readonly cache: string;
  readonly roots: RunRoots;
}

function runPaths(root: string, runId: string): RunPathSet {
  const run = join(root, 'runs', runId);
  const roots = {
    run,
    home: join(run, 'home'),
    agent: join(run, 'home', '.omp', 'agent'),
    workspace: join(run, 'workspace'),
    tmp: join(run, 'tmp'),
    private: join(run, 'private'),
    sessions: join(run, 'sessions'),
    logs: join(run, 'logs'),
    evidence: join(run, 'evidence'),
  } satisfies RunRoots;
  return { run, manifest: join(run, 'manifest.json'), partial: join(run, 'prepare.partial.json'), lock: join(run, '.prepare.lock'), cache: join(root, 'cache'), roots };
}

function pidIsLive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

function readPrepareState(path: string): PrepareState | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw prepareError('partial_state_unreadable', 'partial state file could not be inspected', { path });
  }
  if (stat.isSymbolicLink()) throw prepareError('partial_state_symlink', 'partial state file is a symbolic link', { path });
  if (!stat.isFile()) throw prepareError('partial_state_invalid', 'partial state file is not a regular file', { path });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw prepareError('partial_state_invalid', 'partial state file is not valid JSON', { path });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw prepareError('partial_state_invalid', 'partial state must be an object', { path });
  }
  const value = parsed as PrepareState;
  if (
    value.schema_version !== 1
    || typeof value.run_id !== 'string'
    || (value.status !== 'preparing' && value.status !== 'failed')
    || typeof value.input_digest !== 'string'
    || typeof value.run_root !== 'string'
    || typeof value.lock_marker !== 'string'
    || !Array.isArray(value.cleanup_paths)
    || !value.cleanup_paths.every(item => typeof item === 'string')
  ) throw prepareError('partial_state_invalid', 'partial state schema is invalid', { path });
  return value;
}

function acquirePrepareLock(path: string): LockHandle {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const marker = `${process.pid}:${new Date().toISOString()}:${randomBytes(12).toString('hex')}`;
  const body = JSON.stringify({ pid: process.pid, marker, acquired_at: new Date().toISOString() }) + '\n';
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, body, { encoding: 'utf8' });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    let existing: { pid?: unknown } | null = null;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    } catch {
      // A corrupt lock is not silently stolen while another process may own it.
    }
    if (existing === null || pidIsLive(existing.pid)) throw prepareError('run_locked', 'another prepare owns this run', { path, pid: existing?.pid ?? null });
    try {
      unlinkSync(path);
    } catch {
      throw prepareError('run_locked', 'stale prepare lock could not be removed', { path });
    }
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, body, { encoding: 'utf8' });
    } finally {
      closeSync(fd);
    }
    void error;
  }
  let released = false;
  return {
    path,
    marker,
    release: () => {
      if (released) return;
      released = true;
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as { marker?: unknown };
        if (value.marker === marker) unlinkSync(path);
      } catch {
        // Another addressed cleanup may have removed the lock.
      }
    },
  };
}

function validatePartialState(state: PrepareState, paths: RunPathSet, runId: string): void {
  if (state.run_id !== runId) throw prepareError('partial_state_invalid', 'partial state belongs to a different run', { expected: runId, actual: state.run_id });
  if (state.run_root !== paths.run) throw prepareError('partial_state_invalid', 'partial state run root is not the expected run root', { expected: paths.run, actual: state.run_root });
  const expected = new Set(Object.values(paths.roots));
  const actual = new Set(state.cleanup_paths);
  if (actual.size !== expected.size || [...expected].some(path => !actual.has(path))) {
    throw prepareError('partial_state_invalid', 'partial state cleanup paths do not match the owned run roots', { expected: [...expected], actual: [...actual] });
  }
  assertNoSymlinkComponents(dirname(paths.run), paths.run, 'partial run root');
  for (const [name, path] of Object.entries(paths.roots)) {
    assertNoSymlinkComponents(paths.run, path, `partial root ${name}`);
  }
}

function removePartialState(state: PrepareState, paths: RunPathSet, runId: string): void {
  validatePartialState(state, paths, runId);
  for (const path of new Set(state.cleanup_paths)) {
    if (path === paths.run) continue;
    assertNoSymlinksInTree(path, 'partial cleanup path');
    rmSync(path, { recursive: true, force: true });
  }
  try {
    const partialStat = lstatSync(paths.partial);
    if (partialStat.isSymbolicLink() || !partialStat.isFile()) throw prepareError('partial_state_symlink', 'partial state file is not a regular file', { path: paths.partial });
    unlinkSync(paths.partial);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw prepareError('partial_state_unreadable', 'partial state file could not be removed', { path: paths.partial });
  }
}

function copyDirectory(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw prepareError('source_external_link', 'source snapshot unexpectedly contains a symlink', { source });
  if (!stat.isDirectory()) throw prepareError('source_invalid', 'workspace fixture snapshot is not a directory', { source });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source).sort()) {
    const child = join(source, entry);
    const target = join(destination, entry);
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) copyDirectory(child, target);
    else if (childStat.isFile()) {
      copyFileSync(child, target);
      try {
        chmodSync(target, childStat.mode & 0o777);
      } catch {
        // Best effort.
      }
    } else throw prepareError('source_unsupported_entry', 'workspace fixture contains an unsupported entry', { child });
  }
}

function copyFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface ScenarioTaskFile {
  readonly source: string;
  readonly relative: string;
  readonly digest: string;
}

function scenarioTaskFile(scenarioPath: string): ScenarioTaskFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(scenarioPath, 'utf8')) as unknown;
  } catch {
    throw prepareError('scenario_invalid', 'scenario is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const task = (parsed as Record<string, unknown>).task;
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return null;
  const file = (task as Record<string, unknown>).file;
  if (typeof file !== 'string') return null;
  const scenarioDirectory = dirname(scenarioPath);
  const source = resolve(scenarioDirectory, file);
  let scenarioDirectoryReal: string;
  let sourceReal: string;
  try {
    scenarioDirectoryReal = realpathSync(scenarioDirectory);
    const sourceStat = lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw prepareError('scenario_task_invalid', 'scenario task file must be a regular file inside the scenario directory');
    let current = scenarioDirectory;
    const relativeSource = relative(scenarioDirectory, source);
    const components = relativeSource === '' ? [] : relativeSource.split(sep);
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const componentStat = lstatSync(current);
      if (componentStat.isSymbolicLink() || (index < components.length - 1 && !componentStat.isDirectory())) {
        throw prepareError('scenario_task_invalid', 'scenario task file path contains a symbolic link or non-directory component');
      }
    }
    sourceReal = realpathSync(source);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw prepareError('scenario_task_invalid', 'scenario task file must be a regular file inside the scenario directory');
  }
  if (!pathContained(scenarioDirectoryReal, sourceReal)) {
    throw prepareError('scenario_task_invalid', 'scenario task file must be inside the canonical scenario directory');
  }
  return { source, relative: relative(scenarioDirectory, source), digest: fileDigest(source) };
}

interface LocalPackage {
  readonly name: string;
  readonly version: string;
  readonly root: string;
  readonly manifest: Record<string, unknown>;
}

interface DeclaredDependency {
  readonly name: string;
  readonly range: string;
  readonly optional: boolean;
}

interface PreparedPackageSource {
  readonly root: string;
  readonly cleanup: () => void;
}

function readLocalPackage(root: string): LocalPackage {
  const packageRoot = resolve(root);
  const manifestPath = join(packageRoot, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw prepareError('artifact_manifest_invalid', 'package.json could not be read', { path: manifestPath, cause: error instanceof Error ? error.message : String(error) });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw prepareError('artifact_manifest_invalid', 'package.json must be an object', { path: manifestPath });
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) throw prepareError('artifact_manifest_invalid', 'package.json name is invalid', { path: manifestPath });
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) throw prepareError('artifact_manifest_invalid', 'package.json version is invalid', { path: manifestPath });
  return { name: manifest.name, version: manifest.version, root: packageRoot, manifest };
}

function declaredDependencies(manifest: Record<string, unknown>, fields: readonly string[]): DeclaredDependency[] {
  const optionalPeers = new Set<string>();
  const peerMeta = manifest.peerDependenciesMeta;
  if (peerMeta !== undefined) {
    if (peerMeta === null || typeof peerMeta !== 'object' || Array.isArray(peerMeta)) throw prepareError('artifact_manifest_invalid', 'package.json peerDependenciesMeta must be an object');
    for (const [name, value] of Object.entries(peerMeta as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).optional === true) optionalPeers.add(name);
    }
  }
  const dependencies: DeclaredDependency[] = [];
  for (const field of fields) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw prepareError('artifact_manifest_invalid', `package.json ${field} must be an object`, { field });
    for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
      if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name) || typeof range !== 'string' || range.length === 0) throw prepareError('artifact_manifest_invalid', `package.json ${field} contains an invalid dependency`, { field, name });
      const optional = field === 'optionalDependencies' || (field === 'peerDependencies' && optionalPeers.has(name));
      dependencies.push({ name, range, optional });
    }
  }
  return dependencies;
}

function packageCandidates(fromRoot: string, name: string): string[] {
  const parts = name.split('/');
  const candidates: string[] = [];
  let cursor = resolve(fromRoot);
  for (;;) {
    candidates.push(join(cursor, 'node_modules', ...parts));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return candidates;
}

function packageAt(path: string, name: string): LocalPackage | null {
  try {
    const candidate = resolve(path);
    const packageStat = lstatSync(candidate);
    if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) return null;
    if (candidate.split(sep).includes('node_modules')) {
      let cursor = dirname(candidate);
      for (;;) {
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          if (basename(cursor) !== 'node_modules' || !lstatSync(realpathSync(cursor)).isDirectory()) return null;
          break;
        }
        if (!stat.isDirectory()) return null;
        if (basename(cursor) === 'node_modules') break;
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
    const packageValue = readLocalPackage(realpathSync(candidate));
    return packageValue.name === name ? packageValue : null;
  } catch {
    return null;
  }
}

function packageResolutionCandidates(name: string, fromRoot: string, fallbackRoots: readonly string[]): string[] {
  const candidates = [...packageCandidates(fromRoot, name), ...fallbackRoots.flatMap(root => packageCandidates(root, name)), ...fallbackRoots];
  const seen = new Set<string>();
  return candidates.map(candidate => resolve(candidate)).filter(candidate => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function resolveLocalPackage(name: string, fromRoot: string, fallbackRoots: readonly string[] = []): LocalPackage | null {
  for (const candidate of packageResolutionCandidates(name, fromRoot, fallbackRoots)) {
    const packageValue = packageAt(candidate, name);
    if (packageValue !== null) return packageValue;
  }
  return null;
}


interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function parseSemver(value: string): Semver | null {
  const match = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value.trim());
  if (match === null) return null;
  const minor = match[2] === undefined || /[xX*]/u.test(match[2]) ? 0 : Number(match[2]);
  const patch = match[3] === undefined || /[xX*]/u.test(match[3]) ? 0 : Number(match[3]);
  return {
    major: Number(match[1]),
    minor,
    patch,
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function sameSemverCore(left: Semver, right: Semver): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function rangeAlternativeAllowsPrerelease(version: Semver, range: string): boolean {
  if (version.prerelease.length === 0) return true;
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(range);
  const candidates = hyphen === null
    ? range.split(/\s+/u)
    : [hyphen[1], hyphen[2]];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const comparator = /^(<=|>=|<|>|=|\^|~)?\s*(.*)$/u.exec(candidate);
    const base = comparator === null || comparator[2] === undefined ? null : parseSemver(comparator[2]);
    if (base !== null && base.prerelease.length > 0 && sameSemverCore(version, base)) return true;
  }
  return false;
}

function rangeTokenMatches(version: Semver, token: string): boolean {
  const normalized = token.trim();
  if (normalized.length === 0 || normalized === '*' || normalized.toLowerCase() === 'latest') return true;
  const comparator = /^(<=|>=|<|>|=|\^|~)?\s*(.*)$/u.exec(normalized);
  if (comparator === null || comparator[2] === undefined) return false;
  const operator = comparator[1] ?? '';
  const rawVersion = comparator[2];
  const base = parseSemver(rawVersion);
  if (base === null) return false;
  const comparison = compareSemver(version, base);
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '^') {
    const upper: Semver = base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
    return comparison >= 0 && compareSemver(version, upper) < 0;
  }
  if (operator === '~') return comparison >= 0 && compareSemver(version, { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }) < 0;
  if (/^(?:\d+)(?:\.(?:x|X|\*))?$/u.test(rawVersion)) return version.major === base.major;
  if (/^(?:\d+\.\d+)(?:\.(?:x|X|\*))?$/u.test(rawVersion)) return version.major === base.major && version.minor === base.minor;
  return comparison === 0;
}

function versionSatisfies(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) return false;
  for (const alternative of range.split('||')) {
    const trimmed = alternative.trim();
    if (trimmed.length === 0 || !rangeAlternativeAllowsPrerelease(parsed, trimmed)) continue;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(trimmed);
    if (hyphen !== null && hyphen[1] !== undefined && hyphen[2] !== undefined) {
      const low = parseSemver(hyphen[1]);
      const high = parseSemver(hyphen[2]);
      if (low !== null && high !== null && compareSemver(parsed, low) >= 0 && compareSemver(parsed, high) <= 0) return true;
      continue;
    }
    if (trimmed.split(/\s+/u).every(token => rangeTokenMatches(parsed, token))) return true;
  }
  return range.trim() === '*' && parsed.prerelease.length === 0;
}

interface DependencyMount {
  readonly sourceRoot: string;
  readonly targetPath: string;
}

interface ClosurePackage {
  readonly package: LocalPackage;
  readonly targetPath: string;
}

function packageInstallBase(packageRoot: string, name: string): string | null {
  const absolute = isAbsolute(packageRoot);
  const normalized = packageRoot.replaceAll('\\', '/').replace(/\/+$/u, '');
  const pathParts = normalized.split('/').filter(part => part.length > 0);
  const nameParts = name.split('/');
  const nodeModulesIndex = pathParts.length - nameParts.length - 1;
  if (nodeModulesIndex < 0 || pathParts[nodeModulesIndex] !== 'node_modules') return null;
  const baseParts = pathParts.slice(0, nodeModulesIndex);
  if (baseParts.length === 0) return absolute ? sep : '';
  const base = baseParts.join(sep);
  return absolute ? `${sep}${base}` : base;
}

function addDependencyMount(mounts: DependencyMount[], sourceRoot: string, targetPath: string, name: string): void {
  const source = resolve(sourceRoot);
  const target = targetPath.replaceAll('\\', '/').replace(/^\.\//u, '');
  const packageMount = { sourceRoot: source, targetPath: target };
  if (!mounts.some(mount => mount.sourceRoot === packageMount.sourceRoot && mount.targetPath === packageMount.targetPath)) mounts.push(packageMount);
  const sourceBase = packageInstallBase(source, name);
  const targetBase = packageInstallBase(target, name);
  if (sourceBase !== null && targetBase !== null && !mounts.some(mount => mount.sourceRoot === sourceBase && mount.targetPath === targetBase)) {
    mounts.push({ sourceRoot: sourceBase, targetPath: targetBase });
  }
}

function mappedDependencyPath(sourceRoot: string, mounts: readonly DependencyMount[]): string | null {
  const source = resolve(sourceRoot);
  let selected: DependencyMount | null = null;
  for (const mount of mounts) {
    if (!pathContained(mount.sourceRoot, source)) continue;
    if (selected === null || mount.sourceRoot.length > selected.sourceRoot.length) selected = mount;
  }
  if (selected === null) return null;
  const suffix = relative(selected.sourceRoot, source);
  const mapped = join(selected.targetPath, suffix).replaceAll('\\', '/');
  return mapped === '.' ? '' : mapped;
}

function dependencyTargetPath(current: ClosurePackage, selected: LocalPackage, name: string, fallbackRoots: readonly string[], mounts: readonly DependencyMount[]): string {
  const selectedRoot = resolve(selected.root);
  const candidate = packageResolutionCandidates(name, current.package.root, fallbackRoots)
    .find(path => resolve(path) === selectedRoot);
  if (candidate !== undefined && pathContained(current.package.root, candidate)) {
    const suffix = relative(current.package.root, candidate);
    if (suffix.length > 0 && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
      return join(current.targetPath, suffix).replaceAll('\\', '/');
    }
  }
  const mapped = mappedDependencyPath(selectedRoot, mounts);
  if (mapped !== null && mapped.length > 0) return mapped;
  return join('node_modules', ...name.split('/')).replaceAll('\\', '/');
}

function dependencyClosure(
  root: LocalPackage,
  fallbackRoots: readonly string[],
  overrides: ReadonlyMap<string, LocalPackage>,
  fields: readonly string[] = ['dependencies', 'peerDependencies', 'optionalDependencies'],
  terminalNames: ReadonlySet<string> = new Set<string>(),
): PackageDependencyRoot[] {
  const mounts: DependencyMount[] = [];
  addDependencyMount(mounts, root.root, '', root.name);
  const resolvedByKey = new Map<string, ClosurePackage>();
  const resolvedByTarget = new Map<string, ClosurePackage>();
  const pending: ClosurePackage[] = [{ package: root, targetPath: '' }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const currentFields = current.package.root === root.root ? fields : ['dependencies', 'peerDependencies', 'optionalDependencies'];
    for (const declaration of declaredDependencies(current.package.manifest, currentFields)) {
      const selected = overrides.get(declaration.name) ?? resolveLocalPackage(declaration.name, current.package.root, fallbackRoots);
      if (selected === null) {
        if (declaration.optional) continue;
        throw prepareError('dependency_missing', `required dependency ${declaration.name} for ${current.package.name} is not installed locally`, { package: current.package.name, dependency: declaration.name, range: declaration.range, searched_from: current.package.root });
      }
      if (!versionSatisfies(selected.version, declaration.range)) {
        if (declaration.optional) continue;
        throw prepareError('dependency_version_mismatch', `installed dependency ${declaration.name}@${selected.version} does not satisfy ${current.package.name} requirement ${declaration.range}`, { package: current.package.name, dependency: declaration.name, required: declaration.range, installed: selected.version, root: selected.root });
      }
      const targetPath = dependencyTargetPath(current, selected, declaration.name, fallbackRoots, mounts);
      const resolved: ClosurePackage = { package: selected, targetPath };
      const previousAtTarget = resolvedByTarget.get(targetPath);
      if (previousAtTarget !== undefined && (resolve(previousAtTarget.package.root) !== resolve(selected.root) || previousAtTarget.package.version !== selected.version)) {
        throw prepareError('dependency_conflict', `dependency destination ${targetPath} resolves to multiple installed versions`, { dependency: declaration.name, first: previousAtTarget.package.root, second: selected.root });
      }
      const key = `${resolve(selected.root)}\0${targetPath}`;
      if (resolvedByKey.has(key)) continue;
      resolvedByKey.set(key, resolved);
      resolvedByTarget.set(targetPath, resolved);
      addDependencyMount(mounts, selected.root, targetPath, selected.name);
      if (!terminalNames.has(selected.name)) pending.push(resolved);
    }
  }
  return [...resolvedByKey.values()]
    .filter(item => resolve(item.package.root) !== resolve(root.root))
    .map(item => ({ name: item.package.name, root: item.package.root, relativePath: item.targetPath }));
}

function mergeDependencyRoots(...groups: readonly PackageDependencyRoot[][]): PackageDependencyRoot[] {
  const merged = new Map<string, PackageDependencyRoot>();
  for (const group of groups) {
    for (const dependency of group) {
      const relativePath = dependency.relativePath ?? join('node_modules', ...dependency.name.split('/')).replaceAll('\\', '/');
      const normalized = { ...dependency, relativePath };
      const previous = merged.get(relativePath);
      if (previous !== undefined && (resolve(previous.root) !== resolve(dependency.root) || previous.name !== dependency.name)) {
        throw prepareError('dependency_conflict', `dependency destination ${relativePath} resolves to multiple installed roots`, { first: previous.root, second: dependency.root });
      }
      merged.set(relativePath, normalized);
    }
  }
  return [...merged.values()].sort((left, right) => (left.relativePath ?? '').localeCompare(right.relativePath ?? ''));
}

/** Development tools can differ from runtime peers; they never enter the published artifact. */
function buildDependencyRoots(runtime: PackageDependencyRoot[], development: PackageDependencyRoot[]): PackageDependencyRoot[] {
  const developmentPaths = new Set(development.map(item => item.relativePath ?? join('node_modules', ...item.name.split('/')).replaceAll('\\', '/')));
  return mergeDependencyRoots(
    runtime.filter(item => !developmentPaths.has(item.relativePath ?? join('node_modules', ...item.name.split('/')).replaceAll('\\', '/'))),
    development,
  );
}

function sourceHasTypeScript(snapshot: SourceSnapshot): boolean {
  return snapshot.files.some(file => !file.startsWith('dist/') && /\.(?:cts|mts|ts|tsx)$/u.test(file));
}

function packageBuildScript(root: string): string | null {
  const manifest = readLocalPackage(root).manifest;
  const scripts = manifest.scripts;
  if (scripts === undefined) return null;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) throw prepareError('artifact_manifest_invalid', 'package.json scripts must be an object', { root });
  const build = (scripts as Record<string, unknown>).build;
  if (build === undefined) return null;
  if (typeof build !== 'string' || build.trim().length === 0) throw prepareError('build_script_invalid', 'package.json scripts.build must be a non-empty string', { root });
  return build;
}

function packageBinEntries(manifest: Record<string, unknown>): Array<[string, string]> {
  const bin = manifest.bin;
  if (typeof bin === 'string') {
    const name = typeof manifest.name === 'string' ? manifest.name.split('/').pop()! : 'package-bin';
    return [[name, bin]];
  }
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) return [];
  return Object.entries(bin as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
}

function writeBuildBinShims(stagingRoot: string, dependencies: readonly PackageDependencyRoot[]): void {
  for (const dependency of dependencies) {
    const relativePath = dependency.relativePath ?? join('node_modules', ...dependency.name.split('/')).replaceAll('\\', '/');
    const parts = relativePath.split('/');
    const packageNodeModulesIndex = parts.reduce((last, part, index) => part === 'node_modules' ? index : last, -1);
    const binRoot = packageNodeModulesIndex < 0
      ? join(stagingRoot, 'node_modules', '.bin')
      : join(stagingRoot, ...parts.slice(0, packageNodeModulesIndex + 1), '.bin');
    mkdirSync(binRoot, { recursive: true, mode: 0o700 });
    const manifest = readLocalPackage(dependency.root).manifest;
    for (const [name, target] of packageBinEntries(manifest)) {
      const targetPath = join(stagingRoot, relativePath, target.replace(/^\.\//u, ''));
      if (!pathContained(stagingRoot, targetPath) || !existsSync(targetPath) || !lstatSync(targetPath).isFile()) throw prepareError('dependency_invalid', `dependency binary ${name} is missing`, { dependency: dependency.name, target });
      const shim = join(binRoot, name);
      if (!pathContained(binRoot, shim)) throw prepareError('dependency_invalid', `dependency binary ${name} escaped staging`, { dependency: dependency.name });
      writeFileSync(shim, `#!${process.execPath}\nrequire(${JSON.stringify(targetPath)});\n`, { mode: 0o700 });
    }
  }
}

/** Ignore npm's checkout-local shims when selecting the installed host omp. */
function hostRuntimePath(binary: string | undefined): string | undefined {
  if (binary !== undefined && binary !== 'omp') return undefined;
  const prefix = process.env.npm_config_local_prefix;
  if (prefix === undefined || !isAbsolute(prefix)) return undefined;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH ?? '').split(delimiter).filter(directory =>
    directory.length === 0
    || !pathContained(prefix, directory)
    || basename(directory) !== '.bin'
    || basename(dirname(directory)) !== 'node_modules',
  ).join(delimiter);
}

function npmInvocation(): { readonly command: string; readonly prefix: readonly string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && isAbsolute(npmExecPath) && existsSync(npmExecPath)) return { command: process.execPath, prefix: [npmExecPath] };
  const delimiter = process.platform === 'win32' ? ';' : ':';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    try {
      if (lstatSync(candidate).isFile()) return { command: candidate, prefix: [] };
    } catch {
      // Continue searching the inherited PATH only for the package manager used
      // during preparation; runtime launch never uses this fallback.
    }
  }
  throw prepareError('build_prerequisite_missing', 'npm is required to run the package build script but is not installed locally');
}

function runPackageBuild(stagingRoot: string, buildScript: string, supportRoot: string): void {
  const npm = npmInvocation();
  const home = join(supportRoot, 'home');
  const tmp = join(supportRoot, 'tmp');
  const npmCache = join(supportRoot, 'npm-cache');
  const npmPrefix = join(supportRoot, 'npm-prefix');
  const npmUserConfig = join(supportRoot, 'npmrc');
  const npmGlobalConfig = join(supportRoot, 'global-npmrc');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  mkdirSync(npmCache, { recursive: true, mode: 0o700 });
  mkdirSync(npmPrefix, { recursive: true, mode: 0o700 });
  writeFileSync(npmUserConfig, '', { flag: 'a', mode: 0o600 });
  writeFileSync(npmGlobalConfig, '', { flag: 'a', mode: 0o600 });
  const npmExecutable = npm.prefix[0] ?? npm.command;
  const env: Record<string, string> = {
    ...inheritedPrepareEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PWD: stagingRoot,
    PATH: executablePath([join(stagingRoot, 'node_modules', '.bin'), dirname(npm.command), dirname(npmExecutable)]),
    NODE: process.execPath,
    npm_execpath: npmExecutable,
    npm_node_execpath: process.execPath,
    npm_config_cache: npmCache,
    npm_config_prefix: npmPrefix,
    npm_config_userconfig: npmUserConfig,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true',
  };
  const result = spawnSync(npm.command, [...npm.prefix, 'run', 'build'], {
    cwd: stagingRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const cause = result.error === undefined ? '' : `: ${redactSubprocessOutput(result.error.message, 2_000)}`;
    throw prepareError('build_failed', `package build script failed${cause}`, {
      root: stagingRoot,
      script: redactSubprocessOutput(buildScript, 4_000),
      status: result.status,
      stdout: redactSubprocessOutput(result.stdout),
      stderr: redactSubprocessOutput(result.stderr),
    });
  }
}

function preparePackageSource(snapshot: SourceSnapshot, cacheRoot: string, dependencies: readonly PackageDependencyRoot[], buildScript: string | null, dependencyArtifacts: readonly PackageArtifact[] = []): PreparedPackageSource {
  const stagedBuildScript = packageBuildScript(snapshot.root);
  if (stagedBuildScript !== buildScript) throw prepareError('snapshot_conflict', 'package build script changed while creating source snapshot', { source: snapshot.source });
  if (buildScript === null) {
    if (sourceHasTypeScript(snapshot)) throw prepareError('build_script_missing', `package ${snapshot.source} contains TypeScript sources but has no build script`, { source: snapshot.source });
    return { root: snapshot.root, cleanup: () => undefined };
  }
  const stagingRoot = join(cacheRoot, `.build-${process.pid}-${randomBytes(8).toString('hex')}`);
  const supportRoot = join(cacheRoot, `.build-support-${process.pid}-${randomBytes(8).toString('hex')}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  rmSync(supportRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    copyDirectory(snapshot.root, stagingRoot);
    rmSync(join(stagingRoot, 'dist'), { recursive: true, force: true });
    materializeDependencyClosure(stagingRoot, dependencyArtifacts.map(artifact => ({ name: artifact.name, artifact })));
    materializeDependencyRoots(stagingRoot, dependencies);
    writeBuildBinShims(stagingRoot, dependencies);
    runPackageBuild(stagingRoot, buildScript, supportRoot);
    if (!existsSync(join(stagingRoot, 'dist')) || !lstatSync(join(stagingRoot, 'dist')).isDirectory()) throw prepareError('build_output_missing', `package build did not produce dist`, { source: snapshot.source, root: stagingRoot });
    return {
      root: stagingRoot,
      cleanup: () => {
        rmSync(stagingRoot, { recursive: true, force: true });
        rmSync(supportRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(supportRoot, { recursive: true, force: true });
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writePinnedRuntimeLauncher(runRoot: string, binary: string): string {
  const launcher = join(runRoot, 'bin', 'omp');
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(binary)} "$@"\n`, { mode: 0o700 });
  chmodSync(launcher, 0o700);
  return launcher;
}

function copyOptionalDirectory(source: string, destination: string): boolean {
  if (!existsSync(source)) return false;
  if (!lstatSync(source).isDirectory()) throw prepareError('artifact_resource_invalid', 'packaged resource is not a directory', { source });
  copyDirectory(source, destination);
  return true;
}

function runIsolatedCommandCopy(fullstack: PackageArtifact, workspace: string): void {
  const script = join(fullstack.root, 'scripts', 'copy-commands.mjs');
  const commands = join(fullstack.root, 'commands');
  if (!existsSync(script)) {
    if (existsSync(commands)) copyDirectory(commands, join(workspace, '.omp', 'commands'));
    return;
  }
  if (!lstatSync(script).isFile()) throw prepareError('artifact_resource_invalid', 'packaged command copy script is not a regular file', { script });
  const runRoot = dirname(workspace);
  const home = join(runRoot, 'home');
  const tmp = join(runRoot, 'tmp');
  const env: Record<string, string> = {
    ...inheritedPrepareEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PWD: workspace,
    PATH: executablePath(),
    NODE: process.execPath,
    npm_node_execpath: process.execPath,
    OMP_PROJECT_DIR: workspace,
  };
  const result = spawnSync(process.execPath, [script], { cwd: workspace, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    const cause = result.error === undefined ? '' : `: ${redactSubprocessOutput(result.error.message, 2_000)}`;
    throw prepareError('artifact_resource_failed', `fullstack command materialization failed${cause}`, {
      script,
      status: result.status,
      stdout: redactSubprocessOutput(result.stdout, 4_000),
      stderr: redactSubprocessOutput(result.stderr, 4_000),
    });
  }
  const target = join(workspace, '.omp', 'commands');
  if (!existsSync(target) || !lstatSync(target).isDirectory()) throw prepareError('artifact_resource_missing', 'fullstack command materialization did not create workspace commands', { target });
}

function provisionPluginResources(core: PackageArtifact, fullstack: PackageArtifact, roots: RunRoots): void {
  const coreSkills = join(core.root, 'skills');
  const fullstackAgents = join(fullstack.root, 'agents');
  const fullstackSkills = join(fullstack.root, 'skills');
  copyOptionalDirectory(coreSkills, join(roots.agent, 'skills'));
  copyOptionalDirectory(fullstackAgents, join(roots.agent, 'agents'));
  copyOptionalDirectory(fullstackSkills, join(roots.agent, 'skills'));
  runIsolatedCommandCopy(fullstack, roots.workspace);
}


function findRuntimeRoot(binary: string): string {
  let cursor = dirname(binary);
  for (;;) {
    if (existsSync(join(cursor, 'runtime.json'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw prepareError('cache_integrity_failure', 'runtime cache metadata could not be located', { binary });
}
function findRuntimePackageRoot(binary: string): string {
  let cursor = dirname(binary);
  for (;;) {
    if (existsSync(join(cursor, 'package.json'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw prepareError('cache_integrity_failure', 'runtime package root could not be located in snapshot', { binary });
}

function materializeRoots(roots: RunRoots): void {
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

function initializeWorkspaceGit(roots: RunRoots, runId: string): void {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: roots.home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const execute = (args: string[]): void => {
    const result = spawnSync('git', args, {
      cwd: roots.workspace,
      env,
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (result.status !== 0 || result.error !== undefined) {
      throw prepareError('git_prerequisite_missing', 'isolated workspace could not establish its own git branch', { operation: args[0] ?? 'git' });
    }
  };
  execute(['init', '-q', `--initial-branch=e2e/${runId}`]);
  execute(['config', '--local', 'user.name', 'OMP E2E Fixture']);
  execute(['config', '--local', 'user.email', 'e2e@example.invalid']);
  writeFileSync(join(roots.workspace, '.e2e-root'), `${runId}\n`, { flag: 'wx', mode: 0o600 });
  execute(['add', '--', '.e2e-root']);
  execute(['commit', '-q', '-m', 'Initialize isolated E2E workspace']);
}

function normalizeCapabilities(value: RuntimeCapabilities): RuntimeCapabilities {
  return { ...value, supported: value.supported, native_inventory: value.native_inventory ?? 'observed-only' };
}


function authConfigDigest(auth: ManifestAuth): Readonly<Record<string, unknown>> {
  if (auth.mode === 'none') return { mode: auth.mode };
  if (auth.mode === 'api-key-env') return { mode: auth.mode, keys: auth.keys.map(key => ({ provider: key.provider, env_name: key.env_name })) };
  if (auth.mode === 'native-host-broker') return { mode: auth.mode, provider: auth.provider, start_local: auth.start_local, bind: auth.bind, profile_fingerprint: auth.profile_fingerprint };
  return { mode: auth.mode, broker_url: auth.broker_url, token_env: auth.token_env, refresh_owner_verified: auth.refresh_owner_verified ?? false };
}

function makeManifest(
  runId: string,
  inputDigest: string,
  runtime: RuntimeSnapshot,
  core: PackageArtifact,
  fullstack: PackageArtifact,
  roots: RunRoots,
  auth: ManifestAuth,
  model: string | null,
  scenario: { id: string; path: string; digest: string },
  configPath: string,
): RunManifest {
  const now = new Date().toISOString();
  const runtimeCaps = normalizeCapabilities(runtime.capabilities);
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    input_digest: inputDigest,
    status: 'ready',
    runtime: {
      binary: runtime.binary,
      version: runtime.version,
      digest: runtime.digest,
      platform: runtime.platform,
      capabilities: runtimeCaps,
    },
    artifacts: {
      core: { root: core.root, digest: core.digest, version: core.version, files: core.files },
      fullstack: { root: fullstack.root, digest: fullstack.digest, version: fullstack.version, files: fullstack.files },
    },
    roots,
    auth,
    model,
    scenario,
    sessions: [],
    created_at: now,
    updated_at: now,
    config_path: configPath,
    receipts: [],
  };
}

function manifestInputDigest(config: PrepareConfig, runtime: RuntimeProbe, core: SourceSnapshot, fullstack: SourceSnapshot, fixture: SourceSnapshot | null, scenarioDigest: string): string {
  return digestValue({
    config: {
      ...config,
      auth: authConfigDigest(config.auth),
    },
    runtime: { version: runtime.version, digest: runtime.digest, platform: runtime.platform, closure_digest: runtime.closure_digest },
    sources: { core: core.digest, fullstack: fullstack.digest, fixture: fixture?.digest ?? null, scenario: scenarioDigest },
  });
}


export async function prepareRun(configPath: string, runId: string): Promise<PrepareResult> {
  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = realpathSync(resolve(configPath));
  } catch (error) {
    return errorResult(prepareError('config_missing', 'prepare config could not be read', { path: resolve(configPath), cause: String(error) }));
  }
  if (!ID_RE.test(runId)) return errorResult(prepareError('run_id_invalid', 'run id contains unsupported characters', { runId }));
  const root = stateRoot();
  const paths = runPaths(root, runId);
  const manifestPath = paths.manifest;
  let lock: LockHandle | undefined;
  try {
    assertNoSymlinkComponents(root, join(root, 'runs'), 'prepare runs root');
    lock = acquirePrepareLock(paths.lock);
    const previousManifest = existsSync(manifestPath) ? readManifest(manifestPath) : null;
    if (previousManifest !== null) {
      // Candidate identity is computed below; do not mutate a ready run while
      // finding out whether new inputs conflict.
    }
    const partial = readPrepareState(paths.partial);
    if (partial !== null && previousManifest === null) removePartialState(partial, paths, runId);
    const rawConfig = JSON.parse(readFileSync(resolvedConfigPath, 'utf8')) as unknown;
    const config = parseConfig(rawConfig, resolvedConfigPath);
    const runtimeProbe = inspectInstalledRuntime({
      binary: config.runtime.binary,
      pathEnv: hostRuntimePath(config.runtime.binary),
      homeRoot: paths.roots.home,
      probeTimeoutMs: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });
    if (!runtimeProbe.capabilities.supported) throw prepareError('unsupported_runtime', 'installed omp did not pass version/help compatibility probes', { version: runtimeProbe.version, capabilities: runtimeProbe.capabilities });
    const coreBuildScript = packageBuildScript(config.artifacts.core.source);
    const fullstackBuildScript = packageBuildScript(config.artifacts.fullstack.source);
    const coreSource = snapshotSource(config.artifacts.core.source, paths.cache, coreBuildScript === null ? {} : { exclude: ['.git', 'node_modules', 'dist'] });
    const fullstackSource = snapshotSource(config.artifacts.fullstack.source, paths.cache, fullstackBuildScript === null ? {} : { exclude: ['.git', 'node_modules', 'dist'] });
    const fixtureSource = config.fixture === undefined ? null : snapshotSource(config.fixture.source, paths.cache);
    const scenarioFileDigest = fileDigest(config.scenario.path);
    const scenarioTask = scenarioTaskFile(config.scenario.path);
    const scenarioDigest = digestValue({ scenario: scenarioFileDigest, task: scenarioTask?.digest ?? null });
    const inputDigest = manifestInputDigest(config, runtimeProbe, coreSource, fullstackSource, fixtureSource, scenarioDigest);
    if (previousManifest !== null) {
      if (previousManifest.input_digest !== inputDigest) throw prepareError('run_conflict', 'run already exists with different runtime, source, or config inputs', { runId, existing_input_digest: previousManifest.input_digest, requested_input_digest: inputDigest, next_command: `prepare --run ${runId}-new` });
      const runtimeRoot = findRuntimeRoot(previousManifest.runtime.binary);
      verifyRuntimeSnapshot(runtimeRoot);
      const existingCore = verifyPackageArtifact(previousManifest.artifacts.core.root);
      const existingFullstack = verifyPackageArtifact(previousManifest.artifacts.fullstack.root);
      if (existingCore.digest !== previousManifest.artifacts.core.digest || existingFullstack.digest !== previousManifest.artifacts.fullstack.digest) {
        throw prepareError('cache_integrity_failure', 'package artifact digest does not match the existing run manifest');
      }
      return { ok: true, status: previousManifest.status, manifest: previousManifest, manifestPath, nextCommand: `doctor --manifest ${manifestPath}` };
    }
    const state: PrepareState = {
      schema_version: 1,
      run_id: runId,
      status: 'preparing',
      input_digest: inputDigest,
      run_root: paths.run,
      cleanup_paths: [paths.run, ...Object.values(paths.roots)],
      lock_marker: lock.marker,
    };
    writeJsonAtomic(paths.partial, state);
    materializeRoots(paths.roots);
    let runtimeForSnapshot = runtimeProbe;
    if (config.auth.mode === 'none' && config.model === null) {
      writeProviderFreeCatalog(paths.roots.agent);
      try {
        const freeProbe = probeProviderFreeRuntime(runtimeProbe.source_binary, {
          homeRoot: paths.roots.home,
          agentRoot: paths.roots.agent,
          projectRoot: paths.roots.workspace,
          tmpRoot: paths.roots.tmp,
          timeoutMs: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        });
        if (!freeProbe.capabilities.provider_free_probe) {
          throw prepareError('prerequisite_missing', 'runtime did not pass the provider-free isolated RPC probe', { runtime: runtimeProbe.version });
        }
        runtimeForSnapshot = { ...runtimeProbe, capabilities: freeProbe.capabilities };
      } catch (error) {
        if (error instanceof ManifestError && error.code === 'prerequisite_missing') throw error;
        throw prepareError('prerequisite_missing', 'provider-free runtime probe could not be established without credentials', { runtime: runtimeProbe.version });
      }
    }
    if (fixtureSource !== null) copyDirectory(fixtureSource.root, paths.roots.workspace);
    initializeWorkspaceGit(paths.roots, runId);
    const scenarioTarget = join(paths.roots.workspace, '.e2e', 'scenario', `${config.scenario.id}.json`);
    copyFile(config.scenario.path, scenarioTarget);
    if (fileDigest(scenarioTarget) !== scenarioFileDigest) throw prepareError('source_changed', 'scenario changed during prepare');
    if (scenarioTask !== null) {
      const taskTarget = resolve(dirname(scenarioTarget), scenarioTask.relative);
      if (!pathContained(dirname(scenarioTarget), taskTarget)) throw prepareError('scenario_task_invalid', 'scenario task escaped prepared workspace');
      copyFile(scenarioTask.source, taskTarget);
      if (fileDigest(taskTarget) !== scenarioTask.digest) throw prepareError('source_changed', 'scenario task changed during prepare');
    }
    const runtimeSnapshotBase = snapshotRuntime(runtimeForSnapshot, paths.cache);
    const runtimeSnapshot: RuntimeSnapshot = {
      ...runtimeSnapshotBase,
      capabilities: runtimeForSnapshot.capabilities,
    };
    const runtimePackageRoot = findRuntimePackageRoot(runtimeSnapshot.binary);
    const runtimePackage = readLocalPackage(runtimePackageRoot);
    const runtimeOverrides = new Map<string, LocalPackage>([[runtimePackage.name, runtimePackage]]);
    const corePackage = readLocalPackage(coreSource.root);
    const coreRuntimeRoots = dependencyClosure(corePackage, [runtimeProbe.source_root, runtimePackageRoot], runtimeOverrides);
    const coreDevRoots = dependencyClosure(corePackage, [config.artifacts.core.source, runtimeProbe.source_root], new Map<string, LocalPackage>(), ['devDependencies']);
    const coreBuildDependencies = buildDependencyRoots(coreRuntimeRoots, coreDevRoots);
    const corePrepared = preparePackageSource(coreSource, paths.cache, coreBuildDependencies, coreBuildScript);
    let coreArtifact: PackageArtifact;
    try {
      coreArtifact = buildPackageArtifact(corePrepared.root, paths.cache, { dependencyRoots: coreRuntimeRoots });
    } finally {
      corePrepared.cleanup();
    }
    const fullstackPackage = readLocalPackage(fullstackSource.root);
    const fullstackOverrides = new Map<string, LocalPackage>([
      [runtimePackage.name, runtimePackage],
      [coreArtifact.name, readLocalPackage(coreArtifact.root)],
    ]);
    const fullstackClosure = dependencyClosure(fullstackPackage, [runtimeProbe.source_root, runtimePackageRoot], fullstackOverrides, ['dependencies', 'peerDependencies', 'optionalDependencies'], new Set([coreArtifact.name]));
    const fullstackRuntimeRoots = mergeDependencyRoots(coreRuntimeRoots, fullstackClosure.filter(dependency => dependency.name !== coreArtifact.name));
    const fullstackDevRoots = dependencyClosure(fullstackPackage, [config.artifacts.fullstack.source, runtimeProbe.source_root], new Map<string, LocalPackage>(), ['devDependencies']);
    const fullstackBuildDependencies = buildDependencyRoots(fullstackRuntimeRoots, fullstackDevRoots);
    const fullstackPrepared = preparePackageSource(fullstackSource, paths.cache, fullstackBuildDependencies, fullstackBuildScript, [coreArtifact]);
    let fullstackArtifact: PackageArtifact;
    try {
      fullstackArtifact = buildPackageArtifact(fullstackPrepared.root, paths.cache, {
        dependencyArtifacts: [{ name: coreArtifact.name, artifact: coreArtifact }],
        dependencyRoots: fullstackRuntimeRoots,
      });
    } finally {
      fullstackPrepared.cleanup();
    }
    // Workspace command files are imported from the run-owned project tree;
    // materialize their package closure from the immutable artifact, never the
    // checkout or the installed package manager tree.
    materializeDependencyClosure(paths.roots.workspace, [{ name: coreArtifact.name, artifact: coreArtifact }]);
    const cachedRuntimeRoots = fullstackRuntimeRoots.map(dependency => {
      const relativePath = dependency.relativePath ?? join('node_modules', ...dependency.name.split('/')).replaceAll('\\', '/');
      return {
        name: dependency.name,
        root: join(fullstackArtifact.root, relativePath),
        relativePath,
      };
    });
    materializeDependencyRoots(paths.roots.workspace, cachedRuntimeRoots);
    provisionPluginResources(coreArtifact, fullstackArtifact, paths.roots);
    writePinnedRuntimeLauncher(paths.run, runtimeSnapshot.binary);
    const manifest = makeManifest(runId, inputDigest, runtimeSnapshot, coreArtifact, fullstackArtifact, paths.roots, config.auth, config.model, { id: config.scenario.id, path: scenarioTarget, digest: scenarioDigest }, resolvedConfigPath);
    writeManifest(manifestPath, manifest);
    try {
      unlinkSync(paths.partial);
    } catch {
      // The final manifest is authoritative; partial cleanup is idempotent.
    }
    return { ok: true, status: manifest.status, manifest, manifestPath, nextCommand: `doctor --manifest ${manifestPath}` };
  } catch (error) {
    let state: PrepareState | null = null;
    try {
      state = readPrepareState(paths.partial);
    } catch {
      // Preserve the original preparation error and never follow a forged partial path.
    }
    if (state !== null) {
      const failure: PrepareState = {
        ...state,
        status: 'failed',
        error: error instanceof ManifestError ? { code: error.code, message: error.message, details: error.details } : { code: 'prepare_failed', message: error instanceof Error ? error.message : String(error) },
      };
      try {
        writeJsonAtomic(paths.partial, failure);
      } catch {
        // Preserve the original preparation error.
      }
    }
    return errorResult(error, manifestPath);
  } finally {
    lock?.release();
  }
}

export function cleanupPartialRun(runId: string, root = stateRoot()): boolean {
  if (!ID_RE.test(runId)) throw prepareError('run_id_invalid', 'run id contains unsupported characters', { runId });
  const paths = runPaths(resolve(root), runId);
  assertNoSymlinkComponents(resolve(root), join(resolve(root), 'runs'), 'cleanup runs root');
  const lock = acquirePrepareLock(paths.lock);
  try {
    const state = readPrepareState(paths.partial);
    if (state === null) return false;
    removePartialState(state, paths, runId);
    return true;
  } finally {
    lock.release();
  }
}


function assertDoctorRunLaunchable(manifest: RunManifest): void {
  if (manifest.status === 'cleaned' || manifest.status === 'failed') {
    throw prepareError('run_not_launchable', `run status ${manifest.status} cannot be launched`, { status: manifest.status });
  }
  assertNoSymlinkComponents(dirname(manifest.roots.run), manifest.roots.run, 'doctor run root');
  for (const [name, root] of Object.entries(manifest.roots)) {
    assertNoSymlinkComponents(manifest.roots.run, root, `doctor root ${name}`);
    try {
      const stat = lstatSync(root);
      if (stat.isSymbolicLink()) throw prepareError('run_root_symlink', 'doctor run root contains a symbolic link', { name, path: root });
      if (!stat.isDirectory()) throw prepareError('run_root_invalid', 'doctor run root is not a directory', { name, path: root });
    } catch (error) {
      if (error instanceof ManifestError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw prepareError('run_root_missing', 'doctor run root is missing', { name, path: root });
      throw prepareError('run_root_unreadable', 'doctor run root could not be inspected', { name, path: root });
    }
  }
}

export async function doctorRun(manifestPath: string): Promise<DoctorResult> {
  const absoluteManifestPath = resolve(manifestPath);
  let manifest: RunManifest;
  try {
    manifest = readManifest(absoluteManifestPath);
  } catch (error) {
    return doctorError(error, absoluteManifestPath);
  }
  try {
    assertDoctorRunLaunchable(manifest);
    const runtimeRoot = findRuntimeRoot(manifest.runtime.binary);
    const runtime = verifyRuntimeSnapshot(runtimeRoot);
    if (runtime.digest !== manifest.runtime.digest) throw prepareError('cache_integrity_failure', 'runtime binary digest does not match manifest', { expected: manifest.runtime.digest, actual: runtime.digest });
    const core = verifyPackageArtifact(manifest.artifacts.core.root);
    const fullstack = verifyPackageArtifact(manifest.artifacts.fullstack.root);
    if (core.digest !== manifest.artifacts.core.digest || fullstack.digest !== manifest.artifacts.fullstack.digest) throw prepareError('cache_integrity_failure', 'package artifact digest does not match manifest');
    for (const root of Object.values(manifest.roots)) {
      if (!pathContained(manifest.roots.run, root)) throw prepareError('manifest_path_outside_run', 'manifest root escaped run root');
    }
    const scenarioTask = scenarioTaskFile(manifest.scenario.path);
    if (digestValue({ scenario: fileDigest(manifest.scenario.path), task: scenarioTask?.digest ?? null }) !== manifest.scenario.digest) {
      throw prepareError('scenario_integrity_failure', 'prepared scenario or task changed after snapshot');
    }
    const authReadiness = await checkBrokerConnection(manifest, { providerRequired: manifest.model !== null, requireRefreshOwnership: true });
    if (!authReadiness.ok) {
      return { ok: false, status: 'blocked', manifest, manifestPath: absoluteManifestPath, error: { code: authReadiness.code, message: authReadiness.message }, checks: { runtime: true, artifacts: true, auth: false } };
    }
    // A none/provider-free run is intentionally not declared process-ready by
    // this structural doctor: omp versions that need a model cannot be probed
    // honestly without injecting a fake credential.  Lifecycle verify may add
    // a controlled fixture/provider prerequisite and retry the observation.
    if (manifest.auth.mode === 'none' && manifest.model === null && manifest.runtime.capabilities?.provider_free_probe !== true) {
      return { ok: false, status: 'blocked', manifest, manifestPath: absoluteManifestPath, error: { code: 'prerequisite_missing', message: 'runtime capability probe did not establish a provider-free process seam' }, checks: { runtime: false, artifacts: true, auth: true } };
    }
    return { ok: true, status: manifest.status, manifest, manifestPath: absoluteManifestPath, nextCommand: `start --manifest ${absoluteManifestPath}`, checks: { runtime: true, artifacts: true, auth: true } };
  } catch (error) {
    return doctorError(error, absoluteManifestPath, manifest);
  }
}

export function validatePrepareConfig(raw: unknown, configPath: string): PrepareConfig {
  return parseConfig(raw, resolve(configPath));
}

export function getRunRoot(runId: string, root = stateRoot()): string {
  if (!ID_RE.test(runId)) throw prepareError('run_id_invalid', 'run id contains unsupported characters', { runId });
  return runPaths(resolve(root), runId).run;
}
