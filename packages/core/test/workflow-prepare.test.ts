import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beginCapability, createCapability, loadProfile, prepareWorkflow, profileHash, resolveState, writeState, type TeamState, type WorkflowPreparationInput } from "../src/index.js";

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function preparationInput(branch: string, continuation?: WorkflowPreparationInput["continuation"]): WorkflowPreparationInput {
  return {
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
    continuation,
  };
}

test("workflow_prepare initializes feature-scoped state and beginCapability can issue its first handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-fresh-"));
  const branch = "feat/prepare-fresh";
  try {
    initGit(root, branch);
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ task: "stale partial state" }));

    const prepared = prepareWorkflow(root, preparationInput(branch));

    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.continuation, false);
    assert.equal(prepared.featureSlug, "feat-prepare-fresh");
    assert.equal(prepared.state.branch, branch);
    assert.deepEqual(prepared.state.classification, preparationInput(branch).classification);
    assert.ok(prepared.state.stages.length > 0);
    assert.ok(prepared.state.stages.every((stage) => stage.status === "pending"));
    assert.match(prepared.statePath, /\.work-state\/features\/feat-prepare-fresh\/state\.json$/);
    assert.equal(prepared.state.dispatch_capability, undefined);

    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.match(readFileSync(prepared.statePath, "utf8"), /dispatch_token_hash/);
    assert.doesNotMatch(readFileSync(prepared.statePath, "utf8"), /"(?:dispatch_token|advance_token)"\s*:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare rejects stale input and malformed persisted branches", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-branch-"));
  const branch = "feat/prepare-branch";
  try {
    initGit(root, branch);
    const stale = prepareWorkflow(root, preparationInput("feat/other"));
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "BRANCH_STALE");

    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ task: "missing branch" }));
    const continuation = prepareWorkflow(root, preparationInput(branch, { feedback: "reopen it", stageId: "discovery" }));
    assert.equal(continuation.ok, false);
    if (!continuation.ok) assert.equal(continuation.code, "CONTINUATION_REJECTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation reopens one stage without losing artifacts or history", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-continuation-"));
  const branch = "feat/prepare-continuation";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, preparationInput(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;

    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    const completed: TeamState = {
      ...resolved.state,
      history: [{ task: "earlier", feedback: "keep this", at: "2026-08-01T00:00:00.000Z" }],
      artifacts: { discovery: "artifacts/discovery.json", preserved: "artifacts/preserved.json" },
      stage_cursor: "discovery",
      stages: resolved.state.stages.map((stage) => ({ ...stage, status: "done" as const })),
      pause: { kind: "done", reason: "" },
    };
    writeState(root, completed, { target: resolved });

    const reopened = prepareWorkflow(root, preparationInput(branch, { feedback: "Revisit discovery", stageId: "discovery" }));

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.equal(reopened.continuation, true);
    assert.equal(reopened.state.stage_cursor, "discovery");
    assert.equal(reopened.state.stages[0]?.status, "pending");
    assert.equal(reopened.state.stages.slice(1).every((stage) => stage.status === "pending"), true);
    assert.deepEqual(reopened.state.artifacts, completed.artifacts);
    assert.equal(reopened.state.history?.length, 2);
    assert.equal(reopened.state.history?.[1]?.feedback, "Revisit discovery");
    assert.match(reopened.state.task, /Revisit discovery/);

    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation clears an unrecoverable terminal capability before retry", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-retry-"));
  const branch = "feat/prepare-retry";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, preparationInput(branch));
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
    const completedAt = "2026-08-21T00:00:00.000Z";
    const failedDispatch = {
      id: "failed-dispatch",
      role: "developer-kotlin",
      agent: "developer-kotlin",
      status: "failed" as const,
      attempt: 1,
      created_at: completedAt,
      completed_at: completedAt,
      completion: {
        dispatch_id: "failed-dispatch",
        cursor_epoch: issued.state.issued_for!.cursor_epoch,
        outcome: "failed" as const,
        artifact_ids: [],
        evidence: "implementation gate failed",
        completed_by: "workflow_complete" as const,
        completed_at: completedAt,
      },
    };
    const prior: TeamState = {
      ...resolved.state,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      stages: resolved.state.stages.map((stage) => stage.id === "discovery" ? { ...stage, status: "done" as const } : stage.id === "implementation" ? { ...stage, status: "in_progress" as const } : { ...stage, status: "pending" as const }),
      pause: { kind: "failed", reason: "implementation gate failed" },
      dispatch_capability: { ...issued.state, status: "dispatched" as const, dispatches: [failedDispatch] },
    };
    writeState(root, prior, { target: resolved });

    const reopened = prepareWorkflow(root, preparationInput(branch, { feedback: "Retry implementation", stageId: "implementation" }));

    assert.equal(reopened.ok, true, reopened.ok ? "" : reopened.error);
    if (!reopened.ok) return;
    assert.equal(reopened.state.dispatch_capability?.status, "invalidated");
    assert.deepEqual(reopened.state.dispatch_capability?.dispatches, []);
    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    assert.notEqual(begun.handoff.capability_id, issued.capability_id);
    assert.notEqual(begun.handoff.dispatch_token, issued.dispatch_token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("workflow_prepare continuation resolves known runtime files when persisted scope is empty", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-empty-scope-"));
  const branch = "feat/prepare-empty-scope";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, preparationInput(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;

    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    writeState(root, { ...resolved.state, scope: {} as TeamState["scope"] }, { target: resolved });

    const reopened = prepareWorkflow(root, {
      ...preparationInput(branch, { feedback: "Revisit implementation", stageId: "discovery" }),
      files: ["src/runtime.ts"],
    });

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.equal(reopened.state.scope?.has_runtime, true);
    assert.deepEqual(reopened.state.scope, {
      scope: ["frontend"],
      has_security: false,
      has_infra: false,
      has_ui: true,
      has_runtime: true,
      dev_agent: "frontend-developer",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation preserves a non-empty persisted scope", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-preserve-scope-"));
  const branch = "feat/prepare-preserve-scope";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, preparationInput(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;

    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    const persistedScope: TeamState["scope"] = {
      scope: ["backend-kotlin"],
      has_security: false,
      has_infra: false,
      has_ui: false,
      has_runtime: true,
      dev_agent: "developer-kotlin",
    };
    writeState(root, { ...resolved.state, scope: persistedScope }, { target: resolved });

    const reopened = prepareWorkflow(root, {
      ...preparationInput(branch, { feedback: "Keep backend scope", stageId: "discovery" }),
      files: ["README.md"],
    });

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.deepEqual(reopened.state.scope, persistedScope);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare continuation keeps docs-only inputs out of runtime scope", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-docs-scope-"));
  const branch = "feat/prepare-docs-scope";
  try {
    initGit(root, branch);
    const fresh = prepareWorkflow(root, preparationInput(branch));
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;

    const resolved = resolveState(root, branch);
    assert.ok(resolved.state && resolved.statePath);
    if (!resolved.state || !resolved.statePath) return;
    writeState(root, { ...resolved.state, scope: undefined }, { target: resolved });

    const reopened = prepareWorkflow(root, {
      ...preparationInput(branch, { feedback: "Revisit documentation", stageId: "discovery" }),
      files: ["README.md", "docs/guide.md", "package.json"],
    });

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.deepEqual(reopened.state.scope, {
      scope: [],
      has_security: false,
      has_infra: false,
      has_ui: false,
      has_runtime: false,
      dev_agent: null,
    });
    assert.equal(reopened.state.scope?.has_runtime, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
