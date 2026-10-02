import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AuthStorage,
  REMOTE_REFRESH_SENTINEL,
  SqliteAuthCredentialStore,
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthCredential,
} from '@oh-my-pi/pi-ai';
import {
  AuthBrokerClient,
  AuthBrokerError,
  RemoteAuthCredentialStore,
  startAuthBroker,
  type AuthBrokerServerHandle,
} from '@oh-my-pi/pi-ai/auth-broker';

const RECEIPT_PREFIX = '@@OMP_E2E_OAUTH_REFRESH_RECEIPT@@';
const NATIVE_PACKAGE_NAME = '@oh-my-pi/pi-ai';
const NATIVE_PACKAGE_VERSION = '18.0.6';
const SUCCESS_PROVIDER = 'e2e-synthetic-oauth';
const FAILURE_PROVIDER = 'e2e-synthetic-oauth-transient-error';
const CLIENT_COUNT = 3;
const BROKER_BEARER = 'fixture-only-broker-bearer';
const ORIGINAL_ACCESS = 'fixture-original-access-value';
const ORIGINAL_REFRESH = 'fixture-original-refresh-value';
const ROTATED_ACCESS = 'fixture-rotated-access-value';
const ROTATED_REFRESH = 'fixture-rotated-refresh-value';
const FAILURE_ACCESS = 'fixture-failure-access-value';
const FAILURE_REFRESH = 'fixture-failure-refresh-value';
const CASE_DEADLINE_MS = 10_000;
const NATIVE_REFRESH_SKEW_MS = 60_000;

interface LoopbackServer {
  readonly port: number;
  stop(force?: boolean): unknown;
}

interface TestClient {
  readonly client: AuthBrokerClient;
  readonly remote: RemoteAuthCredentialStore;
  readonly auth: AuthStorage;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

let notification: (() => void) | undefined;
function notifyWaiters(): void {
  const wake = notification;
  notification = undefined;
  if (wake !== undefined) wake();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + CASE_DEADLINE_MS;
  while (!predicate()) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error('synthetic_case_deadline');
    let wake!: () => void;
    const changed = new Promise<void>(resolve => {
      wake = (): void => resolve();
      notification = wake;
    });
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('synthetic_case_deadline')), remaining);
    });
    try {
      await Promise.race([changed, deadline]);
    } finally {
      clearTimeout(timer);
      if (notification === wake) notification = undefined;
    }
  }
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('synthetic_case_deadline')), CASE_DEADLINE_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function resolveImportedPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.resolve(NATIVE_PACKAGE_NAME)));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === NATIVE_PACKAGE_NAME && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Continue toward the root of the package Bun actually resolved.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('native_package_version_unavailable');
}

function registerSyntheticProvider(id: string): void {
  registerOAuthProvider({
    id,
    name: 'E2E synthetic OAuth provider',
    login: async () => { throw new Error('synthetic_login_must_not_run'); },
    getApiKey: credentials => credentials.access,
  });
}

function makeBrokerStorage(store: SqliteAuthCredentialStore, tokenUrl: string): AuthStorage {
  return new AuthStorage(store, {
    refreshOAuthCredential: async (_provider, _credentialId, credential, signal) => {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: credential.refresh }),
        signal,
      });
      if (response.status !== 200) throw new Error(`synthetic_token_endpoint_http_${response.status}`);
      const body = await response.json() as Partial<TokenResponse>;
      if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number') {
        throw new Error('synthetic_token_endpoint_invalid_response');
      }
      return {
        access: body.access_token,
        refresh: body.refresh_token,
        expires: Date.now() + body.expires_in * 1_000,
      };
    },
  });
}

async function openClient(
  url: string,
  fetchImpl: typeof fetch,
  remoteStores: RemoteAuthCredentialStore[],
): Promise<TestClient> {
  const client = new AuthBrokerClient({ url, token: BROKER_BEARER, timeoutMs: 8_000, maxRetries: 0, fetchImpl });
  const result = await client.fetchSnapshot();
  if (result.status !== 200) throw new Error('initial_broker_snapshot_missing');
  const remote = new RemoteAuthCredentialStore({
    client,
    initialSnapshot: result.snapshot,
    streamSnapshots: false,
    backgroundIdleMs: 1_000,
  });
  remoteStores.push(remote);
  const auth = new AuthStorage(remote);
  await auth.reload();
  return { client, remote, auth };
}

function clientRefreshesAreRedacted(remoteStores: readonly RemoteAuthCredentialStore[]): boolean {
  return remoteStores.every(remote => remote.listAuthCredentials().every(row =>
    row.credential.type !== 'oauth' ||
    (row.credential.refresh === REMOTE_REFRESH_SENTINEL &&
      row.credential.refresh !== ORIGINAL_REFRESH &&
      row.credential.refresh !== ROTATED_REFRESH &&
      row.credential.refresh !== FAILURE_REFRESH)));
}

function oauthRow(store: SqliteAuthCredentialStore, provider: string, refresh: string) {
  const row = store.listAuthCredentials(provider).find(entry => entry.credential.type === 'oauth' && entry.credential.refresh === refresh);
  if (row === undefined || row.credential.type !== 'oauth') throw new Error('synthetic_oauth_row_missing');
  return row;
}

async function main(): Promise<void> {
  const importedVersion = resolveImportedPackageVersion();
  assert.equal(importedVersion, NATIVE_PACKAGE_VERSION, 'fixture must import the exact locked native package version');
  const isolatedRoot = process.env.E2E_OAUTH_REFRESH_ROOT;
  if (isolatedRoot === undefined || isolatedRoot.length === 0) throw new Error('isolated_test_root_missing');
  const workingRoot = await mkdtemp(join(isolatedRoot, 'scenario-'));

  let tokenEndpoint: LoopbackServer | undefined;
  let brokerServer: AuthBrokerServerHandle | undefined;
  let sqliteStore: SqliteAuthCredentialStore | undefined;
  const sqliteStores: SqliteAuthCredentialStore[] = [];
  const remoteStores: RemoteAuthCredentialStore[] = [];
  const successGate = Promise.withResolvers<void>();
  let cleanupFailed = false;
  let fixtureReceiptLine: string | undefined;
  let successfulRefreshRequests = 0;
  let providerFailureRequests = 0;
  let providerRefreshInFlight = 0;
  let providerRefreshMaxInFlight = 0;
  let brokerRefreshAttempts = 0;
  let brokerRefreshInFlight = 0;
  let brokerRefreshMaxInFlight = 0;

  try {
    registerSyntheticProvider(SUCCESS_PROVIDER);
    registerSyntheticProvider(FAILURE_PROVIDER);

    tokenEndpoint = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/oauth/token') return new Response(null, { status: 404 });
        let body: { refresh_token?: unknown };
        try {
          body = await request.json() as { refresh_token?: unknown };
        } catch {
          return new Response(null, { status: 400 });
        }
        if (body.refresh_token === ORIGINAL_REFRESH) {
          successfulRefreshRequests += 1;
          providerRefreshInFlight += 1;
          providerRefreshMaxInFlight = Math.max(providerRefreshMaxInFlight, providerRefreshInFlight);
          notifyWaiters();
          try {
            await successGate.promise;
            return Response.json({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3_600 });
          } finally {
            providerRefreshInFlight -= 1;
            notifyWaiters();
          }
        }
        if (body.refresh_token === FAILURE_REFRESH) {
          providerFailureRequests += 1;
          notifyWaiters();
          return Response.json({ error: 'synthetic_temporarily_unavailable' }, { status: 503 });
        }
        return new Response(null, { status: 400 });
      },
    });
    const tokenUrl = `http://127.0.0.1:${tokenEndpoint.port}/oauth/token`;

    const dbPath = join(workingRoot, 'credentials.sqlite');
    sqliteStore = await SqliteAuthCredentialStore.open(dbPath);
    sqliteStores.push(sqliteStore);
    const originalCredential: OAuthCredential = {
      type: 'oauth',
      access: ORIGINAL_ACCESS,
      refresh: ORIGINAL_REFRESH,
      expires: Date.now() + 3_600_000,
      accountId: 'synthetic-success-account',
    };
    sqliteStore.upsertAuthCredentialForProvider(SUCCESS_PROVIDER, originalCredential);
    const originalRow = oauthRow(sqliteStore, SUCCESS_PROVIDER, ORIGINAL_REFRESH);
    let brokerStorage = makeBrokerStorage(sqliteStore, tokenUrl);
    await brokerStorage.reload();
    brokerServer = startAuthBroker({
      storage: brokerStorage,
      bind: '127.0.0.1:0',
      bearerTokens: [BROKER_BEARER],
      disableRefresher: true,
    });

    const trackedFetch: typeof fetch = async (input, init) => {
      const inputUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const url = new URL(inputUrl);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'POST' && /^\/v1\/credential\/\d+\/refresh$/u.test(url.pathname)) {
        brokerRefreshAttempts += 1;
        brokerRefreshInFlight += 1;
        brokerRefreshMaxInFlight = Math.max(brokerRefreshMaxInFlight, brokerRefreshInFlight);
        notifyWaiters();
        try {
          return await globalThis.fetch(input, init);
        } finally {
          brokerRefreshInFlight -= 1;
          notifyWaiters();
        }
      }
      return globalThis.fetch(input, init);
    };

    const initialClients: TestClient[] = [];
    for (let index = 0; index < CLIENT_COUNT; index += 1) {
      initialClients.push(await openClient(brokerServer.url, trackedFetch, remoteStores));
    }
    const originalKeys = await withDeadline(Promise.all(initialClients.map(client => client.auth.getApiKey(SUCCESS_PROVIDER))));
    assert.deepEqual(originalKeys, Array(CLIENT_COUNT).fill(ORIGINAL_ACCESS), 'all clients must consume original access before expiry');
    assert.equal(successfulRefreshRequests, 0, 'valid credentials must not call the synthetic token endpoint');
    assert.equal(providerFailureRequests, 0);
    assert.equal(clientRefreshesAreRedacted(remoteStores), true, 'remote snapshots must contain only the refresh sentinel');

    // AuthStorage refreshes inside a native 60-second skew; mutate only this synthetic row's expiry.
    const forcedExpiry = Date.now() + NATIVE_REFRESH_SKEW_MS - 1;
    sqliteStore.updateAuthCredential(originalRow.id, { ...originalCredential, expires: forcedExpiry });
    const expiredCredential = oauthRow(sqliteStore, SUCCESS_PROVIDER, ORIGINAL_REFRESH).credential;
    assert.equal(expiredCredential.type, 'oauth');
    assert.equal(expiredCredential.access, originalCredential.access, 'expiry change must preserve access');
    assert.equal(expiredCredential.refresh, originalCredential.refresh, 'expiry change must preserve refresh');
    assert.equal(expiredCredential.expires, forcedExpiry);
    await brokerStorage.reload();
    await Promise.all(initialClients.map(async client => {
      await client.remote.refreshSnapshot();
      await client.auth.reload();
    }));

    const pendingKeys = initialClients.map(client => client.auth.getApiKey(SUCCESS_PROVIDER));
    await waitFor(() => successfulRefreshRequests >= 1 && brokerRefreshInFlight === CLIENT_COUNT);
    assert.equal(successfulRefreshRequests, 1, 'one concurrent wave must issue exactly one provider refresh POST');
    assert.equal(providerRefreshInFlight, 1, 'the controlled provider response must remain gated');
    assert.equal(brokerRefreshInFlight, CLIENT_COUNT, 'all independent clients must overlap native broker refresh HTTP requests');
    successGate.resolve();
    const rotatedKeys = await withDeadline(Promise.all(pendingKeys));
    assert.deepEqual(rotatedKeys, Array(CLIENT_COUNT).fill(ROTATED_ACCESS), 'every caller must consume rotated access');

    const storedRotation = oauthRow(sqliteStore, SUCCESS_PROVIDER, ROTATED_REFRESH).credential;
    assert.equal(storedRotation.type, 'oauth');
    assert.equal(storedRotation.access, ROTATED_ACCESS, 'native SQLite must persist rotated access');
    assert.equal(storedRotation.refresh, ROTATED_REFRESH, 'native SQLite must persist rotated refresh');
    assert.equal(clientRefreshesAreRedacted(remoteStores), true, 'clients must never receive the real refresh token');
    const concurrentCases = {
      status: 'passed' as const,
      callers: CLIENT_COUNT,
      broker_refresh_attempts: brokerRefreshAttempts,
      broker_refresh_max_in_flight: brokerRefreshMaxInFlight,
      provider_refresh_requests: successfulRefreshRequests,
      provider_refresh_max_in_flight: providerRefreshMaxInFlight,
      rotated_access_callers: rotatedKeys.filter(key => key === ROTATED_ACCESS).length,
      stored_access_rotated: storedRotation.access === ROTATED_ACCESS,
      stored_refresh_rotated: storedRotation.refresh === ROTATED_REFRESH,
      client_refresh_sentinel_only: clientRefreshesAreRedacted(remoteStores),
    };

    for (const remote of remoteStores) remote.close();
    remoteStores.length = 0;
    await brokerServer.close();
    brokerServer = undefined;
    sqliteStore.close();
    const oldStoreIndex = sqliteStores.indexOf(sqliteStore);
    if (oldStoreIndex >= 0) sqliteStores.splice(oldStoreIndex, 1);

    const successfulRequestsBeforeReopen = successfulRefreshRequests;
    sqliteStore = await SqliteAuthCredentialStore.open(dbPath);
    sqliteStores.push(sqliteStore);
    brokerStorage = makeBrokerStorage(sqliteStore, tokenUrl);
    await brokerStorage.reload();
    const reopenedCredential = oauthRow(sqliteStore, SUCCESS_PROVIDER, ROTATED_REFRESH).credential;
    assert.equal(reopenedCredential.type, 'oauth');
    assert.equal(reopenedCredential.access, ROTATED_ACCESS, 'reopened SQLite must preserve rotated access');
    assert.equal(reopenedCredential.refresh, ROTATED_REFRESH, 'reopened SQLite must preserve rotated refresh');
    brokerServer = startAuthBroker({
      storage: brokerStorage,
      bind: '127.0.0.1:0',
      bearerTokens: [BROKER_BEARER],
      disableRefresher: true,
    });
    const reopenedClient = await openClient(brokerServer.url, trackedFetch, remoteStores);
    const reopenedKey = await withDeadline(reopenedClient.auth.getApiKey(SUCCESS_PROVIDER));
    assert.equal(reopenedKey, ROTATED_ACCESS, 'fresh native client must reuse the persisted rotated access');
    assert.equal(successfulRefreshRequests, successfulRequestsBeforeReopen, 'reopen and reuse must not cause another refresh');
    assert.equal(clientRefreshesAreRedacted(remoteStores), true);
    const persistenceCases = {
      status: 'passed' as const,
      reopened_access_callers: 1,
      provider_refresh_requests_before: successfulRequestsBeforeReopen,
      provider_refresh_requests_after: successfulRefreshRequests,
    };

    const failureCredential: OAuthCredential = {
      type: 'oauth',
      access: FAILURE_ACCESS,
      refresh: FAILURE_REFRESH,
      expires: Date.now() + NATIVE_REFRESH_SKEW_MS - 1,
      accountId: 'synthetic-transient-error-account',
    };
    sqliteStore.upsertAuthCredentialForProvider(FAILURE_PROVIDER, failureCredential);
    const failureRow = oauthRow(sqliteStore, FAILURE_PROVIDER, FAILURE_REFRESH);
    await brokerStorage.reload();
    const failureClient = await openClient(brokerServer.url, trackedFetch, remoteStores);
    const storedBeforeFailure = oauthRow(sqliteStore, FAILURE_PROVIDER, FAILURE_REFRESH).credential;
    let brokerErrorStatus = 0;
    try {
      await failureClient.client.refreshCredential(failureRow.id);
    } catch (error) {
      if (error instanceof AuthBrokerError) brokerErrorStatus = error.status ?? 0;
    }
    assert.equal(brokerErrorStatus, 500, 'native broker client must receive the transient provider refresh error');
    const unavailableKey = await withDeadline(failureClient.auth.getApiKey(FAILURE_PROVIDER));
    assert.equal(unavailableKey, undefined, 'transient failure must not return stale access or an environment fallback');
    const storedAfterFailure = sqliteStore.listAuthCredentials(FAILURE_PROVIDER).find(entry => entry.id === failureRow.id);
    assert.ok(storedAfterFailure, 'transient failure must leave its credential active');
    assert.equal(storedAfterFailure.disabledCause, null);
    assert.deepEqual(storedAfterFailure.credential, storedBeforeFailure, 'transient failure must not overwrite stored credentials');
    assert.ok(providerFailureRequests >= 1, 'the local synthetic token endpoint must answer HTTP 503');
    const transientCases = {
      status: 'passed' as const,
      endpoint_503_responses: providerFailureRequests,
      broker_error_status: brokerErrorStatus,
      get_api_key_unavailable: unavailableKey === undefined,
      stored_row_active: storedAfterFailure.disabledCause === null,
      stored_row_unchanged: JSON.stringify(storedAfterFailure.credential) === JSON.stringify(storedBeforeFailure),
    };

    const fixtureReceipt = {
      native_package_version: importedVersion,
      initial_valid: {
        status: 'passed' as const,
        callers: CLIENT_COUNT,
        original_access_callers: originalKeys.filter(key => key === ORIGINAL_ACCESS).length,
        refresh_requests: 0,
      },
      concurrent_expiry_refresh: concurrentCases,
      persistence_reopen: persistenceCases,
      transient_error: transientCases,
      cleanup: { status: 'complete' as const },
    };
    const serializedReceipt = JSON.stringify(fixtureReceipt);
    for (const secret of [ORIGINAL_ACCESS, ORIGINAL_REFRESH, ROTATED_ACCESS, ROTATED_REFRESH, FAILURE_ACCESS, FAILURE_REFRESH, BROKER_BEARER]) {
      assert.equal(serializedReceipt.includes(secret), false, 'receipt must omit credentials and bearer material');
    }

    fixtureReceiptLine = `${RECEIPT_PREFIX}${serializedReceipt}\n`;
  } finally {
    successGate.resolve();
    for (const remote of remoteStores.splice(0)) {
      try { remote.close(); } catch { cleanupFailed = true; }
    }
    if (brokerServer !== undefined) {
      try { await brokerServer.close(); } catch { cleanupFailed = true; }
    }
    for (const store of sqliteStores.splice(0)) {
      try { store.close(); } catch { cleanupFailed = true; }
    }
    if (tokenEndpoint !== undefined) {
      try { await Promise.resolve(tokenEndpoint.stop(true)); } catch { cleanupFailed = true; }
    }
    unregisterOAuthProvider(SUCCESS_PROVIDER);
    unregisterOAuthProvider(FAILURE_PROVIDER);
    try {
      await rm(workingRoot, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw new Error('synthetic_cleanup_failed');
  }

  if (fixtureReceiptLine === undefined) throw new Error('synthetic_receipt_missing');
  process.stdout.write(fixtureReceiptLine);
}

main().catch(() => {
  process.stderr.write('native OAuth refresh fixture failed\n');
  process.exitCode = 1;
});
