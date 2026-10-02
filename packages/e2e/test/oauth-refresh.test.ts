import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { validatePrepareConfig } from '../src/prepare.js';

test('synthetic OAuth provider cannot enter the real native-host-broker launch path', () => {
  const configPath = fileURLToPath(new URL('../scenarios/isolated-smoke.env.json', import.meta.url));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.auth = { mode: 'native-host-broker', provider: 'e2e-synthetic-oauth', start_local: true, bind: '127.0.0.1:43123' };
  config.model = 'e2e-synthetic-oauth/local-test';
  assert.throws(() => validatePrepareConfig(config, configPath), {
    code: 'config_invalid', details: { field: 'auth.provider' },
  });
});

test('standalone native regression fails explicitly when Bun is unavailable', t => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'ux-e2e-no-bun-'));
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'oauth-refresh', '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: emptyPath }, timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, 'bun_required');
  assert.equal(receipt.cleanup.status, 'not_run');
  assert.equal(receipt.cases, undefined);
  assert.equal(result.stderr, '');
});
