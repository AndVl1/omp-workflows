import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, cpSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  readManifest,
  verifyManifest,
  writeManifest,
  type RunManifest,
  type SessionRecord,
} from './manifest.js';
import { assertSafeRunPath, buildChildEnvironment, manifestRoots, pathContained, readRunLeaseOwnership, type ManifestRoots, type RunLeaseOwnership } from './environment.js';
import { killProcessTree, pidIsLive, readSessionRecord, startTestSession, type SessionInfo, type TestSession } from './server.js';
import { writeProviderFreeCatalog } from './runtime.js';
import { verifyPackageArtifact } from './artifacts.js';
import { checkBrokerConnection, resolveLaunchAuthEnvironment } from './auth.js';
import { generateReport, type GenerateReportResult, type ReportInput, type Verdict } from './report.js';
import { stripAnsi, TranscriptLog, WsDriver, waitFor } from './driver.js';
import { loadScenario } from './scenario.js';
import { doctorRun } from './prepare.js';
import { deferred } from './util.js';

export type VerifySuite = 'isolation' | 'live-smoke';
export type VerifyStatus = 'passed' | 'failed' | 'blocked';

export interface VerifyOptions {
  readonly manifestPath: string;
  readonly suite: VerifySuite;
  readonly keepFailed?: boolean;
  readonly sessionId?: string;
  readonly report?: boolean;
}

export interface CleanupOptions {
  readonly manifestPath: string;
  readonly keepFailed?: boolean;
  /** Preserve a failed verification status when deleting mutable roots. */
  readonly preserveFailure?: boolean;
}

export interface CleanupResult {
  readonly ok: boolean;
  readonly status: 'cleaned' | 'failed';
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly status: VerifyStatus;
  readonly suite: VerifySuite;
  readonly manifestPath: string;
  readonly checks: Readonly<Record<string, boolean | string>>;
  readonly errors: readonly { readonly code: string; readonly message: string }[];
  readonly report?: GenerateReportResult;
  readonly cleanup?: CleanupResult;
}

class VerifyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

function errorOf(error: unknown, fallback = 'verify_failed'): { code: string; message: string } {
  if (error instanceof VerifyError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: fallback, message: error.message };
  return { code: fallback, message: String(error) };
}

function storedSessionIds(manifest: RunManifest): string[] {
  const ids = new Set(manifest.sessions.map(session => session.id));
  if (existsSync(manifest.roots.sessions)) {
    for (const entry of readdirSync(manifest.roots.sessions, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  return [...ids];
}


function readConnectionUrl(path: string): string {
  if (!existsSync(path)) throw new VerifyError('session_connection_missing', 'session connection metadata is unavailable');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new VerifyError('session_connection_invalid', 'session connection metadata is invalid');
  }
  if (value === null || typeof value !== 'object') throw new VerifyError('session_connection_invalid', 'session connection metadata is invalid');
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.connection_url === 'string' ? raw.connection_url : null;
  if (url === null || !url.startsWith('http://127.0.0.1:')) throw new VerifyError('session_connection_invalid', 'session connection metadata has no loopback URL');
  return url;
}

function sessionFor(manifest: RunManifest, requested: string | undefined): SessionRecord | null {
  const ids = storedSessionIds(manifest);
  const ordered = requested === undefined ? [...ids].reverse() : [requested];
  for (const id of ordered) {
    const registered = manifest.sessions.find(session => session.id === id);
    if (registered !== undefined) {
      if (registered.status === 'running' || registered.status === 'ready') return registered;
      continue;
    }
    const info = readSessionRecord(manifest, id);
    if (info === null || (info.status !== 'running' && info.status !== 'ready')) continue;
    return {
      id,
      status: info.status === 'running' ? 'running' : 'ready',
      ...(info.pid === null ? {} : { pid: info.pid }),
      ...(info.startMarker === null ? {} : { start_marker: info.startMarker }),
      ...(info.process === undefined ? {} : { process: info.process }),
      transcript_path: info.transcriptPath,
      log_path: info.logPath,
      private_connection_path: info.privateConnectionPath,
    };
  }
  return null;
}

function reportInput(status: VerifyStatus, suite: VerifySuite, errors: readonly { readonly code: string; readonly message: string }[]): ReportInput {
  const verdict: Verdict = status === 'passed' ? 'PASS' : status === 'failed' ? 'FAIL' : 'CONDITIONAL';
  const summary = errors.length === 0
    ? `${suite} verification passed.`
    : `${suite} verification ${status}: ${errors.map(error => `${error.code}: ${error.message}`).join('; ')}`;
  return {
    steps: [{
      id: `${suite}-verification`,
      name: suite,
      order: 1,
      ratings: status === 'passed' ? { error_handling: 5 } : { error_handling: status === 'blocked' ? 3 : 1 },
      defects: [],
      screenshots: [],
      notes: summary,
    }],
    defects: status === 'failed'
      ? errors.map((error, index) => ({
          id: `VERIFY-${index + 1}`,
          severity: 'HIGH' as const,
          dimension: 'error_handling' as const,
          title: `${error.code}: ${error.message}`,
          step: `${suite}-verification`,
          evidence: [],
        }))
      : [],
    agent_quality: { rating: 0, rationale: 'automated verification; no agent quality assessment' },
    verdict,
    overall: { summary, recommendation: status === 'passed' ? 'ship' : 'rework' },
    regressions: errors.map(error => `${error.code}: ${error.message}`),
  };
}

interface IsolationProbeRoots {
  readonly label: 'a' | 'b';
  readonly base: string;
  readonly home: string;
  readonly agent: string;
  readonly workspace: string;
  readonly tmp: string;
  readonly pluginRoot: string;
  readonly pluginDigest: string;
  readonly marker: string;
}

type JsonRecord = Record<string, unknown>;

interface RpcCommandSignal {
  readonly name: string;
  readonly source: string;
}

interface RpcProbeResult {
  readonly ok: boolean;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stateResponse: boolean;
  readonly commandsResponse: boolean;
  readonly model: string | null;
  readonly commands: readonly RpcCommandSignal[];
  readonly markerSeen: boolean;
  readonly hostMarkerSeen: boolean;
}

function materializedTreeDigest(root: string): string {
  const hash = createHash('sha256');
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new VerifyError('plugin_snapshot_invalid', 'derived plugin snapshot contains a symbolic link');
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child), join(relativePath, child));
      return;
    }
    if (!stat.isFile()) throw new VerifyError('plugin_snapshot_invalid', 'derived plugin snapshot contains a non-file entry');
    hash.update(relativePath.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  };
  visit(root, '');
  return hash.digest('hex');
}

function createIsolationProbeRoots(manifest: RunManifest, label: 'a' | 'b'): IsolationProbeRoots {
  const base = join(manifest.roots.tmp, 'isolation', label);
  rmSync(base, { recursive: true, force: true });
  const home = join(base, 'home');
  const agent = join(home, '.omp', 'agent');
  const workspace = join(base, 'workspace');
  const tmp = join(base, 'tmp');
  const pluginRoot = join(base, 'plugin');
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  writeProviderFreeCatalog(agent);
  const commandSource = join(manifest.artifacts.fullstack.root, 'commands');
  const pluginEntrypoint = join(manifest.artifacts.fullstack.root, 'dist', 'index.js');
  if (!existsSync(commandSource) || !existsSync(pluginEntrypoint)) {
    throw new VerifyError('plugin_snapshot_missing', 'prepared fullstack artifact has no shipped extension entrypoint and commands directory');
  }
  cpSync(manifest.artifacts.fullstack.root, pluginRoot, { recursive: true, errorOnExist: false });
  const marker = `e2e-isolation-${label}`;
  const variantEntrypoint = join(pluginRoot, 'dist', 'e2e-variant.js');
  writeFileSync(variantEntrypoint, [
    `import registerOriginal from "./index.js";`,
    '',
    'export default function registerE2EVariant(pi) {',
    '  registerOriginal(pi);',
    `  pi.registerCommand("${marker}", {`,
    `    description: "isolated ${label} command marker",`,
    '    handler: (_args, ctx) => {',
    `      ctx.ui.notify("${marker}", "info");`,
    '    },',
    '  });',
    '}',
    '',
  ].join('\n'), { mode: 0o600 });
  cpSync(commandSource, join(workspace, '.omp', 'commands'), { recursive: true, errorOnExist: false });
  writeFileSync(join(workspace, '.omp', 'commands', `${marker}.md`), `---\ndescription: ${marker}\n---\n${marker}\n`, { mode: 0o600 });
  writeFileSync(join(workspace, '.e2e-state-marker'), `${manifest.run_id}:${label}:before-restart\n`, { mode: 0o600 });
  const realPluginRoot = realpathSync(pluginRoot);
  const realRunRoot = realpathSync(manifest.roots.run);
  if (!pathContained(realRunRoot, realPluginRoot)) {
    throw new VerifyError('plugin_snapshot_invalid', 'derived plugin snapshot resolved outside the run root');
  }
  if (!pathContained(realpathSync(base), realPluginRoot)) {
    throw new VerifyError('plugin_snapshot_invalid', 'derived plugin snapshot resolved outside its run-owned variant root');
  }
  return {
    label,
    base,
    home,
    agent,
    workspace,
    tmp,
    pluginRoot: realPluginRoot,
    pluginDigest: materializedTreeDigest(realPluginRoot),
    marker,
  };
}

function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function modelIdentity(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  const model = asJsonRecord(value);
  if (model === null) return null;
  const id = typeof model.id === 'string' ? model.id : null;
  const provider = typeof model.provider === 'string' ? model.provider : null;
  if (id === null) return null;
  return provider === null ? id : `${provider}/${id}`;
}

function parseRpcLine(line: string): JsonRecord | null {
  if (line.trim().length === 0) return null;
  try {
    return asJsonRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function rpcResponse(frames: readonly JsonRecord[], id: string, command: string): JsonRecord | null {
  for (const frame of frames) {
    if (frame.id === id && frame.type === 'response' && frame.command === command && frame.success === true) return frame;
  }
  return null;
}

function rpcCommandSignals(response: JsonRecord | null): RpcCommandSignal[] {
  const data = asJsonRecord(response?.data);
  const rawCommands = data?.commands;
  if (!Array.isArray(rawCommands)) return [];
  const commands: RpcCommandSignal[] = [];
  for (const raw of rawCommands) {
    const command = asJsonRecord(raw);
    if (command === null || typeof command.name !== 'string' || typeof command.source !== 'string') continue;
    commands.push({ name: command.name, source: command.source });
  }
  return commands;
}


function containsCommandSignal(commands: readonly RpcCommandSignal[], name: string, source?: string): boolean {
  return commands.some(command => command.name === name && (source === undefined || command.source === source));
}

function probeEnvironment(manifest: RunManifest, roots: IsolationProbeRoots, hostFixture: string): Record<string, string> {
  const contaminated = {
    ...process.env,
    OMP_PLUGIN_PATH: hostFixture,
    PI_EXTENSION_PATH: hostFixture,
    PI_CODING_AGENT_DIR: hostFixture,
    OMP_PROJECT_DIR: hostFixture,
  };
  const env = buildChildEnvironment(manifest, {
    baseEnv: contaminated,
    extra: { OMP_E2E_VERIFY: '1' },
  });
  Object.assign(env, {
    HOME: roots.home,
    OMP_HOME: roots.home,
    XDG_CONFIG_HOME: join(roots.home, '.config'),
    XDG_DATA_HOME: join(roots.home, '.local', 'share'),
    XDG_STATE_HOME: join(roots.home, '.local', 'state'),
    XDG_CACHE_HOME: join(roots.home, '.cache'),
    PI_CODING_AGENT_DIR: roots.agent,
    PI_AGENT_DIR: roots.agent,
    OMP_AGENT_DIR: roots.agent,
    OMP_PROJECT_DIR: roots.workspace,
    OMP_SESSION_DIR: join(roots.base, 'sessions'),
    OMP_LOG_DIR: join(roots.base, 'logs'),
    TMPDIR: roots.tmp,
    TMP: roots.tmp,
    TEMP: roots.tmp,
    PWD: roots.workspace,
  });
  delete env.OMP_PLUGIN_PATH;
  delete env.PI_EXTENSION_PATH;
  return env;
}

interface TypedRpcResult {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly frames: readonly JsonRecord[];
}

async function runTypedRpcProcess(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  input: string,
): Promise<TypedRpcResult> {
  const { promise, resolve: finish } = deferred<TypedRpcResult>();
  const child = spawn(binary, [...args], {
    cwd,
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid ?? -1;
  const frames: JsonRecord[] = [];
  let stdoutTail = '';
  let timedOut = false;
  let settled = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const consumeStdout = (chunk: Buffer): void => {
    stdoutTail += chunk.toString('utf8');
    for (;;) {
      const newline = stdoutTail.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutTail.slice(0, newline);
      stdoutTail = stdoutTail.slice(newline + 1);
      const frame = parseRpcLine(line);
      if (frame !== null) frames.push(frame);
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* A process that already exited needs no signal. */
    }
    forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* The process may already have exited. */
      }
    }, 1_000);
  }, 20_000);
  const finishProcess = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(forceTimer);
    const trailing = parseRpcLine(stdoutTail);
    if (trailing !== null) frames.push(trailing);
    finish({ pid, exitCode, signal, timedOut, frames });
  };
  child.stdout?.on('data', consumeStdout);
  child.stdin?.end(input);
  child.once('error', () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* Spawn errors have no owned process to terminate. */
    }
    finishProcess(null, null);
  });
  child.once('close', (code, signal) => {
    finishProcess(code, signal);
  });
  return await promise;
}

async function runRpcProbe(manifest: RunManifest, roots: IsolationProbeRoots, hostFixture: string): Promise<RpcProbeResult> {
  const env = probeEnvironment(manifest, roots, hostFixture);
  const entrypoint = join(roots.pluginRoot, 'dist', 'e2e-variant.js');
  const args = [
    '--mode',
    'rpc',
    '--no-ui',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--extension',
    entrypoint,
    '--model',
    'e2e-offline/no-request',
  ];
  const processResult = await runTypedRpcProcess(
    manifest.runtime.binary,
    args,
    roots.workspace,
    env,
    '{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_available_commands"}\n',
  );
  const state = rpcResponse(processResult.frames, 'state', 'get_state');
  const commandsResponse = rpcResponse(processResult.frames, 'commands', 'get_available_commands');
  const commands = rpcCommandSignals(commandsResponse);
  const model = modelIdentity(asJsonRecord(state?.data)?.model);
  const markerSeen = containsCommandSignal(commands, roots.marker, 'extension');
  const hostMarkerSeen = containsCommandSignal(commands, 'e2e-host-contaminant');
  const stateResponse = state !== null;
  const commandsObserved = commandsResponse !== null;
  const ok =
    !processResult.timedOut
    && processResult.exitCode === 0
    && stateResponse
    && commandsObserved
    && model === 'e2e-offline/no-request'
    && markerSeen
    && !hostMarkerSeen
    && !pidIsLive(processResult.pid);
  return {
    ok,
    pid: processResult.pid,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    stateResponse,
    commandsResponse: commandsObserved,
    model,
    commands,
    markerSeen,
    hostMarkerSeen,
  };
}
interface ExternalFixtureMutation {
  readonly marker: string;
  readonly path: string;
  readonly restore: () => void;
}

function configuredSourceRoots(manifest: RunManifest, roots: ManifestRoots): string[] {
  if (manifest.config_path === undefined || !existsSync(manifest.config_path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifest.config_path, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const config = asJsonRecord(raw);
  if (config === null) return [];
  const candidates: string[] = [];
  const addSource = (value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0) return;
    const source = resolve(dirname(manifest.config_path!), value);
    if (!pathContained(roots.run, source) && !candidates.includes(source)) candidates.push(source);
  };
  const fixture = asJsonRecord(config.fixture);
  addSource(fixture?.source);
  const artifacts = asJsonRecord(config.artifacts);
  addSource(asJsonRecord(artifacts?.core)?.source);
  addSource(asJsonRecord(artifacts?.fullstack)?.source);
  return candidates;
}

function createExternalFixtureMutation(manifest: RunManifest, roots: ManifestRoots): ExternalFixtureMutation {
  const marker = `e2e-post-prepare-${manifest.run_id}-${process.pid}`;
  for (const source of configuredSourceRoots(manifest, roots)) {
    if (!existsSync(source) || !lstatSync(source).isDirectory()) continue;
    const commands = join(source, 'commands');
    const parent = existsSync(commands) && lstatSync(commands).isDirectory() ? commands : source;
    const path = join(parent, `${marker}.md`);
    if (existsSync(path) || pathContained(roots.run, path)) continue;
    try {
      writeFileSync(path, `---\ndescription: ${marker}\n---\n${marker}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      continue;
    }
    return {
      marker,
      path,
      restore: () => {
        rmSync(path, { force: true });
      },
    };
  }
  throw new VerifyError('isolation_prerequisite_missing', 'no writable external source fixture was available for the post-prepare snapshot probe');
}

function appendIsolationReceipt(manifestPath: string, manifest: RunManifest, receipt: JsonRecord): void {
  writeManifest(manifestPath, {
    ...manifest,
    receipts: [...(manifest.receipts ?? []), receipt],
    updated_at: new Date().toISOString(),
  });
}

async function runIsolation(manifest: RunManifest, manifestPath: string): Promise<{ status: VerifyStatus; checks: Record<string, boolean | string>; errors: { code: string; message: string }[] }> {
  const checks: Record<string, boolean | string> = {};
  const errors: { code: string; message: string }[] = [];
  const roots = manifestRoots(manifest);
  checks.roots_contained = Object.values(roots).every(root => pathContained(roots.run, root));
  if (checks.roots_contained !== true) errors.push({ code: 'manifest_path_outside_run', message: 'one or more run roots escape the run root' });

  for (const [name, root] of Object.entries(roots)) {
    if (!pathContained(roots.run, root)) {
      errors.push({ code: 'root_outside_run', message: `${name} root is outside the run root` });
      continue;
    }
    try {
      const stat = lstatSync(root);
      checks[`root_${name}`] = stat.isDirectory();
      if (!stat.isDirectory()) errors.push({ code: 'root_not_directory', message: `${name} root is not a directory` });
    } catch {
      checks[`root_${name}`] = false;
      errors.push({ code: 'root_missing', message: `${name} root is missing` });
    }
  }

  const hostFixture = join(roots.tmp, 'host-contaminant');
  const hostCommandRoot = join(hostFixture, '.omp', 'commands');
  mkdirSync(hostCommandRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(hostCommandRoot, 'e2e-host-contaminant.md'), '---\ndescription: e2e-host-contaminant\n---\ne2e-host-contaminant\n', { mode: 0o600 });
  const contaminatedEnv = buildChildEnvironment(manifest, {
    baseEnv: {
      ...process.env,
      OMP_PLUGIN_PATH: hostFixture,
      PI_EXTENSION_PATH: hostFixture,
      PI_CODING_AGENT_DIR: hostFixture,
      OMP_PROJECT_DIR: hostFixture,
    },
  });
  checks.host_extension_env_excluded =
    contaminatedEnv.OMP_PROJECT_DIR === roots.workspace
    && contaminatedEnv.PI_CODING_AGENT_DIR === roots.agent
    && contaminatedEnv.NODE_OPTIONS === undefined
    && contaminatedEnv.NODE_PATH === undefined
    && contaminatedEnv.OMP_CONFIG === undefined
    && contaminatedEnv.OMP_PLUGIN_PATH === undefined;
  if (checks.host_extension_env_excluded !== true) errors.push({ code: 'host_environment_leak', message: 'child environment contains an excluded host discovery variable' });

  let probeA: IsolationProbeRoots;
  let probeB: IsolationProbeRoots;
  try {
    probeA = createIsolationProbeRoots(manifest, 'a');
    probeB = createIsolationProbeRoots(manifest, 'b');
  } catch (error) {
    const detail = errorOf(error, 'isolation_prerequisite_missing');
    errors.push(detail);
    return { status: 'blocked', checks, errors };
  }
  const [firstA, firstB] = await Promise.all([
    runRpcProbe(manifest, probeA, hostFixture),
    runRpcProbe(manifest, probeB, hostFixture),
  ]);
  const ownA = containsCommandSignal(firstA.commands, probeA.marker, 'extension');
  const ownB = containsCommandSignal(firstB.commands, probeB.marker, 'extension');
  const crossA = containsCommandSignal(firstA.commands, probeB.marker);
  const crossB = containsCommandSignal(firstB.commands, probeA.marker);
  checks.concurrent_processes = firstA.pid > 0 && firstB.pid > 0 && firstA.pid !== firstB.pid;
  checks.two_artifacts_distinct =
    probeA.pluginRoot !== probeB.pluginRoot
    && probeA.pluginDigest !== probeB.pluginDigest;
  checks.rpc_responses_successful =
    firstA.stateResponse && firstA.commandsResponse && firstB.stateResponse && firstB.commandsResponse;
  checks.provider_free_selected_model =
    firstA.model === 'e2e-offline/no-request' && firstB.model === 'e2e-offline/no-request';
  checks.plugin_a_marker = ownA;
  checks.plugin_b_marker = ownB;
  checks.plugin_a_source = firstA.commands.find(command => command.name === probeA.marker && command.source === 'extension')?.source ?? 'unobserved';
  checks.plugin_b_source = firstB.commands.find(command => command.name === probeB.marker && command.source === 'extension')?.source ?? 'unobserved';
  checks.plugin_markers_exclusive = !crossA && !crossB;
  checks.host_marker_unavailable = !firstA.hostMarkerSeen && !firstB.hostMarkerSeen;
  checks.process_exit_clean = firstA.exitCode === 0 && firstB.exitCode === 0 && firstA.signal === null && firstB.signal === null;
  if (checks.concurrent_processes !== true) {
    errors.push({ code: 'concurrent_processes_unproven', message: 'isolation probes did not produce two distinct live process observations' });
  }
  if (checks.two_artifacts_distinct !== true) {
    errors.push({ code: 'isolation_artifacts_not_distinct', message: 'the concurrent probes did not use two distinct materialized plugin artifact snapshots' });
  }
  if (!firstA.stateResponse || !firstB.stateResponse || !firstA.commandsResponse || !firstB.commandsResponse) {
    errors.push({ code: 'rpc_response_missing', message: 'native RPC did not return successful get_state and get_available_commands responses by id and type' });
  }
  if (checks.provider_free_selected_model !== true) {
    errors.push({ code: 'provider_free_model_unobserved', message: 'successful RPC state responses did not select e2e-offline/no-request' });
  }
  if (checks.plugin_a_marker !== true || checks.plugin_b_marker !== true || firstA.markerSeen !== true || firstB.markerSeen !== true) {
    errors.push({ code: 'native_command_isolation_failed', message: 'native command inventory did not expose both run-specific extension marker commands' });
  }
  if (checks.plugin_markers_exclusive !== true) errors.push({ code: 'plugin_marker_cross_leak', message: 'one process observed another run marker' });
  if (checks.host_marker_unavailable !== true) errors.push({ code: 'host_fixture_loaded', message: 'a contaminating host command was visible to an isolated process' });
  if (checks.process_exit_clean !== true) errors.push({ code: 'probe_process_failed', message: 'an isolation RPC process crashed or exited with a non-zero status' });

  const stateMarker = join(probeA.workspace, '.e2e-state-marker');
  let stateBefore: string | null = null;
  try {
    stateBefore = readFileSync(stateMarker, 'utf8');
  } catch {
    errors.push({ code: 'restart_state_missing', message: 'the prepared workspace state marker was not available before restart' });
  }
  let artifactBefore: { core: string; fullstack: string } | null = null;
  try {
    artifactBefore = {
      core: verifyPackageArtifact(manifest.artifacts.core.root).digest,
      fullstack: verifyPackageArtifact(manifest.artifacts.fullstack.root).digest,
    };
  } catch (error) {
    errors.push(errorOf(error, 'artifact_snapshot_invalid'));
  }
  let mutation: ExternalFixtureMutation | null = null;
  let restartedA: RpcProbeResult | null = null;
  try {
    mutation = createExternalFixtureMutation(manifest, roots);
    restartedA = await runRpcProbe(manifest, probeA, hostFixture);
    checks.external_fixture_mutated = true;
    checks.external_mutation_not_loaded =
      !containsCommandSignal(restartedA.commands, mutation.marker)
      && !containsCommandSignal(firstA.commands, mutation.marker)
      && !containsCommandSignal(firstB.commands, mutation.marker);
    if (checks.external_mutation_not_loaded !== true) {
      errors.push({ code: 'checkout_mutation_loaded', message: 'a command added after prepare was observed by an isolated process' });
    }
  } catch (error) {
    const detail = errorOf(error, 'isolation_prerequisite_missing');
    checks.external_fixture_mutated = false;
    checks.external_mutation_not_loaded = false;
    errors.push(detail);
  } finally {
    try {
      mutation?.restore();
      checks.external_fixture_restored = mutation === null || !existsSync(mutation.path);
    } catch (error) {
      checks.external_fixture_restored = false;
      errors.push(errorOf(error, 'external_fixture_restore_failed'));
    }
  }

  let artifactAfter: { core: string; fullstack: string } | null = null;
  try {
    artifactAfter = {
      core: verifyPackageArtifact(manifest.artifacts.core.root).digest,
      fullstack: verifyPackageArtifact(manifest.artifacts.fullstack.root).digest,
    };
  } catch (error) {
    errors.push(errorOf(error, 'artifact_snapshot_invalid'));
  }
  checks.checkout_snapshot_stable =
    artifactBefore !== null
    && artifactAfter !== null
    && artifactBefore.core === artifactAfter.core
    && artifactBefore.fullstack === artifactAfter.fullstack;
  if (checks.checkout_snapshot_stable !== true) errors.push({ code: 'artifact_snapshot_changed', message: 'prepared package snapshots changed during the external fixture mutation probe' });

  const restartedState: string | null = (() => {
    try {
      return readFileSync(stateMarker, 'utf8');
    } catch {
      return null;
    }
  })();
  checks.restart_state_preserved =
    stateBefore !== null
    && restartedState === stateBefore
    && restartedA !== null
    && restartedA.ok
    && restartedA.pid !== firstA.pid;
  checks.restart_rpc_responses_successful =
    restartedA !== null && restartedA.stateResponse && restartedA.commandsResponse;
  if (checks.restart_state_preserved !== true) errors.push({ code: 'restart_state_lost', message: 'restart did not preserve the prepared workspace state marker and successful native RPC observation' });
  if (checks.restart_rpc_responses_successful !== true) errors.push({ code: 'restart_rpc_failed', message: 'restart did not return successful typed RPC responses' });

  const receiptPath = assertSafeRunPath(roots.run, join(roots.evidence, 'isolation-process-receipt.json'), 'isolation receipt');
  assertSafeRunPath(roots.run, roots.evidence, 'isolation evidence');
  mkdirSync(roots.evidence, { recursive: true, mode: 0o700 });
  const receipt: JsonRecord = {
    kind: 'process-observation',
    suite: 'isolation',
    provider_free_model: firstA.model,
    provider_free_selected_model: checks.provider_free_selected_model,
    rpc_responses_successful: checks.rpc_responses_successful,
    concurrent_processes: checks.concurrent_processes,
    two_artifacts_distinct: checks.two_artifacts_distinct,
    artifact_variant_digests: {
      a: probeA.pluginDigest,
      b: probeB.pluginDigest,
    },
    plugin_markers_exclusive: checks.plugin_markers_exclusive,
    command_sources: {
      a: firstA.commands.find(command => command.name === probeA.marker && command.source === 'extension')?.source ?? null,
      b: firstB.commands.find(command => command.name === probeB.marker && command.source === 'extension')?.source ?? null,
    },
    host_marker_unavailable: checks.host_marker_unavailable,
    external_mutation_not_loaded: checks.external_mutation_not_loaded,
    checkout_snapshot_stable: checks.checkout_snapshot_stable,
    restart_state_preserved: checks.restart_state_preserved,
    process_exit_clean: checks.process_exit_clean,
    native_inventory: 'observed-only',
    inventory_complete: false,
  };
  const receiptFd = openSync(receiptPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(receiptFd, 0o600);
    writeSync(receiptFd, JSON.stringify(receipt, null, 2) + '\n');
  } finally {
    closeSync(receiptFd);
  }
  checks.evidence_receipt_written = existsSync(receiptPath);
  if (checks.evidence_receipt_written !== true) errors.push({ code: 'evidence_receipt_missing', message: 'isolation observations were not persisted in run-scoped evidence' });
  const restartedPid = restartedA?.pid ?? -1;
  checks.owned_processes_reaped =
    firstA.pid > 0
    && firstB.pid > 0
    && restartedPid > 0
    && !pidIsLive(firstA.pid)
    && !pidIsLive(firstB.pid)
    && !pidIsLive(restartedPid);
  if (checks.owned_processes_reaped !== true) errors.push({ code: 'probe_process_leaked', message: 'an isolation RPC process remained live after its owned probe closed' });
  checks.native_inventory = 'observed-only';
  checks.native_inventory_complete = false;
  checks.no_llm =
    checks.rpc_responses_successful === true
    && checks.provider_free_selected_model === true
    && checks.process_exit_clean === true;
  if (checks.no_llm !== true) errors.push({ code: 'provider_free_probe_missing', message: 'provider-free typed RPC readiness was not observed; isolation cannot pass' });

  const foreignLog = join(dirname(roots.run), `foreign-omp-${manifest.run_id}-${process.pid}.log`);
  let foreignCreated = false;
  try {
    if (pathContained(roots.run, foreignLog)) throw new VerifyError('foreign_log_probe_invalid', 'foreign log probe path unexpectedly entered the run root');
    writeFileSync(foreignLog, 'foreign session log\n', { flag: 'wx', mode: 0o600 });
    foreignCreated = true;
    const scoped = generateReport(manifest, reportInput('blocked', 'isolation', []));
    const reportText = readFileSync(scoped.jsonPath, 'utf8');
    checks.foreign_log_ignored = !reportText.includes(foreignLog) && !reportText.includes('foreign session log');
  } catch (error) {
    checks.foreign_log_ignored = false;
    errors.push(errorOf(error, 'foreign_log_scope_failed'));
  } finally {
    if (foreignCreated) rmSync(foreignLog, { force: true });
  }
  if (checks.foreign_log_ignored !== true) errors.push({ code: 'foreign_log_loaded', message: 'scoped report evidence consulted a foreign log outside the manifest roots' });

  const receiptToManifest = {
    ...receipt,
    evidence_path: receiptPath,
    process_ids: [firstA.pid, firstB.pid, ...(restartedA === null ? [] : [restartedA.pid])],
  };
  try {
    appendIsolationReceipt(manifestPath, manifest, receiptToManifest);
  } catch (error) {
    errors.push(errorOf(error, 'isolation_receipt_manifest_update_failed'));
  }
  const blocked = errors.some(error => error.code === 'isolation_prerequisite_missing');
  return { status: blocked ? 'blocked' : errors.length === 0 ? 'passed' : 'failed', checks, errors };
}

interface LiveScenarioContract {
  readonly command: string | null;
  readonly input: string | null;
  readonly taskPrompt: string | null;
  readonly expectations: readonly string[];
}

function liveScenarioContract(manifest: RunManifest): LiveScenarioContract {
  const empty: LiveScenarioContract = { command: null, input: null, taskPrompt: null, expectations: [] };
  if (!existsSync(manifest.scenario.path)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifest.scenario.path, 'utf8')) as unknown;
  } catch {
    return empty;
  }
  const scenario = asJsonRecord(raw);
  if (scenario === null) return empty;
  const textual: string[] = [];
  for (const key of ['title', 'description'] as const) {
    if (typeof scenario[key] === 'string') textual.push(scenario[key] as string);
  }
  const rawExpectations: string[] = [];
  const stages = scenario.stages;
  if (Array.isArray(stages)) {
    for (const rawStage of stages) {
      const stage = asJsonRecord(rawStage);
      const expect = stage?.expect;
      if (!Array.isArray(expect)) continue;
      for (const value of expect) {
        if (typeof value === 'string') {
          rawExpectations.push(value);
          textual.push(value);
        }
      }
    }
  }
  const explicitCommand = typeof scenario.command === 'string' && scenario.command.trim().startsWith('/')
    ? scenario.command.trim()
    : null;
  const commandMatch = textual.join('\n').match(/\/[A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*)?/u);
  const command = explicitCommand ?? commandMatch?.[0] ?? null;
  const params = asJsonRecord(scenario.params);
  const timing = asJsonRecord(scenario.timing);
  const interpolationValues: JsonRecord = { ...(params ?? {}) };
  if (typeof timing?.stageTimeoutMs === 'number') interpolationValues.max_time = `${Math.round(timing.stageTimeoutMs / 1_000)}s`;
  const interpolate = (value: string): string => value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (whole, key: string) => {
    const replacement = interpolationValues[key];
    return typeof replacement === 'string' ? replacement : whole;
  }).trim();
  let taskPrompt: string | null = null;
  const task = scenario.task;
  if (typeof task === 'string' && task.trim().length > 0) taskPrompt = interpolate(task);
  if (taskPrompt === null) {
    const taskRecord = asJsonRecord(task);
    const inline = typeof taskRecord?.prompt === 'string'
      ? taskRecord.prompt
      : typeof taskRecord?.text === 'string'
        ? taskRecord.text
        : null;
    if (inline !== null && inline.trim().length > 0) taskPrompt = interpolate(inline);
    const file = typeof taskRecord?.file === 'string' ? taskRecord.file : null;
    if (taskPrompt === null && file !== null) {
      const taskPath = resolve(dirname(manifest.scenario.path), file);
      try {
        if (pathContained(dirname(manifest.scenario.path), taskPath) && existsSync(taskPath)) {
          taskPrompt = interpolate(readFileSync(taskPath, 'utf8'));
        }
      } catch {
        taskPrompt = null;
      }
    }
  }
  if (taskPrompt === null) {
    const scenarioPrompt = typeof scenario.prompt === 'string'
      ? scenario.prompt
      : typeof scenario.task_prompt === 'string'
        ? scenario.task_prompt
        : typeof params?.task === 'string'
          ? params.task
          : null;
    if (scenarioPrompt !== null && scenarioPrompt.trim().length > 0) taskPrompt = interpolate(scenarioPrompt);
  }
  try {
    taskPrompt = loadScenario(manifest.scenario.path).task.trim();
  } catch {
    // Keep explicit inline prompt support for minimal smoke scenarios.
  }
  if (taskPrompt !== null && (taskPrompt.length < 3 || taskPrompt.includes('{{'))) taskPrompt = null;
  const commandWords = command === null
    ? []
    : command.split(/\s+/u).map(word => word.replace(/^\//u, '').toLowerCase());
  const expectations: string[] = [];
  for (const value of rawExpectations) {
    const normalized = stripAnsi(value).trim();
    const lower = normalized.toLowerCase();
    if (
      normalized.length < 3
      || normalized.startsWith('/')
      || commandWords.some(word => lower === word || lower.includes(`/${word}`))
      || expectations.includes(normalized)
    ) continue;
    expectations.push(normalized);
  }
  const explicitInput = typeof scenario.input === 'string'
    ? scenario.input.trim()
    : typeof scenario.command_input === 'string'
      ? scenario.command_input.trim()
      : null;
  const taskInput = taskPrompt?.replace(/\s+/gu, ' ').trim() ?? null;
  const input = explicitInput !== null && explicitInput.startsWith('/')
    ? explicitInput
    : command === null
      ? null
      : taskInput !== null && /^\/(?:do-work|team)\b/u.test(command)
        ? `${command} ${taskInput}`
        : command;
  return { command, input, taskPrompt, expectations };
}

function workflowStateDigest(root: string, expectedBranch: string): string | null {
  if (!existsSync(root)) return null;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new VerifyError('workflow_state_invalid', 'workflow state root is not a trusted directory');
  }
  const candidates = [join(root, 'team-state.json')];
  const features = join(root, 'features');
  if (existsSync(features)) {
    if (!lstatSync(features).isDirectory() || lstatSync(features).isSymbolicLink()) {
      throw new VerifyError('workflow_state_invalid', 'workflow feature state root is not a trusted directory');
    }
    for (const feature of readdirSync(features).sort()) {
      const directory = join(features, feature);
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
        throw new VerifyError('workflow_state_invalid', 'workflow feature state directory is not trusted');
      }
      candidates.push(join(directory, 'state.json'));
    }
  }
  const hash = createHash('sha256');
  let fileCount = 0;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new VerifyError('workflow_state_invalid', 'canonical workflow state is not a regular file');
    const body = readFileSync(path);
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new VerifyError('workflow_state_invalid', 'canonical workflow state is not valid JSON');
    }
    const state = asJsonRecord(raw);
    if (state?.schema !== 1 || state.branch !== expectedBranch || typeof state.task !== 'string' || typeof state.stage_cursor !== 'string') {
      throw new VerifyError('workflow_state_invalid', 'canonical workflow state does not match the isolated branch');
    }
    fileCount += 1;
    hash.update(path.slice(root.length + 1));
    hash.update('\0');
    hash.update(body);
    hash.update('\0');
  }
  return fileCount === 0 ? null : hash.digest('hex');
}

interface LiveObservation {
  readonly submitted: boolean;
  readonly semantic: readonly string[];
}

function observeLiveCommand(
  log: TranscriptLog,
  baselineFrames: number,
  submittedInput: string,
  commandToken: string,
  expectations: readonly string[],
): LiveObservation {
  const before = log.frames.slice(0, baselineFrames);
  const after = log.frames.slice(baselineFrames);
  const submitted = after.some(frame => frame.t === 'i' && stripAnsi(frame.d).includes(commandToken));
  const beforeOutput = before.filter(frame => frame.t === 'o').map(frame => stripAnsi(frame.d)).join('\n').toLowerCase();
  const afterOutput = after.filter(frame => frame.t === 'o').map(frame => stripAnsi(frame.d)).join('\n').toLowerCase();
  const commandlessOutput = afterOutput.replaceAll(submittedInput.toLowerCase(), '').replaceAll(commandToken.toLowerCase(), '').trim();
  const semantic = expectations.filter(expectation => {
    const expected = expectation.toLowerCase();
    return !beforeOutput.includes(expected) && commandlessOutput.includes(expected);
  });
  return { submitted, semantic };
}

interface LiveCommandInventory {
  readonly ok: boolean;
  readonly model: string | null;
  readonly commandName: string | null;
  readonly source: string | null;
  readonly error?: { code: string; message: string };
}

function commandNames(command: string): readonly string[] {
  const token = command.trim().split(/\s+/u)[0] ?? '';
  if (token.length === 0) return [];
  const bare = token.replace(/^\//u, '');
  return [token, bare, `/${bare}`];
}

async function probeLiveCommandInventory(manifest: RunManifest, command: string): Promise<LiveCommandInventory> {
  const names = commandNames(command);
  try {
    const auth = await resolveLaunchAuthEnvironment(manifest, { providerRequired: true, requireRefreshOwnership: true });
    const entrypoint = join(manifest.artifacts.fullstack.root, 'dist', 'index.js');
    if (!existsSync(entrypoint)) {
      return {
        ok: false,
        model: null,
        commandName: null,
        source: null,
        error: { code: 'live_plugin_snapshot_missing', message: 'prepared fullstack artifact has no live extension entrypoint' },
      };
    }
    const env = buildChildEnvironment(manifest, {
      authEnv: auth.env,
      extra: { OMP_E2E_LIVE_INVENTORY: '1' },
    });
    const processResult = await runTypedRpcProcess(
      manifest.runtime.binary,
      [
        '--mode',
        'rpc',
        '--no-ui',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--extension',
        entrypoint,
        '--model',
        manifest.model!,
      ],
      manifest.roots.workspace,
      env,
      '{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_available_commands"}\n',
    );
    const state = rpcResponse(processResult.frames, 'state', 'get_state');
    const commandsResponse = rpcResponse(processResult.frames, 'commands', 'get_available_commands');
    const model = modelIdentity(asJsonRecord(state?.data)?.model);
    const signals = rpcCommandSignals(commandsResponse);
    const signal = signals.find(candidate => names.includes(candidate.name) && candidate.source === 'extension') ?? null;
    const ok =
      !processResult.timedOut
      && processResult.exitCode === 0
      && processResult.signal === null
      && state !== null
      && commandsResponse !== null
      && model === manifest.model
      && signal !== null
      && !pidIsLive(processResult.pid);
    if (ok) return { ok: true, model, commandName: signal.name, source: signal.source };
    return {
      ok: false,
      model,
      commandName: signal?.name ?? null,
      source: signal?.source ?? null,
      error: {
        code: 'live_command_inventory_failed',
        message: 'native command inventory did not confirm the requested extension command and selected model',
      },
    };
  } catch (error) {
    return {
      ok: false,
      model: null,
      commandName: null,
      source: null,
      error: errorOf(error, 'live_command_inventory_failed'),
    };
  }
}

async function runLiveSmoke(manifest: RunManifest, requestedSessionId: string | undefined): Promise<{ status: VerifyStatus; checks: Record<string, boolean | string>; errors: { code: string; message: string }[]; session?: TestSession; sessionIds?: readonly string[] }> {
  const checks: Record<string, boolean | string> = {}, sessionIds: string[] = [];
  const errors: { code: string; message: string }[] = [];
  const contract = liveScenarioContract(manifest);
  if (manifest.model === null || manifest.auth.mode === 'none') {
    return {
      status: 'blocked',
      checks: { auth_ready: false },
      errors: [{ code: 'live_prerequisite_missing', message: 'live-smoke requires a selected model and explicit api-key-env or broker authentication' }],
    };
  }
  checks.scenario_assertion_available =
    contract.command !== null
    && contract.input !== null
    && contract.taskPrompt !== null
    && contract.expectations.length > 0;
  if (checks.scenario_assertion_available !== true) {
    return {
      status: 'blocked',
      checks,
      errors: [{ code: 'live_scenario_assertion_missing', message: 'live-smoke requires an explicitly runnable command, concrete task/prompt input, and a non-echo expected response assertion' }],
    };
  }
  const auth = await checkBrokerConnection(manifest);
  checks.auth_ready = auth.ok;
  if (!auth.ok) {
    return {
      status: 'blocked',
      checks,
      errors: [{ code: auth.code, message: auth.message }],
    };
  }
  const inventory = await probeLiveCommandInventory(manifest, contract.command!);
  checks.command_inventory = inventory.ok;
  checks.command_name = inventory.commandName ?? 'unobserved';
  checks.command_source = inventory.source ?? 'unobserved';
  if (inventory.ok !== true) {
    return {
      status: inventory.error?.code === 'live_plugin_snapshot_missing' ? 'blocked' : 'failed',
      checks,
      errors: [inventory.error ?? { code: 'live_command_inventory_failed', message: 'native command inventory did not confirm the requested live command' }],
    };
  }
  const selected = sessionFor(manifest, requestedSessionId);
  if (selected !== null && selected.status === 'running') {
    errors.push({ code: 'session_already_running', message: 'a live session must be stopped before live-smoke starts' });
    return { status: 'failed', checks, errors };
  }
  const stateRoot = join(manifest.roots.workspace, '.work-state');
  const expectedBranch = `e2e/${manifest.run_id}`;
  let stateBeforeCommand: string | null;
  try {
    stateBeforeCommand = workflowStateDigest(stateRoot, expectedBranch);
  } catch (error) {
    return { status: 'failed', checks, errors: [errorOf(error, 'workflow_state_invalid')] };
  }
  const requested = requestedSessionId ?? `verify-${Date.now().toString(36)}`;
  const sessionId = storedSessionIds(manifest).includes(requested) ? `${requested}-smoke` : requested;
  let session: TestSession;
  try {
    session = await startTestSession({
      manifest,
      sessionId,
      surface: 'text',
      scenario: { id: manifest.scenario.id },
    });
  } catch (error) {
    const detail = errorOf(error, 'live_start_failed');
    return { status: 'failed', checks, errors: [detail] };
  }
  sessionIds.push(session.sessionId);

  try {
    checks.selected_model = session.readiness.model === manifest.model;
    if (checks.selected_model !== true) {
      errors.push({ code: 'live_selected_model_mismatch', message: 'live session readiness selected a different model than the manifest contract' });
    }
    const url = readConnectionUrl(session.privateConnectionPath);
    const driver = new WsDriver({ url, transcriptPath: session.transcriptPath });
    const log = new TranscriptLog(session.transcriptPath);
    await driver.open();
    try {
      // PTY spawn and native inventory readiness precede the interactive
      // editor by ~1s on omp 18.x. Sending CR before the editor mounts leaves
      // the task typed but unsubmitted. Wait for the rendered input prompt.
      try {
        let consumedFrameCount = 0;
        let recentTerminalOutput = '';
        await waitFor(() => {
          log.refresh();
          while (consumedFrameCount < log.frames.length) {
            const frame = log.frames[consumedFrameCount++];
            if (frame?.t !== 'o' || typeof frame.d !== 'string') continue;
            recentTerminalOutput = `${recentTerminalOutput}${frame.d}`.slice(-2_048);
          }
          return recentTerminalOutput.includes('╰─ ');
        }, { timeoutMs: 30_000, intervalMs: 100 });
      } catch {
        throw new VerifyError('live_tui_not_ready', 'native omp did not render its interactive input prompt before command submission');
      }
      const baselineFrames = log.frames.length;
      const command = contract.command!;
      const input = contract.input!;
      await driver.type(input);
      await driver.pressEnter();
      let observation: LiveObservation = { submitted: false, semantic: [] };
      await waitFor(() => {
        log.refresh();
        observation = observeLiveCommand(log, baselineFrames, input, command.split(/\s+/u)[0] ?? command, contract.expectations);
        const currentState = workflowStateDigest(stateRoot, expectedBranch);
        checks.workflow_state_saved = currentState !== null && currentState !== stateBeforeCommand;
        return observation.submitted && observation.semantic.length > 0 && checks.workflow_state_saved === true;
      }, { timeoutMs: 120_000, intervalMs: 250 });
      checks.registered_command = inventory.ok && observation.submitted;
      checks.provider_response_semantic = observation.semantic.length > 0;
      checks.provider_output = checks.provider_response_semantic;
      checks.startup_echo_rejected = checks.provider_response_semantic === true;
      if (checks.registered_command !== true) errors.push({ code: 'live_command_not_submitted', message: 'the registered command was not observed as submitted terminal input' });
      if (checks.provider_response_semantic !== true) errors.push({ code: 'live_provider_response_unproven', message: 'live output matched no scenario-specific assertion distinct from startup or terminal echo' });
    } catch (error) {
      const detail = errorOf(error, 'live_request_failed');
      errors.push(detail);
      checks.provider_output = false;
      checks.provider_response_semantic = false;
      checks.registered_command = false;
      checks.startup_echo_rejected = false;
    } finally {
      await driver.close();
    }
  } catch (error) {
    errors.push(errorOf(error, 'live_connection_failed'));
  } finally {
    const sessionInfo = readSessionRecord(manifest, session.sessionId);
    checks.session_ready = sessionInfo?.ready === true;
    if (checks.session_ready !== true) {
      errors.push({ code: 'live_session_not_ready', message: 'live-smoke did not observe ready:true in the owned session record' });
    }
    await session.close();
  }

  // Only a canonical engine state belongs to the workflow. Session-start
  // observability and runtime mapping files do not establish resumability.
  let stateBeforeResume: string | null = null;
  try {
    stateBeforeResume = workflowStateDigest(stateRoot, expectedBranch);
  } catch (error) {
    errors.push(errorOf(error, 'workflow_state_invalid'));
  }
  checks.workflow_state_saved = stateBeforeResume !== null;
  if (checks.workflow_state_saved !== true) errors.push({ code: 'workflow_state_missing', message: 'live-smoke did not leave a saved workflow state for resume' });
  if (stateBeforeResume === null) return { status: 'failed', checks, errors, session, sessionIds };

  const resumeId = `${sessionId}-resume`;
  let resumed: TestSession | undefined;
  try {
    resumed = await startTestSession({
      manifest,
      sessionId: resumeId,
      surface: 'text',
      scenario: { id: manifest.scenario.id },
    });
    sessionIds.push(resumed.sessionId);
    await waitFor(() => {
      const resumedInfo = readSessionRecord(manifest, resumed!.sessionId);
      if (resumedInfo?.status === 'failed') throw new VerifyError('resume_session_failed', 'new session exited before native readiness');
      return resumedInfo?.ready === true && resumedInfo.status === 'running';
    }, { timeoutMs: 15_000, intervalMs: 100 });
    checks.resume_ready = true;
    checks.resume_new_session = resumed.sessionId !== session.sessionId && checks.resume_ready === true;
    if (checks.resume_ready !== true) errors.push({ code: 'resume_session_not_ready', message: 'new resume session did not report ready:true' });
  } catch (error) {
    checks.resume_ready = false;
    checks.resume_new_session = false;
    errors.push(errorOf(error, 'resume_start_failed'));
  } finally {
    if (resumed !== undefined) await resumed.close();
  }
  let stateAfterResume: string | null = null;
  try {
    stateAfterResume = workflowStateDigest(stateRoot, expectedBranch);
  } catch (error) {
    errors.push(errorOf(error, 'workflow_state_invalid'));
  }
  checks.resume_state_preserved =
    stateBeforeResume !== null
    && stateAfterResume === stateBeforeResume
    && checks.resume_new_session === true;
  if (checks.resume_state_preserved !== true) errors.push({ code: 'resume_state_lost', message: 'a new omp session did not preserve the saved workflow state' });
  return { status: errors.length === 0 ? 'passed' : 'failed', checks, errors, session, sessionIds };
}

interface CleanupSessionPlan {
  readonly sessionId: string;
  readonly info: SessionInfo;
  readonly cwd: string;
}

type CleanupLease = RunLeaseOwnership;

function cleanupLease(manifest: RunManifest): CleanupLease | null {
  const roots = manifestRoots(manifest);
  const path = assertSafeRunPath(roots.private, join(roots.private, 'run.active.lock'), 'run active lock');
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new VerifyError('run_lease_unreadable', `run lease could not be inspected: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new VerifyError('run_lease_invalid', `run lease is not a regular file: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new VerifyError('run_lease_invalid', `run lease is not valid JSON: ${path}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VerifyError('run_lease_invalid', `run lease record is invalid: ${path}`);
  }
  const sessionId = (parsed as Record<string, unknown>).session_id;
  if (typeof sessionId !== 'string') throw new VerifyError('run_lease_invalid', `run lease session identity is missing: ${path}`);
  try {
    const ownership = readRunLeaseOwnership(manifest, sessionId);
    if (ownership === null) throw new VerifyError('run_lease_unreadable', `run lease disappeared during inspection: ${path}`);
    return ownership;
  } catch (error) {
    if (error instanceof VerifyError) throw error;
    throw new VerifyError('run_lease_invalid', error instanceof Error ? error.message : String(error));
  }
}

function cleanupSessionPlans(manifest: RunManifest, lease: CleanupLease | null): CleanupSessionPlan[] {
  const plans: CleanupSessionPlan[] = [];
  const listedById = new Map(manifest.sessions.map(session => [session.id, session] as const));
  for (const sessionId of storedSessionIds(manifest)) {
    const listed = listedById.get(sessionId);
    const info = readSessionRecord(manifest, sessionId);
    if (info === null) {
      if (listed === undefined || listed.status === 'preparing' || listed.status === 'ready' || listed.status === 'running') {
        throw new VerifyError('session_identity_unverified', `session ${sessionId} has no readable terminal record`);
      }
      continue;
    }
    if (info.status === 'stop_refused') {
      throw new VerifyError('process_identity_ambiguous', `session ${sessionId} previously refused process shutdown`);
    }
    const activeStatus = info.status === 'preparing' || info.status === 'ready' || info.status === 'running';
    if (activeStatus && (info.pid === null || info.process === undefined)) {
      throw new VerifyError('session_start_ambiguous', `session ${sessionId} has status ${info.status} without a typed process receipt`);
    }
    if (info.process === undefined) continue;
    const cwd = resolve(manifest.roots.run, info.process.cwd_relative);
    if (!pathContained(manifest.roots.run, cwd)) {
      throw new VerifyError('process_cwd_outside_run', `session ${sessionId} cwd is outside the run root`);
    }
    plans.push({ sessionId, info, cwd });
  }
  if (lease !== null && !pidIsLive(lease.holderPid)) {
    const known = plans.some(plan => plan.sessionId === lease.sessionId) || listedById.has(lease.sessionId);
    if (!known) throw new VerifyError('session_identity_unverified', `run lease references unknown session ${lease.sessionId}`);
  }
  return plans;
}
function hasRawSessionEvidence(roots: ManifestRoots): boolean {
  for (const root of [roots.sessions, roots.logs]) {
    let stat: Stats;
    try {
      stat = lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new VerifyError('cleanup_evidence_unreadable', 'run-owned session evidence could not be inspected');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    try {
      if (readdirSync(root).length > 0) return true;
    } catch {
      throw new VerifyError('cleanup_evidence_unreadable', 'run-owned session evidence could not be inspected');
    }
  }
  return false;
}


/**
 * Stop and remove only resources rooted in a verified run manifest. Every live
 * process needs the typed receipt written by server.ts; a PID without the
 * receipt is an ownership refusal, never a kill candidate.
 */
export async function cleanupRun(options: CleanupOptions): Promise<CleanupResult> {
  const manifestPath = resolve(options.manifestPath);
  let manifest: RunManifest;
  try {
    manifest = readManifest(manifestPath);
    verifyManifest(manifest);
  } catch (error) {
    const detail = errorOf(error, 'manifest_invalid');
    return { ok: false, status: 'failed', removed: [], retained: [], error: detail };
  }
  const roots = manifestRoots(manifest);
  const removed: string[] = [];
  const retained: string[] = [];
  try {
    const lease = cleanupLease(manifest);
    const plans = cleanupSessionPlans(manifest, lease);
    const leaseLive = lease !== null && pidIsLive(lease.holderPid);
    if (leaseLive) {
      const ownerPlan = plans.find(plan => plan.sessionId === lease.sessionId);
      if (ownerPlan === undefined || ownerPlan.info.pid === null || ownerPlan.info.process === undefined || !pidIsLive(ownerPlan.info.pid)) {
        throw new VerifyError('run_active', `run lease is live but session ${lease.sessionId} has no provable process receipt`);
      }
    }

    /*
     * Validate every session before stopping any process or removing any
     * root.  A typed receipt is also checked when its leader is already dead:
     * killProcessTree refuses an unobservable surviving group, while allowing
     * a fully gone process after a parent crash.
     */
    for (const plan of plans) {
      if (plan.info.process === undefined || plan.info.pid === null) continue;
      await killProcessTree(plan.info.pid, {
        manifest,
        sessionId: plan.sessionId,
        receipt: plan.info.process,
        executablePath: manifest.runtime.binary,
        executableDigest: manifest.runtime.digest,
        cwd: plan.cwd,
      });
    }
    let leaseAfterStop = cleanupLease(manifest);
    const releaseDeadline = Date.now() + 1_000;
    while (leaseAfterStop !== null && pidIsLive(leaseAfterStop.holderPid) && Date.now() < releaseDeadline) {
      const { promise: tick, resolve: settle } = deferred<void>();
      setTimeout(settle, 50);
      await tick;
      leaseAfterStop = cleanupLease(manifest);
    }
    if (leaseAfterStop !== null && pidIsLive(leaseAfterStop.holderPid)) {
      throw new VerifyError('run_active', `run lease remains live during cleanup (pid ${String(leaseAfterStop.holderPid)})`);
    }
    if (lease !== null && leaseAfterStop !== null && leaseAfterStop.ownerNonce !== lease.ownerNonce) {
      throw new VerifyError('run_lease_changed', 'run lease ownership changed during cleanup');
    }
    const cleanupReportPath = join(roots.evidence, 'cleanup', 'report.json');
    let existingCleanupArchive = false;
    try {
      const stat = lstatSync(cleanupReportPath);
      existingCleanupArchive = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new VerifyError('cleanup_evidence_unreadable', 'existing cleanup evidence could not be inspected');
      }
    }
    if (!(manifest.status === 'cleaned' && existingCleanupArchive) && hasRawSessionEvidence(roots)) {
      const sessionIds = [...new Set(storedSessionIds(manifest).filter(id => readSessionRecord(manifest, id) !== null))];
      const input: ReportInput = {
        steps: [],
        defects: [],
        agent_quality: { rating: 0, rationale: 'not assessed during automatic cleanup' },
        verdict: 'CONDITIONAL',
        overall: { summary: 'Verification was not performed during cleanup; run-owned session evidence was retained.' },
        verification: { suite: 'cleanup', checks: {}, session_ids: sessionIds },
      };
      let archive: GenerateReportResult;
      try {
        archive = generateReport(manifest, input, {
          outputId: 'cleanup',
          mdDir: join(roots.evidence, 'cleanup-markdown'),
          copyEvidence: true,
        });
      } catch (error) {
        const detail = errorOf(error, 'cleanup_evidence_failed');
        throw new VerifyError('cleanup_evidence_failed', detail.message);
      }
      if (archive.warnings.some(warning => warning === 'raw evidence omitted for secret safety' || warning === 'evidence copy failed')) {
        throw new VerifyError('cleanup_evidence_failed', 'run-owned session evidence could not be safely retained');
      }
    }
    // Private state is removed even when --keep-failed retains the workspace.
    if (pathContained(roots.run, roots.private) && existsSync(roots.private)) {
      rmSync(roots.private, { recursive: true, force: true });
      removed.push(roots.private);
    }
    const preserveWorkspace = options.keepFailed === true && (manifest.status === 'failed' || options.preserveFailure === true);
    const mutable = [roots.home, roots.agent, roots.tmp, roots.workspace, roots.sessions, roots.logs];
    for (const root of mutable) {
      if (preserveWorkspace && root === roots.workspace) {
        retained.push(root);
        continue;
      }
      if (!pathContained(roots.run, root)) throw new VerifyError('cleanup_path_outside_run', `cleanup path escapes run root: ${root}`);
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
        removed.push(root);
      }
    }
    retained.push(roots.evidence, manifestPath);
    const finalStatus: RunManifest['status'] = options.preserveFailure === true || manifest.status === 'failed' ? 'failed' : 'cleaned';
    writeManifest(manifestPath, {
      ...manifest,
      status: finalStatus,
      updated_at: new Date().toISOString(),
      sessions: manifest.sessions.map(session => session.status === 'running' ? { ...session, status: 'stopped' as const } : session),
    });
    return { ok: true, status: finalStatus === 'failed' ? 'failed' : 'cleaned', removed, retained };
  } catch (error) {
    const detail = errorOf(error, 'cleanup_refused');
    return { ok: false, status: 'failed', removed, retained, error: detail };
  }
}

/** Execute a real verification suite, export scoped evidence, then clean up. */
export async function verifyRun(options: VerifyOptions): Promise<VerifyResult> {
  const manifestPath = resolve(options.manifestPath);
  let manifest: RunManifest;
  try {
    manifest = readManifest(manifestPath);
    verifyManifest(manifest);
  } catch (error) {
    const detail = errorOf(error, 'manifest_invalid');
    return { ok: false, status: 'failed', suite: options.suite, manifestPath, checks: {}, errors: [detail] };
  }

  const doctor = await doctorRun(manifestPath);
  if (!doctor.ok) {
    const detail = doctor.error ?? { code: 'prerequisite_missing', message: 'doctor blocked the suite' };
    let status: VerifyStatus = 'blocked';
    const errors = [{ code: detail.code, message: detail.message }];
    let report: GenerateReportResult | undefined;
    if (options.report !== false) {
      try {
        const input = {
          ...reportInput(status, options.suite, errors),
          verification: { suite: options.suite, checks: { doctor: false }, session_ids: [] },
        };
        report = generateReport(manifestPath, input, { sessionId: options.sessionId, copyEvidence: true });
      } catch (error) {
        errors.push(errorOf(error, 'report_generation_failed'));
        status = 'failed';
      }
    }
    const blocked: VerifyResult = {
      ok: false,
      status,
      suite: options.suite,
      manifestPath,
      checks: { doctor: false },
      errors,
    };
    const cleanup = await cleanupRun({ manifestPath, keepFailed: options.keepFailed, preserveFailure: false });
    if (!cleanup.ok) {
      return { ...blocked, ok: false, status: 'failed', errors: [...errors, cleanup.error ?? { code: 'cleanup_failed', message: 'run-owned cleanup was refused' }], ...(report === undefined ? {} : { report }), cleanup };
    }
    return { ...blocked, ...(report === undefined ? {} : { report }), cleanup };
  }

  let outcome: { status: VerifyStatus; checks: Record<string, boolean | string>; errors: { code: string; message: string }[]; session?: TestSession; sessionIds?: readonly string[] };
  try {
    outcome = options.suite === 'isolation'
      ? await runIsolation(manifest, manifestPath)
      : await runLiveSmoke(manifest, options.sessionId);
  } catch (error) {
    outcome = {
      status: 'failed',
      checks: {},
      errors: [errorOf(error, 'verification_failed')],
    };
  }
  let status = outcome.status;
  let errors = [...outcome.errors];
  let report: GenerateReportResult | undefined;
  if (options.report !== false) {
    try {
      const input = {
        ...reportInput(status, options.suite, errors),
        verification: {
          suite: options.suite,
          checks: outcome.checks,
          session_ids: outcome.sessionIds ?? [],
        },
      };
      report = generateReport(
        manifestPath,
        input,
        {
          sessionId: options.suite === 'live-smoke' ? undefined : options.sessionId ?? outcome.session?.sessionId,
          copyEvidence: true,
        },
      );
    } catch (error) {
      errors.push(errorOf(error, 'report_generation_failed'));
      status = 'failed';
    }
  }
  const base: VerifyResult = {
    ok: status === 'passed',
    status,
    suite: options.suite,
    manifestPath,
    checks: outcome.checks,
    errors,
  };
  const cleanup = await cleanupRun({
    manifestPath,
    keepFailed: options.keepFailed,
    preserveFailure: status !== 'passed',
  });
  if (!cleanup.ok) {
    return { ...base, ok: false, status: 'failed', errors: [...errors, cleanup.error ?? { code: 'cleanup_failed', message: 'run-owned cleanup was refused' }], ...(report === undefined ? {} : { report }), cleanup };
  }
  return { ...base, ...(report === undefined ? {} : { report }), cleanup };
}
