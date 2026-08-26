import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentMapping,
  mappingPreferencesHash,
  readAgentMapping,
  writeAgentMapping,
} from "../src/engine/agent-mapping.js";

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
