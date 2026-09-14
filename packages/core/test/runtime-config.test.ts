import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/engine/config.js";
import { resolveScope } from "../src/engine/scope.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { RuntimeConfigError, resolveRuntimeConfigPath, writeConfig } from "../src/runtime-config.js";
import { withTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import {
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

test("writer capture callback failure restores an absent config exactly", () => {
  const root = projectRoot("omp-config-capture-throw-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    assert.throws(
      () => writeConfig(path!, { roles: { analyst: "capture-agent" } }, {
        cwd: root,
        onPublished: () => { throw new Error("capture failed"); },
      }),
      /capture failed/,
    );
    assert.equal(existsSync(path!), false, "capture failure must remove only the publication it captured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer prepublication capture failure leaves an absent config untouched", () => {
  const root = projectRoot("omp-config-before-publish-throw-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    assert.throws(
      () => writeConfig(path!, { roles: { analyst: "capture-agent" } }, {
        cwd: root,
        beforePublish: () => { throw new Error("before publish capture failed"); },
      }),
      /before publish capture failed/,
    );
    assert.equal(existsSync(path!), false, "prepublication capture failure must leave no visible config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer token restores the exact preimage after atomic replacement", () => {
  const root = projectRoot("omp-config-atomic-replacement-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    const original = JSON.stringify({ roles: { analyst: "old-agent" }, unknown: { keep: true } }, null, 2) + "\n";
    writeFileSync(path!, original, "utf8");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const token = writeConfig(path!, { roles: { analyst: "new-agent" } }, { cwd: root, pinnedRoot: pinned });
      assert.ok(token);
      assert.notEqual(readFileSync(path!, "utf8"), original, "atomic write must publish a replacement image");
      assert.equal(token?.rollback(), true, "the token must restore its own atomic postimage");
      assert.equal(readFileSync(path!, "utf8"), original, "rollback must restore the exact prior bytes");
    } finally {
      pinned.close();
    }
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

test("borrowed pinned root rolls back a helper write after root replacement", () => {
  const root = projectRoot("omp-config-pinned-");
  const replacement = projectRoot("omp-config-pinned-replacement-");
  const moved = `${root}-moved`;
  const oldConfig = JSON.stringify({ roles: { incumbent: "old-agent" } }, null, 2) + "\n";
  writeFileSync(join(root, ".omp", "team.config.json"), oldConfig, "utf8");
  let swapped = false;
  const pinned = PinnedProjectRoot.open(root, {
    beforeTempOpen: (relativePath) => {
      if (swapped || relativePath !== ".omp/team.config.json") return;
      swapped = true;
      renameSync(root, moved);
      renameSync(replacement, root);
    },
  });
  assert.ok(pinned);
  if (!pinned) return;
  try {
    const path = resolveRuntimeConfigPath(root, pinned);
    assert.ok(path);
    assert.throws(
      () => writeConfig(path!, { roles: { analyst: "pinned-agent" } }, { cwd: root, pinnedRoot: pinned }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === "path_invalid",
    );
    assert.equal(swapped, true);
    assert.equal(readFileSync(join(moved, ".omp", "team.config.json"), "utf8"), oldConfig, "detached old tree keeps its exact preimage");
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false, "replacement pathname stays untouched");
  } finally {
    pinned.close();
    rmSync(moved, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
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

test("session seed registry abort restores the exact config preimage", () => {
  const root = projectRoot("runtime-config-registry-abort-");
  try {
    writeTestRegistryMarker(root);
    assert.throws(() => withTestRegistry(root, ["runtime_config"], (registration) => {
      writeRuntimeConfigFromBarrel({
        roles: { backend: "abort-agent" },
        owner: () => registration.owner,
        registrationToken: registration.token,
      }, root);
      throw new Error("abort after runtime config publication");
    }), /abort after runtime config publication/);
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false, "registry abort must remove only the owned config postimage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session seed writes the config once and never clobbers user customization", () => {
  const root = projectRoot("runtime-config-seed-");
  try {
    writeTestRegistryMarker(root);
    const first = withTestRegistry(root, ["runtime_config"], (registration) => {
      const opts = {
        roles: { backend: "preset-dev" },
        scopeMap: [{ glob: ["**/*.kt"], scope: "jvm", dev_agent: "preset-dev" }],
        flags: {},
        owner: () => registration.owner,
        registrationToken: registration.token,
      };
      const first = writeRuntimeConfigFromBarrel(opts, root);
      assert.ok(first?.endsWith(join(".omp", "team.config.json")));
      assert.match(readFileSync(first!, "utf8"), /preset-dev/);
      writeFileSync(first!, JSON.stringify({ roles: { backend: "my-rust-agent" }, scope_map: [{ glob: ["**/*.rs"], scope: "rust", dev_agent: "my-rust-agent" }], design_system: null }, null, 2) + String.fromCharCode(10));
      const second = writeRuntimeConfigFromBarrel(opts, root);
      assert.equal(second, first);
      const after = JSON.parse(readFileSync(first!, "utf8"));
      assert.equal(after.roles.backend, "my-rust-agent", "user roles must survive a session seed");
      assert.equal(after.scope_map[0].scope, "rust", "user scope_map must survive a session seed");
      return first;
    });
    assert.ok(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config parser preserves own prototype-named scope keys and rejects malformed classifiers", () => {
  const root = projectRoot("omp-config-scope-prototype-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    const scopeMap = [
      { glob: ["constructor.ts"], scope: "constructor", dev_agent: "agent" },
      { glob: ["toString.ts"], scope: "toString", dev_agent: "agent" },
      { glob: ["valueOf.ts"], scope: "valueOf", dev_agent: "agent" },
      { glob: ["proto.ts"], scope: "__proto__", dev_agent: "agent" },
    ];
    const runtimeClasses: Record<string, string | boolean> = {};
    Object.defineProperty(runtimeClasses, "constructor", { enumerable: true, value: "runtime" });
    Object.defineProperty(runtimeClasses, "toString", { enumerable: true, value: "ui" });
    Object.defineProperty(runtimeClasses, "valueOf", { enumerable: true, value: false });
    Object.defineProperty(runtimeClasses, "__proto__", { enumerable: true, value: "none" });
    writeFileSync(path, JSON.stringify({
      scope_map: scopeMap,
      scope_runtime_classes: runtimeClasses,
      scope_ui_classes: { toString: "not-a-boolean" },
    }));

    const config = resolveConfig(root);
    assert.equal(Object.hasOwn(config.scope_runtime_classes ?? {}, "constructor"), true);
    assert.equal(Object.hasOwn(config.scope_runtime_classes ?? {}, "__proto__"), true);
    assert.ok(config.diagnostics.some(diagnostic => diagnostic.path === "scope_ui_classes.toString"));
    const flags = resolveScope(["constructor.ts", "toString.ts", "valueOf.ts", "proto.ts"], config);
    assert.equal(flags.has_runtime, true);
    assert.equal(flags.has_ui, true, "runtime class 'ui' remains a valid UI classification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config parser reports duplicate scopes and does not route ambiguous entries", () => {
  const root = projectRoot("omp-config-scope-duplicate-");
  try {
    const path = resolveRuntimeConfigPath(root);
    assert.ok(path);
    writeFileSync(path, JSON.stringify({
      scope_map: [
        { glob: ["**/*.ts"], scope: "duplicate", dev_agent: "first" },
        { glob: ["**/*.ts"], scope: "duplicate", dev_agent: "second" },
      ],
      scope_runtime_classes: { duplicate: "runtime" },
    }));
    const config = resolveConfig(root);
    assert.ok(config.diagnostics.some(diagnostic => diagnostic.path === "scope_map[1].scope"));
    const flags = resolveScope(["src/main.ts"], config);
    assert.deepEqual(flags.scope, []);
    assert.equal(flags.has_runtime, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker loss after runtime config publication rolls back the visible postimage", () => {
  const root = projectRoot("runtime-config-marker-publication-");
  writeTestRegistryMarker(root);
  let removed = false;
  try {
    assert.throws(
      () => withTestRegistry(root, ["runtime_config"], (registration) => {
        const path = writeRuntimeConfigFromBarrel({
          roles: { backend: "marker-loss-agent" },
          owner: () => registration.owner,
          registrationToken: registration.token,
        }, root);
        assert.ok(path);
        unlinkSync(join(root, ".omp-test-registry-marker"));
        removed = true;
      }),
      /(?:activation_markers_missing|ENOENT|requested workflow capability is no longer active)/,
    );
    assert.equal(removed, true, "the marker is removed after the config becomes visible");
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false, "marker loss must roll back the runtime config postimage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
