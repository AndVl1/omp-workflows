import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRegistryRegistration, commitRegistryRegistration, recordRegistryUndo, rollbackRegistryRegistration } from "@andvl1/omp-workflows-core/registry";
import { fullstackTestOwner } from "./mock-registration.js";
import { openFullstackRuntimeTest } from "./runtime-access-fixture.js";
import {
  createEscalationAdapter,
  registerEscalationAdapter,
  type EscalationAdapterCapabilities,
  type EscalationAdapterFactory,
  MAX_CUSTOM_ADAPTER_KIND_BYTES,
  MAX_CUSTOM_ADAPTER_KINDS_PER_ROOT,
} from "../src/adapters/registry.js";

type FullstackRuntime = ReturnType<typeof openFullstackRuntimeTest>;
const runtimeFixtures = new Map<string, FullstackRuntime>();
function runtimeFor(root: string, owner = fullstackTestOwner(root)): FullstackRuntime {
  const existing = runtimeFixtures.get(root);
  if (existing) return existing;
  const runtime = openFullstackRuntimeTest(root, "registry-security-" + runtimeFixtures.size, owner);
  runtimeFixtures.set(root, runtime);
  return runtime;
}
test.after(() => {
  for (const runtime of runtimeFixtures.values()) runtime.close();
  runtimeFixtures.clear();
});

function register(
  root: string,
  kind: string,
  factory: EscalationAdapterFactory,
  metadata: EscalationAdapterCapabilities,
  owner = fullstackTestOwner(root),
): void {
  const runtime = runtimeFor(root, owner);
  const registration = beginRegistryRegistration(runtime.activation.registry_context, root, ["escalation_adapters"]);
  if (!registration.ok) throw new Error(registration.code + ": " + registration.error);
  try {
    registerEscalationAdapter(registration.token, kind, factory, metadata);
    commitRegistryRegistration(registration.token);
  } catch (error) {
    try { rollbackRegistryRegistration(registration.token); } catch { /* preserve registration failure */ }
    throw error;
  }
}

function createAdapter(root: string, config: Parameters<typeof createEscalationAdapter>[0]): ReturnType<typeof createEscalationAdapter> {
  return createEscalationAdapter(config, root, undefined, runtimeFor(root).access, runtimeFor(root).proofAuthority);
}

function registerWithRuntime(
  runtime: FullstackRuntime,
  root: string,
  kind: string,
  factory: EscalationAdapterFactory,
  metadata: EscalationAdapterCapabilities,
): void {
  const registration = beginRegistryRegistration(runtime.activation.registry_context, root, ["escalation_adapters"]);
  if (!registration.ok) throw new Error(registration.code + ": " + registration.error);
  try {
    registerEscalationAdapter(registration.token, kind, factory, metadata);
    commitRegistryRegistration(registration.token);
  } catch (error) {
    try { rollbackRegistryRegistration(registration.token); } catch { /* preserve registration failure */ }
    throw error;
  }
}

const capabilities: EscalationAdapterCapabilities = {
  canReceiveInbound: false,
  canSend: true,
  canSendWithIdempotency: true,
};

// Mirrors the core owner callback bound; kept private there by design.
const MAX_REGISTRY_CALLBACKS = 256;

function adapterFactory(kind: string, onCreate: () => void): EscalationAdapterFactory {
  return () => {
    onCreate();
    return {
      kind,
      send: async () => ({ sent: true }),
      sendWithIdempotency: async () => ({ sent: true }),
      cancel: async () => undefined,
    };
  };
}

test("registry: built-in http/telegram kinds cannot be replaced or receive secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-reserved-"));
  try {
    let attackerCalls = 0;
    const attacker = ((config) => {
      attackerCalls += 1;
      throw new Error(`attacker received ${JSON.stringify(config)}`);
    }) as EscalationAdapterFactory;
    assert.throws(() => register(root, "http", attacker, { ...capabilities, canReceiveInbound: true }), /reserved|built-in|owner_conflict/i);
    assert.throws(() => register(root, "telegram", attacker, { ...capabilities, canReceiveInbound: false }), /reserved|built-in|owner_conflict/i);

    const http = createAdapter(root, { adapter: "http", http: { url: "https://secret.invalid/http-token" } });
    const telegram = createAdapter(root, { adapter: "telegram", telegram: { token: "telegram-secret", chatId: "chat-secret" } });
    assert.equal(http?.kind, "http", "reserved http remains the built-in adapter");
    assert.equal(telegram?.kind, "telegram", "reserved telegram remains the built-in adapter");
    assert.equal(attackerCalls, 0, "reserved-kind rejection occurs before attacker factory invocation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry: first custom owner wins and exact same registration is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-owner-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "adapter-owner-foreign-"));
  try {
    const kind = "security-custom-owner";
    let firstCalls = 0;
    let foreignCalls = 0;
    const firstFactory = adapterFactory(kind, () => { firstCalls += 1; });
    const foreignFactory = adapterFactory(kind, () => { foreignCalls += 1; });
    const foreignOwner = { ...fullstackTestOwner(foreignRoot), owner_id: "@andvl1/omp-workflows-fullstack:foreign" };
    const mutableCapabilities = { ...capabilities };

    register(root, kind, firstFactory, mutableCapabilities);
    // The registry must retain a frozen snapshot rather than caller-owned
    // metadata. This altered tuple cannot replace the first registration.
    mutableCapabilities.canReceiveInbound = true;
    assert.throws(() => register(root, kind, firstFactory, mutableCapabilities), /already owned|owner_conflict/i);
    // Registrations are scoped by immutable project root: a foreign root may
    // use the same kind without intercepting this root's owner.
    register(foreignRoot, kind, foreignFactory, capabilities, foreignOwner);
    // An exact replay by the first owner is the only accepted duplicate on
    // the original root.
    register(root, kind, firstFactory, capabilities);

    const adapter = createAdapter(root, { adapter: kind, custom: { token: "custom-secret" } });
    const foreignAdapter = createAdapter(foreignRoot, { adapter: kind, custom: { token: "foreign-secret" } });
    assert.equal(adapter?.kind, kind, "the first custom registration remains usable");
    assert.equal(foreignAdapter?.kind, kind, "a separate root may register the same kind independently");
    assert.equal(firstCalls, 1, "the winning factory constructs exactly once");
    assert.equal(foreignCalls, 1, "the foreign root's factory constructs only for its own root");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});


test("registry: stale custom owner is swept and an overlong kind or per-root cap is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-bounds-"));
  try {
    const staleKind = "security-custom-stale";
    register(root, staleKind, adapterFactory(staleKind, () => undefined), capabilities);
    const oldRuntime = runtimeFor(root);
    oldRuntime.close();
    runtimeFixtures.delete(root);
    const replacement = runtimeFor(root);
    assert.equal(createAdapter(root, { adapter: staleKind, custom: { token: "stale" } }), null, "revoked owner registration is not revived");
    register(root, staleKind, adapterFactory(staleKind, () => undefined), capabilities);
    assert.equal(createAdapter(root, { adapter: staleKind, custom: { token: "fresh" } })?.kind, staleKind, "replacement owner can register after stale sweep");

    const overlong = "a".repeat(MAX_CUSTOM_ADAPTER_KIND_BYTES + 1);
    assert.throws(() => register(root, overlong, adapterFactory(overlong, () => undefined), capabilities), /kind|invalid/i);
    for (let index = 0; index < MAX_CUSTOM_ADAPTER_KINDS_PER_ROOT - 1; index += 1) {
      const kind = `security-custom-cap-${index}`;
      register(root, kind, adapterFactory(kind, () => undefined), capabilities);
    }
    assert.throws(() => register(root, "security-custom-cap-overflow", adapterFactory("security-custom-cap-overflow", () => undefined), capabilities), /capacity|invalid/i);
    replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("registry: idempotent activations retain independent custom adapter leases in either close order", () => {
  for (const firstClose of ["a", "b"] as const) {
    const root = mkdtempSync(join(tmpdir(), `adapter-cross-activation-${firstClose}-`));
    let first: FullstackRuntime | undefined;
    let second: FullstackRuntime | undefined;
    let third: FullstackRuntime | undefined;
    try {
      first = runtimeFor(root);
      second = openFullstackRuntimeTest(root, "registry-security-cross-activation", fullstackTestOwner(root));
      const kind = `security-cross-activation-${firstClose}`;
      const factory = adapterFactory(kind, () => undefined);
      registerWithRuntime(first, root, kind, factory, capabilities);
      registerWithRuntime(second, root, kind, factory, capabilities);
      const closeFirst = firstClose === "a" ? first : second;
      const stillLive = firstClose === "a" ? second : first;
      closeFirst.close();
      assert.equal(createEscalationAdapter({ adapter: kind, custom: { token: "shared" } }, root, undefined, stillLive.access)?.kind, kind, "the remaining activation lease keeps the cell usable");
      stillLive.close();
      third = openFullstackRuntimeTest(root, "registry-security-cross-activation-check", fullstackTestOwner(root));
      assert.equal(createEscalationAdapter({ adapter: kind, custom: { token: "closed" } }, root, undefined, third.access), null, "the cell is removed after both activation leases close");
      third.close();
      runtimeFixtures.delete(root);
    } finally {
      first?.close();
      second?.close();
      third?.close();
      runtimeFixtures.delete(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test("registry: callback-cap rejection leaves no partially inserted custom adapter lease", () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-undo-cap-"));
  try {
    const runtime = runtimeFor(root);
    const registration = beginRegistryRegistration(runtime.activation.registry_context, root, ["escalation_adapters"]);
    if (!registration.ok) throw new Error(registration.code + ": " + registration.error);
    // Fill 255 slots, then let the first registration consume the exact
    // 256th slot. The next registration callback must fail at the bound.
    for (let index = 0; index < MAX_REGISTRY_CALLBACKS - 1; index += 1) recordRegistryUndo(registration.token, () => undefined);
    const kind = "security-undo-cap";
    registerEscalationAdapter(registration.token, kind, adapterFactory(kind, () => undefined), capabilities);
    assert.throws(
      () => registerEscalationAdapter(registration.token, `${kind}-overflow`, adapterFactory(`${kind}-overflow`, () => undefined), capabilities),
      /callbacks are bounded/i,
    );
    rollbackRegistryRegistration(registration.token);

    const fresh = runtimeFor(root);
    const retry = beginRegistryRegistration(fresh.activation.registry_context, root, ["escalation_adapters"]);
    if (!retry.ok) throw new Error(retry.code + ": " + retry.error);
    try {
      registerEscalationAdapter(retry.token, kind, adapterFactory(kind, () => undefined), capabilities);
      commitRegistryRegistration(retry.token);
    } catch (error) {
      try { rollbackRegistryRegistration(retry.token); } catch { /* preserve registration failure */ }
      throw error;
    }
    assert.equal(createAdapter(root, { adapter: kind, custom: { token: "after-cap" } })?.kind, kind, "fresh registration succeeds after a prefilled callback cap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
