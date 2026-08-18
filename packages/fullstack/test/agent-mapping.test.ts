import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentMapping } from "@andvl1/omp-workflows-core";
import { refreshFullstackAgentMappings, waitForFullstackAgentMappings } from "../src/agent-mapping.js";

test("fullstack refresh publishes the live role mapping without touching team.config", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-refresh-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const configPath = join(root, ".omp", "team.config.json");
    const originalConfig = '{ "roles": { "regression-planner": "analyst" } }\n';
    writeFileSync(configPath, originalConfig);
    const result = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "analyst" }, { name: "task" }],
    }));

    assert.equal(result.diagnostics["regression-planner"]?.status, "preferred");
    assert.equal(result.resolved_roles["regression-planner"], "analyst");
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.deepEqual(readAgentMapping(root), result);
    assert.deepEqual(await waitForFullstackAgentMappings(root), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack refresh uses generic task when a specialized planner is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-fallback-"));
  try {
    const result = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "task" }],
    }));

    assert.equal(result.resolved_roles["regression-planner"], "task");
    assert.equal(result.diagnostics["regression-planner"]?.status, "fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
