import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'omp 18.3.4\\n'
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf 'Usage: omp --mode rpc --session-dir --config\\n'
  exit 0
fi
if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then
  IFS= read -r state
  if [ "$state" = '{"id":"state","type":"get_state"}' ]; then
    printf '{"id":"state","type":"response","success":true,"data":{"model":{"id":"no-request","provider":"e2e-offline"}}}\\n'
    if IFS= read -r commands && [ "$commands" = '{"id":"commands","type":"get_available_commands"}' ]; then
      printf '{"id":"commands","type":"response","success":true,"data":{"commands":[{"name":"do-work","source":"extension"},{"name":"cto","source":"extension"}]}}\\n'
    fi
    exit 0
  fi
  printf 'unexpected RPC request\\n' >&2
  exit 1
fi
printf 'FIXTURE_READY\\n'
while IFS= read -r line; do
  printf 'FIXTURE_ECHO:%s\\n' "$line"
done
`;

export interface PrepareRunFixture {
  readonly root: string;
  readonly configPath: string;
  readonly runtimeBinary: string;
  readonly stateRoot: string;
  writeRuntime(script: string): void;
  cleanup(): void;
}

/** Create minimal package sources and an installed-runtime-shaped process fixture. */
export function createPrepareRunFixture(): PrepareRunFixture {
  const root = mkdtempSync(join(tmpdir(), 'ux-e2e-prepare-fixture-'));
  const runtimeRoot = join(root, 'installed-omp');
  const runtimeBinary = join(runtimeRoot, 'dist', 'cli.js');
  const coreRoot = join(root, 'packages', 'core');
  const fullstackRoot = join(root, 'packages', 'fullstack');
  const scenarioPath = join(root, 'scenario.json');
  const stateRoot = join(root, 'run-state');

  mkdirSync(join(runtimeRoot, 'dist'), { recursive: true });
  mkdirSync(join(coreRoot, 'dist'), { recursive: true });
  mkdirSync(join(fullstackRoot, 'dist'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({ name: '@oh-my-pi/pi-coding-agent', version: '18.3.4' }) + '\n');
  writeFileSync(join(coreRoot, 'package.json'), JSON.stringify({ name: '@fixture/core', version: '1.0.0', files: ['dist'], main: './dist/index.js', types: './dist/index.d.ts' }) + '\n');
  writeFileSync(join(coreRoot, 'dist', 'index.js'), 'export const coreFixture = true;\n');
  writeFileSync(join(coreRoot, 'dist', 'index.d.ts'), 'export declare const coreFixture: true;\n');
  writeFileSync(join(fullstackRoot, 'package.json'), JSON.stringify({ name: '@fixture/fullstack', version: '1.0.0', files: ['dist'], main: './dist/index.js', types: './dist/index.d.ts' }) + '\n');
  writeFileSync(join(fullstackRoot, 'dist', 'index.js'), 'export const fullstackFixture = true;\n');
  writeFileSync(join(fullstackRoot, 'dist', 'index.d.ts'), 'export declare const fullstackFixture: true;\n');
  writeFileSync(scenarioPath, JSON.stringify({ id: 'fixture', task: 'provider-free' }) + '\n');

  const writeRuntime = (script: string): void => {
    writeFileSync(runtimeBinary, script, { mode: 0o700 });
    chmodSync(runtimeBinary, 0o700);
  };
  writeRuntime(RUNTIME_SCRIPT);

  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    runtime: { binary: runtimeBinary },
    artifacts: { core: { source: coreRoot }, fullstack: { source: fullstackRoot } },
    scenario: { id: 'fixture', path: scenarioPath },
    model: null,
    auth: { mode: 'none' },
  }, null, 2) + '\n');

  return {
    root,
    configPath,
    runtimeBinary,
    stateRoot,
    writeRuntime,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
