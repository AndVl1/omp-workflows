import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as core from "@andvl1/omp-workflows-core";
import {
  assertWorkflowRuntimeCompatibility,
  FULLSTACK_RUNTIME_CONTRACT,
} from "../src/runtime-compatibility.js";
import { registerWorkflowTools } from "../src/index.js";

test("fullstack: matched checkout runtime registers workflow_handoff", () => {
  assert.equal(typeof core.handoffWorkflow, "function");
  assert.ok(FULLSTACK_RUNTIME_CONTRACT.requires?.includes("workflow_handoff"));
  assert.doesNotThrow(() => assertWorkflowRuntimeCompatibility(core));

  const tools = new Map<string, unknown>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  } as never);
  assert.ok(tools.has("workflow_handoff"));
});

test("fullstack: missing core handoff export fails with an actionable loaded-runtime diagnosis", () => {
  const skewedCore = {
    ...core,
    handoffWorkflow: undefined,
    getCoreRuntimeContract: undefined,
    CORE_RUNTIME_CONTRACT: undefined,
  };

  assert.throws(
    () => assertWorkflowRuntimeCompatibility(skewedCore),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /workflow_handoff|handoffWorkflow/);
      assert.match(error.message, /Loaded @andvl1\/omp-workflows-core version=.* path=/);
      assert.match(error.message, /loaded @andvl1\/omp-workflows-fullstack version=.* path=/);
      assert.match(error.message, /Rebuild both .*install the matched pair.*restart OMP/);
      return true;
    },
  );
});

test("fullstack: a mismatched core contract is rejected before tool registration", () => {
  const coreVersion = core.CORE_RUNTIME_CONTRACT.package.version;
  const skewedVersion = `${coreVersion}-skew`;
  const skewedPath = "/Users/operator/.omp/plugins/node_modules/@andvl1/omp-workflows-core/dist/index.js";
  const skewedContract = {
    ...core.CORE_RUNTIME_CONTRACT,
    package: {
      ...core.CORE_RUNTIME_CONTRACT.package,
      version: skewedVersion,
      path: skewedPath,
    },
  };
  const skewedCore = {
    ...core,
    CORE_RUNTIME_CONTRACT: skewedContract,
    getCoreRuntimeContract: () => skewedContract,
  };

  assert.throws(
    () => assertWorkflowRuntimeCompatibility(skewedCore),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /package versions differ/);
      assert.ok(error.message.includes(`core=${skewedVersion}, fullstack=${FULLSTACK_RUNTIME_CONTRACT.package.version}`));
      assert.ok(error.message.includes(`path=${skewedPath}`));
      assert.match(error.message, /matched pair/);
      return true;
    },
  );
});

