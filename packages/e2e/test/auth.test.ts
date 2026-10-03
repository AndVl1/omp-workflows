import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { checkBrokerConnection } from '../src/auth.js';
import { createIsolatedRunFixture } from './fixtures/isolated-run.js';

test('broker readiness requires the selected bearer and never falls back after broker loss', async t => {
  const fixture = createIsolatedRunFixture();
  t.after(() => fixture.cleanup());
  const expectedToken = 'opaque-fixture-broker-value';
  const server = createServer((request, response) => {
    if (request.url === '/v1/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true,"version":"fixture"}');
      return;
    }
    if (request.url === '/v1/credentials/disabled') {
      response.writeHead(request.headers.authorization === `Bearer ${expectedToken}` ? 404 : 401);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => resolve()); });
  let closed = false;
  t.after(async () => {
    if (!closed) await new Promise<void>(resolve => { server.close(() => resolve()); });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const manifest = {
    ...fixture.manifest,
    model: 'provider/live-model',
    auth: {
      mode: 'broker' as const,
      broker_url: `http://127.0.0.1:${address.port}`,
      token_env: 'E2E_BROKER_TEST_TOKEN',
      refresh_owner_verified: true,
    },
  };

  const ready = await checkBrokerConnection(manifest, { secretEnv: { E2E_BROKER_TEST_TOKEN: expectedToken } });
  assert.equal(ready.ok, true);
  const refused = await checkBrokerConnection(manifest, { secretEnv: { E2E_BROKER_TEST_TOKEN: 'wrong-secret' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'broker_auth_unavailable');
  assert.equal(JSON.stringify(refused).includes('wrong-secret'), false);

  await new Promise<void>(resolve => { server.close(() => resolve()); });
  closed = true;
  const unavailable = await checkBrokerConnection(manifest, { secretEnv: { E2E_BROKER_TEST_TOKEN: expectedToken } });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'broker_unavailable');
});
