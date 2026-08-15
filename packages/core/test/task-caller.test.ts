/**
 * Integration test: core's `createTaskCaller` must produce a `TaskCaller`
 * that delegates to the actual OMP `TaskTool` shape (the static `execute`
 * method). We don't run a real OMP session — we mock `TaskTool.execute`
 * and assert that:
 *
 *  1. The shape we depend on is structural (`execute(toolCallId, params, ...)`).
 *  2. `call()` forwards flat single-spawn params verbatim (`agent`, `task`,
 *     `name`, `effort`).
 *  3. `batch()` rewrites `{ context, tasks[] }` into the OMP batch shape.
 *  4. The result is normalised into `TaskResult` (`id`, `output`, `artifacts`,
 *     `exitCode`, `error`).
 *
 * The test does NOT import `@oh-my-pi/pi-coding-agent/task` directly — the
 * `TaskToolLike` interface in `stage.ts` is the actual contract the engine
 * depends on. If OMP changes `TaskTool.execute`'s signature, the test
 * catches it via the structural duck-type check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskCaller, type TaskToolLike } from "../src/engine/stage.js";

test("core: createTaskCaller maps to OMP TaskTool.execute signature", async () => {
	const calls: Array<{ toolCallId: string; params: Record<string, unknown> }> = [];
	const fakeTool: TaskToolLike = {
		async execute(toolCallId, params) {
			calls.push({ toolCallId, params });
			return { output: { id: "spawn-1", output: "ok", artifacts: {}, exitCode: 0 } };
		},
	};

	const caller = createTaskCaller(fakeTool);
	const result = await caller.call({
		agent: "developer-kotlin",
		task: "implement foo",
		name: "kfoo",
		effort: "lo",
	});

	assert.equal(calls.length, 1);
	const call = calls[0]!;
	assert.match(call.toolCallId, /^task-[a-z0-9-]+$/, "toolCallId is a stable id");
	assert.equal(call.params.agent, "developer-kotlin");
	assert.equal(call.params.task, "implement foo");
	assert.equal(call.params.name, "kfoo");
	assert.equal(call.params.effort, "lo");
	assert.equal(result.id, "spawn-1");
	assert.equal(result.output, "ok");
	assert.equal(result.exitCode, 0);
});

test("core: createTaskCaller batch rewrites into OMP {context, tasks} shape", async () => {
	const calls: Array<{ params: Record<string, unknown> }> = [];
	const fakeTool: TaskToolLike = {
		async execute(_toolCallId, params) {
			calls.push({ params });
			return {
				output: {
					results: [
						{ id: "a", output: "alpha", artifacts: {}, exitCode: 0 },
						{ id: "b", output: "beta", artifacts: {}, exitCode: 0 },
					],
				},
			};
		},
	};

	const caller = createTaskCaller(fakeTool);
	const results = await caller.batch({
		context: "Stage: architecture",
		tasks: [
			{ agent: "architect", task: "minimal", name: "min", effort: "lo" },
			{ agent: "architect", task: "pragmatic", name: "prag", effort: "hi" },
		],
	});

	assert.equal(calls.length, 1);
	const params = calls[0]!.params;
	assert.equal(params.context, "Stage: architecture");
	assert.ok(Array.isArray(params.tasks), "tasks is an array");
	const tasks = params.tasks as Array<Record<string, unknown>>;
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0]?.agent, "architect");
	assert.equal(tasks[0]?.task, "minimal");
	assert.equal(tasks[0]?.name, "min");
	assert.equal(tasks[0]?.effort, "lo");
	assert.equal(tasks[1]?.name, "prag");

	assert.equal(results.length, 2);
	assert.equal(results[0]?.id, "a");
	assert.equal(results[0]?.output, "alpha");
	assert.equal(results[1]?.output, "beta");
});

test("core: createTaskCaller omits empty optional fields from wire params", async () => {
	const calls: Array<{ params: Record<string, unknown> }> = [];
	const fakeTool: TaskToolLike = {
		async execute(_toolCallId, params) {
			calls.push({ params });
			return { output: { id: "x", output: "ok", artifacts: {}, exitCode: 0 } };
		},
	};

	const caller = createTaskCaller(fakeTool);
	await caller.call({ agent: "qa", task: "run tests" });
	const params = calls[0]!.params;
	assert.deepEqual(Object.keys(params).sort(), ["agent", "task"]);
	assert.equal(params.agent, "qa");
	assert.equal(params.task, "run tests");
});

test("core: createTaskCaller normalises non-object output to a string", async () => {
	const fakeTool: TaskToolLike = {
		async execute() {
			return { output: "raw text response" };
		},
	};

	const caller = createTaskCaller(fakeTool);
	const result = await caller.call({ agent: "developer-kotlin", task: "noop" });
	assert.equal(result.output, "raw text response");
	assert.equal(result.exitCode, 0);
});

test("core: createTaskCaller reads native TaskTool details results", async () => {
  const fakeTool: TaskToolLike = {
    async execute() {
      return {
        content: [{ type: "text", text: "tool summary" }],
        details: {
          async: { state: "completed" },
          results: [{
            id: "native-1",
            output: "native output",
            artifacts: { report: "{\"ok\":true}" },
            exitCode: 0,
          }],
        },
      };
    },
  };

  const result = await createTaskCaller(fakeTool).call({ agent: "qa", task: "inspect" });
  assert.equal(result.id, "native-1");
  assert.equal(result.output, "native output");
  assert.deepEqual(result.artifacts, { report: "{\"ok\":true}" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
});

test("core: createTaskCaller rejects an asynchronous TaskTool result as pending", async () => {
  const fakeTool: TaskToolLike = {
    async execute() {
      return { details: { async: { state: "running" } } };
    },
  };

  const result = await createTaskCaller(fakeTool).call({ agent: "qa", task: "inspect" });
  assert.equal(result.pending, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? "", /asynchronous/);
});

test("core: createTaskCaller maps native batch details", async () => {
  const fakeTool: TaskToolLike = {
    async execute() {
      return {
        details: {
          results: [
            { id: "native-a", output: "a", artifacts: {}, exitCode: 0 },
            { id: "native-b", output: "b", artifacts: {}, exitCode: 2, error: "failed" },
          ],
        },
      };
    },
  };

  const results = await createTaskCaller(fakeTool).batch({
    context: "review",
    tasks: [
      { agent: "qa", task: "check a" },
      { agent: "security-tester", task: "check b" },
    ],
  });
  assert.deepEqual(results.map((result) => [result.id, result.output, result.exitCode, result.error]), [
    ["native-a", "a", 0, undefined],
    ["native-b", "b", 2, "failed"],
  ]);
});
