import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerWorkflowTools } from "../src/index.js";

type RegisteredTool = {
  name: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};
function writeBeginFixture(root: string, branch: string): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
    schema: 1,
    branch,
    run_key: branch,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: "lightweight",
    },
    task: "cwd binding regression",
    stage_cursor: "discovery",
    stages: [{ id: "discovery", status: "in_progress" }],
    artifacts: {},
    scope: {
      scope: [],
      has_security: false,
      has_infra: false,
      has_ui: false,
      has_runtime: false,
      dev_agent: "developer-kotlin",
    },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
  }) + "\n");
}

test("fullstack: workflow tools register and fail closed with structured responses", async () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  assert.deepEqual([...tools.keys()], ["workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance"]);
  for (const name of tools.keys()) {
    assert.ok(tools.get(name)?.parameters, `${name} exposes a parameter schema`);
  }

  const begin = tools.get("workflow_begin")!;
  const workerBeginResult = await begin.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerBeginResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  const status = tools.get("workflow_status")!;
  const beginResult = await begin.execute("test", {}, undefined, undefined, null);
  const statusResult = await status.execute("test", {}, undefined, undefined, null);
  const complete = tools.get("workflow_complete")!;
  const advance = tools.get("workflow_advance")!;
  const completeResult = await complete.execute("test", {
    dispatch_id: "dispatch",
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    evidence: "evidence",
  }, undefined, undefined, null);
  const advanceResult = await advance.execute("test", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    evidence: "evidence",
  }, undefined, undefined, null);

  for (const response of [beginResult, statusResult, completeResult, advanceResult]) {
    assert.equal(response.details && typeof response.details, "object");
    assert.equal((response.details as { ok?: boolean }).ok, false);
    assert.match(response.content[0].text, /\"ok\":false/);
  }
  assert.equal((beginResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((statusResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((completeResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((advanceResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
});
test("fullstack: workflow_begin follows the canonical session cwd, not a stale context cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeBeginFixture(canonical, "main");
    // This is the exact failure shape from the report: state says `main`,
    // but the stale context directory has no active git branch.
    writeBeginFixture(stale, "main");

    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const begin = tools.get("workflow_begin")!;
    const response = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: stale, sessionManager: { getCwd: () => canonical }, hasUI: true } as never,
    );

    const details = response.details;
    if (!details || typeof details !== "object" || !("ok" in details)) throw new Error("workflow_begin response has no ok field");
    assert.equal(details.ok, true);
  } finally {
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});
test("fullstack: mutable schema defaults are factories", () => {
  const strictZ = {
    ...z,
    array: (element: Parameters<typeof z.array>[0]) => {
      const schema = z.array(element);
      return new Proxy(schema, {
        get(target, property, receiver) {
          if (property !== "default") return Reflect.get(target, property, receiver);
          const defaultMethod = Reflect.get(target, property, receiver) as (value: unknown) => unknown;
          return (value: unknown) => {
            if (value !== null && typeof value === "object") {
              throw new Error("mutable default must be a factory");
            }
            return Reflect.apply(defaultMethod, target, [value]);
          };
        },
      });
    },
  } as typeof z;

  assert.doesNotThrow(() => {
    registerWorkflowTools({
      zod: { z: strictZ },
      registerTool() {},
    } as never);
  });
});
