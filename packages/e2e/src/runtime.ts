/** Runtime discovery, capability probing, and immutable content-addressed snapshots. */
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
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ManifestError, type RuntimeCapabilities } from './manifest.js';

const VERSION_RE = /^\s*(?:[A-Za-z0-9@._~/-]+\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/imu;
const VERSION_FALLBACK_RE = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/iu;

export interface RuntimeProbeOptions {
  readonly binary?: string;
  readonly pathEnv?: string;
  readonly probeTimeoutMs?: number;
  readonly fixtureRoot?: string;
  /** Optional isolated home used for --version/--help probes. */
  readonly homeRoot?: string;
}

export interface RuntimeProbe {
  readonly source_binary: string;
  readonly source_root: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly version: string;
  readonly digest: string;
  readonly platform: string;
  readonly capabilities: RuntimeCapabilities;
  readonly closure_digest: string;
}

export interface RuntimeSnapshot {
  readonly root: string;
  readonly binary: string;
  readonly digest: string;
  readonly closure_digest: string;
  readonly version: string;
  readonly platform: string;
  readonly files: readonly string[];
  readonly capabilities: RuntimeCapabilities;
}

interface TreeEntry {
  readonly relative_path: string;
  readonly source_path: string;
  readonly kind: 'file' | 'directory';
}

interface SnapshotMetadata {
  readonly schema_version: 1;
  readonly package_name: string;
  readonly package_version: string;
  readonly version: string;
  readonly binary_relative: string;
  readonly binary_digest: string;
  readonly closure_digest: string;
  readonly platform: string;
  readonly files: readonly string[];
  readonly capabilities: RuntimeCapabilities;
}

function runtimeError(code: string, message: string, details: Record<string, unknown> = {}): ManifestError {
  return new ManifestError(code, message, details);
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pathContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findOnPath(command: string, pathEnv: string): string {
  if (command.includes(sep) || isAbsolute(command)) return resolve(command);
  for (const directory of pathEnv.split(':')) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return resolve(candidate);
    } catch {
      // Continue searching each PATH component.
    }
  }
  throw runtimeError('runtime_missing', `installed runtime ${command} was not found on PATH`, { command });
}

function readPackageRoot(binary: string): { root: string; name: string; version: string } {
  let cursor = dirname(binary);
  for (;;) {
    const packagePath = join(cursor, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : 'omp-runtime';
        const version = typeof value.version === 'string' && value.version.length > 0 ? value.version : 'unknown';
        return { root: cursor, name, version };
      }
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw runtimeError('runtime_package_missing', 'installed omp runtime package.json could not be located', { binary });
}

interface RuntimeCommandOptions {
  readonly fixtureRoot?: string;
  readonly homeRoot?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

function runRuntimeCommand(binary: string, args: readonly string[], timeoutMs: number, options: RuntimeCommandOptions = {}): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    ...options.env,
  };
  if (options.homeRoot !== undefined) {
    const home = resolve(options.homeRoot);
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = join(home, '.config');
    env.XDG_DATA_HOME = join(home, '.local', 'share');
    env.XDG_STATE_HOME = join(home, '.local', 'state');
    env.XDG_CACHE_HOME = join(home, '.cache');
  }
  if (options.fixtureRoot !== undefined) {
    env.OMP_PROJECT_DIR = options.fixtureRoot;
    env.OMP_HOME = options.fixtureRoot;
    env.PI_CODING_AGENT_DIR = join(options.fixtureRoot, '.omp', 'agent');
  }
  const spawnOptions = {
    env,
    encoding: 'utf8' as const,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  };
  let result = spawnSync(binary, args, spawnOptions);
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'EACCES' && extname(binary) === '.js') {
    result = spawnSync(process.execPath, [binary, ...args], spawnOptions);
  }
  if (result.error !== undefined) {
    throw runtimeError('runtime_probe_failed', `runtime probe failed: ${result.error.message}`, { binary, args });
  }
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function parseRuntimeVersion(output: string, packageVersion: string): string {
  const match = VERSION_RE.exec(output) ?? VERSION_FALLBACK_RE.exec(output);
  if (match?.[1] !== undefined) return match[1];
  if (packageVersion !== 'unknown') return packageVersion;
  const firstLine = output.trim().split(/\r?\n/u)[0];
  return firstLine === undefined || firstLine.length === 0 ? 'unknown' : firstLine.slice(0, 128);
}

function treeEntries(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visited = new Set<string>();
  const visit = (source: string, relativePath: string): void => {
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      throw runtimeError('runtime_source_changed', `runtime source could not be read: ${String(error)}`, { source });
    }
    if (stat.isSymbolicLink()) {
      throw runtimeError('runtime_external_link', 'runtime closure contains a symlink; immutable snapshot requires real files', { source });
    }
    if (stat.isDirectory()) {
      const real = resolve(source);
      if (visited.has(real)) throw runtimeError('runtime_source_cycle', 'runtime source contains a directory cycle', { source });
      visited.add(real);
      entries.push({ relative_path: relativePath, source_path: source, kind: 'directory' });
      for (const child of readdirSync(source).sort()) {
        const childRelative = relativePath.length === 0 ? child : join(relativePath, child);
        visit(join(source, child), childRelative);
      }
      return;
    }
    if (!stat.isFile()) throw runtimeError('runtime_unsupported_entry', 'runtime closure contains a non-file entry', { source });
    entries.push({ relative_path: relativePath, source_path: source, kind: 'file' });
  };
  visit(root, '');
  return entries;
}

function treeDigest(root: string, entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    if (entry.relative_path.length === 0) continue;
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.relative_path.replaceAll('\\', '/'));
    hash.update('\0');
    if (entry.kind === 'file') hash.update(sha256File(entry.source_path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function copyTree(root: string, target: string, entries: readonly TreeEntry[]): void {
  mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    if (entry.relative_path.length === 0) continue;
    const destination = join(target, entry.relative_path);
    if (!pathContained(target, destination)) throw runtimeError('runtime_path_escape', 'runtime snapshot path escaped its target', { destination });
    if (entry.kind === 'directory') {
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(entry.source_path, destination);
    try {
      chmodSync(destination, statSync(entry.source_path).mode & 0o777);
    } catch {
      // Preserve content even on filesystems without POSIX mode bits.
    }
  }
  void root;
}

function snapshotEntries(root: string): TreeEntry[] {
  return treeEntries(root);
}

function metadataPath(root: string): string {
  return join(root, 'runtime.json');
}

function readMetadata(root: string): SnapshotMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath(root), 'utf8')) as SnapshotMetadata;
    if (parsed.schema_version !== 1 || typeof parsed.binary_relative !== 'string' || typeof parsed.closure_digest !== 'string') throw new Error('invalid runtime metadata');
    return parsed;
  } catch (error) {
    throw runtimeError('cache_integrity_failure', 'runtime cache metadata is missing or invalid', { root, cause: error instanceof Error ? error.message : String(error) });
  }
}

export function inspectInstalledRuntime(options: RuntimeProbeOptions = {}): RuntimeProbe {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const selected = options.binary ?? 'omp';
  const candidate = findOnPath(selected, pathEnv);
  let sourceBinary: string;
  try {
    sourceBinary = realpathSync(candidate);
    const stat = lstatSync(sourceBinary);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch (error) {
    throw runtimeError('runtime_missing', `installed runtime ${selected} is not a readable file`, { binary: candidate, cause: String(error) });
  }
  const packageInfo = readPackageRoot(sourceBinary);
  const timeout = options.probeTimeoutMs ?? 5_000;
  const versionRun = runRuntimeCommand(sourceBinary, ['--version'], timeout, { fixtureRoot: options.fixtureRoot, homeRoot: options.homeRoot });
  const helpRun = runRuntimeCommand(sourceBinary, ['--help'], timeout, { fixtureRoot: options.fixtureRoot, homeRoot: options.homeRoot });
  const combined = `${versionRun.stdout}\n${versionRun.stderr}\n${helpRun.stdout}\n${helpRun.stderr}`;
  const version = parseRuntimeVersion(combined, packageInfo.version);
  const sourceEntries = snapshotEntries(packageInfo.root);
  const closureDigest = treeDigest(packageInfo.root, sourceEntries);
  const commandSignals = ['--version', '--help'];
  for (const signal of ['--mode', '--session-dir', '--config', 'auth-broker']) {
    if (combined.includes(signal)) commandSignals.push(signal);
  }
  const capabilities: RuntimeCapabilities = {
    supported: versionRun.status === 0 && helpRun.status === 0,
    command_signals: commandSignals,
    broker_env: ['OMP_AUTH_BROKER_URL', 'OMP_AUTH_BROKER_TOKEN'],
    native_inventory: 'observed-only',
    // A version/help probe never starts an omp process in provider-free mode.
    // Keep this explicit so doctor cannot turn structural evidence into a
    // fake no-model readiness claim.
    provider_free_probe: false,
    ...(versionRun.status !== 0 || helpRun.status !== 0 ? { reason: 'runtime_version_or_help_probe_failed' } : { reason: 'provider_free_probe_not_attempted' }),
  };
  return {
    source_binary: sourceBinary,
    source_root: packageInfo.root,
    package_name: packageInfo.name,
    package_version: packageInfo.version,
    version,
    digest: sha256File(sourceBinary),
    platform: `${process.platform}-${process.arch}`,
    capabilities,
    closure_digest: closureDigest,
  };
}

export interface ProviderFreeProbeOptions {
  readonly homeRoot: string;
  readonly agentRoot: string;
  readonly projectRoot: string;
  readonly tmpRoot: string;
  readonly timeoutMs?: number;
  /** Explicit immutable extension entrypoint for pre-session discovery. */
  readonly extensionPath?: string;
  readonly expectedCommands?: readonly string[];
  readonly pathEnv?: string;
}

export interface ProviderFreeProbeResult {
  readonly capabilities: RuntimeCapabilities;
  readonly stdout: string;
  readonly stderr: string;
  readonly commands?: readonly { readonly name: string; readonly source: string }[];
}

export function writeProviderFreeCatalog(agentRoot: string): string {
  const root = resolve(agentRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'models.yml');
  const content = [
    'providers:',
    '  e2e-offline:',
    '    baseUrl: http://127.0.0.1:9/v1',
    '    api: openai-completions',
    '    auth: none',
    '    models:',
    '      - id: no-request',
    '        name: Offline Probe',
    '        contextWindow: 4096',
    '        maxTokens: 1024',
    '',
  ].join('\n');
  if (existsSync(path) && readFileSync(path, 'utf8') !== content) {
    throw runtimeError('fixture_conflict', 'run-local provider-free catalog already exists with different content', { path });
  }
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

export function probeProviderFreeRuntime(binary: string, options: ProviderFreeProbeOptions): ProviderFreeProbeResult {
  if (options.extensionPath !== undefined && (options.expectedCommands?.length ?? 0) === 0) {
    throw runtimeError('probe_contract_invalid', 'an explicit extension probe requires named command signals');
  }
  const timeout = options.timeoutMs ?? 5_000;
  const extensionArgs = options.extensionPath === undefined ? [] : ['--extension', options.extensionPath];
  const result = runRuntimeCommand(
    binary,
    ['--mode', 'rpc', '--no-ui', '--no-extensions', '--no-skills', '--no-rules', ...extensionArgs, '--model', 'e2e-offline/no-request'],
    timeout,
    {
      env: {
        PATH: options.pathEnv ?? [dirname(binary), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        HOME: resolve(options.homeRoot),
        OMP_HOME: resolve(options.homeRoot),
        PI_CODING_AGENT_DIR: resolve(options.agentRoot),
        PI_AGENT_DIR: resolve(options.agentRoot),
        OMP_AGENT_DIR: resolve(options.agentRoot),
        OMP_PROJECT_DIR: resolve(options.projectRoot),
        TMPDIR: resolve(options.tmpRoot),
        TMP: resolve(options.tmpRoot),
        TEMP: resolve(options.tmpRoot),
      },
      input: '{"id":"state","type":"get_state"}\n' +
        (options.extensionPath === undefined ? '' : '{"id":"commands","type":"get_available_commands"}\n'),
    },
  );
  const frames: Record<string, unknown>[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      const frame = JSON.parse(line) as unknown;
      if (frame !== null && typeof frame === 'object' && !Array.isArray(frame)) {
        frames.push(frame as Record<string, unknown>);
      }
    } catch {
      // Native RPC may emit diagnostics; only typed responses prove readiness.
    }
  }
  const state = frames.find(frame => frame.type === 'response' && frame.id === 'state');
  const stateData = state?.data;
  const model = stateData !== null && typeof stateData === 'object' ? (stateData as Record<string, unknown>).model : null;
  const selected = model !== null && typeof model === 'object' &&
    (model as Record<string, unknown>).id === 'no-request' &&
    (model as Record<string, unknown>).provider === 'e2e-offline';
  const commandResponse = frames.find(frame => frame.type === 'response' && frame.id === 'commands');
  const commandData = commandResponse?.data;
  const rawCommands = commandData !== null && typeof commandData === 'object'
    ? (commandData as Record<string, unknown>).commands : null;
  const commands = Array.isArray(rawCommands) ? rawCommands
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value))
    .filter(value => typeof value.name === 'string' && typeof value.source === 'string')
    .map(value => ({ name: value.name as string, source: value.source as string })) : [];
  const extensionReady = options.extensionPath === undefined ||
    (commandResponse?.success === true && !frames.some(frame => frame.type === 'extension_error') &&
      options.expectedCommands!.every(name =>
        commands.filter(command => command.name === name && command.source === 'extension').length === 1));
  const supported = result.status === 0 && state?.success === true && selected && extensionReady;
  const capabilities: RuntimeCapabilities = {
    supported,
    provider_free_probe: supported,
    command_signals: supported ? ['get_state', ...(options.extensionPath === undefined ? [] : ['get_available_commands', ...options.expectedCommands!])] : [],
    broker_env: ['OMP_AUTH_BROKER_URL', 'OMP_AUTH_BROKER_TOKEN'],
    native_inventory: 'observed-only',
    reason: supported ? 'provider_free_rpc_observed' : 'provider_free_rpc_probe_failed',
  };
  return { capabilities, stdout: result.stdout, stderr: result.stderr, ...(options.extensionPath === undefined ? {} : { commands }) };
}

export function snapshotRuntime(probe: RuntimeProbe, cacheRoot: string): RuntimeSnapshot {
  if (!isAbsolute(cacheRoot)) throw runtimeError('cache_path_invalid', 'runtime cache root must be absolute', { cacheRoot });
  const sourceEntries = snapshotEntries(probe.source_root);
  const beforeDigest = treeDigest(probe.source_root, sourceEntries);
  if (beforeDigest !== probe.closure_digest) throw runtimeError('runtime_source_changed', 'installed runtime changed during probe', { expected: probe.closure_digest, actual: beforeDigest });
  const destinationRoot = join(resolve(cacheRoot), probe.closure_digest);
  if (existsSync(destinationRoot)) {
    const existing = verifyRuntimeSnapshot(destinationRoot);
    if (existing.closure_digest !== probe.closure_digest || existing.digest !== probe.digest) {
      throw runtimeError('cache_integrity_failure', 'existing runtime cache entry failed identity verification', { root: destinationRoot });
    }
    return existing;
  }
  mkdirSync(resolve(cacheRoot), { recursive: true, mode: 0o700 });
  const staging = join(resolve(cacheRoot), `.${probe.closure_digest}.${process.pid}.${randomBytes(8).toString('hex')}.partial`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const runtimeTarget = join(staging, 'runtime');
    copyTree(probe.source_root, runtimeTarget, sourceEntries);
    const afterEntries = snapshotEntries(probe.source_root);
    const afterDigest = treeDigest(probe.source_root, afterEntries);
    if (afterDigest !== beforeDigest) throw runtimeError('runtime_source_changed', 'installed runtime changed while creating snapshot', { before: beforeDigest, after: afterDigest });
    const relativeBinary = relative(probe.source_root, probe.source_binary);
    if (relativeBinary.startsWith('..') || isAbsolute(relativeBinary)) throw runtimeError('runtime_path_escape', 'runtime executable is outside its package root', { binary: probe.source_binary });
    const snapshotBinary = join(runtimeTarget, relativeBinary);
    const snapshotFiles = afterEntries.filter(entry => entry.kind === 'file' && entry.relative_path.length > 0).map(entry => entry.relative_path.replaceAll('\\', '/')).sort();
    const metadata: SnapshotMetadata = {
      schema_version: 1,
      package_name: probe.package_name,
      package_version: probe.package_version,
      version: probe.version,
      binary_relative: relativeBinary.replaceAll('\\', '/'),
      binary_digest: probe.digest,
      closure_digest: probe.closure_digest,
      platform: probe.platform,
      files: snapshotFiles,
      capabilities: probe.capabilities,
    };
    writeFileSync(metadataPath(staging), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
    const finalParent = dirname(destinationRoot);
    mkdirSync(finalParent, { recursive: true, mode: 0o700 });
    try {
      renameSync(staging, destinationRoot);
    } catch (error) {
      if (!existsSync(destinationRoot)) throw runtimeError('cache_publish_failed', `runtime cache publication failed: ${String(error)}`, { destinationRoot });
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return verifyRuntimeSnapshot(destinationRoot);
}

export function verifyRuntimeSnapshot(root: string): RuntimeSnapshot {
  if (!isAbsolute(root)) throw runtimeError('cache_path_invalid', 'runtime snapshot root must be absolute', { root });
  const metadata = readMetadata(root);
  const binary = join(root, 'runtime', metadata.binary_relative);
  if (!pathContained(root, binary) || !existsSync(binary)) throw runtimeError('cache_integrity_failure', 'runtime snapshot executable is missing or escaped root', { root, binary });
  const binaryStat = lstatSync(binary);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw runtimeError('cache_integrity_failure', 'runtime snapshot executable is not a regular file', { binary });
  const digest = sha256File(binary);
  if (digest !== metadata.binary_digest) throw runtimeError('cache_integrity_failure', 'runtime snapshot executable digest mismatch', { binary, expected: metadata.binary_digest, actual: digest });
  const runtimeRoot = join(root, 'runtime');
  const runtimeEntries = snapshotEntries(runtimeRoot);
  const runtimeClosureDigest = treeDigest(runtimeRoot, runtimeEntries);
  if (runtimeClosureDigest !== metadata.closure_digest) throw runtimeError('cache_integrity_failure', 'runtime snapshot closure digest mismatch', { root, expected: metadata.closure_digest, actual: runtimeClosureDigest });
  const expectedFiles = metadata.files.slice().sort();
  const actualFiles = runtimeEntries.filter(entry => entry.kind === 'file' && entry.relative_path.length > 0).map(entry => entry.relative_path.replaceAll('\\', '/')).sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) throw runtimeError('cache_integrity_failure', 'runtime snapshot file set changed', { root });
  return {
    root,
    binary,
    digest,
    closure_digest: metadata.closure_digest,
    version: metadata.version,
    platform: metadata.platform,
    files: actualFiles,
    capabilities: metadata.capabilities,
  };
}

export function runtimeCacheKey(probe: RuntimeProbe): string {
  const value = `${probe.platform}\0${probe.version}\0${probe.digest}\0${probe.closure_digest}`;
  return digestText(value);
}

export function runtimeBinaryIsSnapshot(path: string, cacheRoot: string): boolean {
  if (!pathContained(cacheRoot, path)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
