import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerWorkflowTools } from "../src/index.js";

type RegisteredTool = {
  name: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};

test("fullstack: workflow tools register and fail closed with structured responses", async () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  assert.deepEqual([...tools.keys()], ["workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance", "lecture_acquire"]);
  for (const name of tools.keys()) {
    assert.ok(tools.get(name)?.parameters, `${name} exposes a parameter schema`);
  }
  const lectureAcquire = tools.get("lecture_acquire")!;
  const workerLectureResult = await lectureAcquire.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerLectureResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  const lectureUnavailableResult = await lectureAcquire.execute("test", {}, undefined, undefined, null);
  assert.equal((lectureUnavailableResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");

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
