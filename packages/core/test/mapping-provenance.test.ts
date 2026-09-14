import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentMapping,
  mappingPreferencesHash,
  readAgentMapping,
  writeAgentMapping,
} from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";

test("mapping hash binds roles, scope, flags, roster, config and provider provenance", () => {
  const base = {
    scope_map: [{ glob: ["**/*.ts"], scope: "frontend", dev_agent: "frontend-developer" }],
    flags: { has_runtime: ["**/runtime/**"] },
    roster: { review: { add: ["qa"] } },
    config_path: "/worktree/.omp/team.config.json",
    config_source: "omp",
    config_hash: "config-a",
    config_version: "v1",
    config_provenance: { writer: "test" },
    provider_discovery: ["analyst", "task"],
    source: "fullstack",
  } as const;
  const hash = mappingPreferencesHash({ analyst: "analyst" }, ["frontend-developer"], base);
  for (const [key, value] of Object.entries({
    roles: { reviewer: "qa" },
    scope_map: [{ glob: ["**/*.go"], scope: "go", dev_agent: "developer-go" }],
    flags: { has_runtime: ["**/other/**"] },
    roster: { review: { add: ["security-tester"] } },
    config_hash: "config-b",
    config_version: "v2",
    provider_discovery: ["analyst", "qa"],
    source: "other-bundle",
  })) {
    const candidate = { ...base, [key]: value };
    const candidateHash = mappingPreferencesHash(
      key === "roles" ? candidate.roles : { analyst: "analyst" },
      ["frontend-developer"],
      candidate,
    );
    assert.notEqual(candidateHash, hash, `hash must change for ${key}`);
  }
});

test("mapping reader rejects stale config/provider/source and keeps worktrees isolated", () => {
  const first = mkdtempSync(join(tmpdir(), "omp-map-provenance-a-"));
  const second = mkdtempSync(join(tmpdir(), "omp-map-provenance-b-"));
  try {
    mkdirSync(join(first, ".omp"), { recursive: true });
    const mapping = buildAgentMapping({
      roles: { analyst: "analyst" },
      availableAgents: ["analyst", "task"],
      source: "fullstack",
      config_source: "omp",
      config_hash: "config-a",
      config_version: "v1",
    });
    writeAgentMapping(first, mapping);
    assert.deepEqual(readAgentMapping(first), mapping);
    assert.equal(readAgentMapping(first, { source: "other-bundle" }), undefined);
    assert.equal(readAgentMapping(first, { config_source: "legacy" }), undefined);
    assert.equal(readAgentMapping(first, { config_hash: "config-b" }), undefined);
    assert.equal(readAgentMapping(first, { config_version: "v2" }), undefined);
    assert.equal(readAgentMapping(first, { availableAgents: ["analyst"] }), undefined);
    assert.equal(readAgentMapping(first, { roles: { analyst: "other" }, extraRoles: [] }), undefined);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("mapping survives JSON reload when fallback-chain keys are reordered", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-map-reordered-fallbacks-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "team.config.json"),
      JSON.stringify({ roles: { primary: "missing-primary" } }) + "\n",
      "utf8",
    );
    const config = resolveConfig(root);
    const mapping = buildAgentMapping({
      roles: config.roles,
      availableAgents: ["task"],
      fallbackChains: {
        primary: ["missing-primary"],
        zebra: ["missing-zebra"],
        alpha: ["missing-alpha"],
      },
      genericFallbackRoles: [],
      source: "mapping-provenance-test",
      scope_map: config.scope_map,
      flags: config.flags,
      roster: config.roster_overrides,
      config_path: config.config_path,
      config_source: config.config_source,
      config_hash: config.config_hash,
      config_version: config.config_version,
      config_provenance: config.config_provenance,
    });
    writeAgentMapping(root, mapping);

    const path = join(root, ".work-state", "runtime", "agent-mapping.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      provenance: { fallback_chains: Record<string, readonly string[]> };
    };
    persisted.provenance.fallback_chains = Object.fromEntries(
      Object.entries(persisted.provenance.fallback_chains).reverse(),
    );
    writeFileSync(path, JSON.stringify(persisted) + "\n", "utf8");

    const expected = {
      roles: config.roles,
      extraRoles: config.scope_map.map((entry) => entry.dev_agent),
      scope_map: config.scope_map,
      flags: config.flags,
      roster: config.roster_overrides,
      config_path: config.config_path,
      config_source: config.config_source,
      config_hash: config.config_hash,
      config_version: config.config_version,
      config_provenance: config.config_provenance,
    };
    const reloaded = readAgentMapping(root, expected);
    assert.ok(reloaded, "reordered persisted fallback chains remain readable");
    assert.deepEqual(resolveConfig(root).agent_mapping?.unresolved_roles, mapping.unresolved_roles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveConfig accepts only a canonical mapping recomputed from current config provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-map-recompute-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { analyst: "analyst", reviewer: "reviewer" } }) + "\n", "utf8");
    const config = resolveConfig(root);
    const mapping = buildAgentMapping({
      roles: config.roles,
      availableAgents: ["analyst", "reviewer", "task"],
      extraRoles: config.scope_map.map((entry) => entry.dev_agent),
      genericFallbackRoles: Object.keys(config.roles),
      source: "mapping-provenance-test",
      scope_map: config.scope_map,
      flags: config.flags,
      roster: config.roster_overrides,
      config_path: config.config_path,
      config_source: config.config_source,
      config_hash: config.config_hash,
      config_version: config.config_version,
      config_provenance: config.config_provenance,
    });
    writeAgentMapping(root, mapping);
    const accepted = resolveConfig(root).agent_mapping;
    assert.ok(accepted, "an exact builder output remains trusted");
    assert.deepEqual(accepted?.resolved_roles, mapping.resolved_roles);
    assert.deepEqual(accepted?.diagnostics, mapping.diagnostics);
    assert.deepEqual(accepted?.unresolved_roles, mapping.unresolved_roles);

    const path = join(root, ".work-state", "runtime", "agent-mapping.json");
    const tampered = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const tamperedResolved = { ...(tampered.resolved_roles as Record<string, string>), analyst: "task" };
    tampered.resolved_roles = tamperedResolved;
    writeFileSync(path, JSON.stringify(tampered) + "\n", "utf8");
    assert.equal(resolveConfig(root).agent_mapping, undefined, "a redirected resolved role is not trusted");

    const tamperedPreferences = { ...mapping, preferences_hash: "0".repeat(64) } as unknown as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(tamperedPreferences) + "\n", "utf8");
    assert.equal(resolveConfig(root).agent_mapping, undefined, "a self-stored preference hash cannot authorize a mapping");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
