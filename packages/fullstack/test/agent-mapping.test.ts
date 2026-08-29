import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowV2Digest,
  type ActualAgentInventory,
  type AgentInventoryAuthority,
  type AgentInventoryAuthorityContext,
  type AgentRef,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
  buildFullstackAgentMapping,
  createTestFullstackInventoryAdmissionContext,
  readFullstackAgentMapping,
  validateFullstackInventoryAdmission,
  writeFullstackAgentMapping,
  type AgentMappingContext,
  type AgentMappingStorage,
  type FullstackAgentMapping,
  type FullstackInventoryAdmissionContext,
} from "../src/agent-mapping.js";
import { runtimeFixture, type RuntimeFixture } from "./runtime-fixtures.js";

type AgentSource = AgentMappingContext["agent_sources"][number];

function sourceFingerprint(seed: string): WorkflowV2Digest {
  const value = createWorkflowV2Digest(
    `sha256:${createHash("sha256").update(seed, "utf8").digest("hex")}`,
  );
  if (!value) throw new Error("test source fingerprint should be valid");
  return value;
}

function inventoryFingerprint(agents: readonly AgentRef[]): WorkflowV2Digest {
  const value = createWorkflowV2Digest(
    `sha256:${createHash("sha256").update(JSON.stringify(agents.map((agent) => ({
      provider_id: agent.provider_id,
      registered_name: agent.registered_name,
      source_fingerprint: agent.source_fingerprint,
    }))), "utf8").digest("hex")}`,
  );
  if (!value) throw new Error("test inventory fingerprint should be valid");
  return value;
}

function sourceFor(fixture: RuntimeFixture, names: readonly string[]): AgentSource {
  return Object.freeze({
    provider_id: fixture.project_identity.provider_id,
    source_fingerprint: sourceFingerprint(`source:${names.join(",")}`),
    registered_names: Object.freeze([...names]),
  });
}

function agent(
  fixture: RuntimeFixture,
  source: AgentSource,
  registered_name: string,
): AgentRef {
  return Object.freeze({
    registered_name,
    provider_id: fixture.project_identity.provider_id,
    source_fingerprint: source.source_fingerprint,
  });
}

function inventoryAdmission(
  fixture: RuntimeFixture,
  agents: readonly AgentRef[],
  reservationId = "reservation-1",
): FullstackInventoryAdmissionContext {
  const actual: ActualAgentInventory = Object.freeze({
    authority: "omp",
    provider_id: fixture.project_identity.provider_id,
    descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
    agents: Object.freeze([...agents]),
    inventory_fingerprint: inventoryFingerprint(agents),
    reservation: Object.freeze({
      reservation_id: reservationId,
      fingerprint: sourceFingerprint(`reservation:${reservationId}`),
    }),
  });
  const authority: AgentInventoryAuthority = {
    resolve: () => ({ ok: true, value: actual, diagnostics: [] }),
  };
  const authorityContext = Object.freeze({
    canonical_root: fixture.project_root,
    session: fixture.project_identity.session,
    provider_id: fixture.project_identity.provider_id,
    descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
    descriptor: Object.freeze({}),
    catalog: Object.freeze({}),
    effective_policy: Object.freeze({}),
  }) as unknown as AgentInventoryAuthorityContext;
  const admission = createTestFullstackInventoryAdmissionContext({
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    canonical_root: fixture.project_root,
    agent_inventory: actual,
    agent_inventory_authority: authority,
    authority_context: authorityContext,
  });
  if (!admission) throw new Error("test inventory admission should be issued");
  return admission;
}

function inMemoryStorage(): AgentMappingStorage {
  let persisted: FullstackAgentMapping | undefined;
  return {
    read: () => persisted,
    write: (mapping) => {
      persisted = mapping;
    },
  };
}


test("fullstack mapping builds and publishes through injected storage without touching team.config", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-refresh-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const configPath = join(root, ".omp", "team.config.json");
    const originalConfig = '{ "roles": { "regression-planner": "analyst" } }\n';
    writeFileSync(configPath, originalConfig);

    const fixture = runtimeFixture(root);
    const source = sourceFor(fixture, ["analyst", "task"]);
    const analyst = agent(fixture, source, "analyst");
    const task = agent(fixture, source, "task");
    const admission = inventoryAdmission(fixture, [analyst, task]);
    const storage = inMemoryStorage();
    const context: AgentMappingContext = {
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      roles: { "regression-planner": analyst },
      inventory_admission: admission,
      storage,
    };

    const built = buildFullstackAgentMapping(context);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.value.diagnostics["regression-planner"]?.status, "preferred");
    assert.deepEqual(built.value.project_identity, fixture.project_identity);
    assert.deepEqual(built.value.run_identity, fixture.run_identity);
    assert.equal(built.value.agent_inventory_authority, "omp");
    assert.equal(built.value.agent_inventory_fingerprint, admission.agent_inventory.inventory_fingerprint);
    assert.deepEqual(built.value.agent_inventory_reservation, admission.agent_inventory.reservation);

    const published = writeFullstackAgentMapping(context);
    assert.equal(published.ok, true);
    if (!published.ok) return;
    assert.deepEqual(published.value.resolved_roles["regression-planner"], analyst);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);

    const expected = {
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      inventory_admission: admission,
    };
    assert.deepEqual(readFullstackAgentMapping(storage, expected), published.value);
    assert.equal(
      readFullstackAgentMapping(storage, {
        ...expected,
        run_identity: runtimeFixture(root, { runId: "foreign-run" }).run_identity,
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack mapping leaves regression planner unavailable without a supported specialized fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-fallback-"));
  try {
    const fixture = runtimeFixture(root);
    const source = sourceFor(fixture, ["analyst", "task"]);
    const task = agent(fixture, source, "task");
    const admission = inventoryAdmission(fixture, [task]);
    const result = buildFullstackAgentMapping({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      roles: { "regression-planner": agent(fixture, source, "analyst") },
      inventory_admission: admission,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.resolved_roles["regression-planner"], undefined);
    assert.equal(result.value.diagnostics["regression-planner"]?.status, "unavailable");
    assert.ok(result.value.unresolved_roles.includes("regression-planner"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack mapping keeps security review unavailable without its specialist", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-security-"));
  try {
    const fixture = runtimeFixture(root);
    const source = sourceFor(fixture, ["security-tester", "task"]);
    const task = agent(fixture, source, "task");
    const admission = inventoryAdmission(fixture, [task]);
    const result = buildFullstackAgentMapping({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      roles: { "security-tester": agent(fixture, source, "security-tester") },
      inventory_admission: admission,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.resolved_roles["security-tester"], undefined);
    assert.equal(result.value.diagnostics["security-tester"]?.status, "unavailable");
    assert.ok(result.value.unresolved_roles.includes("security-tester"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack mapping rejects bare inventory arrays and missing reservations", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-admission-"));
  try {
    const fixture = runtimeFixture(root);
    const source = sourceFor(fixture, ["analyst"]);
    const analyst = agent(fixture, source, "analyst");
    const result = buildFullstackAgentMapping({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      roles: { analyst },
      inventory_admission: {
        available_agents: [analyst],
      } as never,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.diagnostics[0]?.code, "CAPABILITY_MISSING");

    const withoutReservation = {
      authority: "omp" as const,
      provider_id: fixture.project_identity.provider_id,
      descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
      agents: [analyst],
      inventory_fingerprint: inventoryFingerprint([analyst]),
    } as unknown as ActualAgentInventory;
    const missingReservationAdmission = createTestFullstackInventoryAdmissionContext({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      canonical_root: fixture.project_root,
      agent_inventory: withoutReservation,
      agent_inventory_authority: {
        resolve: () => ({ ok: true, value: withoutReservation, diagnostics: [] }),
      },
      authority_context: {
        canonical_root: fixture.project_root,
        session: fixture.project_identity.session,
        provider_id: fixture.project_identity.provider_id,
        descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
        descriptor: {},
        catalog: {},
        effective_policy: {},
      } as unknown as AgentInventoryAuthorityContext,
    });
    assert.equal(missingReservationAdmission, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack inventory admission binds the authority context to the explicit canonical root", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-root-binding-"));
  try {
    const fixture = runtimeFixture(root);
    const source = sourceFor(fixture, ["analyst"]);
    const analyst = agent(fixture, source, "analyst");
    const admitted = inventoryAdmission(fixture, [analyst]);
    const wrongRootContext = Object.freeze({
      ...admitted.authority_context,
      canonical_root: `${fixture.project_root}-foreign`,
    }) as unknown as AgentInventoryAuthorityContext;
    const wrongRoot = createTestFullstackInventoryAdmissionContext({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      canonical_root: fixture.project_root,
      agent_inventory: admitted.agent_inventory,
      agent_inventory_authority: {
        resolve: () => ({ ok: true, value: admitted.agent_inventory, diagnostics: [] }),
      },
      authority_context: wrongRootContext,
    });
    assert.equal(wrongRoot, undefined);

    let writes = 0;
    const rejectedMapping = buildFullstackAgentMapping({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      roles: { analyst },
      inventory_admission: wrongRoot as never,
      storage: {
        read: () => undefined,
        write: () => { writes += 1; },
      },
    });
    assert.equal(rejectedMapping.ok, false);
    if (!rejectedMapping.ok) assert.equal(rejectedMapping.diagnostics[0]?.code, "CAPABILITY_MISSING");
    assert.equal(writes, 0);

    const checked = validateFullstackInventoryAdmission(admitted, fixture.project_identity, fixture.run_identity);
    assert.equal(checked.ok, true);
    if (checked.ok) assert.equal(checked.value.canonical_root, fixture.project_root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack mapping rejects a persisted mapping after current OMP availability drifts", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-stale-"));
  try {
    const fixture = runtimeFixture(root);
    const source = sourceFor(fixture, ["analyst", "task"]);
    const analyst = agent(fixture, source, "analyst");
    const task = agent(fixture, source, "task");
    let current = inventoryAdmission(fixture, [analyst, task]);
    const staleAdmission = current;
    const storage = inMemoryStorage();
    const context: AgentMappingContext = {
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      agent_sources: [source],
      roles: { analyst },
      inventory_admission: current,
      storage,
    };
    const written = writeFullstackAgentMapping(context);
    assert.equal(written.ok, true);
    if (!written.ok) return;

    const changed = inventoryAdmission(fixture, [analyst], "reservation-2");
    current = createTestFullstackInventoryAdmissionContext({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      canonical_root: fixture.project_root,
      agent_inventory: changed.agent_inventory,
      agent_inventory_authority: {
        resolve: () => ({ ok: true, value: changed.agent_inventory, diagnostics: [] }),
      },
      authority_context: staleAdmission.authority_context,
    })!;
    assert.notEqual(current.agent_inventory.inventory_fingerprint, staleAdmission.agent_inventory.inventory_fingerprint);
    assert.equal(
      readFullstackAgentMapping(storage, {
        project_identity: fixture.project_identity,
        run_identity: fixture.run_identity,
        agent_sources: [source],
        inventory_admission: current,
      }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
