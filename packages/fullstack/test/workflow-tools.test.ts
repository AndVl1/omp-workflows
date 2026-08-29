import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAdmissionBridge,
  createProviderRegistry,
  listProviderQuarantine,
  listProviders,
  lookupProvider,
  WORKFLOW_V2_HOST_DESCRIPTOR,
  WorkflowV2HostAdmissionError,
} from "@andvl1/omp-workflows-core";
import ompWorkflowsFullstack, {
  FULLSTACK_PROVIDER_CATALOG,
  FULLSTACK_PROVIDER_DESCRIPTOR,
  FULLSTACK_PROVIDER_REGISTRATION,
  FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
  FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  publishFullstackProvider,
  registerFullstackHost,
} from "../src/index.js";
import { computeCatalogContentDigest, computeDescriptorFingerprint, publishProvider } from "@andvl1/omp-workflows-core";

function fakePi(): { on: (name: string, handler: unknown) => void; registerCommand: () => void; registerTool: () => void } {
  return {
    on() {},
    registerCommand() {
      throw new Error("canonical command registration must remain core-host-owned");
    },
    registerTool() {
      throw new Error("canonical tool registration must remain core-host-owned");
    },
  };
}

test("fullstack publishes one immutable descriptor/catalog registration with exact fingerprints", () => {
  assert.equal(FULLSTACK_PROVIDER_DESCRIPTOR.id, "@andvl1/omp-workflows-fullstack");
  assert.equal(FULLSTACK_PROVIDER_DESCRIPTOR.protocol_version, 2);
  assert.equal(FULLSTACK_PROVIDER_DESCRIPTOR.catalog_content_digest, FULLSTACK_PROVIDER_CATALOG.content_digest);
  assert.equal(FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST, FULLSTACK_PROVIDER_CATALOG.content_digest);
  assert.equal(FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT, computeDescriptorFingerprint(FULLSTACK_PROVIDER_DESCRIPTOR));
  assert.equal(FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST, computeCatalogContentDigest(FULLSTACK_PROVIDER_CATALOG));
  assert.ok(FULLSTACK_PROVIDER_CATALOG.profiles.length > 0);
  assert.ok(Object.isFrozen(FULLSTACK_PROVIDER_DESCRIPTOR));
  assert.ok(Object.isFrozen(FULLSTACK_PROVIDER_DESCRIPTOR.defaults));
  assert.ok(Object.isFrozen(FULLSTACK_PROVIDER_CATALOG));
  assert.equal(typeof FULLSTACK_PROVIDER_REGISTRATION.createRuntime, "function");
});

test("fullstack publication is idempotent and never invokes the runtime factory", () => {
  const registry = createProviderRegistry();
  const first = publishFullstackProvider(registry);
  const second = publishFullstackProvider(registry);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(first.value, second.value);
});

test("fullstack quarantines an equivalent prepublication with a foreign runtime factory", () => {
  const registry = createProviderRegistry();
  let foreignFactoryCalls = 0;
  const foreignCreateRuntime: typeof FULLSTACK_PROVIDER_REGISTRATION.createRuntime = () => {
    foreignFactoryCalls += 1;
    throw new Error("foreign runtime factory must never be invoked");
  };

  const prepublished = publishProvider(registry, {
    ...FULLSTACK_PROVIDER_REGISTRATION,
    createRuntime: foreignCreateRuntime,
  });
  assert.equal(prepublished.ok, true);

  const guarded = publishFullstackProvider(registry);
  assert.equal(guarded.ok, false);
  if (!guarded.ok) assert.equal(guarded.diagnostics[0]?.code, "PROVIDER_QUARANTINED");
  assert.equal(listProviders(registry).length, 0);
  assert.equal(lookupProvider(registry, FULLSTACK_PROVIDER_DESCRIPTOR.id).ok, false);
  assert.equal(listProviderQuarantine(registry).some((entry) => entry.provider_id === FULLSTACK_PROVIDER_DESCRIPTOR.id), true);
  assert.equal(foreignFactoryCalls, 0);
});

test("an immutable identity conflict is quarantined by the core registry", () => {
  const registry = createProviderRegistry();
  assert.equal(publishFullstackProvider(registry).ok, true);
  const conflict = publishProvider(registry, {
    ...FULLSTACK_PROVIDER_REGISTRATION,
    descriptor_fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  });
  assert.equal(conflict.ok, false);
  assert.equal(listProviderQuarantine(registry).some((entry) => entry.provider_id === FULLSTACK_PROVIDER_DESCRIPTOR.id), true);
});

test("default extension entrypoint installs only the stateless marker hook", () => {
  const events: string[] = [];
  ompWorkflowsFullstack({
    ...fakePi(),
    on(name: string) {
      events.push(name);
    },
  } as never);
  assert.deepEqual(events, ["before_agent_start"]);
});

test("host registration fails closed when launcher filesystem authority is absent", () => {
  assert.throws(
    () => registerFullstackHost(fakePi() as never, {
      registry: createProviderRegistry(),
      admission: createAdmissionBridge(),
      host: WORKFLOW_V2_HOST_DESCRIPTOR,
      resolveRoot: () => "/project",
      resolveSession: () => ({ session_id: "session", lifecycle_id: "lifecycle" }),
    }),
    WorkflowV2HostAdmissionError,
  );
});
