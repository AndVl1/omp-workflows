import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCapability, createCapability } from "../src/engine/durable.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import type { TeamState } from "../src/engine/types.js";

const genericRoles = {
  "regression-planner": "analyst",
  "regression-executor": "manual-qa",
  "regression-oracle": "qa",
  "security-tester": "security-tester",
} as const;

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

function writeState(root: string, capability: NonNullable<TeamState["dispatch_capability"]>, profileHashValue: string): void {
  const profile = loadProfile("feature-regression");
  assert.ok(profile);
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "REGRESS", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "feature-regression" },
    task: "mapping refresh regression",
    stage_cursor: "surface_mapping",
    stages: profile.stages.map(stage => ({
      id: stage.id,
      status: stage.id === "surface_mapping" ? "in_progress" : stage.id === "discovery_intake" ? "done" : "pending",
    })),
    artifacts: {},
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    profile_hash: profileHashValue,
    cursor_epoch: capability.issued_for?.cursor_epoch,
    dispatch_capability: capability,
  }) + "\n");
}

function publishMapping(root: string, availableAgents: string[]): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: genericRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents,
    extraRoles: config.scope_map.map(entry => entry.dev_agent),
    genericFallbackRoles: Object.keys(genericRoles).filter(role => role !== "security-tester"),
  });
  writeAgentMapping(root, mapping);
}

test("beginCapability reissues an undispatched capability after mapping refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-mapping-refresh-"));
  try {
    initGit(root);
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const profile = loadProfile("feature-regression");
    assert.ok(profile);
    const persistedHash = profileHash(profile);
    const stale = createCapability({
      run_key: "main",
      branch: "main",
      workflow: "feature-regression",
      profile_hash: persistedHash,
      stage_cursor: "surface_mapping",
      kind: "single",
      expected_roster: [{ role: "regression-planner", agent: "regression-planner" }],
    });
    publishMapping(root, ["analyst"]);
    writeState(root, stale.state, persistedHash);

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    assert.deepEqual(begun.ok && begun.handoff?.expected_roster, [{ role: "regression-planner", agent: "analyst" }]);
    assert.notEqual(begun.ok && begun.handoff?.capability_id, stale.capability_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("beginCapability fails closed when no eligible or generic agent exists", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-mapping-unavailable-"));
  try {
    initGit(root);
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const profile = loadProfile("feature-regression");
    assert.ok(profile);
    const persistedHash = profileHash(profile);
    publishMapping(root, ["scout"]);
    writeState(root, createCapability({
      run_key: "main",
      branch: "main",
      workflow: "feature-regression",
      profile_hash: persistedHash,
      stage_cursor: "surface_mapping",
      kind: "single",
      expected_roster: [{ role: "regression-planner", agent: "regression-planner" }],
    }).state, persistedHash);

    const begun = beginCapability(root);
    assert.equal(begun.ok, false);
    assert.match(begun.error, /no available agent mapping/);
    assert.match(begun.error, /regression-planner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
