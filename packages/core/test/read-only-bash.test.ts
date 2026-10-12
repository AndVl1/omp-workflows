import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedAstIndexBash } from "../src/gates/read-only-bash.js";
import { admitOrdinaryWorker, details, emit, ordinaryHarness, ordinaryIngress } from "./reliable-stage-execution-fixture.js";

const cwd = "/tmp/readonly-worktree";

test("AST lookups and explicit index refresh are the only admitted read-only Bash operations", () => {
  for (const command of ["ast-index refs readOnlyAstProbe", "ast-index search producer --limit 20", "ast-index --format json outline src/producer.ts", "/opt/homebrew/bin/ast-index rebuild", "ast-index update", "ast-index stats"]) {
    assert.equal(isAllowedAstIndexBash({ command, cwd: "." }, cwd), true, command);
  }
  for (const command of ["ast-index rebuild; touch producer.ts", "ast-index refs $(touch producer.ts)", "AST_INDEX_DB_PATH=producer.ts ast-index rebuild", "ast-index rebuild --root /tmp/foreign", "ast-index update --watch", "ast-index clear", "ast-index sql DELETE", "ast-index refs probe > producer.ts", "ast-index refs probe && git status", "ast-index refs probe | cat", "./ast-index rebuild", "bash -c ast-index", "ast-index refs probe\nrm producer.ts", "ast-index refs probe --limit -1"]) {
    assert.equal(isAllowedAstIndexBash({ command }, cwd), false, command);
  }
  assert.equal(isAllowedAstIndexBash({ command: "ast-index rebuild", env: { AST_INDEX_DB_PATH: "producer.ts" } }, cwd), false);
  assert.equal(isAllowedAstIndexBash({ command: "ast-index update", cwd: "../foreign" }, cwd), false);
  const getter = Object.defineProperty({}, "command", { get() { throw new Error("must not execute input getters"); } });
  assert.equal(isAllowedAstIndexBash(getter, cwd), false);
});

test("unused-symbol scans accept bounded query flags and reject workspace or shell overrides", () => {
  for (const command of ["ast-index unused-symbols", "ast-index unused-symbols --module packages/core --format json --limit 200", "ast-index --format json unused-symbols --export-only --module packages/fullstack --limit 10000"]) {
    assert.equal(isAllowedAstIndexBash({ command }, cwd), true, command);
  }
  for (const suffix of ["--module ../foreign", "--module /tmp/foreign", "--module packages/../foreign", "--module file:foreign", "--limit 0", "--limit 10001", "--format dot", "--walk-up", "--root /tmp", "--module", "--export-only --export-only", "--format json --format text", "--module packages/core; touch x", "--module $(pwd)"]) {
    assert.equal(isAllowedAstIndexBash({ command: `ast-index unused-symbols ${suffix}` }, cwd), false, suffix);
  }
  assert.equal(isAllowedAstIndexBash({ command: "ast-index --format json unused-symbols --format text" }, cwd), false);
});

test("registered read-only workers and artifact-scoped orchestrators can refresh AST but cannot use arbitrary Bash", async () => {
  const harness = ordinaryHarness({ readOnlyBashAgents: ["developer"] });
  try {
    const { handoff } = await ordinaryIngress(harness);
    const worker = await admitOrdinaryWorker(harness, handoff, "readonly-bash");
    for (const context of [worker.childContext, harness.context]) {
      for (const command of ["ast-index refs readOnlyAstProbe", "ast-index rebuild", "ast-index update", "ast-index unused-symbols --module packages/core --format json --limit 200"]) {
        const result = await emit(harness, "tool_call", { toolName: "bash", input: { command }, toolCallId: `readonly-${command}` }, context);
        assert.deepEqual(result.filter(Boolean), [], command);
      }
      for (const command of ["touch producer.ts", "ast-index update; touch producer.ts", "ast-index rebuild --root /tmp/foreign"]) {
        const result = await emit(harness, "tool_call", { toolName: "bash", input: { command }, toolCallId: `denied-${command}` }, context);
        assert.equal(result.some(value => value && details(value).block === true), true, command);
      }
    }
    const impostor = { ...worker.childContext, sessionManager: { ...worker.childContext.sessionManager } };
    const rejected = await emit(harness, "tool_call", { toolName: "bash", input: { command: "ast-index update", agent: "developer" }, toolCallId: "impostor" }, impostor);
    assert.equal(rejected.some(value => value && details(value).block === true), true);
  } finally {
    await harness.close();
  }
});
