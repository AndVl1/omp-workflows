import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { run } from "../src/engine/run.js";
import { registerWorkflowProfiles } from "../src/engine/profile.js";
import { writeStateBootstrap } from "../src/engine/state.js";
import type { Profile, TaskType, TeamState } from "../src/engine/types.js";
import type { TaskCaller, TaskResult } from "../src/engine/stage.js";

const PROFILE_NAME = "run-continuation-regression";

const profile: Profile = {
  name: PROFILE_NAME,
  title: "Continuation regression",
  description: "Minimal profile for run continuation tests",
  match: { type: ["FEATURE"] },
  stages: [
    { id: "upstream", title: "Upstream", type: "single", role: "worker" },
    { id: "reopened", title: "Reopened", type: "single", role: "worker", consumes: ["upstream"] },
    { id: "downstream", title: "Downstream", type: "single", role: "worker" },
  ],
};

registerWorkflowProfiles([profile]);

function taskResult(id: string): TaskResult {
  return { id, output: "ok", artifacts: {}, exitCode: 0 };
}

function fixtureState(branch: string, statuses: TeamState["stages"][number]["status"][]): TeamState {
  return {
    schema: 1,
    branch,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: PROFILE_NAME,
    },
    task: "Original task",
    history: [{ task: "Earlier task", feedback: "Earlier feedback", at: "2026-01-01T00:00:00.000Z" }],
    workflow_override: true,
    issue: null,
    stage_cursor: "reopened",
    stages: profile.stages.map((stage, index) => ({ id: stage.id, status: statuses[index]! })),
    artifacts: { upstream: "artifacts/upstream.json", preserved: "artifacts/preserved.json" },
    pause: { kind: "user_checkpoint", reason: "waiting for feedback" },
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function options(root: string, branch: string, taskTool: TaskCaller, continuation?: { feedback: string; stageId: string }) {
  return {
    task: "New conflicting task classification",
    cwd: root,
    branch,
    autonomous: true,
    classification: {
      type: "BUG_FIX" as TaskType,
      complexity: "COMPLEX" as const,
      confidence: "LOW" as const,
      autonomous: true,
      workflow: "debug-cycle" as const,
    },
    taskTool,
    continuation,
  };
}

test("run continuation rejects stale branch before task calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-stale-"));
  try {
    initGit(root, "feature/other");
    writeStateBootstrap(root, fixtureState("feature/original", ["done", "done", "done"]));
    let calls = 0;
    const taskTool: TaskCaller = {
      async call() { calls += 1; return taskResult("call"); },
      async batch() { calls += 1; return [taskResult("batch")]; },
    };

    await assert.rejects(
      run(options(root, "feature/other", taskTool, { feedback: "Please revisit it", stageId: "reopened" })),
      /cannot continue workflow: no non-stale state for branch feature\/other/,
    );
    assert.equal(calls, 0, "stale continuation must reject before task.call or batch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run continuation preserves persisted classification, upstream state, artifacts, and history", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-valid-"));
  const branch = "feature/continuation";
  try {
    initGit(root, branch);
    writeStateBootstrap(root, fixtureState(branch, ["done", "done", "done"]));
    const calls: string[] = [];
    const taskTool: TaskCaller = {
      async call(args) {
        calls.push(args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "unknown");
        return taskResult(`call-${calls.length}`);
      },
      async batch(args) {
        calls.push(...args.tasks.map(() => "batch"));
        return args.tasks.map((_, index) => taskResult(`batch-${index}`));
      },
    };

    const result = await run(options(root, branch, taskTool, {
      feedback: "Rework the reopened stage",
      stageId: "reopened",
    }));

    assert.deepEqual(result.classification, {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: PROFILE_NAME,
    }, "continuation must use persisted classification over new input");
    assert.equal(result.profile.name, PROFILE_NAME, "continuation must use persisted profile");
    assert.deepEqual(calls, ["reopened", "downstream"], "only reopened and downstream stages run");

    const statePath = result.statePath!;
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.deepEqual(state.stages, [
      { id: "upstream", status: "done" },
      { id: "reopened", status: "done" },
      { id: "downstream", status: "done" },
    ]);
    assert.deepEqual(state.artifacts, fixtureState(branch, ["done", "done", "done"]).artifacts);
    assert.equal(state.history?.length, 2);
    assert.equal(state.history?.[1]?.feedback, "Rework the reopened stage");
    assert.match(state.task, /User feedback: Rework the reopened stage/);
    assert.equal(state.dispatch_capability?.status, "complete", "successful continuation must durably join and advance every stage");
    assert.doesNotMatch(readFileSync(statePath, "utf8"), /"(?:dispatch_token|advance_token)"\s*:/, "plaintext handoff secrets must never be persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run continuation keeps explicit custom feature state and artifacts layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-custom-"));
  const branch = "feature/x";
  try {
    initGit(root, branch);
    const customDir = join(root, ".work-state", "features", "custom");
    mkdirSync(join(customDir, "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "custom\n");
    writeFileSync(join(customDir, "artifacts", "upstream.json"), JSON.stringify({ source: "custom" }));
    writeStateBootstrap(root, fixtureState(branch, ["done", "done", "done"]), { featureSlug: "custom" });
    writeFileSync(join(customDir, "artifacts", "upstream.json"), JSON.stringify({ source: "custom" }));
    const prompts: string[] = [];
    const taskTool: TaskCaller = {
      async call(args) { prompts.push(args.task); return taskResult("call"); },
      async batch(args) { prompts.push(...args.tasks.map((task) => task.task)); return args.tasks.map(() => taskResult("batch")); },
    };
    const result = await run(options(root, branch, taskTool, { feedback: "custom feedback", stageId: "reopened" }));
    assert.equal(result.statePath, join(customDir, "state.json"));
    assert.ok(prompts.some((prompt) => prompt.includes('"source": "custom"')));
    const state = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
    assert.equal(state.pause.kind, "done");
    assert.match(state.task, /custom feedback/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run continuation keeps legacy state and artifacts layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-legacy-"));
  const branch = "feature/x";
  try {
    initGit(root, branch);
    const state = fixtureState(branch, ["done", "done", "done"]);
    const legacyDir = join(root, ".work-state");
    mkdirSync(join(legacyDir, "artifacts"), { recursive: true });
    writeFileSync(join(legacyDir, "team-state.json"), JSON.stringify(state));
    writeFileSync(join(legacyDir, "artifacts", "upstream.json"), JSON.stringify({ source: "legacy" }));
    const prompts: string[] = [];
    const taskTool: TaskCaller = {
      async call(args) { prompts.push(args.task); return taskResult("call"); },
      async batch(args) { prompts.push(...args.tasks.map((task) => task.task)); return args.tasks.map(() => taskResult("batch")); },
    };
    const result = await run(options(root, branch, taskTool, { feedback: "legacy feedback", stageId: "reopened" }));
    assert.equal(result.statePath, join(legacyDir, "team-state.json"));
    assert.ok(prompts.some((prompt) => prompt.includes('"source": "legacy"')));
    assert.equal(existsSync(join(root, ".work-state", "features", "feature-x", "state.json")), false);
    assert.equal(existsSync(join(legacyDir, "team-state.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
