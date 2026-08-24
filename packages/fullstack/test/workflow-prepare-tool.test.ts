import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { registerWorkflowTools } from "../src/index.js";

type Tool = {
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

test("workflow_prepare tool reaches workflow_begin on a fresh branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-tool-"));
  const branch = "feat/prepare-tool";
  try {
    initGit(root, branch);
    const tools = new Map<string, Tool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: Tool & { name: string }) {
        tools.set(tool.name, tool);
      },
    } as never);

    const prepare = tools.get("workflow_prepare")!;
    const prepared = await prepare.execute("prepare", {
      task: "Implement a small feature",
      branch,
      classification: {
        type: "FEATURE",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: false,
        autonomous_reason: "interactive by default",
        workflow: "lightweight",
      },
      files: [],
    }, undefined, undefined, { cwd: root } as never);
    const preparedDetails = prepared.details as { ok: boolean; state_path?: string; error?: string };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    assert.match(preparedDetails.state_path ?? "", /features\/feat-prepare-tool\/state\.json$/);

    const begun = await tools.get("workflow_begin")!.execute("begin", {}, undefined, undefined, { cwd: root } as never);
    const beginDetails = begun.details as { ok: boolean; handoff?: { dispatch_token?: string }; error?: string };
    assert.equal(beginDetails.ok, true, beginDetails.error);
    assert.ok(beginDetails.handoff?.dispatch_token);
    const persisted = readFileSync(preparedDetails.state_path!, "utf8");
    assert.doesNotMatch(persisted, /"(?:dispatch_token|advance_token)"\s*:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
