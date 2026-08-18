import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentMapping,
  readAgentMapping,
  writeAgentMapping,
} from "../src/engine/agent-mapping.js";

test("agent mapping prefers configured agents and degrades eligible roles to task", () => {
  const mapping = buildAgentMapping({
    roles: {
      "regression-planner": "analyst",
      "regression-executor": "manual-qa",
      "security-tester": "security-tester",
    },
    fallbackChains: {
      "regression-planner": ["analyst", "diagnostics"],
      "regression-executor": ["manual-qa", "qa"],
      "security-tester": ["security-tester"],
    },
    availableAgents: ["task", "qa"],
    genericFallbackRoles: ["regression-planner", "regression-executor"],
  });

  assert.equal(mapping.resolved_roles["regression-planner"], "task");
  assert.equal(mapping.diagnostics["regression-planner"]?.status, "fallback");
  assert.equal(mapping.resolved_roles["regression-executor"], "qa");
  assert.equal(mapping.diagnostics["regression-executor"]?.status, "fallback");
  assert.equal(mapping.resolved_roles["security-tester"], undefined);
  assert.equal(mapping.diagnostics["security-tester"]?.status, "unavailable");
  assert.ok(mapping.unresolved_roles.includes("security-tester"));
});

test("agent mapping persists atomically and rejects malformed files", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-agent-mapping-"));
  try {
    const mapping = buildAgentMapping({
      roles: { analyst: "analyst" },
      availableAgents: ["analyst"],
    });
    const path = writeAgentMapping(root, mapping);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, 1);
    assert.deepEqual(readAgentMapping(root), mapping);

    writeFileSync(path, "{broken", "utf8");
    assert.equal(readAgentMapping(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
