import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  authorizeDispatch,
  beginCapability,
  createCapability,
  loadProfile,
  prepareWorkflow,
  profileHash,
  resolveState,
  writeState,
  type TeamState,
  type WorkflowPreparationInput,
} from "../src/index.js";

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function input(
  branch: string,
  continuation?: WorkflowPreparationInput["continuation"],
  complexity: "QUICK" | "COMPLEX" = "QUICK",
): WorkflowPreparationInput {
  return {
    task: "Retry a failed workflow stage",
    branch,
    classification: {
      type: "FEATURE",
      complexity,
      confidence: "HIGH",
      autonomous: false,
      autonomous_reason: "interactive by default",
      workflow: complexity === "COMPLEX" ? "full-feature" : "lightweight",
    },
    continuation,
  };
}

function priorState(
  state: TeamState,
  stageId: string,
  capability: NonNullable<TeamState["dispatch_capability"]>,
): TeamState {
  const stageIndex = state.stages.findIndex((stage) => stage.id === stageId);
  return {
    ...state,
    stage_cursor: stageId,
    cursor_epoch: capability.issued_for!.cursor_epoch,
    stages: state.stages.map((stage, index) => index < stageIndex
      ? { ...stage, status: "done" as const }
      : index === stageIndex
        ? { ...stage, status: "in_progress" as const }
        : { ...stage, status: "pending" as const }),
    pause: { kind: "failed", reason: "dispatch failed a stage gate" },
    dispatch_capability: capability,
  };
}

test("workflow_prepare continuation retries a downstream terminal capability and rejects its old auth", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-downstream-retry-"));
  const branch = "feat/prepare-downstream-retry";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, input(branch, undefined, "COMPLEX"));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    if (!profile) return;
    const issued = createCapability({
      run_key: branch,
      branch,
      workflow: "full-feature",
      profile_hash: profileHash(profile),
      stage_cursor: "manual_qa",
      kind: "single",
      expected_roster: [{ role: "manual-qa", agent: "manual-qa" }],
    });
    const completedAt = "2026-08-21T00:00:00.000Z";
    const terminal = {
      id: "manual-qa-failed",
      role: "manual-qa",
      agent: "manual-qa",
      status: "failed" as const,
      attempt: 1,
      created_at: completedAt,
      completed_at: completedAt,
      completion: {
        dispatch_id: "manual-qa-failed",
        cursor_epoch: issued.state.issued_for!.cursor_epoch,
        outcome: "failed" as const,
        artifact_ids: [],
        evidence: "manual QA gate failed",
        completed_by: "workflow_complete" as const,
        completed_at: completedAt,
      },
    };
    const prior = priorState(resolved.state, "manual_qa", { ...issued.state, status: "dispatched", dispatches: [terminal] });
    writeState(root, prior, { target: resolved });
    const before = readFileSync(resolved.statePath, "utf8");

    const reopened = prepareWorkflow(root, input(branch, { feedback: "Retry implementation after manual QA failure", stageId: "implementation" }, "COMPLEX"));

    assert.equal(reopened.ok, true, reopened.ok ? "" : reopened.error);
    if (!reopened.ok) return;
    assert.equal(reopened.state.stage_cursor, "implementation");
    assert.equal(reopened.state.dispatch_capability?.status, "invalidated");
    assert.deepEqual(reopened.state.dispatch_capability?.dispatches, []);
    const oldAuth = authorizeDispatch(root, {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: branch,
      branch,
      workflow: "full-feature",
      profile_hash: profileHash(profile),
      stage_cursor: "manual_qa",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "manual-qa",
      agent: "manual-qa",
    });
    assert.equal(oldAuth.ok, false);
    if (!oldAuth.ok) assert.match(oldAuth.error, /capability identity mismatch|capability invalidated/);

    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    assert.equal(begun.handoff.stage_cursor, "implementation");
    assert.notEqual(begun.handoff.capability_id, issued.capability_id);
    assert.notEqual(begun.handoff.dispatch_token, issued.dispatch_token);
    const persisted = readFileSync(resolved.statePath, "utf8");
    assert.doesNotMatch(persisted, new RegExp(begun.handoff.dispatch_token));
    assert.doesNotMatch(persisted, new RegExp(begun.handoff.advance_token));
    assert.notEqual(before, persisted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation refuses to recover an active upstream capability", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-upstream-cap-"));
  const branch = "feat/prepare-upstream-cap";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, input(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    if (!profile) return;
    const issued = createCapability({
      run_key: branch,
      branch,
      workflow: "lightweight",
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      kind: "single",
      expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    const prior = priorState(resolved.state, "implementation", { ...issued.state, status: "ready", dispatches: [] });
    writeState(root, prior, { target: resolved });
    const before = readFileSync(resolved.statePath, "utf8");

    const reopened = prepareWorkflow(root, input(branch, { feedback: "Reopen code review", stageId: "code_review" }));

    assert.equal(reopened.ok, false);
    if (!reopened.ok) assert.match(reopened.error, /upstream dispatch capability is active/);
    assert.equal(readFileSync(resolved.statePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation rejects an active dispatch instead of invalidating live work", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-live-dispatch-"));
  const branch = "feat/prepare-live-dispatch";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, input(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    if (!profile) return;
    const issued = createCapability({
      run_key: branch,
      branch,
      workflow: "lightweight",
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      kind: "single",
      expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    const createdAt = "2026-08-21T00:00:00.000Z";
    const prior = priorState(resolved.state, "implementation", {
      ...issued.state,
      status: "dispatched",
      dispatches: [{ id: "live-dispatch", role: "developer-kotlin", agent: "developer-kotlin", status: "authorized", attempt: 1, created_at: createdAt }],
    });
    writeState(root, prior, { target: resolved });
    const before = readFileSync(resolved.statePath, "utf8");

    const reopened = prepareWorkflow(root, input(branch, { feedback: "Retry implementation", stageId: "implementation" }));

    assert.equal(reopened.ok, false);
    if (!reopened.ok) assert.match(reopened.error, /dispatch is still resumable/);
    assert.equal(readFileSync(resolved.statePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation rejects a capability bound to an unknown stage", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-canonical-cap-"));
  const branch = "feat/prepare-canonical-cap";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, input(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    if (!profile) return;
    const issued = createCapability({
      run_key: branch,
      branch,
      workflow: "lightweight",
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      kind: "single",
      expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    const malformed = { ...issued.state, status: "ready" as const, issued_for: { ...issued.state.issued_for!, stage_cursor: "not-a-stage" }, dispatches: [] };
    writeState(root, { ...resolved.state, dispatch_capability: malformed }, { target: resolved });
    const before = readFileSync(resolved.statePath, "utf8");

    const reopened = prepareWorkflow(root, input(branch, { feedback: "Retry implementation", stageId: "implementation" }));

    assert.equal(reopened.ok, false);
    if (!reopened.ok) assert.match(reopened.error, /mismatched dispatch capability binding|unknown capability stage/);
    assert.equal(readFileSync(resolved.statePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
