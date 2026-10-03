import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDetachedWorkerEnvironment } from '../src/cli.js';
import { buildChildEnvironment, sessionPaths, writeSessionRecord } from '../src/environment.js';
import { doctorRun, prepareRun } from '../src/prepare.js';
import { cleanupRun } from '../src/verify.js';
import { readManifest, writeManifest, type ProcessReceipt, type RunManifest, type SessionRecord } from '../src/manifest.js';
import { createIsolatedRunFixture } from './fixtures/isolated-run.js';
import { createPrepareRunFixture } from './fixtures/prepare-run.js';

async function withPrepareRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env['OMP_E2E_ROOT'];
  process.env['OMP_E2E_ROOT'] = root;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env['OMP_E2E_ROOT'];
    else process.env['OMP_E2E_ROOT'] = previous;
  }
}

test('isolated child process drops contaminating OMP, PI, and CLAUDE host settings', t => {
  const fixture = createIsolatedRunFixture();
  t.after(() => fixture.cleanup());

  const env = buildChildEnvironment(fixture.manifest, {
    sessionId: 'leak-probe',
    baseEnv: {
      PATH: '/host/omp/bin',
      HOME: '/host/home',
      OMP_BIN: '/host/omp',
      OMP_CONFIG: '/host/.omp/config.yml',
      OMP_PLUGINS_DIR: '/host/plugins',
      OMP_SKIP_SETUP: '0',
      PI_CODING_AGENT_DIR: '/host/.omp/agent',
      PI_AGENT_DIR: '/host/agents',
      CLAUDE_CONFIG_DIR: '/host/.claude',
      CLAUDE_CODE_HOME: '/host/claude',
      NODE_OPTIONS: '--require /host/inject.js',
      NODE_PATH: '/host/modules',
      TERM: 'xterm-256color',
    },
  });
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const observed = JSON.parse(probe.stdout) as Record<string, string | undefined>;
  for (const key of ['OMP_BIN', 'OMP_CONFIG', 'OMP_PLUGINS_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_HOME', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.equal(observed[key], undefined, `${key} did not cross the child-process boundary`);
  }
  assert.equal(observed['HOME'], fixture.manifest.roots.home);
  assert.equal(observed['PI_CODING_AGENT_DIR'], fixture.manifest.roots.agent);
  assert.equal(observed['PI_AGENT_DIR'], fixture.manifest.roots.agent);
  assert.equal(observed['OMP_HOME'], fixture.manifest.roots.home);
  assert.equal(observed['OMP_AGENT_DIR'], fixture.manifest.roots.agent);
  assert.equal(observed['OMP_PROJECT_DIR'], fixture.manifest.roots.workspace);
  assert.equal(observed['OMP_SESSION_DIR'], sessionPaths(fixture.manifest, 'leak-probe').root);
  assert.equal(observed['OMP_SKIP_SETUP'], '1', 'native onboarding cannot intercept a prepared PTY');
  assert.equal(observed['TMPDIR'], fixture.manifest.roots.tmp);
  assert.equal(observed['TMP'], fixture.manifest.roots.tmp);
  assert.equal(observed['TEMP'], fixture.manifest.roots.tmp);
  const childPath = observed['PATH'];
  assert.ok(childPath !== undefined);
  assert.equal(childPath.split(delimiter).includes('/host/omp/bin'), false);
});

test('detached worker receives only declared auth and host-profile environment', () => {
  const fixture = createIsolatedRunFixture();
  try {
    const baseEnv = {
      PATH: '/host/bin',
      HOME: '/host/home',
      TMPDIR: '/host/tmp',
      OMP_E2E_ROOT: '/host/state',
      NODE_OPTIONS: '--require /host/inject.js',
      NODE_PATH: '/host/modules',
      OMP_CONFIG: '/host/.omp/config.yml',
      OMP_PROFILE: 'host-profile',
      PI_PROFILE: 'host-pi-profile',
      PI_CODING_AGENT_DIR: 'relative-agent',
      RANDOM_HOST_SECRET: 'do-not-copy',
    };
    const noneEnv = buildDetachedWorkerEnvironment(fixture.manifest, baseEnv);
    assert.equal(noneEnv.PATH, '/host/bin');
    assert.equal(noneEnv.HOME, '/host/home');
    assert.equal(noneEnv.TMPDIR, '/host/tmp');
    assert.equal(noneEnv.OMP_E2E_ROOT, resolve(fixture.manifest.roots.run, '..', '..'));
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'OMP_CONFIG', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_DIR', 'RANDOM_HOST_SECRET']) {
      assert.equal(noneEnv[key], undefined, `${key} crossed into a detached worker`);
    }

    const apiManifest = {
      ...fixture.manifest,
      auth: {
        mode: 'api-key-env',
        keys: [{ provider: 'openai', env_name: 'OPENAI_API_KEY' }],
      },
    } as RunManifest;
    const apiEnv = buildDetachedWorkerEnvironment(apiManifest, {
      ...baseEnv,
      OPENAI_API_KEY: 'declared-secret',
    });
    assert.equal(apiEnv.OPENAI_API_KEY, 'declared-secret');
    assert.equal(apiEnv.RANDOM_HOST_SECRET, undefined);

    const nativeManifest = {
      ...fixture.manifest,
      auth: {
        mode: 'native-host-broker',
        provider: 'openai-codex',
        start_local: true,
        bind: '127.0.0.1:43123',
        profile_fingerprint: 'a'.repeat(64),
      },
    } as RunManifest;
    const nativeEnv = buildDetachedWorkerEnvironment(nativeManifest, baseEnv);
    assert.equal(nativeEnv.OMP_PROFILE, 'host-profile');
    assert.equal(nativeEnv.PI_PROFILE, 'host-pi-profile');
    assert.equal(nativeEnv.PI_CODING_AGENT_DIR, 'relative-agent');
    assert.equal(nativeEnv.OMP_CONFIG, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('prepare selects installed omp instead of npm-local checkout shim', async t => {
  const fixture = createPrepareRunFixture();
  t.after(() => fixture.cleanup());
  const localBin = join(fixture.root, 'node_modules', '.bin');
  const hostBin = join(fixture.root, 'host-bin');
  mkdirSync(localBin, { recursive: true });
  mkdirSync(hostBin);
  writeFileSync(join(localBin, 'omp'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  symlinkSync(fixture.runtimeBinary, join(hostBin, 'omp'));
  const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as { runtime: { binary: string } };
  config.runtime.binary = 'omp';
  writeFileSync(fixture.configPath, JSON.stringify(config) + '\n');

  const previousPath = process.env.PATH;
  const previousPrefix = process.env.npm_config_local_prefix;
  process.env.PATH = `${localBin}${delimiter}${hostBin}${delimiter}${previousPath ?? ''}`;
  process.env.npm_config_local_prefix = fixture.root;
  try {
    await withPrepareRoot(fixture.stateRoot, async () => {
      const result = await prepareRun(fixture.configPath, 'host-runtime');
      assert.equal(result.ok, true, result.error?.message);
      assert.equal(result.manifest?.runtime.version, '18.3.4');
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPrefix === undefined) delete process.env.npm_config_local_prefix;
    else process.env.npm_config_local_prefix = previousPrefix;
  }
});

test('standalone prepare builds through a PATH npm symlink when npm_execpath is absent', async t => {
  const npmExecPath = process.env['npm_execpath'];
  const npmCandidates = [
    ...(npmExecPath !== undefined && isAbsolute(npmExecPath) ? [npmExecPath] : []),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory =>
      join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm')),
  ];
  let npmCliPath: string | undefined;
  for (const candidate of npmCandidates) {
    try {
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isFile()) {
        npmCliPath = resolved;
        break;
      }
    } catch {
      // Try the next installed package-manager candidate.
    }
  }
  assert.ok(npmCliPath !== undefined, 'the preparation regression requires the installed npm CLI');

  const fixture = createPrepareRunFixture();
  t.after(() => fixture.cleanup());
  const coreRoot = join(fixture.root, 'packages', 'core');
  writeFileSync(join(coreRoot, 'package.json'), JSON.stringify({
    name: '@fixture/core',
    version: '1.0.0',
    type: 'module',
    files: ['dist'],
    main: './dist/index.js',
    scripts: { build: 'node build.mjs' },
  }) + '\n');
  writeFileSync(join(coreRoot, 'build.mjs'), [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "mkdirSync('dist', { recursive: true });",
    'writeFileSync("dist/index.js", \'export const coreFixture = "built-by-npm";\\n\');',
  ].join('\n') + '\n');

  const npmBin = join(fixture.root, 'npm-bin');
  mkdirSync(npmBin);
  symlinkSync(npmCliPath, join(npmBin, 'npm'));
  symlinkSync(process.execPath, join(npmBin, 'node'));
  const cli = spawnSync(process.execPath, [
    '--import', 'tsx',
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    'prepare', '--config', fixture.configPath, '--run', 'npm-path-symlink', '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // Omit npm_execpath and host auth/settings. The only npm on PATH is its
    // real CLI symlink; node is present for its shebang and the package build.
    env: { OMP_E2E_ROOT: fixture.stateRoot, PATH: npmBin },
  });
  assert.equal(cli.status, 0, `${cli.error?.message ?? ''}\n${cli.stderr}\n${cli.stdout}`);
  const payload = JSON.parse(cli.stdout) as {
    ok: boolean;
    status: string;
    manifest_path?: string;
    error?: { code?: string; message?: string };
  };
  assert.equal(payload.ok, true, JSON.stringify(payload.error));
  assert.equal(payload.status, 'ready');
  assert.ok(payload.manifest_path !== undefined);
  const manifestPath = payload.manifest_path;
  await withPrepareRoot(fixture.stateRoot, async () => {
    const manifest = readManifest(manifestPath);
    // This compiled module lives in a fresh manifest-selected cache path, so its
    // specifier is unavailable at author time; exercise the package-loading boundary.
    const builtPackage: unknown = await import(pathToFileURL(join(manifest.artifacts.core.root, 'dist', 'index.js')).href);
    assert.ok(typeof builtPackage === 'object' && builtPackage !== null && 'coreFixture' in builtPackage);
    assert.equal(builtPackage.coreFixture, 'built-by-npm');
  });
});

test('prepare refuses a changed installed runtime for an existing run', async t => {
  const fixture = createPrepareRunFixture();
  t.after(() => fixture.cleanup());

  await withPrepareRoot(fixture.stateRoot, async () => {
    const first = await prepareRun(fixture.configPath, 'runtime-conflict');
    assert.ok(first.ok, `initial prepare failed: ${first.error?.code ?? 'unknown'}`);
    assert.ok(first.manifestPath !== undefined);
    assert.ok(first.manifest !== undefined);
    const pinned = first.manifest;

    const originalScript = readFileSync(fixture.runtimeBinary, 'utf8');
    const changedScript = originalScript.replace('"no-request"', '"changed-no-request"');
    assert.notEqual(changedScript, originalScript);
    fixture.writeRuntime(changedScript);
    const conflicting = await prepareRun(fixture.configPath, 'runtime-conflict');
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.error?.code, 'run_conflict');

    const after = readManifest(first.manifestPath);
    assert.equal(after.input_digest, pinned.input_digest);
    assert.equal(after.runtime.digest, pinned.runtime.digest);
  });
});

test('prepare requires a successful typed provider-free RPC response', async t => {
  const fixture = createPrepareRunFixture();
  t.after(() => fixture.cleanup());
  const originalScript = readFileSync(fixture.runtimeBinary, 'utf8');
  const falsePositive = originalScript.replace(
    '{"id":"state","type":"response","success":true,"data":{"model":{"id":"no-request","provider":"e2e-offline"}}}',
    'no-request e2e-offline',
  );
  assert.notEqual(falsePositive, originalScript);
  fixture.writeRuntime(falsePositive);

  await withPrepareRoot(fixture.stateRoot, async () => {
    const result = await prepareRun(fixture.configPath, 'rpc-not-ready');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'prerequisite_missing');
    assert.equal(existsSync(join(fixture.stateRoot, 'runs', 'rpc-not-ready', 'manifest.json')), false);
  });
});

test('doctor rejects a cache artifact whose content changed after prepare', async t => {
  const fixture = createPrepareRunFixture();
  t.after(() => fixture.cleanup());

  await withPrepareRoot(fixture.stateRoot, async () => {
    const prepared = await prepareRun(fixture.configPath, 'cache-integrity');
    assert.ok(prepared.ok, `initial prepare failed: ${prepared.error?.code ?? 'unknown'}`);
    assert.ok(prepared.manifest !== undefined && prepared.manifestPath !== undefined);

    const artifactFile = join(prepared.manifest.artifacts.core.root, 'dist', 'index.js');
    writeFileSync(artifactFile, 'export const coreFixture = false;\n');
    const doctor = await doctorRun(prepared.manifestPath);
    assert.equal(doctor.ok, false);
    assert.equal(doctor.error?.code, 'cache_integrity_failure');
  });
});

test('cleanup refuses a live foreign PID and leaves its run workspace untouched', async t => {
  const fixture = createIsolatedRunFixture();
  t.after(() => fixture.cleanup());

  const sessionId = 'foreign-process';
  const paths = sessionPaths(fixture.manifest, sessionId);
  mkdirSync(paths.root, { recursive: true });
  const receipt: ProcessReceipt = {
    pid: process.pid,
    pgid: process.pid,
    start_marker: 'not-the-current-process-start-marker',
    executable_digest: fixture.manifest.runtime.digest,
    argv_digest: '1'.repeat(64),
    cwd_relative: '.',
    owner_nonce: `${fixture.manifest.run_id}:${sessionId}:foreign-owner`,
  };
  const record: SessionRecord = {
    id: sessionId,
    status: 'running',
    pid: process.pid,
    start_marker: receipt.start_marker,
    process: receipt,
    transcript_path: paths.transcript,
    log_path: paths.log,
    private_connection_path: paths.connection,
  };
  const manifest: RunManifest = { ...fixture.manifest, sessions: [record] };
  writeManifest(fixture.manifestPath, manifest);
  writeFileSync(paths.record, JSON.stringify({ ...record, started_at: new Date().toISOString() }) + '\n', { mode: 0o600 });

  const result = await cleanupRun({ manifestPath: fixture.manifestPath });
  assert.equal(result.ok, false);
  assert.ok(existsSync(fixture.manifest.roots.workspace));
});

test('cleanup refuses a session path outside the declared run roots', async t => {
  const fixture = createIsolatedRunFixture();
  t.after(() => fixture.cleanup());

  const paths = sessionPaths(fixture.manifest, 'outside-path');
  const invalidManifest = {
    ...fixture.manifest,
    sessions: [{
      id: 'outside-path',
      status: 'stopped',
      transcript_path: join(fixture.root, 'outside-transcript.jsonl'),
      log_path: paths.log,
      private_connection_path: paths.connection,
    }],
  };
  writeFileSync(fixture.manifestPath, JSON.stringify(invalidManifest, null, 2) + '\n');

  const result = await cleanupRun({ manifestPath: fixture.manifestPath });
  assert.equal(result.ok, false);
  assert.ok(existsSync(fixture.manifest.roots.workspace));
});
