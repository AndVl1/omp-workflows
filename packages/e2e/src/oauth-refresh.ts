import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const EXPECTED_NATIVE_VERSION = '18.0.6';
const MINIMUM_BUN = [1, 3, 14] as const;
const FIXTURE_DEADLINE_MS = 45_000;
const FIXTURE_STDOUT_LIMIT = 64 * 1024;
const FIXTURE_RECEIPT_PREFIX = '@@OMP_E2E_OAUTH_REFRESH_RECEIPT@@';
const INTEGRATION_BOUNDARY = 'Native component/process integration using real AuthStorage, SqliteAuthCredentialStore, startAuthBroker, AuthBrokerClient, and RemoteAuthCredentialStore; unchanged production CLI serve wiring is not exercised.';
const NATIVE_PROVENANCE = 'exact E2E devDependency and lockfile pin; fixture verified the imported package';

interface RefreshCaseBase {
  readonly status: 'passed';
}

export interface OAuthRefreshCases {
  readonly initial_valid: RefreshCaseBase & {
    readonly callers: number;
    readonly original_access_callers: number;
    readonly refresh_requests: number;
  };
  readonly concurrent_expiry_refresh: RefreshCaseBase & {
    readonly callers: number;
    readonly broker_refresh_attempts: number;
    readonly broker_refresh_max_in_flight: number;
    readonly provider_refresh_requests: number;
    readonly provider_refresh_max_in_flight: number;
    readonly rotated_access_callers: number;
    readonly stored_access_rotated: boolean;
    readonly stored_refresh_rotated: boolean;
    readonly client_refresh_sentinel_only: boolean;
  };
  readonly persistence_reopen: RefreshCaseBase & {
    readonly reopened_access_callers: number;
    readonly provider_refresh_requests_before: number;
    readonly provider_refresh_requests_after: number;
  };
  readonly transient_error: RefreshCaseBase & {
    readonly endpoint_503_responses: number;
    readonly broker_error_status: number;
    readonly get_api_key_unavailable: boolean;
    readonly stored_row_active: boolean;
    readonly stored_row_unchanged: boolean;
  };
}

export interface OAuthRefreshReceipt {
  readonly ok: boolean;
  readonly kind: 'native-oauth-refresh-component-integration';
  readonly status: 'passed' | 'failed';
  readonly native_package: {
    readonly name: '@oh-my-pi/pi-ai';
    readonly version: string | null;
    readonly provenance: string;
  };
  readonly bun_version: string | null;
  readonly integration_boundary: typeof INTEGRATION_BOUNDARY;
  readonly cases?: OAuthRefreshCases;
  readonly cleanup: { readonly status: 'complete' | 'not_run' | 'failed' };
  readonly error?: { readonly code: string; readonly message: string };
}

interface BunVersion {
  readonly text: string;
  readonly parts: readonly [number, number, number];
}

interface FixtureOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stdoutOverflow: boolean;
  readonly spawnFailed: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

interface Failure {
  readonly code: string;
  readonly message: string;
}

function failureReceipt(
  error: Failure,
  bunVersion: string | null,
  cleanup: OAuthRefreshReceipt['cleanup']['status'],
): OAuthRefreshReceipt {
  return {
    ok: false,
    kind: 'native-oauth-refresh-component-integration',
    status: 'failed',
    native_package: { name: '@oh-my-pi/pi-ai', version: null, provenance: `expected E2E devDependency ${EXPECTED_NATIVE_VERSION}; fixture not verified` },
    bun_version: bunVersion,
    integration_boundary: INTEGRATION_BOUNDARY,
    cleanup: { status: cleanup },
    error,
  };
}

function preflightBun(): { readonly version?: BunVersion; readonly error?: Failure } {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('bun', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
    });
  } catch {
    return { error: { code: 'bun_required', message: 'Bun >=1.3.14 is required for the native OAuth refresh regression.' } };
  }
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return { error: { code: 'bun_required', message: 'Bun >=1.3.14 is required for the native OAuth refresh regression.' } };
  }
  if (result.error !== undefined || result.status !== 0) {
    return { error: { code: 'bun_version_unavailable', message: 'Unable to read the Bun version required for the native OAuth refresh regression.' } };
  }
  const text = String(result.stdout).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (match === null) {
    return { error: { code: 'bun_unsupported', message: 'Bun >=1.3.14 is required for the native OAuth refresh regression.' } };
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < MINIMUM_BUN.length; index += 1) {
    if (parts[index]! > MINIMUM_BUN[index]!) return { version: { text, parts } };
    if (parts[index]! < MINIMUM_BUN[index]!) {
      return { error: { code: 'bun_unsupported', message: 'Bun >=1.3.14 is required for the native OAuth refresh regression.' } };
    }
  }
  return { version: { text, parts } };
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: `${root}/home`,
    PI_CODING_AGENT_DIR: `${root}/agent`,
    PI_CONFIG_DIR: `${root}/config`,
    XDG_CONFIG_HOME: `${root}/xdg-config`,
    XDG_DATA_HOME: `${root}/xdg-data`,
    XDG_CACHE_HOME: `${root}/xdg-cache`,
    XDG_STATE_HOME: `${root}/xdg-state`,
    TMPDIR: `${root}/tmp`,
    TMP: `${root}/tmp`,
    TEMP: `${root}/tmp`,
    E2E_OAUTH_REFRESH_ROOT: `${root}/run`,
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
  if (process.env.LC_ALL !== undefined) env.LC_ALL = process.env.LC_ALL;
  if (process.env.TZ !== undefined) env.TZ = process.env.TZ;
  return env;
}

async function preparePrivateDirectories(root: string): Promise<void> {
  await Promise.all(['home', 'agent', 'config', 'xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state', 'tmp', 'run']
    .map(directory => mkdir(`${root}/${directory}`, { recursive: true, mode: 0o700 })));
}

async function runFixture(path: string, root: string): Promise<FixtureOutcome> {
  let child: ChildProcess;
  try {
    child = spawn('bun', ['run', path], {
      cwd: `${root}/run`,
      env: isolatedEnvironment(root),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return { code: null, stdout: '', stdoutOverflow: false, spawnFailed: true, timedOut: false, aborted: false };
  }

  let stdout = '';
  let stdoutOverflow = false;
  let spawnFailed = false;
  let timedOut = false;
  let aborted = false;
  let hardKill: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    hardKill ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_000);
  };
  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const onSigterm = (): void => controller.abort();
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FIXTURE_DEADLINE_MS);
  controller.signal.addEventListener('abort', onAbort);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const remaining = FIXTURE_STDOUT_LIMIT - stdout.length;
    if (chunk.length > remaining) stdoutOverflow = true;
    if (remaining > 0) stdout += chunk.slice(0, remaining);
  });
  // Native libraries may log synthetic token material: drain, never retain, and never forward.
  child.stderr?.resume();
  child.on('error', () => { spawnFailed = true; });

  let code: number | null = null;
  try {
    await new Promise<void>(resolveClose => {
      child.once('close', exitCode => {
        code = exitCode;
        resolveClose();
      });
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardKill);
    controller.signal.removeEventListener('abort', onAbort);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
  return { code, stdout, stdoutOverflow, spawnFailed, timedOut, aborted };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateCases(value: unknown): OAuthRefreshCases | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, ['native_package_version', 'initial_valid', 'concurrent_expiry_refresh', 'persistence_reopen', 'transient_error', 'cleanup']) ||
      value.native_package_version !== EXPECTED_NATIVE_VERSION) return undefined;
  const initial = value.initial_valid;
  const concurrent = value.concurrent_expiry_refresh;
  const persistence = value.persistence_reopen;
  const transient = value.transient_error;
  const cleanup = value.cleanup;
  if (!isObject(initial) || !hasOnlyKeys(initial, ['status', 'callers', 'original_access_callers', 'refresh_requests']) || initial.status !== 'passed' ||
      !isCount(initial.callers) || initial.callers < 2 || !isCount(initial.original_access_callers) || initial.original_access_callers !== initial.callers ||
      initial.refresh_requests !== 0 ||
      !isObject(concurrent) || !hasOnlyKeys(concurrent, [
        'status', 'callers', 'broker_refresh_attempts', 'broker_refresh_max_in_flight', 'provider_refresh_requests',
        'provider_refresh_max_in_flight', 'rotated_access_callers', 'stored_access_rotated', 'stored_refresh_rotated', 'client_refresh_sentinel_only',
      ]) || concurrent.status !== 'passed' || !isCount(concurrent.callers) || concurrent.callers !== initial.callers ||
      !isCount(concurrent.broker_refresh_attempts) || concurrent.broker_refresh_attempts < 2 ||
      !isCount(concurrent.broker_refresh_max_in_flight) || concurrent.broker_refresh_max_in_flight < 2 ||
      concurrent.provider_refresh_requests !== 1 || concurrent.provider_refresh_max_in_flight !== 1 ||
      !isCount(concurrent.rotated_access_callers) || concurrent.rotated_access_callers !== concurrent.callers ||
      concurrent.stored_access_rotated !== true || concurrent.stored_refresh_rotated !== true || concurrent.client_refresh_sentinel_only !== true ||
      !isObject(persistence) || !hasOnlyKeys(persistence, ['status', 'reopened_access_callers', 'provider_refresh_requests_before', 'provider_refresh_requests_after']) ||
      persistence.status !== 'passed' || !isCount(persistence.reopened_access_callers) || persistence.reopened_access_callers < 1 ||
      persistence.provider_refresh_requests_before !== 1 || persistence.provider_refresh_requests_after !== 1 ||
      !isObject(transient) || !hasOnlyKeys(transient, [
        'status', 'endpoint_503_responses', 'broker_error_status', 'get_api_key_unavailable', 'stored_row_active', 'stored_row_unchanged',
      ]) || transient.status !== 'passed' || !isCount(transient.endpoint_503_responses) || transient.endpoint_503_responses < 1 ||
      transient.broker_error_status !== 500 || transient.get_api_key_unavailable !== true || transient.stored_row_active !== true || transient.stored_row_unchanged !== true ||
      !isObject(cleanup) || !hasOnlyKeys(cleanup, ['status']) || cleanup.status !== 'complete') return undefined;
  return {
    initial_valid: initial as unknown as OAuthRefreshCases['initial_valid'],
    concurrent_expiry_refresh: concurrent as unknown as OAuthRefreshCases['concurrent_expiry_refresh'],
    persistence_reopen: persistence as unknown as OAuthRefreshCases['persistence_reopen'],
    transient_error: transient as unknown as OAuthRefreshCases['transient_error'],
  };
}

function parseFixtureOutput(stdout: string): OAuthRefreshCases | undefined {
  const lines = stdout.split(/\r?\n/u).filter(line => line.startsWith(FIXTURE_RECEIPT_PREFIX));
  if (lines.length !== 1) return undefined;
  try {
    return validateCases(JSON.parse(lines[0]!.slice(FIXTURE_RECEIPT_PREFIX.length)) as unknown);
  } catch {
    return undefined;
  }
}

function passedReceipt(bunVersion: string, cases: OAuthRefreshCases): OAuthRefreshReceipt {
  return {
    ok: true,
    kind: 'native-oauth-refresh-component-integration',
    status: 'passed',
    native_package: { name: '@oh-my-pi/pi-ai', version: EXPECTED_NATIVE_VERSION, provenance: NATIVE_PROVENANCE },
    bun_version: bunVersion,
    integration_boundary: INTEGRATION_BOUNDARY,
    cases,
    cleanup: { status: 'complete' },
  };
}

export async function runOAuthRefreshScenario(): Promise<OAuthRefreshReceipt> {
  const preflight = preflightBun();
  if (preflight.error !== undefined) return failureReceipt(preflight.error, null, 'not_run');

  let root: string;
  try {
    root = await mkdtemp(`${tmpdir()}/omp-e2e-oauth-refresh-`);
  } catch {
    return failureReceipt({ code: 'oauth_refresh_setup_failed', message: 'Unable to create isolated OAuth refresh test state.' }, preflight.version!.text, 'not_run');
  }

  let cases: OAuthRefreshCases | undefined;
  let failed: Failure | undefined;
  let cleanup: OAuthRefreshReceipt['cleanup']['status'] = 'complete';
  try {
    await preparePrivateDirectories(root);
    const fixturePath = fileURLToPath(new URL('../assets/oauth-refresh.bun.ts', import.meta.url));
    await access(fixturePath, constants.R_OK);
    const child = await runFixture(fixturePath, root);
    if (child.timedOut) failed = { code: 'oauth_refresh_timeout', message: 'The native OAuth refresh fixture exceeded its bounded deadline.' };
    else if (child.aborted) failed = { code: 'oauth_refresh_aborted', message: 'The native OAuth refresh fixture was interrupted.' };
    else if (child.spawnFailed || child.code !== 0 || child.stdoutOverflow) {
      failed = { code: 'oauth_refresh_fixture_failed', message: 'The native OAuth refresh fixture did not complete successfully.' };
    } else {
      cases = parseFixtureOutput(child.stdout);
      if (cases === undefined) failed = { code: 'oauth_refresh_fixture_failed', message: 'The native OAuth refresh fixture did not complete successfully.' };
    }
  } catch {
    failed = { code: 'oauth_refresh_fixture_failed', message: 'The native OAuth refresh fixture did not complete successfully.' };
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      cleanup = 'failed';
    }
  }

  if (cleanup === 'failed') return failureReceipt({ code: 'oauth_refresh_cleanup_failed', message: 'Unable to remove isolated OAuth refresh test state.' }, preflight.version!.text, cleanup);
  if (failed !== undefined || cases === undefined) {
    return failureReceipt(failed ?? { code: 'oauth_refresh_fixture_failed', message: 'The native OAuth refresh fixture did not complete successfully.' }, preflight.version!.text, cleanup);
  }
  return passedReceipt(preflight.version!.text, cases);
}
