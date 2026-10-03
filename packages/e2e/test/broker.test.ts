import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deferred } from '../src/util.js';
import type { RunManifest } from '../src/manifest.js';
import {
  ensureManagedBroker,
  hostAuthProfileFingerprint,
  managedBrokerStatus,
  readManagedBrokerToken,
  stopManagedBroker,
} from '../src/broker.js';

const TOKEN = 'fixture-native-broker-token';

function runRoots(stateRoot: string, runId: string): RunManifest['roots'] {
  const run = join(stateRoot, 'runs', runId);
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

function processStartMarker(pid: number): string {
  const psBinary = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps';
  const result = spawnSync(psBinary, ['-ww', '-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw result.error ?? new Error('fixture could not inspect its process start marker');
  }
  const marker = result.stdout.trim();
  if (marker.length === 0) throw new Error('fixture process start marker was empty');
  return marker;
}

function spawnBrokerOwner(manifest: RunManifest): ChildProcess {
  const helper = fileURLToPath(new URL('./fixtures/broker-owner.ts', import.meta.url));
  return spawn(process.execPath, ['--import', 'tsx', helper, JSON.stringify(manifest)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function waitForBrokerOwnerReady(owner: ChildProcess): Promise<void> {
  const stdout = owner.stdout;
  if (stdout === null) return Promise.reject(new Error('broker owner has no stdout pipe'));
  const ready = deferred<void>();
  let settled = false;
  let output = '';
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    stdout.off('data', onData);
    ready.reject(error);
  };
  const onData = (chunk: Buffer | string): void => {
    if (settled) return;
    output += chunk.toString();
    const newline = output.indexOf('\n');
    if (newline < 0) return;
    try {
      const message: unknown = JSON.parse(output.slice(0, newline));
      if (message === null || typeof message !== 'object' || !('ready' in message) || message.ready !== true) {
        fail(new Error('broker owner failed before readiness'));
        return;
      }
      settled = true;
      stdout.off('data', onData);
      ready.resolve();
    } catch (error) {
      fail(error instanceof Error ? error : new Error('broker owner sent invalid readiness data'));
    }
  };
  stdout.setEncoding('utf8');
  stdout.on('data', onData);
  owner.once('error', fail);
  owner.once('exit', (code, signal) => fail(new Error(`broker owner exited before readiness (${String(code ?? signal)})`)));
  return ready.promise;
}

async function stopBrokerOwner(owner: ChildProcess): Promise<void> {
  if (owner.exitCode !== null || owner.signalCode !== null) return;
  const exited = deferred<void>();
  owner.once('exit', code => {
    if (code === 0) exited.resolve();
    else exited.reject(new Error(`broker owner cleanup exited with ${String(code)}`));
  });
  if (owner.stdin === null) owner.kill('SIGTERM');
  else owner.stdin.end();
  await exited.promise;
}

function waitForProcessAbsentByPs(pid: number): void {
  const psBinary = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = spawnSync(psBinary, ['-ww', '-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      timeout: 1_000,
    });
    if (result.error !== undefined) throw result.error;
    if (result.signal !== null) throw new Error('fixture ps process was interrupted');
    if (result.status !== 0 || result.stdout.trim().length === 0) return;
    // The separate owner must reap this real child; zombie status is not enough.
  }
  throw new Error('fixture process remained visible after the owner should have reaped it');
}

function spawnLiveClient(): Promise<ChildProcess> {
  const pending = deferred<ChildProcess>();
  const client = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  client.once('spawn', () => pending.resolve(client));
  client.once('error', error => pending.reject(error));
  return pending.promise;
}

async function stopLiveClient(client: ChildProcess): Promise<void> {
  if (client.exitCode !== null || client.signalCode !== null) return;
  const exited = deferred<void>();
  client.once('exit', () => exited.resolve());
  client.kill('SIGTERM');
  await exited.promise;
}

function externalRunManifest(fx: Fixture, runId: string): RunManifest {
  const roots = runRoots(fx.stateRoot, runId);
  return {
    ...fx.manifest,
    run_id: runId,
    status: 'running',
    roots,
    scenario: { ...fx.manifest.scenario, path: join(roots.run, 'scenario.json') },
    sessions: [],
  };
}

function writeExternalLiveSession(
  fx: Fixture,
  runId: string,
  sessionId: string,
  clientPid: number,
): { recordPath: string; record: Record<string, unknown> } {
  const manifest = externalRunManifest(fx, runId);
  const roots = manifest.roots;
  const sessionRoot = join(roots.sessions, sessionId);
  const leaseMarker = 'external-session-lease';
  const startMarker = processStartMarker(clientPid);
  const ownerNonce = `${runId}:${sessionId}:${leaseMarker}`;
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  mkdirSync(roots.private, { recursive: true, mode: 0o700 });

  const leasePath = join(roots.private, 'run.active.lock');
  writeFileSync(leasePath, `${JSON.stringify({
    run_id: runId,
    session_id: sessionId,
    pid: process.pid,
    marker: leaseMarker,
    acquired_at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  chmodSync(leasePath, 0o600);

  const record: Record<string, unknown> = {
    id: sessionId,
    status: 'running',
    pid: clientPid,
    start_marker: startMarker,
    process: {
      pid: clientPid,
      pgid: null,
      start_marker: startMarker,
      executable_digest: fx.manifest.runtime.digest,
      argv_digest: 'f'.repeat(64),
      cwd_relative: '.',
      owner_nonce: ownerNonce,
    },
    transcript_path: join(roots.sessions, sessionId, 'transcript.jsonl'),
    log_path: join(roots.logs, `${sessionId}.log`),
    private_connection_path: join(roots.private, 'sessions', sessionId, 'connection.json'),
    started_at: new Date().toISOString(),
    lease_marker: leaseMarker,
    ready: true,
  };
  const recordPath = join(sessionRoot, 'session.json');
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(recordPath, 0o600);

  const manifestPath = join(roots.run, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return { recordPath, record };
}


function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function freePort(): Promise<number> {
  const pending = deferred<number>();
  const server = createServer();
  server.once('error', error => pending.reject(error));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close(() => pending.reject(new Error('fixture did not expose a TCP port')));
      return;
    }
    const port = address.port;
    server.close(error => error === undefined ? pending.resolve(port) : pending.reject(error));
  });
  return pending.promise;
}

function fakeRuntimeScript(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'omp-native-broker-fixture 1.0.0\\n'
  exit 0
fi
if [ "$1" != "auth-broker" ] || [ "$2" != "serve" ]; then exit 2; fi
node -e '
const http = require("http");
const fs = require("fs");
const path = require("path");
const bind = process.argv[1].slice("--bind=".length);
const token = fs.readFileSync(path.join(process.env.HOME, ".omp", "auth-broker.token"), "utf8").trim();
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (typeof agentDir === "string") {
  fs.mkdirSync(agentDir, {recursive:true});
  fs.writeFileSync(path.join(agentDir, "broker-profile-resolution.json"), JSON.stringify({agent_dir:agentDir,cwd:process.cwd()}));
}
const server = http.createServer((req, res) => {
  if (req.url === "/v1/healthz") {
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify({ok:true,version:"fixture"}));
    return;
  }
  if (req.url === "/v1/credentials/disabled") {
    res.writeHead(req.headers.authorization === "Bearer " + token ? 404 : 401);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
const [host, port] = bind.split(":");
server.listen(Number(port), host);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
' -- "$3" &
wait
`;
}

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly stateRoot: string;
  readonly binary: string;
  readonly manifest: RunManifest;
  readonly previous: Readonly<Record<string, string | undefined>>;
  cleanup(): void;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'omp-e2e-native-broker-'));
  const home = join(root, 'home');
  const stateRoot = join(root, 'e2e-state');
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(join(home, '.omp', 'agent'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const tokenPath = join(home, '.omp', 'auth-broker.token');
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const binary = join(runtimeRoot, 'omp-fixture.sh');
  writeFileSync(binary, fakeRuntimeScript(), { mode: 0o700 });
  chmodSync(binary, 0o700);

  const keys = ['HOME', 'OMP_E2E_ROOT', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) previous[key] = process.env[key];
  process.env.HOME = home;
  process.env.OMP_E2E_ROOT = stateRoot;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.XDG_CACHE_HOME;
  const port = await freePort();
  const profileFingerprint = hostAuthProfileFingerprint();
  const roots = runRoots(stateRoot, 'broker-fixture-run');
  mkdirSync(roots.run, { recursive: true, mode: 0o700 });
  const manifest = {
    schema_version: 1,
    run_id: 'broker-fixture-run',
    input_digest: 'a'.repeat(64),
    status: 'ready',
    runtime: { binary, version: 'fixture', digest: digestFile(binary), platform: process.platform },
    artifacts: { core: { root: join(root, 'core'), digest: 'b'.repeat(64) }, fullstack: { root: join(root, 'fullstack'), digest: 'c'.repeat(64) } },
    roots,
    auth: { mode: 'native-host-broker', provider: 'openai-codex', start_local: true, bind: `127.0.0.1:${port}`, profile_fingerprint: profileFingerprint },
    model: 'openai-codex/fixture-model',
    scenario: { id: 'fixture', path: join(roots.run, 'scenario.json'), digest: 'd'.repeat(64) },
    sessions: [],
  } as unknown as RunManifest;
  return {
    root,
    home,
    stateRoot,
    binary,
    manifest,
    previous,
    cleanup: () => {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('native host broker starts once, reuses, and keeps the host token private', async t => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const started = await ensureManagedBroker(fx.manifest);
  assert.equal(started.status, 'started');
  assert.equal(started.provider, 'openai-codex');
  assert.equal(started.token, TOKEN);
  assert.equal(readManagedBrokerToken(fx.manifest), TOKEN);
  const tokenStat = lstatSync(join(fx.home, '.omp', 'auth-broker.token'));
  assert.equal(tokenStat.mode & 0o777, 0o600);
  assert.equal(await managedBrokerStatus(fx.manifest).then(result => result.status), 'running');

  const reused = await ensureManagedBroker(fx.manifest);
  assert.equal(reused.status, 'reused');
  assert.equal(reused.url, started.url);
  assert.equal(reused.token, TOKEN);

  const managerFiles = readdirSync(join(fx.stateRoot, 'broker-manager'));
  for (const file of managerFiles) {
    assert.equal(readFileSync(join(fx.stateRoot, 'broker-manager', file), 'utf8').includes(TOKEN), false);
  }
  await stopManagedBroker(fx.manifest);
  assert.equal(await managedBrokerStatus(fx.manifest).then(result => result.status), 'stopped');
  assert.equal(readManagedBrokerToken(fx.manifest), TOKEN);
});

test('native host broker safely cleans a gracefully exited receipt and refuses a live reused PID', async t => {
  const fx = await fixture();
  t.after(async () => {
    try {
      await stopManagedBroker(fx.manifest);
    } finally {
      fx.cleanup();
    }
  });

  await ensureManagedBroker(fx.manifest);
  const managerRoot = join(fx.stateRoot, 'broker-manager');
  const receiptName = readdirSync(managerRoot).find(file => file.endsWith('.receipt.json'));
  assert.ok(receiptName !== undefined);
  const receiptPath = join(managerRoot, receiptName);
  const originalReceiptText = readFileSync(receiptPath, 'utf8');
  const originalReceipt = JSON.parse(originalReceiptText) as Record<string, unknown>;
  const pid = originalReceipt.pid;
  const pgid = originalReceipt.pgid;
  const startMarker = originalReceipt.start_marker;
  assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
  assert.ok(typeof pgid === 'number' && pgid === pid);
  assert.ok(typeof startMarker === 'string');
  assert.equal(processStartMarker(pid), startMarker);

  process.kill(-pgid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  // This detached OS process has no child exit event in the test; poll its
  // actual manager status rather than simulating process lifetime with timers.
  let stopped = false;
  while (Date.now() < deadline) {
    if ((await managedBrokerStatus(fx.manifest)).status === 'stopped') {
      stopped = true;
      break;
    }
    await delay(25);
  }
  assert.equal(stopped, true, 'graceful broker exit should release its listener');

  // A live PID with different identity is not a stale receipt, even after
  // the original listener has disappeared. Never signal or discard it.
  const reusedReceipt = { ...originalReceipt, pid: process.pid };
  writeFileSync(receiptPath, `${JSON.stringify(reusedReceipt)}\n`, { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  await assert.rejects(
    () => stopManagedBroker(fx.manifest),
    error => error instanceof Error && 'code' in error && error.code === 'broker_stop_identity_changed',
  );
  const retainedReceipt: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.ok(retainedReceipt !== null && typeof retainedReceipt === 'object' && 'pid' in retainedReceipt);
  assert.equal(retainedReceipt.pid, process.pid);

  writeFileSync(receiptPath, originalReceiptText, { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  await stopManagedBroker(fx.manifest);
  await stopManagedBroker(fx.manifest);
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'stopped');
  assert.equal(readdirSync(managerRoot).includes(receiptName), false);
});

test('native host broker stop succeeds when an owned target exits between liveness and ps checks', async t => {
  const fx = await fixture();
  let owner: ChildProcess | undefined;
  t.after(async () => {
    try {
      if (owner === undefined) await stopManagedBroker(fx.manifest);
      else await stopBrokerOwner(owner);
    } finally {
      fx.cleanup();
    }
  });

  owner = spawnBrokerOwner(fx.manifest);
  await waitForBrokerOwnerReady(owner);
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'running');
  const managerRoot = join(fx.stateRoot, 'broker-manager');
  const receiptName = readdirSync(managerRoot).find(file => file.endsWith('.receipt.json'));
  assert.ok(receiptName !== undefined);
  const receipt = JSON.parse(readFileSync(join(managerRoot, receiptName), 'utf8')) as Record<string, unknown>;
  const pid = receipt.pid;
  const pgid = receipt.pgid;
  const startMarker = receipt.start_marker;
  assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
  assert.ok(typeof pgid === 'number' && pgid === pid);
  assert.ok(typeof startMarker === 'string');
  assert.equal(processStartMarker(pid), startMarker);

  const realKill = process.kill.bind(process);
  // Freeze this verified OS group until stop sends SIGTERM, then force an
  // actual exit after kill(0) succeeds but before the next ps observation.
  // A separate live parent reaps the broker while this test waits synchronously.
  realKill(-pgid, 'SIGSTOP');
  let termDelivered = false;
  let exitForcedDuringProbe = false;
  t.mock.method(process, 'kill', (target, signal) => {
    const result = realKill(target, signal);
    if (target === -pgid && signal === 'SIGTERM' && result) {
      termDelivered = true;
    } else if (termDelivered && !exitForcedDuringProbe && target === pid && signal === 0 && result) {
      exitForcedDuringProbe = true;
      realKill(-pgid, 'SIGKILL');
      waitForProcessAbsentByPs(pid);
    }
    return result;
  });

  try {
    await stopManagedBroker(fx.manifest);
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(termDelivered, true, 'stop must signal the receipt-verified broker process group');
  assert.equal(exitForcedDuringProbe, true, 'the actual target must disappear after a successful kill(0) result');
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'stopped');
  await stopManagedBroker(fx.manifest);
  assert.equal(readdirSync(managerRoot).includes(receiptName), false);
});

test('native host broker resolves a relative coding-agent directory before changing cwd', async t => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const configuredRelative = relative(process.cwd(), join(fx.root, 'relative-agent'));
  const expectedAgentDir = resolve(configuredRelative);
  process.env.PI_CODING_AGENT_DIR = configuredRelative;
  const manifest = {
    ...fx.manifest,
    auth: {
      ...fx.manifest.auth,
      profile_fingerprint: hostAuthProfileFingerprint(),
    },
  } as RunManifest;
  const started = await ensureManagedBroker(manifest);
  assert.equal(started.status, 'started');
  const observedPath = join(expectedAgentDir, 'broker-profile-resolution.json');
  const observed = JSON.parse(readFileSync(observedPath, 'utf8')) as { agent_dir?: string; cwd?: string };
  assert.equal(observed.agent_dir, expectedAgentDir);
  assert.equal(realpathSync(observed.cwd ?? ''), realpathSync(resolve(fx.stateRoot, 'broker-manager')));
  await stopManagedBroker(manifest);
});

test('concurrent clients for a controlled host profile share one broker manager', async t => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const results = await Promise.all([
    ensureManagedBroker(fx.manifest),
    ensureManagedBroker(fx.manifest),
    ensureManagedBroker(fx.manifest),
  ]);
  assert.equal(results.filter(result => result.status === 'started').length, 1);
  assert.equal(results.filter(result => result.status === 'reused').length, 2);
  assert.equal(new Set(results.map(result => result.url)).size, 1);
  await stopManagedBroker(fx.manifest);
});

test('native host broker refuses an occupied unowned loopback listener', async t => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const server = createServer((_request, response) => { response.writeHead(200); response.end(); });
  const listening = deferred<void>();
  server.once('error', error => listening.reject(error));
  server.listen(Number(fx.manifest.auth.bind.split(':')[1]), '127.0.0.1', () => listening.resolve());
  await listening.promise;
  t.after(() => {
    const closed = deferred<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'unowned');
});

test('native host broker refuses a spoofed manager receipt without killing the broker', async t => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  await ensureManagedBroker(fx.manifest);
  const managerRoot = join(fx.stateRoot, 'broker-manager');
  const receiptPath = readdirSync(managerRoot).find(file => file.endsWith('.receipt.json'));
  assert.ok(receiptPath !== undefined);
  const path = join(managerRoot, receiptPath);
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  receipt.executable_digest = 'e'.repeat(64);
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'failed');
  await assert.rejects(() => stopManagedBroker(fx.manifest), error => (error as { code?: string }).code === 'broker_receipt_mismatch');
  receipt.executable_digest = fx.manifest.runtime.digest;
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  await stopManagedBroker(fx.manifest);
});

test('native host broker stays up for an unlisted live session in another run', async t => {
  const fx = await fixture();
  let client: ChildProcess | undefined;
  t.after(async () => {
    try {
      if (client !== undefined) await stopLiveClient(client);
      try {
        await stopManagedBroker(fx.manifest);
      } catch {
        /* preserve the test result if cleanup cannot stop the broker */
      }
    } finally {
      fx.cleanup();
    }
  });
  await ensureManagedBroker(fx.manifest);
  const liveClient = await spawnLiveClient();
  client = liveClient;
  if (liveClient.pid === undefined) throw new Error('fixture client did not expose a process id');
  writeExternalLiveSession(fx, 'external-broker-run', 'session-live', liveClient.pid);

  await assert.rejects(
    () => stopManagedBroker(fx.manifest),
    error => (error as { code?: string }).code === 'broker_clients_live',
  );
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'running');

  await stopLiveClient(liveClient);
  rmSync(join(fx.stateRoot, 'runs', 'external-broker-run'), { recursive: true, force: true });
  await stopManagedBroker(fx.manifest);
  assert.equal((await managedBrokerStatus(fx.manifest)).status, 'stopped');
});
