import { test } from "node:test";
import assert from "node:assert/strict";
import { ctoNestingGuard, NESTED_CTO_BLOCK_REASON } from "../src/gates/cto-nesting.js";

test("cto-nesting: blocks a direct cto task target", () => {
  const result = ctoNestingGuard({ toolName: "task", input: { agent: "cto", task: "orchestrate this" } });
  assert.deepEqual(result, { block: true, reason: NESTED_CTO_BLOCK_REASON });
});

test("cto-nesting: blocks @cto in a parallel task batch", () => {
  const result = ctoNestingGuard({
    toolName: "task",
    input: { tasks: [{ agent: "developer-go", task: "safe" }, { agent: "@cto", task: "nested" }] },
  });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /main session/);
});

test("cto-nesting: allows concrete team agents and unrelated tools", () => {
  assert.equal(ctoNestingGuard({ toolName: "task", input: { agent: "team-lead", task: "lead" } }), undefined);
  assert.equal(ctoNestingGuard({ toolName: "read", input: { agent: "cto" } }), undefined);
  assert.equal(ctoNestingGuard({ toolName: "task", input: { tasks: [{ agent: "qa", task: "verify" }] } }), undefined);
});
