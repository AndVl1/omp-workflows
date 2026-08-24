import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCapability } from "../src/engine/durable.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { dispatchGate, parseDispatchMarker } from "../src/gates/dispatch.js";
import { writeState } from "../src/engine/state.js";

test("begin capability returns a role marker accepted by dispatchGate", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-handoff-marker-"));
  const branch = "feat/dispatch-marker";
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
      task: "dispatch marker regression",
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
    }, { featureSlug: "dispatch-marker" });

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const handoff = begun.handoff;
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

    const accepted = dispatchGate({
      toolName: "task",
      input: { agent: "developer-kotlin", role: marker.role, task: marker.marker },
    }, { cwd: root });
    assert.equal(accepted, undefined);

    const persisted = readFileSync(join(root, ".work-state", "features", "dispatch-marker", "state.json"), "utf8");
    assert.equal(persisted.includes(marker.marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
