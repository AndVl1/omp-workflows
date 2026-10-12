/**
 * Transport boundaries: ambiguous batch rows stay unbound, and asynchronous
 * task responses cannot be mistaken for terminal completion. Registered
 * interpreter fixtures cover real admission, child identity and submission.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskCaller, type TaskToolLike } from "../src/engine/stage.js";


test("core: trusted batch stamps task identity only for exact positional rows", async () => {
  const positionalTool: TaskToolLike = {
    async execute() {
      return {
        details: {
          results: [
            { output: "first", artifacts: {}, exitCode: 0 },
            { output: "second", artifacts: {}, exitCode: 0 },
          ],
        },
      };
    },
  };
  const exact = await createTaskCaller(positionalTool).batch({
    context: "review",
    tasks: [
      { agent: "qa", task: "first", name: "assigned-first" },
      { agent: "qa", task: "second", name: "assigned-second" },
    ],
  });
  assert.deepEqual(exact.map((result) => result.task_id), ["assigned-first", "assigned-second"]);

  const shortTool: TaskToolLike = {
    async execute() {
      return { details: { results: [{ output: "only", artifacts: {}, exitCode: 0 }] } };
    },
  };
  const ambiguous = await createTaskCaller(shortTool).batch({
    context: "review",
    tasks: [
      { agent: "qa", task: "first", name: "assigned-first" },
      { agent: "qa", task: "second", name: "assigned-second" },
    ],
  });
  assert.equal(ambiguous[0]?.task_id, undefined, "count mismatch remains unbound");
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

