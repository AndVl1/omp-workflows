import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRegistryRegistration, commitRegistryRegistration, recordRegistryUndo, rollbackRegistryRegistration } from "@andvl1/omp-workflows-core/registry";
import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import { openCtoRuntimeBridgeRouteAccess } from "@andvl1/omp-workflows-core/cto-runtime";
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

    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "telegram-secret", chatId: "chat-secret" } }));
    const http = createAdapter(root, { adapter: "http", http: { url: "https://secret.invalid/http-token" } });
    const telegram = createAdapter(root, { adapter: "telegram", telegram: { token: "telegram-secret", chatId: "chat-secret" } });
    assert.equal(http?.kind, "http", "reserved http remains the built-in adapter");
    assert.equal(telegram?.kind, "telegram", "reserved telegram remains the built-in adapter");
    assert.equal(attackerCalls, 0, "reserved-kind rejection occurs before attacker factory invocation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("registry: HTTP construction requires matching live runtime and proof authorities", async () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-authority-http-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "adapter-authority-http-foreign-"));
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const config = { adapter: "http", http: { url: "https://example.invalid/hook" } };
  try {
    assert.equal(createEscalationAdapter(config, root, undefined, undefined, undefined), null, "missing authorities reject before HTTP construction");
    assert.equal(fetchCalls, 0, "missing authorities never invoke fetch");

    const stale = openFullstackRuntimeTest(root, "registry-security-http-stale", fullstackTestOwner(root), true, false);
    stale.close();
    assert.equal(createEscalationAdapter(config, root, undefined, stale.access, stale.proofAuthority), null, "stale authorities reject before HTTP construction");
    assert.equal(fetchCalls, 0, "stale authorities never invoke fetch");

    const resident = runtimeFor(root);
    let customCalls = 0;
    const customKind = "authority-custom";
    register(root, customKind, () => {
      customCalls += 1;
      return { kind: customKind, send: async () => ({ sent: true }), sendWithIdempotency: async () => ({ sent: true }), cancel: async () => undefined };
    }, capabilities);
    assert.equal(createEscalationAdapter({ adapter: customKind }, root, undefined, undefined, undefined), null, "missing authorities reject before custom construction");
    assert.equal(customCalls, 0, "missing authorities never invoke a custom factory");
    const foreign = runtimeFor(foreignRoot);
    assert.equal(createEscalationAdapter(config, root, undefined, foreign.access, foreign.proofAuthority), null, "cross-root authorities reject before HTTP construction");
    assert.equal(fetchCalls, 0, "cross-root authorities never invoke fetch");

    const adapter = createEscalationAdapter(config, root, undefined, resident.access, resident.proofAuthority);
    assert.ok(adapter, "matching live authorities construct HTTP");
    assert.equal((await adapter.send({ id: "run/ask", level: "question", title: "title", body: "body", at: new Date().toISOString(), by: "test", run_id: "run" } as never)).sent, true, "activated HTTP sends");
    assert.equal(fetchCalls, 1, "activated HTTP invokes fetch once");

    resident.close();
    await assert.rejects(() => adapter.send({} as never), /authority|activation|runtime|root/i, "revoked authority rejects before the next HTTP effect");
    assert.equal(fetchCalls, 1, "revoked-before-call HTTP never invokes fetch");
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    const resident = runtimeFixtures.get(root);
    const foreign = runtimeFixtures.get(foreignRoot);
    resident?.close();
    foreign?.close();
    runtimeFixtures.delete(root);
    runtimeFixtures.delete(foreignRoot);
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test("registry: HTTP response after revocation is not admitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-authority-http-await-"));
  const runtime = openFullstackRuntimeTest(root, "registry-security-http-await", fullstackTestOwner(root), true, false);
  runtimeFixtures.set(root, runtime);
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let release: ((response: Response) => void) | undefined;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    return await new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch;
  try {
    const adapter = createEscalationAdapter({ adapter: "http", http: { url: "https://example.invalid/hook" } }, root, undefined, runtime.access, runtime.proofAuthority);
    assert.ok(adapter);
    const pending = adapter.send({} as never);
    runtime.close();
    release!(new Response("ok", { status: 200 }));
    await assert.rejects(() => pending, /authority|activation|runtime|root/i, "a revoked in-flight response is not admitted");
    assert.equal(fetchCalls, 1, "the in-flight request may have started exactly once");
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    runtimeFixtures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry: bridge-only authority constructs Telegram but not HTTP", () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-authority-bridge-"));
  const runtime = openFullstackRuntimeTest(root, "registry-security-bridge", fullstackTestOwner(root), true, false);
  runtimeFixtures.set(root, runtime);
  const pin = PinnedProjectRoot.open(root);
  assert.ok(pin);
  const config = { adapter: "telegram", telegram: { token: "bridge-token", chatId: "bridge-chat" } };
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify(config));
    const bridgeRoute = openCtoRuntimeBridgeRouteAccess(runtime.activation.registry_context, pin!);
    assert.ok(bridgeRoute, "bridge route authority opens for the activated root");
    const telegram = createEscalationAdapter(config, root, pin, undefined, runtime.proofAuthority, bridgeRoute!);
    assert.ok(telegram, "bridge-only authority is accepted for Telegram");
    assert.equal(createEscalationAdapter({ adapter: "http", http: { url: "https://example.invalid/hook" } }, root, pin, undefined, runtime.proofAuthority, bridgeRoute!), null, "bridge-only authority is rejected for HTTP");
    bridgeRoute!.close();
  } finally {
    pin!.close();
    runtime.close();
    runtimeFixtures.delete(root);
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

    // Use an isolated root for the per-root capacity boundary. The stale-kind
    // lifecycle above intentionally occupies one custom slot on `root`.
    const capRoot = mkdtempSync(join(tmpdir(), "adapter-bounds-cap-"));
    let capRuntime: FullstackRuntime | undefined;
    try {
      capRuntime = openFullstackRuntimeTest(capRoot, "registry-security-cap", fullstackTestOwner(capRoot), true, false);
      runtimeFixtures.set(capRoot, capRuntime);
      for (let index = 0; index < MAX_CUSTOM_ADAPTER_KINDS_PER_ROOT; index += 1) {
        const kind = `security-custom-cap-${index}`;
        registerWithRuntime(capRuntime, capRoot, kind, adapterFactory(kind, () => undefined), capabilities);
      }
      assert.throws(
        () => registerWithRuntime(capRuntime!, capRoot, "security-custom-cap-overflow", adapterFactory("security-custom-cap-overflow", () => undefined), capabilities),
        /capacity|invalid/i,
      );
    } finally {
      capRuntime?.close();
      runtimeFixtures.delete(capRoot);
      rmSync(capRoot, { recursive: true, force: true });
    }
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
      second = openFullstackRuntimeTest(root, "registry-security-cross-activation", fullstackTestOwner(root), true, false);
      const kind = `security-cross-activation-${firstClose}`;
      const factory = adapterFactory(kind, () => undefined);
      registerWithRuntime(first, root, kind, factory, capabilities);
      registerWithRuntime(second, root, kind, factory, capabilities);
      const closeFirst = firstClose === "a" ? first : second;
      const stillLive = firstClose === "a" ? second : first;
      closeFirst.close();
      assert.equal(createEscalationAdapter({ adapter: kind, custom: { token: "shared" } }, root, undefined, stillLive.access, stillLive.proofAuthority)?.kind, kind, "the remaining activation lease keeps the cell usable");
      stillLive.close();
      third = openFullstackRuntimeTest(root, "registry-security-cross-activation-check", fullstackTestOwner(root), true, false);
      assert.equal(createEscalationAdapter({ adapter: kind, custom: { token: "closed" } }, root, undefined, third.access, third.proofAuthority), null, "the cell is removed after both activation leases close");
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


test("registry: constructed custom adapter methods fail closed after lease close and replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "adapter-constructed-revoked-"));
  let owner: FullstackRuntime | undefined;
  let replacement: FullstackRuntime | undefined;
  try {
    const runtime = runtimeFor(root);
    owner = openFullstackRuntimeTest(root, "registry-security-custom-owner", fullstackTestOwner(root), true, false);
    const kind = "security-constructed-revoked";
    let sends = 0;
    let polls = 0;
    const factory = (): ReturnType<EscalationAdapterFactory> => ({
      kind,
      send: async () => { sends += 1; return { sent: true }; },
      sendWithIdempotency: async () => { sends += 1; return { sent: true }; },
      cancel: async () => undefined,
      pollOnce: async () => { polls += 1; return []; },
    });
    registerWithRuntime(owner!, root, kind, factory, { ...capabilities, canReceiveInbound: true });
    const old = createEscalationAdapter({ adapter: kind }, root, undefined, runtime.access, runtime.proofAuthority);
    assert.ok(old);
    await old.send({} as Parameters<typeof old.send>[0]);
    await old.pollOnce?.();
    assert.equal(sends, 1);
    assert.equal(polls, 1);

    owner.close();
    await assert.rejects(() => old.send({} as Parameters<typeof old.send>[0]), /custom adapter registration is no longer live/);
    await assert.rejects(() => old.pollOnce!(), /custom adapter registration is no longer live/);
    assert.equal(sends, 1, "revoked direct send never reaches the old transport");
    assert.equal(polls, 1, "revoked direct poll never reaches the old transport");

    replacement = openFullstackRuntimeTest(root, "registry-security-custom-replacement", fullstackTestOwner(root), true, false);
    registerWithRuntime(replacement, root, kind, factory, { ...capabilities, canReceiveInbound: true });
    const fresh = createEscalationAdapter({ adapter: kind }, root, undefined, runtime.access, runtime.proofAuthority);
    assert.ok(fresh);
    await assert.rejects(() => old.send({} as Parameters<typeof old.send>[0]), /custom adapter registration is no longer live/);
    await fresh.send({} as Parameters<typeof fresh.send>[0]);
    assert.equal(sends, 2, "the replacement registration constructs a usable fresh adapter");
  } finally {
    replacement?.close();
    owner?.close();
    rmSync(root, { recursive: true, force: true });
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
