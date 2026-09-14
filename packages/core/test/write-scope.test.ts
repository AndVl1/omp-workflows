/**
 * Bounded write_scope experiment (scope 7):
 *   - the flag is OFF by default;
 *   - enabled worker mutations fail closed because the host has no
 *     descriptor-bound execution seam;
 *   - generic shell execution is denied; no shell-text parser is authorization;
 *   - orchestrator state ownership remains independent and authoritative.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerWriteScopeGate, orchestratorWriteGate } from "../src/gates/orchestrator-write.js";

const SCOPE = { enabled: true, allow: ["src/**", "test/**"], deny: ["src/secret/**"] };
const DESCRIPTOR_REASON = /descriptor_bound_mutation_unavailable/;

function worker(cwd: string, event: { toolName: string; input?: Record<string, unknown> | string }) {
  return workerWriteScopeGate(event, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
}

test("write_scope: disabled by default and never blocks", () => {
  const event = { toolName: "write", input: { path: "src/whatever.ts" } };
  assert.equal(workerWriteScopeGate(event, { cwd: "/tmp/proj", actor: "worker", hasUI: false, writeScope: { enabled: false, allow: [] } }), undefined);
  assert.equal(workerWriteScopeGate(event, { cwd: "/tmp/proj", actor: "worker", hasUI: false }), undefined);
});

test("write_scope: enabled generic writes fail closed before pathname authorization", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-mutation-"));
  const outside = mkdtempSync(join(tmpdir(), "wscope-mutation-outside-"));
  const moved = `${cwd}.moved`;
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "src-evil"), { recursive: true });
    writeFileSync(join(cwd, "src", "safe.ts"), "safe\n");
    const outsideFile = join(outside, "sentinel.txt");
    writeFileSync(outsideFile, "sentinel\n");
    symlinkSync(outsideFile, join(cwd, "src", "linked-file"));
    linkSync(outsideFile, join(cwd, "src", "hard-link.ts"));

    for (const path of [
      "src/safe.ts",
      "src-evil/escape.ts",
      "src/linked-file",
      "src/hard-link.ts",
      "../outside.ts",
      "lib/other.ts",
      outsideFile,
    ]) {
      const result = worker(cwd, { toolName: "write", input: { path } });
      assert.equal(result?.block, true, `write ${path} is denied`);
      assert.match(result?.reason ?? "", DESCRIPTOR_REASON);
    }
    for (const toolName of ["write", "edit"]) {
      const result = worker(cwd, { toolName, input: { path: "src/safe.ts" } });
      assert.equal(result?.block, true, `${toolName} is denied without descriptor binding`);
      assert.match(result?.reason ?? "", DESCRIPTOR_REASON);
    }

    // A root replacement cannot turn a later generic host write into an
    // external mutation: the unsupported route is rejected before execution.
    const replacement = mkdtempSync(join(tmpdir(), "wscope-replacement-"));
    try {
      renameSync(cwd, moved);
      symlinkSync(replacement, cwd, "dir");
      const result = worker(cwd, { toolName: "write", input: { path: "src/replacement.ts" } });
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", DESCRIPTOR_REASON);
      assert.deepEqual(readdirSync(replacement), []);
    } finally {
      rmSync(replacement, { recursive: true, force: true });
    }
    assert.equal(readFileSync(outsideFile, "utf8"), "sentinel\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("write_scope: every generic shell command blocks without descriptor binding", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-bash-"));
  const outside = mkdtempSync(join(tmpdir(), "wscope-bash-outside-"));
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "sentinel\n");
    const readOnly = [
      "pwd",
      "ls src",
      "cat src/file.ts",
      "git diff -- src/file.ts",
      "git status --short",
      "find src -type f",
      "grep -n text src/file.ts",
    ];
    for (const command of readOnly) {
      const result = worker(cwd, { toolName: "bash", input: { command } });
      assert.equal(result?.block, true, command);
      assert.match(result?.reason ?? "", DESCRIPTOR_REASON, command);
    }

    const blocked = [
      "mkdir -p src/nested",
      "touch src/nested/file.ts",
      "rm src/nested/file.ts",
      "cp src/a.ts src/b.ts",
      "mv src/a.ts src/b.ts",
      "printf 'ok' > src/nested/edit.ts",
      `ln -s ${outsideFile} src/new-link`,
      `ln ${outsideFile} src/new-hard-link`,
      `cp -l ${outsideFile} src/new-cp-link`,
      `mv ${outsideFile} src/moved-file`,
      "touch src-evil/file.ts",
      "python3 -c 'open(\\\"src/nested/python.ts\\\", \\\"w\\\").write(\\\"x\\\")'",
      "make",
      "python3 build.py",
      "node scripts/write.js",
      "sh scripts/write.sh",
      "npm run build",
      "./tools/write-outside",
      "npm install",
      "git diff --output=src/generated.diff",
      "git diff -o src/generated.diff",
      "git diff --ext-diff -- src/file.ts",
      "sort -o src/generated.txt src/file.ts",
      "find src -fprint src/generated.txt",
      "find src -exec touch {} \\\\;",
      "sed -i s/a/b/ src/file.ts",
    ];
    for (const command of blocked) {
      const result = worker(cwd, { toolName: "bash", input: { command } });
      assert.equal(result?.block, true, command);
      assert.match(result?.reason ?? "", DESCRIPTOR_REASON, command);
    }
    assert.equal(readFileSync(outsideFile, "utf8"), "sentinel\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("write_scope: non-worker actors, mounted tools, and malformed scopes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-actor-"));
  try {
    assert.equal(workerWriteScopeGate({ toolName: "write", input: { path: "lib/other.ts" } }, { cwd, actor: "orchestrator", hasUI: true, writeScope: SCOPE }), undefined);
    assert.equal(workerWriteScopeGate({ toolName: "write", input: { path: "lib/other.ts" } }, { cwd, hasUI: true, writeScope: SCOPE }), undefined);
    assert.equal(workerWriteScopeGate({ toolName: "write", input: { path: "xd://workflow_instructions" } }, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE }), undefined);
    const malformedScope = workerWriteScopeGate(
      { toolName: "write", input: { path: "src/a.ts" } },
      { cwd, actor: "worker", hasUI: false, writeScope: { enabled: true, allow: [42 as unknown as string] } },
    );
    assert.equal(malformedScope?.block, true);
    assert.match(malformedScope?.reason ?? "", /malformed scope/);
    const malformedEnablement = workerWriteScopeGate(
      { toolName: "write", input: { path: "src/a.ts" } },
      { cwd, actor: "worker", hasUI: false, writeScope: { enabled: "yes" as unknown as boolean, allow: ["src/**"] } },
    );
    assert.equal(malformedEnablement?.block, true);
    assert.match(malformedEnablement?.reason ?? "", /malformed scope/);
    assert.equal(workerWriteScopeGate(
      { toolName: "write", input: { path: "outside.ts" } },
      { cwd, actor: "orchestrator", hasUI: true, writeScope: { enabled: true, allow: [42 as unknown as string] } },
    ), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("write_scope: composed after orchestratorWriteGate", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-gate-"));
  try {
    const stateDir = join(cwd, ".work-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "team-state.json"), JSON.stringify({
      schema: 1,
      branch: "feat/x",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "t",
      workflow_override: false,
      issue: null,
      stage_cursor: "s",
      stages: [{ id: "s", status: "in_progress" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      updated_at: new Date().toISOString(),
    }));
    const stateWrite = { toolName: "write", input: { path: join(cwd, ".work-state", "team-state.json") } };
    assert.equal(orchestratorWriteGate(stateWrite, { cwd, actor: "worker", hasUI: false })?.block, true);
    assert.match(workerWriteScopeGate(stateWrite, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE })?.reason ?? "", DESCRIPTOR_REASON);
    const sourceWrite = { toolName: "write", input: { path: "src/a.ts" } };
    assert.equal(orchestratorWriteGate(sourceWrite, { cwd, actor: "worker", hasUI: false }), undefined);
    assert.match(workerWriteScopeGate(sourceWrite, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE })?.reason ?? "", DESCRIPTOR_REASON);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
