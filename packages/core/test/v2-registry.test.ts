import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProviderAgentInventory,
  computeCatalogContentDigest,
  computeDescriptorFingerprint,
  computeProfileContentDigest,
  preflightAgentInventory,
} from "../src/workflow-v2/descriptor.js";
import {
  createProviderRegistry,
  listProviderQuarantine,
  listProviders,
  lookupProvider,
  publishProvider,
  validateProviderCapabilities,
} from "../src/workflow-v2/registry.js";
import {
  createProviderCatalog,
  loadProfileByIdentity,
} from "../src/engine/profile.js";
import type {
  ProviderDescriptor,
  ProviderId,
  ProviderRecord,
  ProviderQuarantine,
  ProviderRegistration,
  ProviderRuntime,
  Profile,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";

const providerId = "@example/workflow-provider" as ProviderId;
const sourceFingerprint = `sha256:${"b".repeat(64)}` as WorkflowV2Digest;
const buildFingerprint = `sha256:${"c".repeat(64)}` as WorkflowV2Digest;
const runtimeFingerprint = `sha256:${"d".repeat(64)}` as WorkflowV2Digest;

const profile: Profile = {
  name: "standard",
  title: "Standard",
  description: "A focused workflow profile",
  match: { type: ["FEATURE"] },
  stages: [{ id: "implementation", title: "Implementation", type: "none" }],
};

function runtime(): ProviderRuntime {
  return {
    provider_id: providerId,
    async dispatch(input) {
      return { status: "succeeded", identity: input.identity, evidence: "ok" };
    },
    shutdown() {},
  };
}

function registration(overrides: Partial<ProviderDescriptor> = {}): ProviderRegistration {
  const catalog = createProviderCatalog([profile]);
  const descriptor: ProviderDescriptor = {
    id: providerId,
    protocol_version: 2,
    capabilities: ["workflow_execution", "profile_catalog"],
    catalog_content_digest: catalog.content_digest,
    agent_sources: [{ provider_id: providerId, source_fingerprint: sourceFingerprint, registered_names: ["analyst", "task"] }],
    executable_provenance: { build_fingerprint: buildFingerprint, runtime_fingerprint: runtimeFingerprint },
    defaults: {},
    ...overrides,
  };
  return {
    descriptor,
    descriptor_fingerprint: computeDescriptorFingerprint(descriptor),
    catalog,
    createRuntime: () => runtime(),
  };
}

test("publishes immutable descriptors and exact duplicate is idempotent", () => {
  const registry = createProviderRegistry();
  const first = publishProvider(registry, registration());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const originalName = first.value.descriptor.agent_sources[0]?.registered_names[0];
  const second = publishProvider(registry, registration());
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value, first.value);
  assert.equal(originalName, "analyst");
  assert.equal(listProviders(registry).length, 1);
});

test("registry capabilities reject forged maps and foreign runtime injection", () => {
  let factoryCalls = 0;
  const forged = {
    providers: new Map([[providerId, {
      provider_id: providerId,
      descriptor: {},
      descriptor_fingerprint: `sha256:${"a".repeat(64)}` as WorkflowV2Digest,
      catalog: {},
      createRuntime: () => {
        factoryCalls += 1;
        return runtime();
      },
    } as unknown as ProviderRecord]]),
    quarantined: new Map(),
  } as unknown as ProviderRegistry;

  assert.throws(() => lookupProvider(forged, providerId), TypeError);
  assert.throws(() => publishProvider(forged, registration()), TypeError);
  assert.equal(factoryCalls, 0);

  const isolated = createProviderRegistry();
  assert.equal("providers" in isolated, false);
  assert.equal("quarantined" in isolated, false);
  assert.equal((isolated as unknown as { readonly providers?: unknown }).providers, undefined);
});

test("registry observations are frozen and cannot mutate publication or quarantine", () => {
  const registry = createProviderRegistry();
  const published = publishProvider(registry, registration());
  assert.equal(published.ok, true);
  if (!published.ok) return;

  const listed = listProviders(registry);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.throws(() => {
    (listed as unknown as ProviderRecord[]).push(published.value);
  }, TypeError);
  assert.throws(() => {
    (published.value as unknown as { provider_id: ProviderId }).provider_id = "@other/provider" as ProviderId;
  }, TypeError);
  assert.equal(lookupProvider(registry, providerId).ok, true);

  const changed = {
    ...registration(),
    descriptor: {
      ...registration().descriptor,
      executable_provenance: {
        build_fingerprint: buildFingerprint,
        runtime_fingerprint: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
      },
    },
  };
  const conflict = publishProvider(registry, {
    ...changed,
    descriptor_fingerprint: computeDescriptorFingerprint(changed.descriptor),
  });
  assert.equal(conflict.ok, false);
  const quarantine = listProviderQuarantine(registry);
  assert.equal(Object.isFrozen(quarantine), true);
  assert.equal(Object.isFrozen(quarantine[0]), true);
  assert.throws(() => {
    (quarantine as unknown as ProviderQuarantine[]).pop();
  }, TypeError);
});

test("quarantines every same-id immutable conflict without first-wins", () => {
  const registry = createProviderRegistry();
  const first = registration();
  assert.equal(publishProvider(registry, first).ok, true);
  const changed = {
    ...first.descriptor,
    executable_provenance: { build_fingerprint: buildFingerprint, runtime_fingerprint: `sha256:${"e".repeat(64)}` as WorkflowV2Digest },
  };
  const conflict = publishProvider(registry, {
    ...first,
    descriptor: changed,
    descriptor_fingerprint: computeDescriptorFingerprint(changed),
  });
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.diagnostics[0]?.code, "PROVIDER_QUARANTINED");
  assert.equal(listProviders(registry).length, 0);
  assert.equal(listProviderQuarantine(registry).length, 1);
  const lookup = lookupProvider(registry, providerId);
  assert.equal(lookup.ok, false);
  if (!lookup.ok) assert.equal(lookup.diagnostics[0]?.code, "PROVIDER_QUARANTINED");
});

test("rejects capability gaps and never executes the factory", () => {
  const registry = createProviderRegistry();
  let factoryCalls = 0;
  const registrationValue = registration({ capabilities: ["workflow_execution"] });
  const result = publishProvider(registry, {
    ...registrationValue,
    createRuntime: () => {
      factoryCalls += 1;
      return runtime();
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const capability = validateProviderCapabilities(result.value, ["profile_catalog", "cto"]);
  assert.equal(capability.ok, false);
  if (!capability.ok) assert.equal(capability.diagnostics[0]?.code, "CAPABILITY_MISSING");
  assert.equal(factoryCalls, 0);
});

test("qualified inventory rejects incompatible source identities", () => {
  const collision = preflightAgentInventory([
    { registered_name: "analyst", provider_id: providerId, source_fingerprint: sourceFingerprint },
    { registered_name: "analyst", provider_id: "@other/provider" as ProviderId, source_fingerprint: sourceFingerprint },
  ]);
  assert.equal(collision.ok, false);
  if (!collision.ok) assert.equal(collision.diagnostics[0]?.code, "AGENT_COLLISION");

  const catalog = createProviderCatalog([profile]);
  assert.equal(computeCatalogContentDigest(catalog), catalog.content_digest);
  const descriptor = registration().descriptor;
  assert.deepEqual(buildProviderAgentInventory(descriptor).map((agent) => agent.registered_name), ["analyst", "task"]);
});

test("catalog profile loading requires the selected profile fingerprint", () => {
  const catalog = createProviderCatalog([profile]);
  const identity = { id: profile.name, fingerprint: computeProfileContentDigest(profile) };
  const selected = loadProfileByIdentity(catalog, identity);
  assert.equal(selected.ok, true);
  const stale = loadProfileByIdentity(catalog, { ...identity, fingerprint: `sha256:${"f".repeat(64)}` as WorkflowV2Digest });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.diagnostics[0]?.code, "IDENTITY_MISMATCH");
});
