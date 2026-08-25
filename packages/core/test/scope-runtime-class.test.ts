import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConditional, resolveScope, runtimeClassForScope, shouldSkip, scopeToRuntimeClass } from "../src/engine/scope.js";
import type { RoleConfig } from "../src/engine/types.js";

function config(scopeMap: RoleConfig["scope_map"], flags: RoleConfig["flags"] = {}): RoleConfig {
  return {
    roles: {},
    roster_overrides: {},
    scope_map: scopeMap,
    flags,
    design_system: null,
  };
}

test("custom scope runtime classes classify without editing core taxonomy", () => {
  const custom = config([
    { glob: ["**/*.rs"], scope: "rust-service", dev_agent: "rust-developer", runtime_class: "runtime" } as RoleConfig["scope_map"][number],
    { glob: ["**/*.md"], scope: "docs", dev_agent: "writer", runtime_class: "ui" } as RoleConfig["scope_map"][number],
  ]);
  const runtime = resolveScope(["src/main.rs"], custom);
  assert.deepEqual(runtime.scope, ["rust-service"]);
  assert.equal(runtime.has_runtime, true);
  assert.equal(runtime.has_ui, false);
  assert.equal(runtime.dev_agent, "rust-developer");
  assert.equal(runtimeClassForScope("rust-service", custom), "runtime");
  assert.equal(scopeToRuntimeClass("rust-service", { "rust-service": "runtime" }), "runtime");

  const docs = resolveScope(["guide/readme.md"], custom);
  assert.equal(docs.has_runtime, false);
  assert.equal(docs.has_ui, true);
});

test("explicit has_runtime flags are additive to runtime scope semantics", () => {
  const custom = config(
    [{ glob: ["**/*.txt"], scope: "notes", dev_agent: "writer", runtime_class: "none" } as RoleConfig["scope_map"][number]],
    { has_runtime: ["**/generated/**"], has_custom: ["**/*.txt"] },
  );
  const flags = resolveScope(["generated/output.txt"], custom);
  assert.deepEqual(flags.scope, ["notes"]);
  assert.equal(flags.has_runtime, true);
  assert.equal(flags.has_custom, true);
  assert.equal(flags.has_ui, false);
  assert.equal(shouldSkip({ skip_if: "scope.has_custom" }, flags), true);
  assert.equal(shouldSkip({ skip_if: "!scope.has_custom" }, flags), false);
  assert.equal(shouldSkip({ skip_if: "scope.unknown" }, flags), false);
  assert.deepEqual(applyConditional(["qa"], [{ if: "scope.has_custom", add: "writer" }], flags), ["qa", "writer"]);
});
