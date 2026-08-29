import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createAdapterFactories,
  createEscalationAdapter,
  registerEscalationAdapterFactory,
} from "../src/adapters/registry.js";
import { channelAdmission, runtimeFixture } from "./runtime-fixtures.js";

test("HTTP builtin fails closed without the provider-runtime transport", () => {
  const root = mkdtempSync(join(tmpdir(), "fullstack-http-admission-"));
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  try {
    const fixture = runtimeFixture(root);
    const admission = channelAdmission(fixture, [{
      id: "alerts",
      adapter: "http",
      direction: "read-only",
      url: "http://127.0.0.1:1/alerts",
    }], {
      endpointPolicy: {
        alerts: {
          url: "http://127.0.0.1:1/alerts",
          method: "POST",
          headers: { "content-type": "application/json" },
          timeout_ms: 100,
          max_body_bytes: 4 * 1024,
        },
      },
    });
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("HTTP fallback must not run");
    }) as typeof fetch;
    const result = createEscalationAdapter(fixture.context, admission);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CAPABILITY_MISSING");
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP registry rejects arbitrary factory registration", () => {
  const factories = createAdapterFactories();
  const result = registerEscalationAdapterFactory(factories, "http", () => null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CONFIG_MALFORMED");
});
