import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { run } from "../src/engine/run.js";
import { registerTestProfiles, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
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
  writeTestRegistryMarker(root);
  registerTestProfiles(root, [profile]);
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
    writeState(root, fixtureState("feature/original", ["done", "done", "done"]));
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
    writeState(root, fixtureState(branch, ["done", "done", "done"]));
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
    writeState(root, fixtureState(branch, ["done", "done", "done"]), { featureSlug: "custom" });
    writeFileSync(join(customDir, "artifacts", "upstream.json"), JSON.stringify({ source: "custom" }));
    const prompts: string[] = [];
    const taskTool: TaskCaller = {
      async call(args) { prompts.push(args.task); return taskResult("call"); },
      async batch(args) { prompts.push(...args.tasks.map((task) => task.task)); return args.tasks.map(() => taskResult("batch")); },
    };
    const result = await run(options(root, branch, taskTool, { feedback: "custom feedback", stageId: "reopened" }));
    assert.equal(result.statePath, realpathSync(join(customDir, "state.json")));
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
    assert.equal(result.statePath, realpathSync(join(legacyDir, "team-state.json")));
    assert.ok(prompts.some((prompt) => prompt.includes('"source": "legacy"')));
    assert.equal(existsSync(join(root, ".work-state", "features", "feature-x", "state.json")), false);
    assert.equal(existsSync(join(legacyDir, "team-state.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle start rereads and preserves a concurrent generic state mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-state-race-"));
  const branch = "feature/state-race";
  const featureId = "state-race";
  const runKey = "run-state-race";
  try {
    initGit(root, branch);
    const seeded = fixtureState(branch, ["done", "done", "done"]);
    seeded.run_key = runKey;
    writeState(root, seeded, { featureSlug: featureId });
    let transactionCount = 0;
    setStateTransactionTestHooks({
      afterTargetResolution: ({ statePath }) => {
        if (++transactionCount !== 2) return;
        const current = JSON.parse(readFileSync(statePath, "utf8")) as TeamState & { state_revision?: number };
        current.task = "concurrent-task-mutation";
        current.state_revision = (current.state_revision ?? 0) + 1;
        writeFileSync(statePath, JSON.stringify(current, null, 2) + "\n", "utf8");
      },
    }, root);
    const taskTool: TaskCaller = {
      async call() { return taskResult("race-call"); },
      async batch(args) { return args.tasks.map((_, index) => taskResult(`race-batch-${index}`)); },
    };
    const result = await run({
      task: "Race lifecycle with generic state mutation",
      cwd: root,
      branch,
      autonomous: false,
      classification: {
        type: "FEATURE",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: false,
        workflow: PROFILE_NAME,
      },
      taskTool,
      continuation: { feedback: "reopen raced stage", stageId: "reopened" },
      feature_id: featureId,
      run_key: runKey,
    }, root);
    const state = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState & { state_revision?: number };
    assert.match(state.task, /concurrent-task-mutation/u);
    assert.equal(state.dispatch_capability?.status, "complete");
    assert.ok((state.state_revision ?? 0) >= 4, "prepare and lifecycle commits must advance revision monotonically");
    assert.equal(transactionCount >= 2, true, "the second transaction is the lifecycle start barrier");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic restart reuses ready and dispatched capabilities without duplicate provider dispatch", async () => {
  for (const mode of ["ready", "dispatched"] as const) {
    const root = mkdtempSync(join(tmpdir(), `omp-run-restart-${mode}-`));
    const branch = `feature/restart-${mode}`;
    let firstAttempt = true;
    let statePath = "";
    const observed: Array<{ capabilityId: string; dispatchId?: string }> = [];
    let calls = 0;
    const callStages: string[] = [];
    const taskTool: TaskCaller = {
      async call({ task }) {
        callStages.push(task.match(/## Stage: ([^ ]+)/)?.[1] ?? "unknown");
        calls += 1;
        if (!firstAttempt) {
          const persisted = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
          observed.push({
            capabilityId: persisted.dispatch_capability?.capability_id ?? "",
            dispatchId: persisted.dispatch_capability?.dispatches?.[0]?.id,
          });
        }
        if (firstAttempt) {
          firstAttempt = false;
          return { id: "pending", output: "", error: "provider remains active", exitCode: 0, pending: true };
        }
        return taskResult(`restart-${calls}`);
      },
      async batch(args) {
        return args.tasks.map((_, index) => taskResult(`restart-batch-${index}`));
      },
    };
    try {
      initGit(root, branch);
      const first = await run({
        task: "restart capability",
        cwd: root,
        branch,
        autonomous: false,
        classification: {
          type: "FEATURE",
          complexity: "QUICK",
          confidence: "HIGH",
          autonomous: false,
          workflow: PROFILE_NAME,
        },
        taskTool,
      });
      statePath = first.statePath;
      const interrupted = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
      const capability = interrupted.dispatch_capability;
      assert.ok(capability?.capability_id && capability.issued_for?.stage_cursor === "upstream");
      assert.equal(capability?.status, "dispatched");
      const originalCapabilityId = capability?.capability_id;
      const originalDispatchId = capability?.dispatches?.[0]?.id;
      if (mode === "ready" && capability) {
        writeState(root, {
          ...interrupted,
          dispatch_capability: { ...capability, status: "ready", dispatches: [] },
        }, { featureSlug: branch.replace(/\//g, "-") });
      }
      await run({
        task: "restart capability replay",
        cwd: root,
        branch,
        autonomous: true,
        classification: {
          type: "BUG_FIX",
          complexity: "COMPLEX",
          confidence: "LOW",
          autonomous: true,
          workflow: "debug-cycle",
        },
        taskTool,
        continuation: { feedback: "resume the interrupted stage", stageId: "upstream" },
      });
      assert.equal(calls, 4, `${mode}: one interrupted call, one resumed upstream call, reopened continuation, and downstream call`);
      assert.equal(observed[0]?.capabilityId, originalCapabilityId, `${mode}: capability identity is preserved across restart`);
      if (mode === "dispatched") assert.equal(observed[0]?.dispatchId, originalDispatchId, "dispatched restart must reuse the authorized dispatch");
      const finalState = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
      assert.equal(finalState.pause.kind, "done");
      assert.equal(finalState.dispatch_capability?.status, "complete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generic restart rejects profile and configuration mutation instead of reminting", async () => {
  for (const mutation of ["profile", "config"] as const) {
    const root = mkdtempSync(join(tmpdir(), `omp-run-restart-mutated-${mutation}-`));
    const branch = `feature/restart-mutated-${mutation}`;
    let firstAttempt = true;
    let calls = 0;
    let statePath = "";
    const taskTool: TaskCaller = {
      async call() {
        calls += 1;
        if (firstAttempt) {
          firstAttempt = false;
          return { id: "pending", output: "", error: "provider remains active", exitCode: 0, pending: true };
        }
        return taskResult("unexpected");
      },
      async batch() { return []; },
    };
    try {
      initGit(root, branch);
      const first = await run({
        task: "restart mutation",
        cwd: root,
        branch,
        autonomous: false,
        classification: {
          type: "FEATURE",
          complexity: "QUICK",
          confidence: "HIGH",
          autonomous: false,
          workflow: PROFILE_NAME,
        },
        taskTool,
      });
      statePath = first.statePath;
      const interrupted = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
      assert.equal(interrupted.dispatch_capability?.status, "dispatched");
      if (mutation === "profile") {
        const tampered = { ...interrupted, profile_hash: "mutated-continuation-profile-hash" };
        writeFileSync(statePath, JSON.stringify(tampered, null, 2) + "\n", "utf8");
      } else {
        mkdirSync(join(root, ".omp"), { recursive: true });
        writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { worker: "mutated-worker" } }) + "\n");
      }
      await assert.rejects(
        run({
          task: "restart mutation replay",
          cwd: root,
          branch,
          autonomous: true,
          classification: {
            type: "BUG_FIX",
            complexity: "COMPLEX",
            confidence: "LOW",
            autonomous: true,
            workflow: "debug-cycle",
          },
          taskTool,
          continuation: { feedback: "resume mutated stage", stageId: "upstream" },
        }),
        /persisted durable stage|state_invalid|stale/u,
      );
      assert.equal(calls, 1, `${mutation}: mutation must reject before provider dispatch`);
      const after = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
      assert.equal(after.dispatch_capability?.capability_id, interrupted.dispatch_capability?.capability_id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
