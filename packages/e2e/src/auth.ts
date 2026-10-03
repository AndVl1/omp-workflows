import type { RunManifest } from './manifest.js';
import { EnvironmentRefusalError, manifestRoots, pathContained } from './environment.js';
import { ensureManagedBroker } from './broker.js';

export type AuthMode = 'none' | 'api-key-env' | 'broker' | 'native-host-broker';

export interface AuthResolution {
  readonly mode: AuthMode;
  readonly env: Readonly<Record<string, string>>;
  readonly redacted: Readonly<Record<string, unknown>>;
  readonly refreshOwnership: 'not-applicable' | 'verified' | 'unverified';
}

export interface AuthReadiness {
  readonly ok: boolean;
  readonly mode: AuthMode | null;
  readonly code: string;
  readonly message: string;
  readonly redacted?: Readonly<Record<string, unknown>>;
}

export interface AuthResolutionOptions {
  /** Secret values are read only from these explicitly selected names. */
  readonly secretEnv?: Readonly<Record<string, string | undefined>>;
  readonly providerRequired?: boolean;
  readonly requireRefreshOwnership?: boolean;
}

export class AuthRefusalError extends EnvironmentRefusalError {
  readonly authCode: string;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(code, message, details);
    this.name = 'AuthRefusalError';
    this.authCode = code;
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function stringListField(value: Record<string, unknown>, names: readonly string[]): string[] {
  const references = value.keys;
  if (Array.isArray(references)) {
    const namesFromReferences = references
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      .map(entry => entry.env_name)
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (namesFromReferences.length > 0) return namesFromReferences;
  }
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === 'string' && candidate.length > 0) return [candidate];
    if (Array.isArray(candidate)) {
      const result = candidate.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      if (result.length > 0) return result;
    }
  }
  return [];
}

function variableName(value: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new AuthRefusalError('invalid_auth_config', `${field} is not a valid environment variable name`, { field });
  }
  return value;
}

function modeOf(manifest: RunManifest): AuthMode {
  const auth = objectOf((manifest as unknown as { auth?: unknown }).auth);
  const mode = auth.mode;
  if (mode === 'none' || mode === 'api-key-env' || mode === 'broker' || mode === 'native-host-broker') return mode;
  throw new AuthRefusalError('invalid_auth_mode', 'manifest auth.mode is unsupported');
}

function authDetails(manifest: RunManifest): Record<string, unknown> {
  const auth = objectOf((manifest as unknown as { auth?: unknown }).auth);
  const nested = objectOf(auth.config ?? auth.broker ?? auth.api_key ?? auth.apiKey);
  return { ...auth, ...nested };
}

function providerRequiredByManifest(manifest: RunManifest): boolean {
  const model = (manifest as unknown as { model?: unknown }).model;
  const auth = objectOf((manifest as unknown as { auth?: unknown }).auth);
  if (auth.mode === 'none' && typeof model === 'string' && /^e2e-offline\//u.test(model)) return false;
  return model !== null && model !== undefined;
}

function secretValue(secretEnv: Readonly<Record<string, string | undefined>>, name: string, code: string): string {
  const value = secretEnv[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthRefusalError(code, `required ${name} credential is unavailable`, { env: name });
  }
  return value;
}

function brokerEndpoint(details: Record<string, unknown>): string {
  const endpoint = stringField(details, ['url', 'endpoint', 'broker_url', 'brokerUrl']);
  if (endpoint === null) {
    throw new AuthRefusalError('broker_prerequisite_missing', 'broker mode requires an explicit endpoint');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new AuthRefusalError('unsafe_broker_endpoint', 'broker endpoint is not a valid URL');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1';
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new AuthRefusalError('unsafe_broker_endpoint', 'broker endpoint must not carry credentials or query secrets');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new AuthRefusalError('unsafe_broker_endpoint', 'external broker endpoints require TLS');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function refreshOwnership(details: Record<string, unknown>): 'not-applicable' | 'verified' | 'unverified' {
  const explicit = details.refresh_owner_verified ?? details.refreshOwnershipVerified ?? details.refresh_owner;
  if (explicit === true || explicit === 'verified') return 'verified';
  if (explicit === false || explicit === 'unverified') return 'unverified';
  return 'unverified';
}

export function resolveAuthEnvironment(manifest: RunManifest, options: AuthResolutionOptions = {}): AuthResolution {
  const mode = modeOf(manifest);
  const details = authDetails(manifest);
  const secretEnv = options.secretEnv ?? process.env;
  if (mode === 'native-host-broker') {
    throw new AuthRefusalError('broker_async_check_required', 'native host broker readiness requires its managed process');
  }
  const providerRequired = options.providerRequired ?? providerRequiredByManifest(manifest);
  const env: Record<string, string> = {};
  if (mode === 'none') {
    if (providerRequired) {
      throw new AuthRefusalError('auth_required', 'provider-backed scenario cannot use auth mode none', { mode });
    }
    return {
      mode,
      env,
      redacted: { mode, provider: 'none' },
      refreshOwnership: 'not-applicable',
    };
  }
  if (mode === 'api-key-env') {
    const names = stringListField(details, ['env', 'env_var', 'key_env', 'variable', 'variables', 'env_vars', 'secret_env']);
    if (names.length === 0) {
      throw new AuthRefusalError('auth_prerequisite_missing', 'api-key-env mode requires explicit secret environment variable names');
    }
    for (const rawName of names) {
      const name = variableName(rawName, 'api-key-env');
      env[name] = secretValue(secretEnv, name, 'auth_prerequisite_missing');
    }
    return {
      mode,
      env,
      redacted: { mode, env_names: names },
      refreshOwnership: 'not-applicable',
    };
  }
  const endpoint = brokerEndpoint(details);
  const tokenNameValue = stringField(details, ['token_env', 'tokenEnv', 'broker_token_env', 'secret_env']);
  if (tokenNameValue === null) {
    throw new AuthRefusalError('broker_prerequisite_missing', 'broker mode requires an explicit token environment variable name');
  }
  const tokenName = variableName(tokenNameValue, 'broker token');
  const token = secretValue(secretEnv, tokenName, 'broker_prerequisite_missing');
  const ownership = refreshOwnership(details);
  if (providerRequired && (options.requireRefreshOwnership ?? true) && ownership !== 'verified') {
    throw new AuthRefusalError(
      'broker_refresh_owner_unverified',
      'broker refresh ownership is not confirmed; use the supported native broker setup',
      { mode, endpoint, token_env: tokenName },
    );
  }
  const roots = manifestRoots(manifest);
  const privateCache = `${roots.private}/auth-cache`;
  if (!pathContained(roots.private, privateCache)) {
    throw new AuthRefusalError('invalid_auth_cache', 'broker auth cache escaped the run private root');
  }
  env.OMP_AUTH_BROKER_URL = endpoint;
  env.OMP_AUTH_BROKER_TOKEN = token;
  env.OMP_AUTH_CACHE_DIR = privateCache;
  return {
    mode,
    env,
    redacted: { mode, endpoint, token_env: tokenName, auth_cache: privateCache, refresh_ownership: ownership },
    refreshOwnership: ownership,
  };
}

/** The host broker runs separately; only its URL and bearer cross into the isolated PTY. */
export async function resolveLaunchAuthEnvironment(manifest: RunManifest, options: AuthResolutionOptions = {}): Promise<AuthResolution> {
  if (manifest.auth.mode !== 'native-host-broker') return resolveAuthEnvironment(manifest, options);
  const managed = await ensureManagedBroker(manifest);
  return {
    mode: 'native-host-broker',
    env: { OMP_AUTH_BROKER_URL: managed.url, OMP_AUTH_BROKER_TOKEN: managed.token },
    redacted: {
      mode: 'native-host-broker',
      provider: manifest.auth.provider,
      endpoint: managed.url,
      refresh_ownership: 'broker-managed; concurrent host clients unverified',
    },
    refreshOwnership: 'unverified',
  };
}

export function checkAuthReadiness(manifest: RunManifest, options: AuthResolutionOptions = {}): AuthReadiness {
  try {
    const resolved = resolveAuthEnvironment(manifest, options);
    return {
      ok: true,
      mode: resolved.mode,
      code: 'ok',
      message: 'selected authentication transport is available',
      redacted: resolved.redacted,
    };
  } catch (error) {
    if (error instanceof AuthRefusalError) {
      const auth = objectOf((manifest as unknown as { auth?: unknown }).auth);
      const mode = auth.mode === 'none' || auth.mode === 'api-key-env' || auth.mode === 'broker' || auth.mode === 'native-host-broker' ? auth.mode : null;
      return { ok: false, mode, code: error.authCode, message: error.message };
    }
    return { ok: false, mode: null, code: 'auth_unavailable', message: 'authentication readiness could not be established' };
  }
}

/** Check native broker liveness and the selected bearer without reading credentials. */
export async function checkBrokerConnection(manifest: RunManifest, options: AuthResolutionOptions = {}): Promise<AuthReadiness> {
  let resolved: AuthResolution;
  try {
    resolved = await resolveLaunchAuthEnvironment(manifest, { ...options, requireRefreshOwnership: true });
  } catch (error) {
    if (manifest.auth.mode !== 'native-host-broker') return checkAuthReadiness(manifest, { ...options, requireRefreshOwnership: true });
    const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'broker_unavailable';
    return { ok: false, mode: 'native-host-broker', code, message: 'current omp authorization could not be connected through its managed native broker' };
  }
  if (resolved.mode !== 'broker' && resolved.mode !== 'native-host-broker') return checkAuthReadiness(manifest, options);
  const endpoint = resolved.env.OMP_AUTH_BROKER_URL;
  const token = resolved.env.OMP_AUTH_BROKER_TOKEN;
  if (endpoint === undefined || token === undefined) {
    return { ok: false, mode: resolved.mode, code: 'broker_prerequisite_missing', message: 'selected broker endpoint or token is unavailable' };
  }
  try {
    const health = await fetch(`${endpoint}/v1/healthz`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok || health.body === null) {
      return { ok: false, mode: resolved.mode, code: 'broker_unavailable', message: 'selected auth broker did not return a healthy native endpoint' };
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = health.body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 4_096) {
          return { ok: false, mode: resolved.mode, code: 'broker_unavailable', message: 'selected auth broker returned an invalid health response' };
        }
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const parsed = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as Record<string, unknown>;
    if (parsed.ok !== true) {
      return { ok: false, mode: resolved.mode, code: 'broker_unavailable', message: 'selected auth broker is not healthy' };
    }
    // The native server authenticates every route other than /v1/healthz.
    // Older brokers return 404 for this optional read-only route AFTER auth.
    const authenticated = await fetch(`${endpoint}/v1/credentials/disabled`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    await authenticated.body?.cancel();
    if (authenticated.status !== 200 && authenticated.status !== 404) {
      return { ok: false, mode: resolved.mode, code: 'broker_auth_unavailable', message: 'selected auth broker rejected the credential probe' };
    }
    return { ok: true, mode: resolved.mode, code: 'ok', message: 'selected native broker is reachable and authenticated', redacted: resolved.redacted };
  } catch {
    return { ok: false, mode: resolved.mode, code: 'broker_unavailable', message: 'selected auth broker is unavailable or did not complete its native readiness probe' };
  }
}

export function authModeOf(manifest: RunManifest): AuthMode {
  return modeOf(manifest);
}

export function providerRequiredForManifest(manifest: RunManifest): boolean {
  return providerRequiredByManifest(manifest);
}

export function redactAuthText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted.replace(/([?&](?:token|key|api[_-]?key|authorization|access_token)=)[^&\s]+/giu, '$1[REDACTED]');
}
