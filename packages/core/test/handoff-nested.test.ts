import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapability, handoffWorkflow, type HandoffWorkflowInput } from "../src/engine/durable.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { writeState } from "../src/engine/state.js";
import type { TeamState } from "../src/engine/types.js";

let fixtureCounter = 0;

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function statePathOf(root: string): string {
  return join(root, ".work-state", "features", "handoff-test", "state.json");
}

function artifactsDirOf(root: string): string {
  return join(root, ".work-state", "features", "handoff-test", "artifacts");
}

function completedSpecFixture(): { root: string; input: HandoffWorkflowInput; approvalPath: string } {
  const branch = `feat/nested-handoff-${fixtureCounter++}`;
  const root = mkdtempSync(join(tmpdir(), `handoff-nested-${fixtureCounter}-`));
  initGit(root, branch);
  const profile = loadProfile("spec-preparation");
  assert.ok(profile, "spec-preparation profile must load");
  const sourceStage = profile.stages[profile.stages.length - 1]!;
  assert.equal(sourceStage.id, "handoff");
  const sourceHash = profileHash(profile);
  const issued = createCapability({
    run_key: branch,
    branch,
    workflow: profile.name,
    profile_hash: sourceHash,
    stage_cursor: sourceStage.id,
    kind: "none",
    expected_roster: [],
  });
  const state: TeamState = {
    schema: 1,
    branch,
    run_key: branch,
    classification: {
      type: "SPEC",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow: profile.name,
      autonomous_reason: "nested approval regression fixture",
    },
    task: "nested approval regression fixture",
    history: [{ task: "fixture", at: "2026-08-01T00:00:00.000Z" }],
    autonomous: false,
    workflow_override: false,
    issue: null,
    stage_cursor: sourceStage.id,
    stages: profile.stages.map((stage) => ({ id: stage.id, status: "done" as const })),
    artifacts: {},
    pause: { kind: "done", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: sourceHash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: { ...issued.state, status: "complete", dispatches: [] },
    updated_at: new Date().toISOString(),
  };
  writeState(root, state, { featureSlug: "handoff-test" });

  const artifactsDir = artifactsDirOf(root);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "spec_handoff.json"), JSON.stringify({
    status: "ready",
    implementation_ready: true,
    goal: "nested approval handoff",
    acceptance_criteria: ["nested approval is accepted"],
  }));
  writeFileSync(join(artifactsDir, "spec-preparation.json"), JSON.stringify({ ready: true }));
  const binding = issued.state.issued_for!;
  const approvalPath = join(artifactsDir, "workflow_approval.json");
  writeFileSync(approvalPath, JSON.stringify({
    artifact_id: "workflow_approval",
    schema_version: 1,
    kind: "workflow_approval",
    status: "approved",
    approval: {
      decision: "approve",
      mode: "interactive",
      actor: "user",
      rationale: "The user explicitly approved the completed implementation-ready specification.",
    },
    source: {
      workflow: binding.workflow,
      stage: binding.stage_cursor,
      status: "completed",
      branch: binding.branch,
      run_key: binding.run_key,
      completed_handoff: {
        capability_id: issued.capability_id,
        stage_cursor: binding.stage_cursor,
        cursor_epoch: binding.cursor_epoch,
        profile_hash: binding.profile_hash,
      },
    },
    target: {
      workflow: "full-feature",
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false },
      branch: binding.branch,
      run_key: binding.run_key,
    },
    bounded_spec_handoff: {
      artifact: ".work-state/features/handoff-test/artifacts/spec_handoff.json",
      scope: ["core"],
      contract: ["nested approval handoff"],
      acceptance_artifact: "spec_handoff",
      blocking_gaps: [],
      implementation_sequence: ["S0"],
    },
    transfer_constraints: {
      do_not_restart_specification: true,
      do_not_modify_spec_handoff: true,
      do_not_expand_scope_beyond_bounded_handoff: true,
    },
  }));

  return {
    root,
    approvalPath,
    input: {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: binding.run_key,
      branch: binding.branch,
      workflow: binding.workflow,
      profile_hash: binding.profile_hash,
      stage_cursor: binding.stage_cursor,
      cursor_epoch: binding.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: binding.stage_cursor, decision: "approved" },
      actor: "orchestrator",
      handoff_context: { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "approved nested specification" },
    },
  };
}

test("handoff accepts the observed nested workflow_approval artifact after binding it to the source and target", () => {
  const fixture = completedSpecFixture();
  try {
    const result = handoffWorkflow(fixture.root, fixture.input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.audit.approval.actor, "orchestrator");
    assert.equal(result.audit.source.workflow, "spec-preparation");
    assert.equal(result.audit.target.workflow, "full-feature");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("handoff rejects nested approval target binding without mutating canonical state or artifacts", () => {
  const fixture = completedSpecFixture();
  try {
    const approval = JSON.parse(readFileSync(fixture.approvalPath, "utf8")) as { target: { branch: string } };
    approval.target.branch = "feat/other-run";
    writeFileSync(fixture.approvalPath, JSON.stringify(approval));
    const stateBefore = readFileSync(statePathOf(fixture.root), "utf8");
    const artifactBefore = readFileSync(fixture.approvalPath, "utf8");

    const result = handoffWorkflow(fixture.root, fixture.input);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "handoff approval evidence is invalid");
    assert.equal(readFileSync(statePathOf(fixture.root), "utf8"), stateBefore);
    assert.equal(readFileSync(fixture.approvalPath, "utf8"), artifactBefore);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
