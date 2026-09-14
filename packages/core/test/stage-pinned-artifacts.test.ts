import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execPath } from "node:process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createTaskCaller, MAX_TASK_RESULT_OUTPUT_BYTES, runStage, type StageContext, type TaskResult, type TaskToolLike } from "../src/engine/stage.js";
import { MAX_ARTIFACT_AGGREGATE_BYTES, MAX_ARTIFACT_BYTES } from "../src/engine/artifacts.js";
import { durableNamespacedArtifactId, slotArtifactEnvelopeBytes } from "../src/engine/fan-in.js";
import type { StageDef, TeamState } from "../src/engine/types.js";

type StageKind = "orchestrator" | "single" | "consilium" | "bash";
type SwapKind = "root" | "ancestor" | "artifact-dir" | "leaf";
type SwapPlan = { outside: string; outsideLeaf?: string; script?: string; restore: () => void };

function makeState(stageId: string, stageType: StageKind): TeamState {
  return {
    schema: 1,
    branch: "feat/pinned-stage",
    run_key: "pinned-stage-run",
    classification: { type: "FEATURE", complexity: "SIMPLE", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: `run ${stageType}`,
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: [{ id: stageId, status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

function makeFixture(nested: boolean): { root: string; artifactsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "stage-pinned-root-"));
  const artifactsDir = nested ? join(root, ".work-state", "features", "feature-a", "artifacts") : join(root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  return { root, artifactsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function swapPath(fixture: { root: string; artifactsDir: string }, kind: SwapKind): SwapPlan {
  const { root, artifactsDir } = fixture;
  const outside = mkdtempSync(join(tmpdir(), "stage-pinned-outside-"));
  if (kind === "root") {
    const moved = `${root}.opened`;
    renameSync(root, moved);
    symlinkSync(outside, root, "dir");
    return { outside, restore: () => { unlinkSync(root); renameSync(moved, root); } };
  }
  if (kind === "ancestor") {
    const target = join(root, ".work-state");
    const moved = `${target}.opened`;
    renameSync(target, moved);
    symlinkSync(outside, target, "dir");
    return { outside, restore: () => { unlinkSync(target); renameSync(moved, target); } };
  }
  if (kind === "artifact-dir") {
    const moved = `${artifactsDir}.opened`;
    renameSync(artifactsDir, moved);
    symlinkSync(outside, artifactsDir, "dir");
    return { outside, restore: () => { unlinkSync(artifactsDir); renameSync(moved, artifactsDir); } };
  }
  const leaf = join(artifactsDir, "first.json");
  const outsideLeaf = join(outside, "first.json");
  writeFileSync(outsideLeaf, "outside-before\n");
  symlinkSync(outsideLeaf, leaf);
  return { outside, outsideLeaf, restore: () => unlinkSync(leaf) };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function unlinkIfSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function restoreDirectorySwap(target: string, moved: string): void {
  unlinkIfSymlink(target);
  if (pathExists(moved) && !pathExists(target)) renameSync(moved, target);
}

function runtimeFsScript(body: string): string {
  return `(async()=>{const fs=await import('node:fs');${body}})().catch((error)=>{console.error(error);process.exitCode=1})`;
}

function bashSwapPlan(fixture: { root: string; artifactsDir: string }, kind: SwapKind): SwapPlan {
  const outside = mkdtempSync(join(tmpdir(), "stage-bash-outside-"));
  if (kind === "root") {
    const moved = `${fixture.root}.opened`;
    return {
      outside,
      script: runtimeFsScript(`fs.renameSync(${JSON.stringify(fixture.root)},${JSON.stringify(moved)});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(fixture.root)},'dir')`),
      restore: () => restoreDirectorySwap(fixture.root, moved),
    };
  }
  if (kind === "ancestor") {
    const target = join(fixture.root, ".work-state");
    const moved = `${target}.opened`;
    return {
      outside,
      script: runtimeFsScript(`fs.renameSync(${JSON.stringify(target)},${JSON.stringify(moved)});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(target)},'dir')`),
      restore: () => restoreDirectorySwap(target, moved),
    };
  }
  if (kind === "artifact-dir") {
    const moved = `${fixture.artifactsDir}.opened`;
    return {
      outside,
      script: runtimeFsScript(`fs.renameSync(${JSON.stringify(fixture.artifactsDir)},${JSON.stringify(moved)});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(fixture.artifactsDir)},'dir')`),
      restore: () => restoreDirectorySwap(fixture.artifactsDir, moved),
    };
  }
  const leaf = join(fixture.artifactsDir, "first.json");
  const outsideLeaf = join(outside, "first.json");
  writeFileSync(outsideLeaf, "outside-before\n");
  return {
    outside,
    outsideLeaf,
    script: runtimeFsScript(`fs.symlinkSync(${JSON.stringify(outsideLeaf)},${JSON.stringify(leaf)})`),
    restore: () => unlinkIfSymlink(leaf),
  };
}

function context(fixture: { root: string; artifactsDir: string }, stageId: string, stageType: StageKind, configure: (ctx: StageContext) => void): StageContext {
  const ctx: StageContext = {
    cwd: fixture.root,
    state: makeState(stageId, stageType),
    artifactsDir: fixture.artifactsDir,
    flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    agent: (role) => role,
    task: {
      call: async (): Promise<TaskResult> => ({ id: `${stageId}-architect`, output: "ok", artifacts: { first: JSON.stringify({ value: 1 }), second: JSON.stringify({ value: 2 }) }, exitCode: 0 }),
      batch: async (): Promise<TaskResult[]> => [{ id: `${stageId}-architect`, slot_id: "architect", output: "ok", artifacts: { first: JSON.stringify({ value: 1 }), second: JSON.stringify({ value: 2 }) }, exitCode: 0 }],
    },
    pause: async () => undefined,
    log: () => undefined,
    resolveDevAgent: () => null,
  };
  if (stageType === "single" || stageType === "consilium") {
    ctx.durable = { authorize: () => ({ ok: true, dispatchId: `${stageId}-dispatch`, state: ctx.state }), complete: () => ({ ok: true }), advance: () => ({ ok: true }) };
  }
  configure(ctx);
  return ctx;
}

function stageFor(stageType: StageKind, command?: string): StageDef {
  const base = { id: stageType, title: stageType, produces: "first" };
  if (stageType === "orchestrator") return { ...base, type: "orchestrator" };
  if (stageType === "single") return { ...base, type: "single", role: "architect" };
  if (stageType === "consilium") return { ...base, type: "consilium", roles: ["architect"] };
  return { ...base, type: "bash", command: command ?? "true" };
}

function paddedJsonObject(totalBytes: number): string {
  assert.ok(totalBytes >= 2);
  return `{${" ".repeat(totalBytes - 2)}}`;
}
function multibyteBoundaryValue(): Record<string, string> {
  return {
    payloadA: "\0".repeat(1_000_000),
    payloadB: "\0".repeat(398_050),
    unicode: "é",
  };
}

 

function assertNoArtifactFiles(fixture: { artifactsDir: string }): void {
  assert.deepEqual(readdirSync(fixture.artifactsDir), [], "rejected TaskResult must not leave partial artifact files");
}

test("stage consilium rolls back the failed slot's shared and namespaced writes", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "consilium-completion-cas", "consilium", (stageCtx) => {
      let completions = 0;
      stageCtx.task.batch = async () => [
        { id: "consilium-completion-cas-architect", slot_id: "architect", output: "ok", artifacts: { first: JSON.stringify({ value: 1 }) }, exitCode: 0 },
        { id: "consilium-completion-cas-reviewer", slot_id: "reviewer", output: "ok", artifacts: { first: JSON.stringify({ value: 2 }) }, exitCode: 0 },
      ];
      stageCtx.durable!.complete = () => {
        completions += 1;
        return completions === 1 ? { ok: true } : { ok: false, error: "state CAS lost" };
      };
    });
    const outcome = await runStage({ ...stageFor("consilium"), id: "consilium-completion-cas", roles: ["architect", "reviewer"] }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /state CAS lost/);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.artifactsDir, "first.json"), "utf8")), { value: 1 }, "failed slot rollback restores the prior shared artifact");
    assert.equal(existsSync(join(fixture.artifactsDir, durableNamespacedArtifactId("first", "architect") + ".json")), true, "completed slot provenance remains");
    assert.equal(existsSync(join(fixture.artifactsDir, durableNamespacedArtifactId("first", "reviewer") + ".json")), false, "failed slot provenance is removed");
  } finally {
    fixture.cleanup();
  }
});

test("stage single rolls back its artifact writes when completion CAS fails", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "single-completion-cas", "single", (stageCtx) => {
      stageCtx.durable!.complete = () => ({ ok: false, error: "state CAS lost" });
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-completion-cas", produces: ["first", "second"] }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /state CAS lost/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});


test("single provider output over the evidence cap leaves no artifact files", async () => {
  const fixture = makeFixture(false);
  try {
    const oversized = "x".repeat(MAX_TASK_RESULT_OUTPUT_BYTES + 1);
    const ctx = context(fixture, "single-provider-output", "single", (stageCtx) => {
      const tool: TaskToolLike = {
        async execute() {
          return { output: { id: "oversized-output", output: oversized, artifacts: { first: "{}" }, exitCode: 0 } };
        },
      };
      stageCtx.task = createTaskCaller(tool);
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-provider-output" }, ctx);
    assert.equal(outcome.status, "failed");
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("single deeply nested provider output is rejected before stringify or artifact writes", async () => {
  const fixture = makeFixture(false);
  try {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 80; index += 1) nested = { child: nested };
    const ctx = context(fixture, "single-provider-nested", "single", (stageCtx) => {
      const tool: TaskToolLike = {
        async execute() {
          return { output: { id: "deep-output", output: nested, artifacts: { first: "{}" }, exitCode: 0 } };
        },
      };
      stageCtx.task = createTaskCaller(tool);
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-provider-nested" }, ctx);
    assert.equal(outcome.status, "failed");
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("orchestrator rejects extra artifact ids before writing", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "orchestrator-extra", "orchestrator", (stageCtx) => {
      stageCtx.orchestrate = async () => ({ output: "ok", artifacts: { first: "{}", extra: "{}" } });
    });
    const outcome = await runStage({ ...stageFor("orchestrator"), id: "orchestrator-extra" }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /exactly match current stage\.produces/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("orchestrator rejects missing artifact ids before writing", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "orchestrator-missing", "orchestrator", (stageCtx) => {
      stageCtx.orchestrate = async () => ({ output: "ok", artifacts: {} });
    });
    const outcome = await runStage({ ...stageFor("orchestrator"), id: "orchestrator-missing" }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /exactly match current stage\.produces/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("orchestrator rejects aggregate and deeply nested artifacts before writing", async () => {
  const aggregateFixture = makeFixture(false);
  try {
    const each = Math.floor(MAX_ARTIFACT_AGGREGATE_BYTES / 2) + 1;
    const aggregateStage: StageDef = { ...stageFor("orchestrator"), id: "orchestrator-aggregate", produces: ["first", "second"] };
    const ctx = context(aggregateFixture, "orchestrator-aggregate", "orchestrator", (stageCtx) => {
      stageCtx.orchestrate = async () => ({
        output: "ok",
        artifacts: { first: paddedJsonObject(each), second: paddedJsonObject(each) },
      });
    });
    const outcome = await runStage(aggregateStage, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /artifact aggregate exceeds/);
    assertNoArtifactFiles(aggregateFixture);
  } finally {
    aggregateFixture.cleanup();
  }

  const nestedFixture = makeFixture(false);
  try {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 80; index += 1) nested = { child: nested };
    const ctx = context(nestedFixture, "orchestrator-nested", "orchestrator", (stageCtx) => {
      stageCtx.orchestrate = async () => ({ output: "ok", artifacts: { first: nested } });
    });
    const outcome = await runStage({ ...stageFor("orchestrator"), id: "orchestrator-nested" }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /artifact structure limit exceeded/);
    assertNoArtifactFiles(nestedFixture);
  } finally {
    nestedFixture.cleanup();
  }
});
test("orchestrator rejects oversized output before writing valid artifacts", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "orchestrator-output", "orchestrator", (stageCtx) => {
      stageCtx.orchestrate = async () => ({
        output: "x".repeat(MAX_TASK_RESULT_OUTPUT_BYTES + 1),
        artifacts: { first: "{}" },
      });
    });
    const outcome = await runStage({ ...stageFor("orchestrator"), id: "orchestrator-output" }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /orchestrator output exceeds/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});


test("single direct TaskResult rejects oversized evidence before persisting valid artifacts", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "single-direct-evidence", "single", (stageCtx) => {
      const oversized = "x".repeat(MAX_TASK_RESULT_OUTPUT_BYTES + 1);
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "direct-evidence", output: oversized, artifacts: { first: "{}" }, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [],
      };
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-direct-evidence" }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /task output exceeds/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("single TaskResult accepts a raw artifact exactly at the byte cap before writing", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "single-byte-max", "single", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "single-byte-max-architect", output: "ok", artifacts: { first: paddedJsonObject(MAX_ARTIFACT_BYTES) }, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [],
      };
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-byte-max" }, ctx);
    assert.equal(outcome.status, "done");
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.artifactsDir, "first.json"), "utf8")), {});
  } finally {
    fixture.cleanup();
  }
});

test("single TaskResult rejects a raw artifact over the byte cap before parsing or writing", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "single-byte-over", "single", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "single-byte-over-architect", output: "ok", artifacts: { first: paddedJsonObject(MAX_ARTIFACT_BYTES + 1) }, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [],
      };
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-byte-over" }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /payload limit/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("single TaskResult rejects an aggregate artifact set over the byte cap before writing", async () => {
  const fixture = makeFixture(false);
  try {
    const each = Math.floor(MAX_ARTIFACT_AGGREGATE_BYTES / 2) + 1;
    const ctx = context(fixture, "single-byte-aggregate", "single", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({
          id: "single-byte-aggregate-architect",
          output: "ok",
          artifacts: { first: paddedJsonObject(each), second: paddedJsonObject(each) },
          exitCode: 0,
        }),
        batch: async (): Promise<TaskResult[]> => [],
      };
    });
    const outcome = await runStage({ ...stageFor("single"), id: "single-byte-aggregate", produces: ["first", "second"] }, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /aggregate/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("consilium slots accept raw artifacts exactly at the byte cap", async () => {
  const fixture = makeFixture(false);
  try {
    const raw = paddedJsonObject(MAX_ARTIFACT_BYTES);
    const ctx = context(fixture, "consilium-byte-max", "consilium", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "unused", output: "ok", artifacts: {}, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [
          { id: "consilium-byte-max-architect", slot_id: "architect", output: "ok", artifacts: { first: raw }, exitCode: 0 },
          { id: "consilium-byte-max-reviewer", slot_id: "reviewer", output: "ok", artifacts: { first: raw }, exitCode: 0 },
        ],
      };
    });
    const outcome = await runStage(
      { ...stageFor("consilium"), id: "consilium-byte-max", roles: ["architect", "reviewer"] },
      ctx,
    );
    assert.equal(outcome.status, "done");
  } finally {
    fixture.cleanup();
  }
});

test("consilium rejects an over-cap slot artifact before any slot writes", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "consilium-byte-over", "consilium", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "unused", output: "ok", artifacts: {}, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [
          { id: "consilium-byte-over-architect", slot_id: "architect", output: "ok", artifacts: { first: paddedJsonObject(MAX_ARTIFACT_BYTES + 1) }, exitCode: 0 },
          { id: "consilium-byte-over-reviewer", slot_id: "reviewer", output: "ok", artifacts: { first: "{}" }, exitCode: 0 },
        ],
      };
    });
    const outcome = await runStage(
      { ...stageFor("consilium"), id: "consilium-byte-over", roles: ["architect", "reviewer"] },
      ctx,
    );
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /payload limit/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("consilium rejects an over-cap aggregate slot set before any slot writes", async () => {
  const fixture = makeFixture(false);
  try {
    const each = Math.floor(MAX_ARTIFACT_AGGREGATE_BYTES / 2) + 1;
    const ctx = context(fixture, "consilium-byte-aggregate", "consilium", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "unused", output: "ok", artifacts: {}, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [
          {
            id: "consilium-byte-aggregate-architect",
            slot_id: "architect",
            output: "ok",
            artifacts: { first: paddedJsonObject(each), second: paddedJsonObject(each) },
            exitCode: 0,
          },
          { id: "consilium-byte-aggregate-reviewer", slot_id: "reviewer", output: "ok", artifacts: { first: "{}", second: "{}" }, exitCode: 0 },
        ],
      };
    });
    const outcome = await runStage(
      { ...stageFor("consilium"), id: "consilium-byte-aggregate", roles: ["architect", "reviewer"], produces: ["first", "second"] },
      ctx,
    );
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /aggregate/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});
test("consilium rejects a cap-plus-one wrapped envelope atomically before writing any slot", async () => {
  const fixture = makeFixture(false);
  try {
    const value = multibyteBoundaryValue();
    const overBytes = Buffer.byteLength(slotArtifactEnvelopeBytes(
      "first",
      "reviewer",
      "consilium-wrapped-cap-over-reviewer",
      value,
    ), "utf8");
    assert.ok(overBytes > MAX_ARTIFACT_BYTES, `wrapped envelope must exceed cap (${overBytes} > ${MAX_ARTIFACT_BYTES})`);
    const ctx = context(fixture, "consilium-wrapped-cap-over", "consilium", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => ({ id: "unused", output: "ok", artifacts: {}, exitCode: 0 }),
        batch: async (): Promise<TaskResult[]> => [
          {
            id: "consilium-wrapped-cap-over-architect",
            slot_id: "architect",
            output: "ok",
            artifacts: { first: "{}" },
            exitCode: 0,
          },
          {
            id: "consilium-wrapped-cap-over-reviewer",
            slot_id: "reviewer",
            output: "ok",
            artifacts: { first: value },
            exitCode: 0,
          },
        ],
      };
    });
    const outcome = await runStage(
      { ...stageFor("consilium"), id: "consilium-wrapped-cap-over", roles: ["architect", "reviewer"] },
      ctx,
    );
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /slot envelope exceeds/);
    assertNoArtifactFiles(fixture);
  } finally {
    fixture.cleanup();
  }
});

function originalArtifactsPath(fixture: { root: string; artifactsDir: string }, kind: SwapKind): string | null {
  if (kind === "root") return join(`${fixture.root}.opened`, relative(fixture.root, fixture.artifactsDir));
  if (kind === "ancestor") return join(`${join(fixture.root, ".work-state")}.opened`, relative(join(fixture.root, ".work-state"), fixture.artifactsDir));
  if (kind === "artifact-dir") return `${fixture.artifactsDir}.opened`;
  return null;
}

function assertUntouched(plan: SwapPlan): void {
  if (plan.outsideLeaf) assert.equal(readFileSync(plan.outsideLeaf, "utf8"), "outside-before\n");
  else assert.deepEqual(readdirSync(plan.outside), []);
}

for (const stageType of ["orchestrator", "single", "consilium", "bash"] as const) {
  for (const swap of ["root", "ancestor", "artifact-dir", "leaf"] as const) {
    test(`pinned ${stageType} rejects ${swap} swap after dispatch without replacement writes`, async () => {
      const fixture = makeFixture(swap !== "root");
      let plan: SwapPlan | undefined;
      try {
        const ctx = context(fixture, stageType, stageType, (stageCtx) => {
          if (stageType === "orchestrator") {
            stageCtx.orchestrate = async () => {
              plan = swapPath(fixture, swap);
              return { artifacts: { first: { value: 1 }, second: { value: 2 } } };
            };
          } else if (stageType !== "bash") {
            stageCtx.task = {
              call: async (): Promise<TaskResult> => {
                plan = swapPath(fixture, swap);
                return { id: `${stageType}-architect`, output: "ok", artifacts: { first: JSON.stringify({ value: 1 }), second: JSON.stringify({ value: 2 }) }, exitCode: 0 };
              },
              batch: async (): Promise<TaskResult[]> => {
                plan = swapPath(fixture, swap);
                return [{ id: `${stageType}-architect`, slot_id: "architect", output: "ok", artifacts: { first: JSON.stringify({ value: 1 }), second: JSON.stringify({ value: 2 }) }, exitCode: 0 }];
              },
            };
          }
        });
        if (stageType === "bash") {
          plan = bashSwapPlan(fixture, swap);
          const command = `${execPath} -e "eval(Buffer.from('${Buffer.from(plan.script!).toString("base64")}', 'base64').toString())"`;
          const outcome = await runStage(stageFor(stageType, command), ctx);
          assert.equal(outcome.status, "failed");
        } else {
          const outcome = await runStage(stageFor(stageType), ctx);
          assert.equal(outcome.status, "failed");
        }
        assert.ok(plan, "swap seam executed");
        assertUntouched(plan);
        const original = originalArtifactsPath(fixture, swap);
        if (original) assert.equal(existsSync(join(original, "first.json")), false, "no partial artifact write before rejection");
      } finally {
        plan?.restore();
        if (plan) rmSync(plan.outside, { recursive: true, force: true });
        fixture.cleanup();
      }
    });
  }
}

test("pinned stage rejects a stale cursor after an async orchestrator result", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "orchestrator", "orchestrator", (stageCtx) => {
      stageCtx.orchestrate = async () => {
        stageCtx.state.stage_cursor = "different-stage";
        return { artifacts: { first: { value: 1 } } };
      };
    });
    const outcome = await runStage(stageFor("orchestrator"), ctx);
    assert.equal(outcome.status, "failed");
    assert.equal(existsSync(join(fixture.artifactsDir, "first.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("pinned single rejects a work-identity mutation after authorize", async () => {
  const fixture = makeFixture(false);
  try {
    const ctx = context(fixture, "single", "single", () => undefined);
    const authorizedState: TeamState = {
      ...ctx.state,
      work_identity: {
        run_id: "run",
        wave_id: "wave",
        slice_id: "slice",
        session_id: "session",
        workflow: "lightweight",
        stage_id: "single",
        stage_cursor: "single",
        capability_id: "cap",
        capability_epoch: "epoch",
        slot_id: "architect",
        task_id: "task",
        dispatch_id: "dispatch",
        attempt: 1,
        worker_id: "worker",
      },
    };
    ctx.durable = {
      authorize: () => ({ ok: true, dispatchId: "dispatch", state: authorizedState }),
      complete: () => ({ ok: true }),
      advance: () => ({ ok: true }),
    };
    ctx.task = {
      call: async (): Promise<TaskResult> => {
        ctx.state = {
          ...ctx.state,
          work_identity: { ...ctx.state.work_identity!, task_id: "tampered" },
        };
        return { id: "single-architect", output: "ok", artifacts: { first: JSON.stringify({ value: 1 }) }, exitCode: 0 };
      },
      batch: async (): Promise<TaskResult[]> => [],
    };
    const outcome = await runStage(stageFor("single"), ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /work identity changed/);
    assert.equal(existsSync(join(fixture.artifactsDir, "first.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("pinned leaf replacement remains a symlink and its target stays unchanged", async () => {
  const fixture = makeFixture(false);
  const outside = mkdtempSync(join(tmpdir(), "stage-leaf-outside-"));
  const leaf = join(fixture.artifactsDir, "first.json");
  const outsideLeaf = join(outside, "first.json");
  writeFileSync(outsideLeaf, "sentinel\n");
  try {
    const ctx = context(fixture, "single", "single", (stageCtx) => {
      stageCtx.task = {
        call: async (): Promise<TaskResult> => {
          symlinkSync(outsideLeaf, leaf);
          return { id: "single-architect", output: "ok", artifacts: { first: JSON.stringify({ value: 1 }) }, exitCode: 0 };
        },
        batch: async (): Promise<TaskResult[]> => [],
      };
    });
    const outcome = await runStage(stageFor("single"), ctx);
    assert.equal(outcome.status, "failed");
    assert.equal(readFileSync(outsideLeaf, "utf8"), "sentinel\n");
    assert.equal(lstatSync(leaf).isSymbolicLink(), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
