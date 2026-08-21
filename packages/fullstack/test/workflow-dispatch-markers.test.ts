import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  dispatchGate,
  loadProfile,
  parseDispatchMarker,
  profileHash,
  writeState,
} from "@andvl1/omp-workflows-core";
import { registerWorkflowTools } from "../src/index.js";

type RegisteredTool = {
  name: string;
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};

test("workflow_begin serializes role-specific dispatch markers in the handoff envelope", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-dispatch-marker-envelope-"));
  const branch = "feat/dispatch-marker-envelope";
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
    const profile = loadProfile("lightweight");
    assert.ok(profile, "lightweight profile must be available");
    const persistedProfileHash = profileHash(profile);
    writeState(root, {
      schema: 1,
      branch,
      run_key: branch,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "workflow marker envelope regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
    }, { featureSlug: "dispatch-marker-envelope" });

    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({ zod: { z }, registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never);
    const begin = tools.get("workflow_begin");
    assert.ok(begin, "workflow_begin must be registered");
    const response = await begin.execute("test", {}, undefined, undefined, { cwd: root } as never);
    const envelope = JSON.parse(response.content[0].text) as {
      ok: boolean;
      handoff?: {
        run_key: string;
        stage_cursor: string;
        kind: "single" | "consilium" | "none";
        cursor_epoch: string;
        expected_roster: Array<{ role: string; agent: string }>;
        dispatch_markers: Array<{ role: string; marker: string }>;
      };
    };
    assert.equal(envelope.ok, true);
    assert.ok(envelope.handoff);
    const handoff = envelope.handoff;
    assert.deepEqual(handoff.dispatch_markers.map((entry) => entry.role), handoff.expected_roster.map((entry) => entry.role));
    assert.equal(handoff.dispatch_markers.length, 1);
    const marker = handoff.dispatch_markers[0]!;
    assert.equal(marker.role, "developer-kotlin");
    assert.deepEqual(parseDispatchMarker(marker.marker), {
      run: handoff.run_key,
      stage: handoff.stage_cursor,
      kind: handoff.kind,
      cursor: handoff.cursor_epoch,
      roles: ["developer-kotlin"],
      role: marker.role,
    });
    assert.equal(dispatchGate({
      toolName: "task",
      input: { agent: "developer-kotlin", role: marker.role, task: marker.marker },
    }, { cwd: root }), undefined);

    const persisted = readFileSync(join(root, ".work-state", "features", "dispatch-marker-envelope", "state.json"), "utf8");
    assert.equal(persisted.includes(marker.marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
