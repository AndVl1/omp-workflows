import { test } from "node:test";
import assert from "node:assert/strict";
import { isMainSessionContext } from "../src/index.js";

test("dispatcher lifecycle: task subagent contexts do not own the messenger", () => {
  assert.equal(isMainSessionContext({ hasUI: false }), false);
  assert.equal(isMainSessionContext({ hasUI: true }), true);
  assert.equal(isMainSessionContext({}), true, "older runtimes without hasUI stay compatible");
  assert.equal(isMainSessionContext(undefined), true, "unknown hook context stays compatible");
});
