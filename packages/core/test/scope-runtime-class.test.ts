import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConditional, resolveScope, runtimeClassForScope, shouldSkip, scopeToRuntimeClass } from "../src/engine/scope.js";
import type { RoleConfig } from "../src/engine/types.js";
import type { ScopeRuntimeClassTable } from "../src/engine/scope.js";

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

test("scope runtime tables use own keys for prototype-named scopes", () => {
  const table = Object.create({
    constructor: "runtime",
    toString: "ui",
    valueOf: true,
    __proto__: "runtime",
  }) as Record<string, string | boolean>;
  Object.defineProperty(table, "constructor", { configurable: true, enumerable: true, value: "runtime" });
  Object.defineProperty(table, "toString", { configurable: true, enumerable: true, value: "ui" });
  Object.defineProperty(table, "valueOf", { configurable: true, enumerable: true, value: false });
  Object.defineProperty(table, "__proto__", { configurable: true, enumerable: true, value: "none" });

  assert.equal(runtimeClassForScope("constructor", table as ScopeRuntimeClassTable), "runtime");
  assert.equal(runtimeClassForScope("toString", table as ScopeRuntimeClassTable), "ui");
  assert.equal(runtimeClassForScope("valueOf", table as ScopeRuntimeClassTable), false);
  assert.equal(runtimeClassForScope("__proto__", table as ScopeRuntimeClassTable), "none");
  assert.equal(runtimeClassForScope("missing", table as ScopeRuntimeClassTable), null);

  const scopes = config([
    { glob: ["constructor.ts"], scope: "constructor", dev_agent: "agent" },
    { glob: ["toString.ts"], scope: "toString", dev_agent: "agent" },
    { glob: ["valueOf.ts"], scope: "valueOf", dev_agent: "agent" },
    { glob: ["proto.ts"], scope: "__proto__", dev_agent: "agent" },
  ]);
  const flags = resolveScope(
    ["constructor.ts", "toString.ts", "valueOf.ts", "proto.ts"],
    scopes,
    { runtimeClasses: table as ScopeRuntimeClassTable },
  );
  assert.equal(flags.has_runtime, true);
  assert.equal(flags.has_ui, true);
});

test("malformed runtime metadata fails closed without calling trim on non-strings", () => {
  const table = { bad: { trim: () => { throw new Error("must not call trim"); } } };
  assert.doesNotThrow(() => runtimeClassForScope("bad", table as unknown as ScopeRuntimeClassTable));
  assert.equal(runtimeClassForScope("bad", table as unknown as ScopeRuntimeClassTable), null);
  const malformed = config([
    { glob: ["**/*.ts"], scope: "bad", dev_agent: "agent", runtime_class: { invalid: true } as unknown as string },
  ]);
  assert.doesNotThrow(() => resolveScope(["main.ts"], malformed));
  const flags = resolveScope(["main.ts"], malformed);
  assert.equal(flags.has_runtime, false);
  assert.equal(flags.has_ui, false);
});
