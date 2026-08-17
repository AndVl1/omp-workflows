import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dispatchGate } from "@andvl1/omp-workflows-core";
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

function writeConsiliumBeginFixture(root: string): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: {
      type: "SPEC",
      complexity: "COMPLEX",
      confidence: "HIGH",
      autonomous: true,
      workflow: "spec-preparation",
    },
    task: "consilium marker regression",
    stage_cursor: "intake_repo_map",
    stages: [{ id: "intake_repo_map", status: "in_progress" }],
    artifacts: {},
    scope: {
      scope: [],
      has_security: false,
      has_infra: false,
      has_ui: false,
      has_runtime: false,
      dev_agent: null,
    },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
  }) + "\n");
}

test("fullstack: workflow_begin exposes role-bound dispatch markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-marker-handoff-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeConsiliumBeginFixture(root);
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
      { cwd: root, hasUI: true } as never,
    );
    const details = response.details as {
      ok?: boolean;
      handoff?: {
        run_key: string;
        stage_cursor: string;
        cursor_epoch: string;
        dispatch_markers?: Array<{ role: string; agent: string; marker: string }>;
      };
    };
    assert.equal(details.ok, true);
    const markers = details.handoff?.dispatch_markers ?? [];
    assert.deepEqual(
      markers.map(({ role, agent }) => ({ role, agent })),
      [
        { role: "analyst", agent: "analyst" },
        { role: "tech-researcher", agent: "tech-researcher" },
      ],
    );
    for (const marker of markers) {
      assert.match(marker.marker, /<!-- omp-dispatch run=main stage=intake_repo_map kind=consilium/);
      assert.match(marker.marker, new RegExp(`cursor=${details.handoff?.cursor_epoch}`));
      assert.match(marker.marker, new RegExp(`role=${marker.role}`));
    }
    const gate = dispatchGate({
      toolName: "task",
      input: {
        tasks: markers.map(({ role, agent, marker }) => ({
          role,
          agent,
          task: `${marker}\nComplete the declared intake work.`,
        })),
      },
    }, { cwd: root });
    assert.equal(gate, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow tools register and fail closed with structured responses", async () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  assert.deepEqual([...tools.keys()], ["workflow_prepare", "workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance"]);
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

test("fullstack: workflow_prepare persists PHASE-0 state in the canonical session cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const prepare = tools.get("workflow_prepare")!;
    const response = await prepare.execute(
      "test",
      {
        task: "prepare state binding regression",
        branch: "main",
        classification: {
          type: "BUG_FIX",
          complexity: "QUICK",
          confidence: "HIGH",
          autonomous: false,
          autonomous_reason: "interactive regression fix",
        },
        files: ["src/main/App.kt"],
        issue: 42,
      },
      undefined,
      undefined,
      { cwd: stale, sessionManager: { getCwd: () => canonical }, hasUI: true } as never,
    );

    const details = response.details as { ok?: boolean; state_path?: string; state?: { branch?: string } };
    assert.equal(details.ok, true);
    assert.equal(details.state?.branch, "main");
    assert.equal(details.state_path, join(canonical, ".work-state", "features", "main", "state.json"));
    const state = JSON.parse(readFileSync(details.state_path!, "utf8")) as {
      branch: string;
      task: string;

      classification?: { type: string; autonomous: boolean; workflow?: string };
      scope?: { scope: string[] };
    };

    const begin = tools.get("workflow_begin")!;
    const beginResponse = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: canonical, hasUI: true } as never,
    );
    assert.equal((beginResponse.details as { ok?: boolean }).ok, true);
    assert.equal(state.branch, "main");
    assert.equal(state.task, "prepare state binding regression");
    assert.deepEqual(state.classification, {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      autonomous_reason: "interactive regression fix",
      workflow: "bug-fix",
    });
    assert.deepEqual(state.scope?.scope, ["backend-kotlin"]);

    const reopenResponse = await tools.get("workflow_prepare")!.execute(
      "test",
      {
        task: "continue current workflow",
        branch: "main",
        continuation: { feedback: "recheck the fix", stageId: "discovery" },
      },
      undefined,
      undefined,
      { cwd: canonical, hasUI: true } as never,
    );
    assert.equal((reopenResponse.details as { ok?: boolean }).ok, true);
    const resumedBegin = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: canonical, hasUI: true } as never,
    );
    assert.equal((resumedBegin.details as { ok?: boolean }).ok, true);
  } finally {
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
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
