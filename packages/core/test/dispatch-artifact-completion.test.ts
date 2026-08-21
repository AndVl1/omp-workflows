import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCapability, authorizeDispatch, completeDispatch } from "../src/engine/durable.js";
import { loadProfile } from "../src/engine/profile.js";
import { resolveState } from "../src/engine/state.js";

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

test("multi-slot producing dispatch records empty completion and validates claimed artifact ids", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-required-artifact-"));
  try {
    const branch = "feature/required-artifact";
    initGit(root, branch);
    const profile = loadProfile("review");
    assert.ok(profile);
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
      schema: 1,
      branch,
      task: "required artifact test",
      classification: { type: "REVIEW", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "review" },
      stage_cursor: "review",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "review" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    }));

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const handoff = begun.handoff;
    const authorization = (role: string, agent: string) => authorizeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role,
      agent,
      tool_call_id: "tool-required-artifact",
    });
    const reviewer = authorization("code-reviewer", "code-reviewer");
    const qa = authorization("qa", "qa");
    assert.equal(reviewer.ok, true);
    assert.equal(qa.ok, true);
    if (!reviewer.ok || !reviewer.record || !qa.ok || !qa.record) return;

    const complete = (dispatchId: string, artifactIds?: string[]) => completeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      dispatch_id: dispatchId,
      outcome: "succeeded",
      evidence: artifactIds ? "task completed with artifact" : "task completed before artifact declaration",
      ...(artifactIds ? { artifact_ids: artifactIds } : {}),
    });
    const missing = complete(reviewer.record.id, ["missing"]);
    assert.equal(missing.ok, false, "claimed artifact ids are still validated before completion");
    if (!missing.ok) assert.match(missing.error, /artifact/i);

    const empty = complete(reviewer.record.id);
    assert.equal(empty.ok, true, "an explicit empty slot completion is recorded for fan-in");
    if (empty.ok) assert.deepEqual(empty.record?.completion?.artifact_ids, []);

    const completed = resolveState(root, branch).state;
    assert.deepEqual(
      completed?.dispatch_capability?.dispatches.map((dispatch) => dispatch.status),
      ["succeeded", "authorized"],
    );

    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "review.json"), JSON.stringify({ findings: [] }));
    assert.equal(complete(qa.record.id, ["review"]).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
