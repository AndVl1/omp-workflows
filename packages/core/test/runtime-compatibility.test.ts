import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertWorkflowBundleCompatibility,
  CORE_RUNTIME_CONTRACT,
  FULLSTACK_RUNTIME_LABEL,
  registerTeamWorkflow,
  WORKFLOW_HANDOFF_CAPABILITY,
  WORKFLOW_RUNTIME_PROTOCOL,
} from "../src/index.js";

const matchedFullstackContract = {
  protocol: WORKFLOW_RUNTIME_PROTOCOL,
  package: {
    name: "@andvl1/omp-workflows-fullstack",
    version: CORE_RUNTIME_CONTRACT.package.version,
    path: "/fixture/fullstack/dist/runtime-compatibility.js",
  },
  capabilities: [WORKFLOW_HANDOFF_CAPABILITY],
  requires: [WORKFLOW_HANDOFF_CAPABILITY],
} as const;

function fakeExtensionApi(): Parameters<typeof registerTeamWorkflow>[0] {
  return {
    setLabel: () => undefined,
    on: () => undefined,
  } as never;
}

test("core: matched fullstack runtime contract is accepted", () => {
  assert.doesNotThrow(() => assertWorkflowBundleCompatibility(matchedFullstackContract));
  assert.doesNotThrow(() => {
    registerTeamWorkflow(fakeExtensionApi(), {
      label: FULLSTACK_RUNTIME_LABEL,
      runtimeContract: matchedFullstackContract,
    });
  });
});

test("core: stale fullstack registration fails with loaded package versions and paths", () => {
  assert.throws(
    () => registerTeamWorkflow(fakeExtensionApi(), { label: FULLSTACK_RUNTIME_LABEL }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Incompatible omp workflow runtime/);
      assert.match(error.message, /@andvl1\/omp-workflows-core version=.* path=/);
      assert.match(error.message, /@andvl1\/omp-workflows-fullstack version=.* path=/);
      assert.match(error.message, /Rebuild both .*install the matched pair.*restart OMP/);
      return true;
    },
  );
});

test("core: a skewed fullstack version is rejected before hook registration", () => {
  const coreVersion = CORE_RUNTIME_CONTRACT.package.version;
  const skewedVersion = `${coreVersion}-skew`;
  const skewedPath = "/Users/operator/.omp/plugins/node_modules/@andvl1/omp-workflows-fullstack/dist/index.js";
  const skewed = {
    ...matchedFullstackContract,
    package: {
      ...matchedFullstackContract.package,
      version: skewedVersion,
      path: skewedPath,
    },
  };
  assert.throws(
    () => registerTeamWorkflow(fakeExtensionApi(), { label: FULLSTACK_RUNTIME_LABEL, runtimeContract: skewed }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /package versions differ/);
      assert.ok(error.message.includes(`core=${coreVersion}, fullstack=${skewedVersion}`));
      assert.ok(error.message.includes(`path=${skewedPath}`));
      return true;
    },
  );
});
