import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/engine/config.js";
import { RuntimeConfigError, resolveRuntimeConfigPath, writeConfig } from "../src/runtime-config.js";
import {
  resetWorkflowOwners,
  writeRuntimeConfig as writeRuntimeConfigFromBarrel,
  RuntimeConfigError as BarrelRuntimeConfigError,
  buildDoWorkPrompt,
  resolveRuntimeConfigPath as barrelResolveRuntimeConfigPath,
  runtimeClassForScope,
  scopeToRuntimeClass,
  writeConfig as barrelWriteConfig,
} from "../src/index.js";

import * as coreBarrel from "../src/index.js";
function projectRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".omp"), { recursive: true });
  return root;
}
test("core barrel exposes runtime config and scope APIs", () => {
  assert.equal(BarrelRuntimeConfigError, RuntimeConfigError);
  assert.equal(barrelResolveRuntimeConfigPath, resolveRuntimeConfigPath);
  assert.equal(barrelWriteConfig, writeConfig);
  assert.equal("DEFAULT_SCOPE_RUNTIME_CLASSES" in coreBarrel, false, "core must not export a domain runtime-class table");
  assert.equal(runtimeClassForScope("backend-kotlin"), null, "unknown scopes classify to null without a caller table");
  assert.equal(scopeToRuntimeClass("custom", { custom: "runtime" }), "runtime");
});

test("do-work reader falls back to a valid legacy .claude config", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-legacy-config-"));
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "team.config.json"), JSON.stringify({
      roles: { analyst: "legacy-analyst" },
      unknown_metadata: { preserved: true },
    }));

    const prompt = buildDoWorkPrompt({ task: "legacy config", autonomyHint: false, issue: null, branch: null }, root);
    assert.match(prompt, /Source: `legacy`/);
    assert.match(prompt, /\| `analyst` \| `legacy-analyst` \|/);
    assert.match(prompt, /Diagnostics: none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work reader surfaces malformed .omp config without falling through to .claude", () => {
  const root = projectRoot("do-work-malformed-first-config-");
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "team.config.json"), JSON.stringify({
      roles: { analyst: "legacy-analyst" },
    }));
    writeFileSync(join(root, ".omp", "team.config.json"), "{broken");

    const prompt = buildDoWorkPrompt({ task: "malformed config", autonomyHint: false, issue: null, branch: null }, root);
    assert.match(prompt, /Source: `omp`/);
    assert.match(prompt, /Diagnostics \(configuration is not silently ignored\):/);
    assert.match(prompt, /\- \[malformed\].*\.omp.*team\.config\.json/);
    assert.doesNotMatch(prompt, /legacy-analyst/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config precedence is explicit and malformed first config never falls through", () => {
  const root = projectRoot("omp-config-precedence-");
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "team.config.json"), JSON.stringify({ roles: { analyst: "legacy-analyst" } }));
    writeFileSync(join(root, ".omp", "team.config.json"), "{broken");

    const config = resolveConfig(root);
    assert.equal(config.config_source, "omp");
    assert.equal(config.diagnostic?.code, "malformed");
    assert.equal(config.config_path, realpathSync(join(root, ".omp", "team.config.json")));
    // INT-001: a malformed config never silently substitutes domain defaults;
    // resolution degrades to the caller preset (none here) plus diagnostics.
    assert.equal(config.roles.analyst, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer preserves unknown metadata and records explicit writer provenance", () => {
  const root = projectRoot("omp-config-metadata-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    writeFileSync(path, JSON.stringify({
      roles: { analyst: "old-analyst" },
      metadata: { version: "v1", custom: { keep: true } },
      unknown_top_level: { keep: "yes" },
    }) + "\n");

    writeConfig(path, { roles: { analyst: "new-analyst" } }, {
      cwd: root,
      writer: "runtime-config-test",
      provenance: { package: "test", entrypoint: "writer" },
      version: "v2",
    });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    assert.equal(parsed.roles.analyst, "new-analyst");
    assert.deepEqual(parsed.metadata.custom, { keep: true });
    assert.deepEqual(parsed.unknown_top_level, { keep: "yes" });
    assert.equal(parsed.metadata.writer, "runtime-config-test");
    assert.equal(parsed.metadata.version, "v2");
    assert.deepEqual(parsed.metadata.provenance, { package: "test", entrypoint: "writer" });
    const config = resolveConfig(root);
    assert.equal(config.config_writer, "runtime-config-test");
    assert.deepEqual(config.unknown_metadata, { unknown_top_level: { keep: "yes" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer rejects cwd mismatch, traversal and symlink escape before side effects", () => {
  const first = projectRoot("omp-config-cwd-a-");
  const second = projectRoot("omp-config-cwd-b-");
  const outside = mkdtempSync(join(tmpdir(), "omp-config-outside-"));
  try {
    const firstPath = join(first, ".omp", "team.config.json");
    assert.throws(
      () => writeConfig(firstPath, { roles: { analyst: "wrong-cwd" } }, { cwd: second }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === "cwd_mismatch",
    );
    assert.equal(existsSync(firstPath), false);
    assert.throws(
      () => writeConfig(join(first, ".omp", "..", "escape.json"), { roles: {} }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === "path_invalid",
    );

    const symlinkRoot = mkdtempSync(join(tmpdir(), "omp-config-symlink-"));
    symlinkSync(outside, join(symlinkRoot, ".omp"), "dir");
    assert.throws(
      () => writeConfig(join(symlinkRoot, ".omp", "team.config.json"), { roles: {} }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === "path_invalid",
    );
    assert.equal(existsSync(join(outside, "team.config.json")), false);
    rmSync(symlinkRoot, { recursive: true, force: true });
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writer surfaces an existing malformed document instead of replacing it", () => {
  const root = projectRoot("omp-config-malformed-write-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    writeFileSync(path, "{broken");
    assert.throws(
      () => writeConfig(path, { roles: { analyst: "replacement" } }, { cwd: root }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === "config_malformed",
    );
    assert.equal(readFileSync(path, "utf8"), "{broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session seed writes the config once and never clobbers user customization", () => {
  const root = projectRoot("runtime-config-seed-");
  try {
    const owner = {
      owner_id: "seed-test",
      bundle_id: "seed-test",
      owner_kind: "fullstack" as const,
      activation_marker: "test",
      host_range: "*",
      provenance: { package: "seed-test", entrypoint: "dist/index.js", cwd: root, config_path: join(root, ".omp", "team.config.json") },
    };
    const opts = {
      roles: { backend: "preset-dev" },
      scopeMap: [{ glob: ["**/*.kt"], scope: "jvm", dev_agent: "preset-dev" }],
      flags: {},
      owner,
    };
    const first = writeRuntimeConfigFromBarrel(opts, root);
    assert.ok(first?.endsWith(join(".omp", "team.config.json")));
    assert.match(readFileSync(first!, "utf8"), /preset-dev/);

    writeFileSync(first!, `${JSON.stringify({ roles: { backend: "my-rust-agent" }, scope_map: [{ glob: ["**/*.rs"], scope: "rust", dev_agent: "my-rust-agent" }], design_system: null }, null, 2)}\n`);
    const second = writeRuntimeConfigFromBarrel(opts, root);
    assert.equal(second, first);
    const after = JSON.parse(readFileSync(first!, "utf8"));
    assert.equal(after.roles.backend, "my-rust-agent", "user roles must survive a session seed");
    assert.equal(after.scope_map[0].scope, "rust", "user scope_map must survive a session seed");
  } finally {
    resetWorkflowOwners(root);
    rmSync(root, { recursive: true, force: true });
  }
});
