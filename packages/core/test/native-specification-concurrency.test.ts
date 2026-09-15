import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { registerTestConstitutionGate, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { registerTestTeamWorkflow } from "./fixtures/host-tool-activation.js";
import { TEST_CONTEXT } from "./fixtures/registrar-host.js";
import { resolveState, writeState } from "../src/engine/state.js";
import { createPreparationHandoff, preparationStateDigest } from "../src/engine/preparation.js";
import { nativeSpecificationTaskGate } from "../src/gates/native-specification.js";
import { dispatchGate } from "../src/gates/dispatch.js";
import { startNativeSpecificationPhase, type NativeSpecificationPhaseStart } from "../src/specification/phase.js";
import { parseDispatchMarker } from "../src/gates/dispatch.js";
import { bindWorkspaceConstitution, createFeatureWorkspace } from "../src/specification/workspace.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { TeamState } from "../src/engine/types.js";

const profile = loadProfile("spec-preparation");
assert.ok(profile);
const constitution = "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n";

type Descriptor = NativeSpecificationPhaseStart["required_next_tool"]["arguments"];

function setupFeature(root: string, featureId: string, runKey: string): void {
  const created = createFeatureWorkspace(root, {
    feature_id: featureId,
    display_name: featureId,
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: profileHash(profile),
    source_kind: "native",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.error);
  const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: runKey, origin_stage: "specify" }, { feature_id: featureId });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  assert.ok(gate.ok && gate.value.binding, "concurrency fixture must establish an approved current constitution binding");
  if (!gate.ok || !gate.value.binding) throw new Error("concurrency fixture constitution gate unavailable");
  const bound = bindWorkspaceConstitution(created.value, gate.value.binding, gate.value.gate_id);
  const workspace = { ...bound, phases: bound.phases.map((phase) => phase.phase === "specify" ? { ...phase, status: "not_started" as const } : phase) };
  const stateWithoutPreparation: TeamState = {
    schema: 1,
    branch: "main",
    run_key: runKey,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: `Prepare ${featureId}`,
    workflow_override: false,
    issue: null,
    stage_cursor: "specify",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "specify" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-09-08T00:00:00.000Z",
    state_revision: 1,
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    cursor_epoch: "preparation-epoch",
    specification: workspace,
  };
  assert.equal(readFileSync(join(root, "CONSTITUTION.md"), "utf8"), constitution);
  writeState(root, stateWithoutPreparation, { featureSlug: featureId });
  const committed = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state;
  assert.ok(committed);
  if (!committed) throw new Error("initial feature state was not committed");
  const stateRevision = committed.state_revision;
  assert.ok(Number.isSafeInteger(stateRevision) && stateRevision > 0);
  const rootDescriptor = PinnedProjectRoot.open(root);
  assert.ok(rootDescriptor);
  if (!rootDescriptor) throw new Error("project root could not be pinned");
  const preparation_handoff = createPreparationHandoff({
    feature_id: featureId,
    run_key: runKey,
    branch: "main",
    task: committed.task,
    classification: committed.classification,
    state_revision: stateRevision,
    state_digest: preparationStateDigest(committed, stateRevision),
    root_identity: { canonical_path: rootDescriptor.canonical_root, dev: rootDescriptor.dev, ino: rootDescriptor.ino },
    source_kind: committed.specification!.source_kind,
    constitution_binding: committed.specification!.constitution_binding,
    constitution_gate_ref: committed.specification!.constitution_gate_ref,
    capacity: 1,
    authentication: {
      source_kind: committed.specification!.source_kind,
      constitution_binding: committed.specification!.constitution_binding,
      constitution_gate_ref: committed.specification!.constitution_gate_ref,
      capacity: 1,
      pinned_root: rootDescriptor,
    },
  });
  rootDescriptor.close();
  writeState(root, { ...committed, preparation_handoff }, { featureSlug: featureId });
}

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "native-concurrent-"));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
  writeFileSync(join(root, "CONSTITUTION.md"), constitution);
  mkdirSync(join(root, ".omp"), { recursive: true });
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "specification-analyst": "specification-worker" } }) + "\n");
  const config = resolveConfig(root);
  writeTestRegistryMarker(root);
  registerTestConstitutionGate(root, "core-test-team-workflow");
  writeAgentMapping(root, buildAgentMapping({
    roles: config.roles,
    availableAgents: ["specification-worker"],
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
    genericFallbackRoles: [],
  }));
  setupFeature(root, "atlas", "run-atlas");
  setupFeature(root, "borealis", "run-borealis");
  setupFeature(root, "meridian", "run-meridian");
  // Deliberately point the mutable pointer at one unrelated feature. Native
  // task authorization must use the marker's exact feature/run selector.
  writeFileSync(join(root, ".work-state", ".active-feature"), "meridian\n");
  return root;
}

function descriptors(root: string): NativeSpecificationPhaseStart[] {
  return ["atlas", "borealis", "meridian"].map((featureId, index) => {
    const runKey = `run-${featureId}`;
    const state = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state;
    assert.ok(state?.preparation_handoff);
    if (!state?.preparation_handoff) throw new Error("preparation handoff missing");
    const started = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: state.preparation_handoff });
    assert.equal(started.ok, true, started.ok ? `${featureId} start ${index}` : `${featureId} start ${index}: ${started.error}`);
    if (!started.ok) throw new Error(started.error);
    return started.value;
  });
}

function registeredTaskHandler(root: string): (event: unknown, ctx: unknown) => unknown {
  let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  registerTestTeamWorkflow(root, {
    setLabel() {},
    on(name: string, candidate: (event: unknown, ctx: unknown) => unknown) { if (name === "tool_call") handler = candidate; },
  } as never, { observability: false });
  assert.ok(handler);
  if (!handler) throw new Error("tool_call handler missing");
  return handler;
}

test("three independent native start descriptors authorize against their own feature states concurrently", () => {
  const root = setupRoot();
  try {
    const started = descriptors(root);
    const handler = registeredTaskHandler(root);
    for (const [index, result] of started.entries()) {
      const input = result.required_next_tool.arguments;
      const featureId = ["atlas", "borealis", "meridian"][index]!;
      const runKey = `run-${featureId}`;
      const state = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state;
      assert.ok(state?.dispatch_capability?.capability_id);
      const task = input.tasks[0]!;
      assert.deepEqual(Object.keys(input).sort(), ["context", "i", "tasks"]);
      assert.deepEqual(Object.keys(task).sort(), ["agent", "name", "outputSchema", "schemaMode", "task"]);
      const marker = parseDispatchMarker(task.task);
      assert.ok(marker);
      assert.equal(marker?.run, runKey);
      assert.equal(marker?.feature_id, featureId);
      assert.equal(marker?.capability_id, state?.dispatch_capability?.capability_id);
      assert.equal(marker?.task_id, state?.dispatch_capability?.dispatches?.[0]?.work_identity?.task_id);
      assert.equal(task.agent, state?.dispatch_capability?.dispatches?.[0]?.agent);
      assert.equal(nativeSpecificationTaskGate({ toolName: "task", input }, { cwd: root })?.block, undefined, `native gate ${index}`);
      const outcome = handler({ toolName: "task", toolCallId: `task-call-${index}`, input }, TEST_CONTEXT(root));
      assert.equal(outcome, undefined, `registered task hook ${index}`);
    }
    for (const [index, result] of started.entries()) {
      const featureId = ["atlas", "borealis", "meridian"][index]!;
      const runKey = `run-${featureId}`;
      const state = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state;
      assert.equal(state?.dispatch_capability?.dispatches?.length, 1, featureId);
      assert.equal(state?.dispatch_capability?.dispatches?.[0]?.work_identity?.worker_id, "specification-worker", featureId);
      assert.equal(result.required_next_tool.arguments.tasks.length, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact native gate ignores concurrent unrelated writes and active-pointer changes", async () => {
  const root = setupRoot();
  try {
    const started = descriptors(root);
    const features = ["atlas", "borealis", "meridian"];
    for (const [index, result] of started.entries()) {
      const target = features[index]!;
      const volatile = features[(index + 1) % features.length]!;
      const volatileStatePath = join(root, ".work-state", "features", volatile, "state.json");
      const writer = spawn(process.execPath, ["--input-type=module", "-e", `
        import { readFileSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const root = process.argv[1];
        const feature = process.argv[2];
        const statePath = join(root, ".work-state", "features", feature, "state.json");
        const original = readFileSync(statePath);
        process.stdout.write("ready\\n");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 96; i++) {
          writeFileSync(statePath, "{\\n");
          writeFileSync(join(root, ".work-state", ".active-feature"), (i % 2 === 0 ? "meridian" : "borealis") + "\\n");
          Atomics.wait(wait, 0, 0, 2);
          writeFileSync(statePath, original);
          Atomics.wait(wait, 0, 0, 2);
        }
      `, root, volatile], { stdio: ["ignore", "pipe", "ignore"] });
      await new Promise<void>((resolve, reject) => {
        writer.stdout.once("data", () => resolve());
        writer.once("error", reject);
      });
      const input = result.required_next_tool.arguments;
      assert.equal(nativeSpecificationTaskGate({ toolName: "task", input }, { cwd: root })?.block, undefined, target);
      await new Promise<void>((resolve, reject) => {
        writer.once("error", reject);
        writer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`volatile writer exited ${code}`)));
      });
      writeFileSync(join(root, ".work-state", ".active-feature"), "meridian\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native marker swapping, merging, duplication, and recomposition fail closed", () => {
  const root = setupRoot();
  try {
    const [atlas, borealis, meridian] = descriptors(root);
    const atlasTask = atlas.required_next_tool.arguments.tasks[0]!;
    const borealisTask = borealis.required_next_tool.arguments.tasks[0]!;
    const swappedMarker = borealisTask.task;
    const swapped = { ...atlas.required_next_tool.arguments, tasks: [{ ...atlasTask, task: swappedMarker }] } as Descriptor;
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: swapped }, { cwd: root })?.block, true);
    const merged = { ...atlas.required_next_tool.arguments, tasks: [atlasTask, borealisTask] } as unknown;
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: merged }, { cwd: root })?.block, true);
    const duplicated = { ...atlas.required_next_tool.arguments, tasks: [atlasTask, atlasTask] } as unknown;
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: duplicated }, { cwd: root })?.block, true);
    const recomposed = { ...atlas.required_next_tool.arguments, tasks: [{ ...atlasTask, task: atlasTask.task.replace(/task=[^\\s]+/u, "task=forged") }] } as Descriptor;
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: recomposed }, { cwd: root })?.block, true);
    const traversal = { ...atlas.required_next_tool.arguments, tasks: [{ ...atlasTask, task: atlasTask.task.replace(/feature_id=[^\s]+/u, "feature_id=../borealis") }] } as Descriptor;
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: traversal }, { cwd: root })?.block, true);
    const omitted = { ...atlas.required_next_tool.arguments, tasks: [{ ...atlasTask, task: atlasTask.task.replace(/\s+feature_id=[^\s]+/u, "") }] } as Descriptor;
    assert.equal(parseDispatchMarker(omitted.tasks[0]!.task)?.feature_id, undefined);
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: omitted }, { cwd: root })?.block, true);
    const alias = { ...atlas.required_next_tool.arguments, tasks: [{ ...atlasTask, task: atlasTask.task.replace(/feature_id=/u, "feature=") }] } as Descriptor;
    assert.equal(parseDispatchMarker(alias.tasks[0]!.task), null);
    assert.equal(nativeSpecificationTaskGate({ toolName: "task", input: alias }, { cwd: root })?.block, true);
    const meridianTask = meridian.required_next_tool.arguments.tasks[0]!;
    assert.equal(dispatchGate({ toolName: "task", input: meridian.required_next_tool.arguments }, { cwd: root }), undefined);
    const crossWorkspace = { ...meridian.required_next_tool.arguments, tasks: [{ ...meridianTask, task: meridianTask.task.replace(/feature_id=[^\s]+/u, "feature_id=atlas") }] } as Descriptor;
    assert.equal(dispatchGate({ toolName: "task", input: crossWorkspace }, { cwd: root })?.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

