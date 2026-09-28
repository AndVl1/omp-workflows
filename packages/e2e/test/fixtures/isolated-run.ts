import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPackageArtifact } from '../../src/artifacts.js';
import type { RunManifest } from '../../src/manifest.js';
import { inspectInstalledRuntime, snapshotRuntime } from '../../src/runtime.js';

export interface IsolatedRunFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: RunManifest;
  readonly runtimeBinary: string;
  cleanup(): void;
}

export interface IsolatedRunFixtureOptions {
  readonly runId?: string;
  readonly runtimeScript?: string;
}

const DEFAULT_RUNTIME = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'omp-fixture 1.0\\n'
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf 'Usage: omp --mode rpc --session-dir --config\\n'
  exit 0
fi
printf 'FIXTURE_READY:%s\\n' "${'${OMP_SESSION_DIR:-missing}'}"
while IFS= read -r line; do
  printf 'FIXTURE_ECHO:%s\\n' "$line"
done
`;

const RPC_PROBE = `if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then
  IFS= read -r state
  if [ "$state" != '{"id":"state","type":"get_state"}' ]; then exit 1; fi
  printf '{"id":"state","type":"response","success":true,"data":{"model":{"id":"no-request","provider":"e2e-offline"}}}\\n'
  IFS= read -r commands
  if [ "$commands" != '{"id":"commands","type":"get_available_commands"}' ]; then exit 1; fi
  printf '{"id":"commands","type":"response","success":true,"data":{"commands":[{"name":"do-work","source":"extension"},{"name":"cto","source":"extension"}]}}\\n'
  exit 0
fi
`;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Create a complete disposable manifest whose runtime is a local process probe. */
export function createIsolatedRunFixture(options: IsolatedRunFixtureOptions = {}): IsolatedRunFixture {
  const root = mkdtempSync(join(tmpdir(), 'ux-e2e-isolated-run-'));
  const previousRoot = process.env.OMP_E2E_ROOT;
  process.env.OMP_E2E_ROOT = root;
  const runId = options.runId ?? 'fixture-run';
  const runRoot = join(root, 'runs', runId);
  const cacheRoot = join(root, 'cache');
  const runtimeSourceRoot = join(cacheRoot, 'fixture-runtime');
  const sourceRuntimeBinary = join(runtimeSourceRoot, 'runtime-probe.sh');
  const supplied = options.runtimeScript ?? DEFAULT_RUNTIME;
  const versioned = supplied.includes('if [ "$1" = "--version" ]')
    ? supplied
    : supplied.replace(/^#!\/bin\/sh\n/u, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "omp-fixture 1.0\\n"; exit 0; fi\n');
  const helped = versioned.includes('if [ "$1" = "--help" ]')
    ? versioned
    : versioned.replace(/^#!\/bin\/sh\n/u, '#!/bin/sh\nif [ "$1" = "--help" ]; then printf "Usage: omp --mode rpc --session-dir --config\\n"; exit 0; fi\n');
  if (!helped.startsWith('#!/bin/sh\n')) throw new Error('disposable runtime fixture must be a shell script');
  const runtimeScript = helped.replace(/^#!\/bin\/sh\n/u, `#!/bin/sh\n${RPC_PROBE}`);
  mkdirSync(runtimeSourceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(sourceRuntimeBinary, runtimeScript, { mode: 0o700 });
  chmodSync(sourceRuntimeBinary, 0o700);
  writeFileSync(join(runtimeSourceRoot, 'package.json'), JSON.stringify({
    name: '@fixture/runtime',
    version: 'omp-fixture 1.0',
    files: ['runtime-probe.sh'],
  }) + '\n', { mode: 0o600 });

  const roots = {
    run: runRoot,
    home: join(runRoot, 'home'),
    agent: join(runRoot, 'home', '.omp', 'agent'),
    workspace: join(runRoot, 'workspace'),
    tmp: join(runRoot, 'tmp'),
    private: join(runRoot, 'private'),
    sessions: join(runRoot, 'sessions'),
    logs: join(runRoot, 'logs'),
    evidence: join(runRoot, 'evidence'),
  };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true, mode: 0o700 });

  const runtimeProbe = inspectInstalledRuntime({
    binary: sourceRuntimeBinary,
    fixtureRoot: roots.workspace,
    homeRoot: roots.home,
  });
  const runtimeSnapshot = snapshotRuntime(runtimeProbe, cacheRoot);

  const coreRoot = join(cacheRoot, 'core');
  const fullstackRoot = join(cacheRoot, 'fullstack');
  mkdirSync(coreRoot, { recursive: true, mode: 0o700 });
  mkdirSync(fullstackRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(fullstackRoot, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(coreRoot, 'package.json'), JSON.stringify({
    name: '@fixture/core',
    version: '1.0.0',
    files: ['artifact.marker'],
  }) + '\n', { mode: 0o600 });
  writeFileSync(join(fullstackRoot, 'package.json'), JSON.stringify({
    name: '@fixture/fullstack',
    version: '1.0.0',
    files: ['dist', 'artifact.marker'],
    main: './dist/index.js',
  }) + '\n', { mode: 0o600 });
  writeFileSync(join(fullstackRoot, 'dist', 'index.js'), 'export default () => {};\n');
  writeFileSync(join(coreRoot, 'artifact.marker'), 'core fixture artifact\n');
  writeFileSync(join(fullstackRoot, 'artifact.marker'), 'fullstack fixture artifact\n');
  const coreArtifact = buildPackageArtifact(coreRoot, cacheRoot);
  const fullstackArtifact = buildPackageArtifact(fullstackRoot, cacheRoot);

  mkdirSync(join(runRoot, 'bin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runRoot, 'bin', 'omp'), `#!/bin/sh\nexec '${runtimeSnapshot.binary.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  const scenarioPath = join(runRoot, 'scenario.json');
  const scenarioText = JSON.stringify({ id: 'fixture', task: 'process-level isolation probe' }) + '\n';
  const scenarioFileDigest = digest(scenarioText);
  const scenarioDigest = digest(JSON.stringify({ scenario: scenarioFileDigest, task: null }));
  writeFileSync(scenarioPath, scenarioText);

  const manifest: RunManifest = {
    schema_version: 1,
    run_id: runId,
    input_digest: digest('fixture-inputs'),
    status: 'ready',
    runtime: {
      binary: runtimeSnapshot.binary,
      version: runtimeSnapshot.version,
      digest: runtimeSnapshot.digest,
      platform: runtimeSnapshot.platform,
      capabilities: runtimeSnapshot.capabilities,
    },
    artifacts: {
      core: { root: coreArtifact.root, digest: coreArtifact.digest },
      fullstack: { root: fullstackArtifact.root, digest: fullstackArtifact.digest },
    },
    roots,
    auth: { mode: 'none' },
    model: null,
    scenario: { id: 'fixture', path: scenarioPath, digest: scenarioDigest },
    sessions: [],
  };
  const manifestPath = join(runRoot, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  return {
    root,
    manifestPath,
    manifest,
    runtimeBinary: runtimeSnapshot.binary,
    cleanup: () => {
      if (previousRoot === undefined) delete process.env.OMP_E2E_ROOT;
      else process.env.OMP_E2E_ROOT = previousRoot;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
