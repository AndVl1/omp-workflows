/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/index.js";
import * as engineConfig from "../src/engine/config.js";
import * as runtimeConfig from "../src/runtime-config.js";
import { createCanonicalRoot } from "../src/workflow-v2/identity.js";
import { readPolicySnapshot } from "../src/workflow-v2/policy.js";
import { createTestDescriptorRelativeFsAuthority } from "../src/workflow-v2/fs-authority.js";
function rootFor(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".omp"), { recursive: true });
  return root;
}

test("runtime-config has no runtime authority, seed writer, or fallback exports", () => {
  assert.deepEqual(Object.keys(runtimeConfig), []);
  for (const removed of ["resolveRuntimeConfigPath", "writeConfig", "writeRuntimeConfig", "RuntimeConfigError"]) {
    assert.equal(removed in runtimeConfig, false, `${removed} must remain removed from the runtime module`);
    assert.equal(removed in engineConfig, false, `${removed} must remain removed from engine/config`);
    assert.equal(removed in core, false, `${removed} must remain removed from the core barrel`);
  }
});

test("engine config exposes policy-v2 seams instead of legacy configuration resolution", () => {
  assert.equal(engineConfig.readPolicySnapshot, readPolicySnapshot);
  for (const exported of [
    "parsePolicyDocument",
    "parsePolicyBytes",
    "parseStrictJsonValue",
    "computePolicyByteHash",
    "computePolicySemanticHash",
    "mergePolicy",
    "writePolicyDocument",
  ]) {
    assert.equal(exported in engineConfig, true, `${exported} is a v2 config seam`);
  }
  for (const removed of ["resolveConfig", "ConfigPreset", "ConfigSource", "agentMappingPath", "buildAgentMapping"]) {
    assert.equal(removed in engineConfig, false, `${removed} must not be a runtime policy authority`);
  }
});

test("policy resolution remains exact .omp-only even when legacy .claude data exists", () => {
  const root = rootFor("v2-runtime-authority-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "team.config.json"), JSON.stringify({ roles: { analyst: "legacy" } }));
    const canonical = createCanonicalRoot(root);
    assert.ok(canonical);
    const result = readPolicySnapshot(canonical, filesystemAuthority);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CONFIG_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
