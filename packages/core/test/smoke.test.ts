/**
 * Smoke test for the package split.
 *
 * Verifies:
 *   1. @omp-workflows/core resolves and exports the public API.
 *   2. @omp-workflows/fullstack can import core and call registerTeamWorkflow.
 *   3. The public API surface (8 profiles) is reachable end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackModels,
  loadAllProfiles,
  resolveWorkflow,
  selectProfile,
} from "@omp-workflows/core";

test("core: loadAllProfiles returns 8 profiles", async () => {
  const profiles = await loadAllProfiles();
  assert.equal(profiles.length, 8);
  const names = profiles.map((p) => p.name);
  assert.ok(names.includes("lightweight"));
  assert.ok(names.includes("full-feature"));
  assert.ok(names.includes("debug-cycle"));
});

test("core: resolveWorkflow matrix", () => {
  assert.equal(resolveWorkflow("FEATURE", "QUICK", false), "lightweight");
  assert.equal(resolveWorkflow("FEATURE", "MEDIUM", false), "standard");
  assert.equal(resolveWorkflow("FEATURE", "COMPLEX", false), "full-feature");
  assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix");
  assert.equal(resolveWorkflow("BUG_FIX", "MEDIUM", true), "debug-cycle");
  assert.equal(resolveWorkflow("HOTFIX", "QUICK", false), "emergency");
  assert.equal(resolveWorkflow("INVESTIGATION", "QUICK", false), "research");
  assert.equal(resolveWorkflow("REVIEW", "QUICK", false), "review");
});

test("core: selectProfile resolves to the right profile", async () => {
  const profiles = await loadAllProfiles();
  const p = selectProfile(profiles, {
    type: "FEATURE", complexity: "QUICK", confidence: "HIGH", workflow: "lightweight",
  });
  assert.ok(p);
  assert.equal(p.name, "lightweight");
  assert.deepEqual(p.stages.map((s) => s.id), [
    "discovery", "implementation", "code_review", "review_fixes", "qa_tests", "summary",
  ]);
});
test("core: defaultFullstackRoles has 16 slots (15 dev + 3 architect variants)", () => {
  const keys = Object.keys(defaultFullstackRoles);
  assert.equal(keys.length, 16);
  assert.equal(defaultFullstackRoles["backend-kotlin"], "developer-kotlin");
  assert.equal(defaultFullstackRoles["frontend"], "frontend-developer");
  assert.equal(defaultFullstackRoles["mobile"], "developer-mobile");
});
test("core: defaultFullstackModels has expected model assignments", () => {
  assert.equal(defaultFullstackModels["architect"], "opus");
  assert.equal(defaultFullstackModels["tech-researcher"], "haiku");
  assert.equal(defaultFullstackModels["*"], "sonnet");
});

test("core: registerTeamWorkflow registers gates + commands", () => {
  const calls: Array<{ kind: string; key: string }> = [];
  const fakePi = {
    setLabel: (label: string) => { calls.push({ kind: "setLabel", key: label }); },
    on: (event: string) => { calls.push({ kind: "on", key: event }); return undefined; },
    registerCommand: (name: string) => { calls.push({ kind: "registerCommand", key: name }); },
  };
  registerTeamWorkflow(fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0], {
    label: "smoke-test",
    roles: defaultFullstackRoles,
    models: defaultFullstackModels,
  });
  assert.ok(calls.some((c) => c.kind === "on" && c.key === "before_agent_start"));
  assert.ok(calls.some((c) => c.kind === "on" && c.key === "session_stop"));
  assert.ok(calls.some((c) => c.kind === "on" && c.key === "tool_call"));
  for (const cmd of ["team", "team-next", "team-yolo", "pulse", "init-team", "interview", "coordinator-stats"]) {
    assert.ok(calls.some((c) => c.kind === "registerCommand" && c.key === cmd), `missing ${cmd}`);
  }
});

test("core: registerTeamWorkflow respects commands subset", () => {
  const calls: string[] = [];
  const fakePi = {
    setLabel: () => undefined,
    on: () => undefined,
    registerCommand: (name: string) => { calls.push(name); },
  };
  registerTeamWorkflow(fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0], {
    commands: ["team", "pulse"],
  });
  assert.deepEqual(calls.sort(), ["pulse", "team"]);
});

test("fullstack: bundle imports core and registers engine", async () => {
  const core = await import("@omp-workflows/core");
  assert.equal(typeof core.registerTeamWorkflow, "function");
  assert.equal(typeof core.defaultFullstackRoles, "object");
  assert.equal(Object.keys(core.defaultFullstackRoles).length, 16);
});

test("fullstack: default empty registerTeamWorkflow does not crash", () => {
  const fakePi = {
    setLabel: () => undefined,
    on: () => undefined,
    registerCommand: () => undefined,
  };
  assert.doesNotThrow(() => registerTeamWorkflow(fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0]));
});
