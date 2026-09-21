import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { registerTeamWorkflow, registerWorkflowTools } from "../src/index.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { readOptionalStageInputs, readRequiredStageInputs, runStage, type StageContext, type TaskResult } from "../src/engine/stage.js";
import { buildDispatchMarker, dispatchGate, trustedDispatchRequests } from "../src/gates/dispatch.js";
import { resolveConfig } from "../src/engine/config.js";
import { prepareWorkflowState } from "../src/engine/run.js";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";
import { readArtifactInput, writeArtifact } from "../src/engine/artifacts.js";
import type { Profile, StageDef, TeamState, TrustedExecutionContext } from "../src/engine/types.js";

const BRANCH = "main";
const CLASSIFICATION = {
  type: "SPEC" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: "spec-preparation",
};
const VALID_PRODUCT_SPEC = {
  recommendation: "proceed",
  value_proposition: "reduce churn by fixing onboarding",
  opportunity: "unknown",
  target_users: ["new users"],
  solution_direction: "improve the first-run experience",
  success_metrics: ["reduce onboarding drop-off"],
  guardrail_metrics: ["no regression in activation"],
  scope: ["first-run experience"],
  anti_scope: ["pricing changes"],
  risks: ["onboarding change may not move the metric"],
  validation_plan: [],
  evidence_trace: ["churn claim -> verified evidence item"],
  open_decisions: [],
};

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};

type PrepareDetails = {
  ok?: boolean;
  error?: string;
  state_path?: string;
  artifacts_dir?: string;
  workflow?: string;
  state?: { run_id?: string };
};

type InstructionsDetails = {
  workflow?: string;
  stage?: {
    id?: string;
    optional_consumes?: string[];
    required_inputs?: Array<{ artifact_id: string }>;
    optional_input_contents?: Array<{ artifact_id: string; path: string; sha256: string; content: string }>;
    instructions?: string;
  };
  state?: {
    required_inputs?: Array<{ artifact_id: string }>;
    required_input_contents?: Array<{ artifact_id: string }>;
    optional_input_contents?: Array<{ artifact_id: string; path: string; sha256: string; content: string }>;
  };
};

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `omp-${prefix}-`));
}

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", BRANCH], { stdio: "ignore" });
}

function trustedContext(root: string, session = "optional-stage-inputs"): TrustedExecutionContext {
  return {
    session_id: session,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: BRANCH,
    authority: "coordinator",
  };
}

function publishIntakeMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  const roles = { analyst: "analyst", "tech-researcher": "tech-researcher" };
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles }) + "\n");
  const config = resolveConfig(root);
  writeAgentMapping(root, buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(roles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(roles),
  }));
}

function publicTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root) });
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never, {
    cwd: root,
    isMainSession: () => true,
    getSessionController: () => controller,
  });
  return tools;
}

async function preparePublic(root: string, productSpec?: string): Promise<{
  tools: Map<string, RegisteredTool>;
  runId: string;
  artifactsDir: string;
  statePath: string;
  instructions: InstructionsDetails;
  begin: PrepareDetails;
}> {
  initGit(root);
  publishIntakeMapping(root);
  const tools = publicTools(root);
  const prepare = tools.get("workflow_prepare");
  const instructionsTool = tools.get("workflow_instructions");
  const beginTool = tools.get("workflow_begin");
  assert.ok(prepare && instructionsTool && beginTool, "public workflow tools must be registered");
  const context = { cwd: root, hasUI: true, session_id: "optional-stage-inputs" };
  const prepared = await prepare.execute(
    "optional-prepare",
    { mode: "new", task: "Prepare an implementation-ready specification", classification: CLASSIFICATION },
    undefined,
    undefined,
    context as never,
  );
  const prepareDetails = prepared.details as PrepareDetails;
  assert.equal(prepareDetails.ok, true, prepareDetails.error);
  const runId = prepareDetails.state?.run_id;
  assert.ok(runId);
  const artifactsDir = prepareDetails.artifacts_dir;
  const statePath = prepareDetails.state_path;
  assert.ok(artifactsDir && statePath);
  if (productSpec !== undefined) writeArtifact(artifactsDir, "product_spec", JSON.parse(productSpec));
  const instructionsResponse = await instructionsTool.execute(
    "optional-instructions",
    {},
    undefined,
    undefined,
    context as never,
  );
  const instructions = instructionsResponse.details as InstructionsDetails;
  const beginResponse = await beginTool.execute(
    "optional-begin",
    {
      selection: {
        rationale: "the shipped intake roster is the required semantic pool",
        occurrences: [{ role: "analyst" }, { role: "tech-researcher" }],
      },
    },
    undefined,
    undefined,
    context as never,
  );
  const begin = beginResponse.details as PrepareDetails;
  return { tools, runId, artifactsDir, statePath, instructions, begin };
}

function preparedDirectRun(root: string): { state: TeamState; artifactsDir: string } {
  initGit(root);
  const prepared = prepareWorkflowState({
    cwd: root,
    branch: BRANCH,
    task: "direct optional-input dispatch",
    mode: "new",
    classification: CLASSIFICATION,
    request_id: `direct-${root.split("/").at(-1)}`,
    execution: trustedContext(root, "direct-optional-inputs"),
  });
  return { state: prepared.state, artifactsDir: prepared.artifactsDir };
}

function stageContext(root: string, state: TeamState, artifactsDir: string, calls: string[]): StageContext {
  return {
    cwd: root,
    state,
    artifactsDir,
    flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    agent: (role) => role,
    task: {
      call: async () => {
        throw new Error("intake consilium must batch dispatch");
      },
      batch: async ({ tasks }) => {
        calls.push(...tasks.map((task) => task.task));
        return tasks.map((task, index): TaskResult => {
          const taskId = task.name ?? `task-${index}`;
          const slotId = taskId.startsWith("intake_repo_map-") ? taskId.slice("intake_repo_map-".length) : taskId;
          return {
            id: taskId,
            task_id: taskId,
            slot_id: slotId,
            output: "intake complete",
            artifacts: { [`spec_intake_repo_map-${slotId}`]: JSON.stringify({ summary: "intake complete" }) },
            exitCode: 0,
          };
        });
      },
    },
    durable: {
      authorize: (role) => ({ ok: true as const, dispatchId: `optional-stage-${role}` }),
      complete: () => ({ ok: true as const }),
      advance: () => ({ ok: true as const }),
    },
    pause: async () => undefined,
    log: () => undefined,
    resolveDevAgent: () => null,
  };
}

function intakeStage(): StageDef {
  const profile = JSON.parse(readFileSync(new URL("../workflows/spec-preparation.json", import.meta.url), "utf8")) as Profile;
  const stage = profile.stages.find((candidate) => candidate.id === "intake_repo_map");
  assert.ok(stage);
  return stage;
}

function persistedState(statePath: string): TeamState {
  return JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
}

test("public SPEC preparation without product_spec exposes intake as optional and begins successfully", async () => {
  const root = scratch("optional-absent");
  try {
    const result = await preparePublic(root);
    assert.equal(result.instructions.workflow, "spec-preparation");
    assert.equal(result.instructions.stage?.id, "intake_repo_map");
    assert.deepEqual(result.instructions.stage?.optional_consumes, ["product_spec"]);
    assert.deepEqual(result.instructions.stage?.optional_input_contents, []);
    assert.deepEqual(result.instructions.state?.required_inputs, []);
    assert.deepEqual(result.instructions.state?.required_input_contents, []);
    assert.deepEqual(result.instructions.state?.optional_input_contents, []);
    assert.equal(result.begin.ok, true, result.begin.error);
    assert.equal(result.artifactsDir, join(root, ".work-state", "runs", result.runId, "artifacts"));
    assert.equal(result.artifactsDir.startsWith(tmpdir()), true);
    const state = persistedState(result.statePath);
    assert.equal(state.stage_cursor, "intake_repo_map");
    assert.equal((state.required_inputs?.intake_repo_map ?? []).some((input) => input.artifact_id === "product_spec"), false);
    assert.equal(Object.values(state.required_input_receipts ?? {}).some((receipt) => receipt.inputs.some((input) => input.artifact_id === "product_spec")), false);
    assert.equal(existsSync(result.artifactsDir), true);
    assert.deepEqual(readArtifactInput(result.artifactsDir, "product_spec"), { status: "absent", path: "product_spec.json" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public SPEC preparation carries exact present product context without promoting it to required evidence", async () => {
  const root = scratch("optional-present");
  const raw = JSON.stringify(VALID_PRODUCT_SPEC, null, 2) + "\n";
  try {
    const result = await preparePublic(root, raw);
    const stage = result.instructions.stage;
    assert.deepEqual(stage?.optional_consumes, ["product_spec"]);
    assert.deepEqual(stage?.required_inputs, []);
    assert.deepEqual(stage?.optional_input_contents, [{
      artifact_id: "product_spec",
      path: "product_spec.json",
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      content: raw,
    }]);
    assert.equal(result.begin.ok, true, result.begin.error);
    const state = persistedState(result.statePath);
    assert.equal((state.required_inputs?.intake_repo_map ?? []).some((input) => input.artifact_id === "product_spec"), false);
    assert.equal(Object.values(state.required_input_receipts ?? {}).some((receipt) => receipt.inputs.some((input) => input.artifact_id === "product_spec")), false);

    const calls: string[] = [];
    const outcome = await runStage(intakeStage(), stageContext(root, state, result.artifactsDir, calls));
    assert.equal(outcome.status, "done", `outcome.note: ${outcome.note}`);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((prompt) => prompt.includes(raw)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native dispatch gate revalidates optional input after begin and never authorizes physical dispatch", async () => {
  const raw = JSON.stringify(VALID_PRODUCT_SPEC, null, 2) + "\n";
  const cases: Array<{ name: string; mutate: (path: string, artifactsDir: string) => void }> = [
    { name: "malformed", mutate: (path) => writeFileSync(path, "{\n") },
    { name: "schema-invalid", mutate: (path) => writeFileSync(path, JSON.stringify({ recommendation: "proceed" })) },
    {
      name: "symlink",
      mutate: (path, artifactsDir) => {
        const outside = join(artifactsDir, "..", "native-outside-product-spec.json");
        writeFileSync(outside, JSON.stringify(VALID_PRODUCT_SPEC));
        rmSync(path, { force: true });
        symlinkSync(outside, path);
      },
    },
  ];
  for (const testCase of cases) {
    const root = scratch(`optional-native-${testCase.name}`);
    try {
      const prepared = await preparePublic(root, raw);
      assert.equal(prepared.instructions.stage?.optional_input_contents?.length, 1, `${testCase.name}: optional context must be read before begin`);
      assert.equal(prepared.begin.ok, true, prepared.begin.error);
      const stateBefore = persistedState(prepared.statePath);
      const stage = intakeStage();
      const capability = stateBefore.dispatch_capability;
      assert.ok(capability?.capability_id && capability.expected_roster, `${testCase.name}: begin must arm a capability`);
      if (!capability?.capability_id || !capability.expected_roster) continue;
      const requiredReceiptBefore = stateBefore.required_input_receipts?.[stage.id];
      const dispatchCountBefore = stateBefore.dispatch_capability?.dispatches.length ?? 0;
      const runKey = stateBefore.run_key ?? prepared.runId;
      const cursor = stateBefore.cursor_epoch ?? stage.id;
      const roles = capability.expected_roster.map((entry) => entry.role);
      const input = {
        tasks: capability.expected_roster.map((entry) => ({
          agent: entry.agent,
          role: entry.role,
          task: buildDispatchMarker(runKey, stage, roles, entry.role, cursor, capability.capability_id, entry.role),
        })),
      };
      testCase.mutate(join(prepared.artifactsDir, "product_spec.json"), prepared.artifactsDir);
      const event = { toolName: "task", toolCallId: `native-optional-${testCase.name}`, input };
      const toolCallHooks: Array<(hookEvent: unknown, hookContext: unknown) => unknown> = [];
      const fakePi = {
        setLabel: () => undefined,
        on: (name: string, handler: (hookEvent: unknown, hookContext: unknown) => unknown) => {
          if (name === "tool_call") toolCallHooks.push(handler);
        },
      };
      registerTeamWorkflow(fakePi as never, { cwd: root, observability: false });
      assert.equal(toolCallHooks.length, 1, `${testCase.name}: public tool_call hook must be registered`);
      const hooked = toolCallHooks[0]!(event, { cwd: root, session_id: "optional-stage-inputs" }) as { block?: boolean; reason?: string } | undefined;
      assert.equal(hooked?.block, true, `${testCase.name}: public tool_call hook must block`);
      assert.match(hooked?.reason ?? "", /optional input product_spec/, `${testCase.name}: hook block must identify optional input`);
      const blocked = dispatchGate(event, { cwd: root });
      assert.equal(blocked?.block, true, `${testCase.name}: native dispatch must block`);
      const authorization = trustedDispatchRequests(event, { cwd: root });
      assert.equal(authorization.ok, false, `${testCase.name}: blocked task must not produce physical authorization`);
      let physicalDispatches = 0;
      if (authorization.ok) physicalDispatches += authorization.requests.length;
      assert.equal(physicalDispatches, 0, `${testCase.name}: zero physical dispatches after optional invalidation`);
      const stateAfter = persistedState(prepared.statePath);
      assert.deepEqual(stateAfter.required_input_receipts?.[stage.id], requiredReceiptBefore, `${testCase.name}: required receipt must remain unchanged`);
      assert.equal(
        stateAfter.dispatch_capability?.dispatches.length ?? 0,
        dispatchCountBefore,
        `${testCase.name}: blocked hook must not authorize a physical dispatch`,
      );
      assert.equal(
        stateAfter.required_input_receipts?.[stage.id]?.inputs.some((inputEntry) => inputEntry.artifact_id === "product_spec") ?? false,
        false,
        `${testCase.name}: optional input must never enter required receipt`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("present malformed, schema-invalid, non-file, symlink, unreadable, and unsafe artifact directories fail before TaskCaller dispatch", async () => {
  const cases: Array<{ name: string; write: (path: string, artifactsDir: string) => void; restore?: (path: string) => void }> = [
    { name: "malformed", write: (path) => writeFileSync(path, "{\n") },
    { name: "schema-invalid", write: (path) => writeFileSync(path, JSON.stringify({ recommendation: "proceed" })) },
    { name: "non-file", write: (path) => mkdirSync(path) },
    {
      name: "symlink",
      write: (path, artifactsDir) => {
        const outside = join(artifactsDir, "..", "outside-product-spec.json");
        writeFileSync(outside, JSON.stringify(VALID_PRODUCT_SPEC));
        symlinkSync(outside, path);
      },
    },
    {
      name: "unreadable",
      write: (path) => {
        writeFileSync(path, JSON.stringify(VALID_PRODUCT_SPEC));
        chmodSync(path, 0o000);
      },
      restore: (path) => chmodSync(path, 0o600),
    },
    {
      name: "artifacts-dir-symlink",
      write: (_path, artifactsDir) => {
        const outside = join(dirname(artifactsDir), "outside-artifacts");
        mkdirSync(outside);
        writeFileSync(join(outside, "product_spec.json"), JSON.stringify(VALID_PRODUCT_SPEC));
        rmSync(artifactsDir, { recursive: true, force: true });
        symlinkSync(outside, artifactsDir);
      },
    },
    {
      name: "artifacts-dir-dangling-symlink",
      write: (_path, artifactsDir) => {
        const outside = join(dirname(artifactsDir), "missing-artifacts");
        rmSync(artifactsDir, { recursive: true, force: true });
        symlinkSync(outside, artifactsDir);
      },
    },
    {
      name: "artifacts-dir-non-directory",
      write: (_path, artifactsDir) => {
        rmSync(artifactsDir, { recursive: true, force: true });
        writeFileSync(artifactsDir, "not-a-directory");
      },
    },
    {
      name: "artifacts-dir-missing-ancestor",
      write: (_path, artifactsDir) => {
        rmSync(dirname(artifactsDir), { recursive: true, force: true });
      },
    },
  ];
  for (const testCase of cases) {
    const root = scratch(`optional-invalid-${testCase.name}`);
    let target: string | undefined;
    try {
      const prepared = preparedDirectRun(root);
      target = join(prepared.artifactsDir, "product_spec.json");
      mkdirSync(prepared.artifactsDir, { recursive: true });
      testCase.write(target, prepared.artifactsDir);
      const calls: string[] = [];
      const outcome = await runStage(intakeStage(), stageContext(root, prepared.state, prepared.artifactsDir, calls));
      assert.equal(outcome.status, "failed", testCase.name);
      assert.equal(calls.length, 0, `${testCase.name}: TaskCaller must not receive a physical dispatch`);
    } finally {
      if (testCase.restore && target && existsSync(target)) testCase.restore(target);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("optional input root absence requires an existing real ancestor chain", () => {
  const root = scratch("optional-absence-boundary");
  try {
    const neverCreatedRoot = join(root, "lazy-artifacts");
    assert.deepEqual(readArtifactInput(neverCreatedRoot, "product_spec"), { status: "absent", path: "product_spec.json" });

    const missingAncestor = join(root, "missing-parent", "artifacts");
    const invalid = readArtifactInput(missingAncestor, "product_spec");
    assert.equal(invalid.status, "invalid");
    if (invalid.status === "invalid") assert.match(invalid.error, /artifacts directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic ancestor aliases are accepted when the distinguished artifacts directory is real", () => {
  const root = scratch("optional-generic-alias");
  const realParent = join(root, "real-parent");
  const artifactsDir = join(realParent, "artifacts");
  const aliasParent = join(root, "alias-parent");
  const raw = JSON.stringify(VALID_PRODUCT_SPEC) + "\n";
  try {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "product_spec.json"), raw);
    symlinkSync(realParent, aliasParent, "dir");

    assert.deepEqual(readArtifactInput(join(aliasParent, "artifacts"), "product_spec"), {
      status: "present",
      path: "product_spec.json",
      content: raw,
      value: VALID_PRODUCT_SPEC,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic stages keep missing mandatory consumes recovery-required and do not substitute optional or summary files", async () => {
  const root = scratch("optional-generic");
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const stage: StageDef = {
      id: "generic-stage",
      title: "Generic stage",
      type: "single",
      role: "analyst",
      consumes: ["mandatory_evidence"],
      optional_consumes: ["product_spec"],
    };
    const state: TeamState = {
      schema: 1,
      branch: BRANCH,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "standard" },
      task: "generic mandatory boundary",
      workflow_override: false,
      issue: null,
      stage_cursor: stage.id,
      stages: [{ id: stage.id, status: "in_progress" }],
      artifacts: {},
      required_inputs: {
        [stage.id]: [
          { artifact_id: "mandatory_evidence", path: "mandatory_evidence.json" },
          { artifact_id: "product_spec", path: "product_spec.json" },
        ],
      },
      required_input_receipts: {},
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
    };
    writeFileSync(join(artifactsDir, "summary.json"), JSON.stringify({ summary: "arbitrary context is not mandatory evidence" }));
    writeFileSync(join(artifactsDir, "product_spec.json"), JSON.stringify(VALID_PRODUCT_SPEC));
    const required = readRequiredStageInputs(stage, state, artifactsDir);
    assert.equal(required.ok, false);
    if (!required.ok) assert.match(required.error, /recovery_required/);
    const calls: string[] = [];
    const genericContext = stageContext(root, state, artifactsDir, calls);
    genericContext.durable = {
      readInputs: () => required,
      authorize: () => ({ ok: false as const, error: "not reached" }),
      complete: () => ({ ok: true as const }),
    };
    const outcome = await runStage(stage, genericContext);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /recovery_required/);
    assert.equal(calls.length, 0, "mandatory recovery failure must precede physical TaskCaller dispatch");
    const optional = readOptionalStageInputs(stage, state, artifactsDir);
    assert.deepEqual(optional, { ok: true, inputs: [], absent: [] }, "persisted required manifest wins over optional metadata");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
