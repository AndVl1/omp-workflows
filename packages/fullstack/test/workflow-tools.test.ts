import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  dispatchGate,
  createCapability,
  type IssuedCapability,
  authorizeDispatch,
  completeDispatch,
  buildAgentMapping,
  loadProfile,
  resolveConfig,
  claimWorkflowOwner,
  resetWorkflowOwners,
  workflowOwnerFor,
  setCtoControlPlane,
  setTeamControlPlane,
  recordWorkPending,
  recordWorkTerminal,
  writeConfig,
  writeAgentMapping,
} from "@andvl1/omp-workflows-core";
import {
  FULLSTACK_BUNDLE_ID,
  fullstackOwnerForCwd,
  fullstackPreset,
  registerWorkflowTools,
  resolveSessionCwd,
  isMainSessionContext,
} from "../src/index.js";
import { registerLectureAcquireTool } from "../src/tools/lecture-acquire.js";

function profileHash(profile: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(profile))).digest("hex");
}

type RegisteredTool = {
  name: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};
function writeBeginFixture(root: string, branch: string): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
    schema: 1,
    branch,
    run_key: branch,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: "lightweight",
    },
    task: "cwd binding regression",
    stage_cursor: "discovery",
    stages: [{ id: "discovery", status: "in_progress" }],
    artifacts: {},
    scope: {
      scope: [],
      has_security: false,
      has_infra: false,
      has_ui: false,
      has_runtime: false,
      dev_agent: "developer-kotlin",
    },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
  }) + "\n");
}

function writeConsiliumBeginFixture(root: string): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: {
      type: "SPEC",
      complexity: "COMPLEX",
      confidence: "HIGH",
      autonomous: true,
      workflow: "spec-preparation",
    },
    task: "consilium marker regression",
    stage_cursor: "intake_repo_map",
    stages: [{ id: "intake_repo_map", status: "in_progress" }],
    artifacts: {},
    scope: {
      scope: [],
      has_security: false,
      has_infra: false,
      has_ui: false,
      has_runtime: false,
      dev_agent: null,
    },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
  }) + "\n");
}

const trustedIntakeRoles = { analyst: "analyst", "tech-researcher": "tech-researcher" } as const;

/** Publish a trusted live agent mapping covering the spec-preparation intake pool. */
function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: trustedIntakeRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(trustedIntakeRoles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(trustedIntakeRoles),
  });
  writeAgentMapping(root, mapping);
}

test("fullstack: workflow_begin exposes role-bound dispatch markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-marker-handoff-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeConsiliumBeginFixture(root);
    publishMapping(root);
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const begin = tools.get("workflow_begin")!;
    const response = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: root, hasUI: true } as never,
    );
    const details = response.details as {
      ok?: boolean;
      handoff?: {
        run_key: string;
        stage_cursor: string;
        cursor_epoch: string;
        dispatch_markers?: Array<{ role: string; agent: string; marker: string }>;
      };
    };
    assert.equal(details.ok, true);
    const markers = details.handoff?.dispatch_markers ?? [];
    assert.deepEqual(
      markers.map(({ role, agent }) => ({ role, agent })),
      [
        { role: "analyst#1", agent: "analyst" },
        { role: "tech-researcher", agent: "tech-researcher" },
        { role: "analyst#2", agent: "analyst" },
      ],
    );
    for (const marker of markers) {
      assert.match(marker.marker, /<!-- omp-dispatch run=main stage=intake_repo_map kind=consilium/);
      assert.match(marker.marker, new RegExp(`cursor=${details.handoff?.cursor_epoch}`));
      assert.match(marker.marker, new RegExp(`role=${marker.role}`));
    }
    const instructions = tools.get("workflow_instructions")!;
    const instructionResponse = await instructions.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true } as never);
    const instructionDetails = instructionResponse.details as { stage?: { slot_artifacts?: Record<string, string[]> } };
    assert.deepEqual(instructionDetails.stage?.slot_artifacts, {
      analyst: ["spec_intake_repo_map-analyst"],
      "tech-researcher": ["spec_intake_repo_map-tech-researcher"],
    });
    const gate = dispatchGate({
      toolName: "task",
      input: {
        tasks: markers.map(({ role, agent, marker }) => ({
          role,
          agent,
          task: `${marker}\nComplete the declared intake work.`,
        })),
      },
    }, { cwd: root });
    assert.equal(gate, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_instructions exposes declared artifact schemas", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-artifact-schemas-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeBeginFixture(root, "main");
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const instructions = tools.get("workflow_instructions")!;
    const response = await instructions.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true } as never);
    const details = response.details as {
      stage?: {
        artifact_schemas?: Record<string, {
          type?: string;
          required?: string[];
          properties?: {
            items?: { type?: string; items?: { type?: string; required?: string[] } };
          };
        } | null>;
      };
    };
    const schemas = details.stage?.artifact_schemas ?? {};
    assert.equal(schemas.discovery?.type, "object");

    assert.deepEqual(schemas.discovery?.required, ["task", "branch"]);
    assert.equal(schemas.dod?.properties?.items?.items?.type, "object");
    assert.deepEqual(schemas.dod?.properties?.items?.items?.required, ["criterion", "verify_method", "status"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: workflow_status exposes completion artifact bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-status-artifacts-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "main",
      branch: "main",
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      kind: "single",
      expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "status artifact binding",
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending" })),
      artifacts: {},
      scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
      profile_hash: persistedProfileHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
    }) + "\n");
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      role: "developer-kotlin",
      agent: "developer-kotlin",
      tool_call_id: "tool-status-artifact",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    assert.ok(authorized.ok && authorized.record);
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "implementation.json"), JSON.stringify({
      ready: true,
      validation_run: true,
      validation_evidence: "status binding fixture",
      files_touched: ["src/main.ts"],
    }));
    const completed = completeDispatch(root, {
      ...auth,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "implementation completed",
      artifact_ids: ["implementation"],
    });
    assert.equal(completed.ok, true);
    const status = tools.get("workflow_status")!;
    const response = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true } as never);
    const details = response.details as { capability?: { dispatches?: Array<Record<string, unknown>> } };
    assert.deepEqual(details.capability?.dispatches?.[0], {
      id: authorized.record.id,
      role: "developer-kotlin",
      agent: "developer-kotlin",
      tool_call_id: "tool-status-artifact",
      status: "succeeded",
      completed: true,
      completed_by: "workflow_complete",
      artifact_ids: ["implementation"],
      outcome: "succeeded",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow tools register and fail closed with structured responses", async () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  registerLectureAcquireTool({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never, z, { resolveSessionCwd, isMainSessionContext });

  assert.deepEqual([...tools.keys()], ["workflow_prepare", "workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_checkpoint_ask", "workflow_advance", "lecture_acquire"]);
  for (const name of tools.keys()) {
    assert.ok(tools.get(name)?.parameters, `${name} exposes a parameter schema`);
  }
  const lectureAcquire = tools.get("lecture_acquire")!;
  const workerLectureResult = await lectureAcquire.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerLectureResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  const lectureUnavailableResult = await lectureAcquire.execute("test", {}, undefined, undefined, null);
  assert.equal((lectureUnavailableResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");

  const begin = tools.get("workflow_begin")!;
  const workerBeginResult = await begin.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerBeginResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  const status = tools.get("workflow_status")!;
  const beginResult = await begin.execute("test", {}, undefined, undefined, null);
  const statusResult = await status.execute("test", {}, undefined, undefined, null);
  const complete = tools.get("workflow_complete")!;
  const advance = tools.get("workflow_advance")!;
  const completeResult = await complete.execute("test", {
    dispatch_id: "dispatch",
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    evidence: "evidence",
  }, undefined, undefined, null);
  const advanceResult = await advance.execute("test", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    evidence: "evidence",
  }, undefined, undefined, null);

  for (const response of [beginResult, statusResult, completeResult, advanceResult]) {
    assert.equal(response.details && typeof response.details, "object");
    assert.equal((response.details as { ok?: boolean }).ok, false);
    assert.match(response.content[0].text, /\"ok\":false/);
  }
  assert.equal((beginResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((statusResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((completeResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((advanceResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
});
test("fullstack: workflow_prepare schema accepts PRODUCT_DISCOVERY classifications", () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  const prepare = tools.get("workflow_prepare")!;
  const parameters = prepare.parameters as {
    safeParse(input: unknown): { success: boolean };
  };
  const parsed = parameters.safeParse({
    task: "prepare product discovery workflow",
    branch: "main",
    classification: {
      type: "PRODUCT_DISCOVERY",
      complexity: "COMPLEX",
      confidence: "HIGH",
      autonomous: false,
      autonomous_reason: "product discovery requires interactive review",
    },
    files: [],
    issue: null,
  });
  assert.equal(parsed.success, true);
});

test("fullstack: workflow_prepare persists PHASE-0 state in the canonical session cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    // INT-001: the engine no longer falls back to core domain defaults, so the
    // fixture writes the fullstack preset config exactly as registration does.
    writeConfig(
      join(canonical, ".omp", "team.config.json"),
      {
        roles: fullstackPreset.roles,
        scope_map: fullstackPreset.scopeMap,
        flags: fullstackPreset.flags,
        scope_runtime_classes: fullstackPreset.scopeRuntimeClasses,
        scope_ui_classes: fullstackPreset.scopeUiClasses,
      },
      { cwd: canonical },
    );
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const prepare = tools.get("workflow_prepare")!;
    const response = await prepare.execute(
      "test",
      {
        task: "prepare state binding regression",
        branch: "main",
        classification: {
          type: "BUG_FIX",
          complexity: "QUICK",
          confidence: "HIGH",
          autonomous: false,
          autonomous_reason: "interactive regression fix",
        },
        files: ["src/main/App.kt"],
        issue: 42,
      },
      undefined,
      undefined,
      { cwd: stale, sessionManager: { getCwd: () => canonical }, hasUI: true } as never,
    );

    const details = response.details as { ok?: boolean; state_path?: string; state?: { branch?: string } };
    assert.equal(details.ok, true);
    assert.equal(details.state?.branch, "main");
    assert.equal(details.state_path, join(canonical, ".work-state", "features", "main", "state.json"));
    const state = JSON.parse(readFileSync(details.state_path!, "utf8")) as {
      branch: string;
      task: string;

      classification?: { type: string; autonomous: boolean; workflow?: string };
      scope?: { scope: string[] };
    };

    const begin = tools.get("workflow_begin")!;
    const beginResponse = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: canonical, hasUI: true } as never,
    );
    assert.equal((beginResponse.details as { ok?: boolean }).ok, true);
    assert.equal(state.branch, "main");
    assert.equal(state.task, "prepare state binding regression");
    assert.deepEqual(state.classification, {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      autonomous_reason: "interactive regression fix",
      workflow: "bug-fix",
    });
    assert.deepEqual(state.scope?.scope, ["backend-kotlin"]);

    const reopenResponse = await tools.get("workflow_prepare")!.execute(
      "test",
      {
        task: "continue current workflow",
        branch: "main",
        continuation: { feedback: "recheck the fix", stageId: "discovery" },
      },
      undefined,
      undefined,
      { cwd: canonical, hasUI: true } as never,
    );
    assert.equal((reopenResponse.details as { ok?: boolean }).ok, true);
    const resumedBegin = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: canonical, hasUI: true } as never,
    );
    assert.equal((resumedBegin.details as { ok?: boolean }).ok, true);
  } finally {
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

test("fullstack: workflow_begin follows the canonical session cwd, not a stale context cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeBeginFixture(canonical, "main");
    // This is the exact failure shape from the report: state says `main`,
    // but the stale context directory has no active git branch.
    writeBeginFixture(stale, "main");

    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const begin = tools.get("workflow_begin")!;
    const response = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: stale, sessionManager: { getCwd: () => canonical }, hasUI: true } as never,
    );

    const details = response.details;
    if (!details || typeof details !== "object" || !("ok" in details)) throw new Error("workflow_begin response has no ok field");
    assert.equal(details.ok, true);
  } finally {
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});
test("fullstack: mutable schema defaults are factories", () => {
  const strictZ = {
    ...z,
    array: (element: Parameters<typeof z.array>[0]) => {
      const schema = z.array(element);
      return new Proxy(schema, {
        get(target, property, receiver) {
          if (property !== "default") return Reflect.get(target, property, receiver);
          const defaultMethod = Reflect.get(target, property, receiver) as (value: unknown) => unknown;
          return (value: unknown) => {
            if (value !== null && typeof value === "object") {
              throw new Error("mutable default must be a factory");
            }
            return Reflect.apply(defaultMethod, target, [value]);
          };
        },
      });
    },
  } as typeof z;

  assert.doesNotThrow(() => {
    registerWorkflowTools({
      zod: { z: strictZ },
      registerTool() {},
    } as never);
  });
});
test("fullstack: explicit preset feeds the core owner-aware service", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-owner-"));
  try {
    assert.equal(fullstackPreset.roles["backend-kotlin"], "developer-kotlin");
    assert.ok(fullstackPreset.scopeMap.some(entry => entry.scope === "frontend"));
    assert.ok(fullstackPreset.flags.has_security?.includes("**/auth/**"));
    assert.ok(fullstackPreset.modelRoles.some(entry => entry.role === "architect"));

    const owner = fullstackOwnerForCwd(root);
    assert.equal(owner.owner_id, FULLSTACK_BUNDLE_ID);
    assert.equal(owner.bundle_id, FULLSTACK_BUNDLE_ID);
    assert.equal(owner.provenance.cwd, root);

    const first = claimWorkflowOwner(root, "workflow_registration", owner);
    assert.equal(first.ok, true);
    const repeat = claimWorkflowOwner(root, "workflow_registration", owner);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.ok && repeat.idempotent, true);

    const conflict = claimWorkflowOwner(root, "workflow_registration", {
      ...owner,
      owner_id: "private-omp",
    });
    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.code, "owner_conflict");
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, FULLSTACK_BUNDLE_ID);
  } finally {
    resetWorkflowOwners(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint accepts only the typed decision envelope", () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  const checkpoint = tools.get("workflow_checkpoint")!;
  const parameters = checkpoint.parameters as { safeParse(input: unknown): { success: boolean } };
  const typedEnvelope = {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    branch: "main",
    workflow: "product-discovery",
    profile_hash: "profile-hash",
    stage_cursor: "product_approval",
    cursor_epoch: "epoch",
    loop_iteration: 1,
    checkpoint: "product_approval",
    checkpoint_id: "product-approval-1",
    checkpoint_kind: "product_approval",
    authorization: "human",
    actor_provenance: {
      kind: "user",
      ref: "terminal-answer/product-owner/1",
      proof: {
        answer_id: "product-owner/1",
        nonce: "durable-nonce",
        channel: "terminal",
        reference: "terminal-answer/product-owner/1",
        binding: "durable-binding",
      },
    },
    decision: "proceed",
    rationale: "evidence supports the decision",
  };
  assert.equal(parameters.safeParse(typedEnvelope).success, true);
  assert.equal(
    parameters.safeParse({
      ...typedEnvelope,
      mode: "interactive",
      actor: "user",
    }).success,
    false,
  );
  assert.equal(parameters.safeParse({ ...typedEnvelope, unexpected: true }).success, false);
});

test("fullstack: F7 core lifecycle exports remain public", () => {
  for (const hook of [setCtoControlPlane, setTeamControlPlane, recordWorkPending, recordWorkTerminal]) {
    assert.equal(typeof hook, "function");
  }
});

function writeCheckpointAskFixture(root: string): IssuedCapability {
  const profile = loadProfile("lightweight");
  assert.ok(profile);
  const persistedProfileHash = profileHash(profile);
  const issued = createCapability({
    run_key: "main",
    branch: "main",
    workflow: "lightweight",
    profile_hash: persistedProfileHash,
    stage_cursor: "implementation",
    kind: "single",
    expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
  });
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "checkpoint ask ingest",
    stage_cursor: "implementation",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" : "pending" })),
    artifacts: {},
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-kotlin" },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    profile_hash: persistedProfileHash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
  }) + "\n");
  return issued;
}

function checkpointAskAuth(issued: IssuedCapability) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: "main",
    branch: "main",
    workflow: "lightweight",
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: issued.state.issued_for!.loop_iteration,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
  };
}

type FakeAskDialogQuestion = { id: string; question: string; options: Array<{ label: string }>; multi?: boolean };
type FakeAskDialogResultItem = { id: string; multi?: boolean; selectedOptions?: string[]; timedOut?: boolean; customInput?: string };
type FakeAskDialogResult = { kind: "submit"; results: FakeAskDialogResultItem[] } | { kind: "chat" } | undefined;
const CHECKPOINT_ASK_QUESTION_ID = "checkpoint:approve_implementation";

function askDialogContext(root: string, answer: FakeAskDialogResult, calls: FakeAskDialogQuestion[][]): Record<string, unknown> {
  return {
    cwd: root,
    hasUI: true,
    ui: {
      async askDialog(questions: FakeAskDialogQuestion[]): Promise<FakeAskDialogResult> {
        calls.push(questions);
        if (answer?.kind !== "submit") return answer;
        // A faithful host echoes the asked question back on every result
        // item (id, question text, option labels, single-select flag).
        return {
          kind: "submit",
          results: answer.results.map((item) => {
            const asked = questions.find((candidate) => candidate.id === item.id) ?? questions[0];
            return {
              ...item,
              multi: item.multi ?? false,
              ...(asked ? { question: asked.question, options: asked.options.map((option) => option.label) } : {}),
            };
          }),
        };
      },
    },
  };
}

function askToolSelection(selection: string[] | undefined, extra: Partial<{ timedOut: boolean; customInput: string }> = {}): FakeAskDialogResult {
  if (selection === undefined) return undefined;
  return { kind: "submit", results: [{ id: CHECKPOINT_ASK_QUESTION_ID, selectedOptions: selection, ...extra }] };
}

test("fullstack: workflow_checkpoint_ask ingests the terminal answer and its proof unblocks workflow_checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-ask-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const issued = writeCheckpointAskFixture(root);
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const ask = tools.get("workflow_checkpoint_ask")!;
    const calls: FakeAskDialogQuestion[][] = [];
    const response = await ask.execute("test", {
      ...checkpointAskAuth(issued),
      question: "Implementation is complete and validated.",
    }, undefined, undefined, askDialogContext(root, askToolSelection(["proceed"]), calls) as never);
    const details = response.details as {
      ok?: boolean;
      error?: string;
      decision?: string;
      checkpoint_kind?: string;
      actor_provenance?: { kind: string; ref: string; proof?: { answer_id: string; nonce: string; channel: string; reference: string; binding: string } };
    };
    assert.equal(details.ok, true, details.error);
    assert.equal(details.decision, "proceed");
    assert.equal(details.checkpoint_kind, "implementation_approval");
    assert.equal(details.actor_provenance?.kind, "user");
    assert.equal(details.actor_provenance?.proof?.channel, "terminal");
    assert.equal(details.actor_provenance?.ref, details.actor_provenance?.proof?.reference);
    // The dialog presented exactly the policy-allowed decisions, single choice.
    assert.deepEqual(calls[0]?.[0]?.options.map((option) => option.label), ["proceed", "reject"]);
    assert.equal(calls[0]?.[0]?.multi, false);
    assert.match(calls[0]?.[0]?.question ?? "", /checkpoint 'approve_implementation'/);
    // The ingest persisted the durable answer; no decision exists yet.
    const ingested = JSON.parse(readFileSync(join(root, ".work-state", "team-state.json"), "utf8")) as Record<string, unknown>;
    const answers = ingested.trusted_checkpoint_answers as Array<Record<string, unknown>>;
    assert.equal(answers?.length, 1);
    assert.equal(answers[0]?.answer_id, details.actor_provenance?.proof?.answer_id);
    assert.equal(answers[0]?.decision, "proceed");
    assert.equal(ingested.typed_checkpoint_decisions, undefined);

    // The returned proof unblocks the canonical typed decision.
    const checkpoint = tools.get("workflow_checkpoint")!;
    const recorded = await checkpoint.execute("test", {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: "lightweight",
      profile_hash: profileHash(loadProfile("lightweight")),
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      authorization: "human",
      actor_provenance: details.actor_provenance,
      decision: "proceed",
      rationale: "approved at the terminal",
    }, undefined, undefined, { cwd: root, hasUI: true } as never);
    const recordedDetails = recorded.details as { ok?: boolean; error?: string };
    assert.equal(recordedDetails.ok, true, recordedDetails.error);
    const decided = JSON.parse(readFileSync(join(root, ".work-state", "team-state.json"), "utf8")) as Record<string, unknown>;
    const typed = decided.typed_checkpoint_decisions as Array<Record<string, unknown>>;
    assert.equal(typed?.length, 1);
    assert.equal(typed[0]?.authorization, "human");
    assert.equal((typed[0]?.actor as Record<string, unknown>)?.kind, "user");
    const consumed = (decided.trusted_checkpoint_answers as Array<Record<string, unknown>>)[0];
    assert.ok(consumed?.consumed_at, "the human answer is consumed after the decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint rejects a decision that diverges from the recorded human answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-diverge-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const issued = writeCheckpointAskFixture(root);
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const ask = tools.get("workflow_checkpoint_ask")!;
    const askResponse = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, askDialogContext(root, askToolSelection(["proceed"]), []) as never);
    const askDetails = askResponse.details as { ok?: boolean; error?: string; actor_provenance?: unknown };
    assert.equal(askDetails.ok, true, askDetails.error);

    const checkpoint = tools.get("workflow_checkpoint")!;
    const envelope = {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: "lightweight",
      profile_hash: profileHash(loadProfile("lightweight")),
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      authorization: "human",
      actor_provenance: askDetails.actor_provenance,
    };
    const diverged = await checkpoint.execute("test", { ...envelope, decision: "reject", rationale: "model override" }, undefined, undefined, { cwd: root, hasUI: true } as never);
    const divergedDetails = diverged.details as { ok?: boolean; error?: string };
    assert.equal(divergedDetails.ok, false);
    assert.match(divergedDetails.error ?? "", /stale or mismatched/);
    const decided = await checkpoint.execute("test", { ...envelope, decision: "proceed", rationale: "as answered" }, undefined, undefined, { cwd: root, hasUI: true } as never);
    const decidedDetails = decided.details as { ok?: boolean; error?: string };
    assert.equal(decidedDetails.ok, true, decidedDetails.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask records nothing on decline, timeout, custom text, or unknown selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-decline-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const issued = writeCheckpointAskFixture(root);
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const ask = tools.get("workflow_checkpoint_ask")!;
    const declines: Array<[string, FakeAskDialogResult]> = [
      ["declined", undefined],
      ["chat redirect", { kind: "chat" }],
      ["timeout", askToolSelection(["proceed"], { timedOut: true })],
      ["custom text", askToolSelection([], { customInput: "make it so" })],
      ["unknown label", askToolSelection(["ship it"])],
    ];
    for (const [label, answer] of declines) {
      const response = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, askDialogContext(root, answer, []) as never);
      const details = response.details as { ok?: boolean; code?: string; error?: string };
      assert.equal(details.ok, false, `${label} must not authorize`);
      assert.equal(details.code, "WORKFLOW_CHECKPOINT_DECLINED", `${label}: ${details.error}`);
      const state = JSON.parse(readFileSync(join(root, ".work-state", "team-state.json"), "utf8")) as Record<string, unknown>;
      assert.equal(state.trusted_checkpoint_answers, undefined, `${label} must not ingest an answer`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask fails closed without UI, for unauthenticated callers, and stays idempotent when resolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-closed-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const issued = writeCheckpointAskFixture(root);
    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const ask = tools.get("workflow_checkpoint_ask")!;
    const calls: FakeAskDialogQuestion[][] = [];

    // Headless session: hasUI is true but no UI surface is bound.
    const unavailable = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, { cwd: root, hasUI: true } as never);
    const unavailableDetails = unavailable.details as { ok?: boolean; code?: string };
    assert.equal(unavailableDetails.ok, false);
    assert.equal(unavailableDetails.code, "WORKFLOW_CHECKPOINT_ASK_UNAVAILABLE");

    // Worker context is rejected before anything else.
    const worker = await ask.execute("worker", checkpointAskAuth(issued), undefined, undefined, { cwd: root, hasUI: false } as never);
    assert.equal((worker.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");

    // A forged capability secret never raises the dialog.
    const forged = await ask.execute("test", { ...checkpointAskAuth(issued), token: "forged-token" }, undefined, undefined, askDialogContext(root, askToolSelection(["proceed"]), calls) as never);
    const forgedDetails = forged.details as { ok?: boolean; error?: string };
    assert.equal(forgedDetails.ok, false);
    assert.match(forgedDetails.error ?? "", /invalid secret/);
    assert.deepEqual(calls, [], "unauthenticated callers must not prompt the human");

    // A happy answer, then the resolved checkpoint short-circuits any re-ask.
    const first = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, askDialogContext(root, askToolSelection(["proceed"]), calls) as never);
    assert.equal((first.details as { ok?: boolean }).ok, true);
    const checkpoint = tools.get("workflow_checkpoint")!;
    const recorded = await checkpoint.execute("test", {
      ...checkpointAskAuth(issued),
      profile_hash: profileHash(loadProfile("lightweight")),
      authorization: "human",
      actor_provenance: (first.details as { actor_provenance?: unknown }).actor_provenance,
      decision: "proceed",
      rationale: "approved at the terminal",
    }, undefined, undefined, { cwd: root, hasUI: true } as never);
    assert.equal((recorded.details as { ok?: boolean; error?: string }).ok, true, (recorded.details as { error?: string }).error);
    const callsAfterAnswer = calls.length;
    const replay = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, askDialogContext(root, undefined, calls) as never);
    const replayDetails = replay.details as { ok?: boolean; already_recorded?: boolean; decision?: string; error?: string };
    assert.equal(replayDetails.ok, true, replayDetails.error);
    assert.equal(replayDetails.already_recorded, true);
    assert.equal(replayDetails.decision, "proceed");
    assert.equal(calls.length, callsAfterAnswer, "resolved checkpoints never re-prompt the human");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Host context eligibility (authoritative host mode + prompt capability) ──

/**
 * Registration harness capturing the session_start handler the workflow
 * tool surface installs, so tests can fire the authoritative host profile
 * exactly as the installed host does: the extension runner is initialized
 * with the runtime mode and UI context before session_start fires.
 */
function registerToolsWithSessionSink(): {
  tools: Map<string, RegisteredTool>;
  fireSessionStart: (ctx: Record<string, unknown>) => void;
} {
  const tools = new Map<string, RegisteredTool>();
  let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(_event: string, handler: (event: unknown, ctx: unknown) => void) {
      sessionStart = handler;
    },
  } as never);
  return { tools, fireSessionStart: (ctx) => sessionStart?.({}, ctx) };
}

test("fullstack: workflow tools trust the authoritative host profile across TUI, RPC, rpc-ui, json, print, and worker contexts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-context-eligibility-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeBeginFixture(root, "main");
    const { tools, fireSessionStart } = registerToolsWithSessionSink();
    const status = tools.get("workflow_status")!;

    // Terminal TUI: the profile names the interactive surface and the
    // per-call tool context carries the same UI (hasUI=true).
    fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const tui = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true } as never);
    assert.equal((tui.details as { ok?: boolean }).ok, true);

    // Plain rpc: the host passes no setToolUIContext (main.ts), so the
    // per-call tool context is UI-less (hasUI=false, no ui) while the
    // session profile carries the connected client's UI. The profile is
    // authoritative — this exact shape was misclassified as a worker
    // (WORKFLOW_CONTEXT_REJECTED) before.
    fireSessionStart({ mode: "rpc", hasUI: true, cwd: root, ui: { select: async () => undefined } });
    const rpc = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
    assert.equal((rpc.details as { code?: string }).code, undefined);
    assert.equal((rpc.details as { ok?: boolean }).ok, true);

    // rpc-ui: the same profile, but the host also wires the tool context.
    const rpcUi = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true, ui: { select: async () => undefined } } as never);
    assert.equal((rpcUi.details as { ok?: boolean }).ok, true);

    // json and print (headless single-shot) sessions never own the tools.
    for (const mode of ["json", "print"]) {
      fireSessionStart({ mode, hasUI: false, cwd: root, ui: {} });
      const headless = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
      assert.equal((headless.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED", mode);
    }

    // Task subagent/worker sessions run with mode "print" and no UI (the
    // installed host initializes subagent runners without mode or UI) and
    // fail closed exactly like headless runs.
    const worker = await status.execute("worker", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
    assert.equal((worker.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask ingests the connected RPC client's select answer from the session profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-ask-rpc-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const issued = writeCheckpointAskFixture(root);
    const { tools, fireSessionStart } = registerToolsWithSessionSink();
    const ask = tools.get("workflow_checkpoint_ask")!;
    const calls: Array<{ title: string; options: string[] }> = [];
    // Plain-rpc session: the profile carries the live select bridge; the
    // per-call tool context stays UI-less exactly as the host wires it.
    fireSessionStart({
      mode: "rpc",
      hasUI: true,
      cwd: root,
      ui: {
        select: async (title: string, options: string[]) => {
          calls.push({ title, options });
          return "proceed";
        },
      },
    });
    const response = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, { cwd: root, hasUI: false } as never);
    const details = response.details as { ok?: boolean; error?: string; decision?: string; loop_iteration?: number; channel?: string; actor_provenance?: { kind?: string } };
    assert.equal(details.ok, true, details.error);
    assert.equal(details.decision, "proceed");
    assert.equal(details.channel, "terminal");
    assert.equal(details.loop_iteration, issued.state.issued_for!.loop_iteration);
    assert.equal(details.actor_provenance?.kind, "user");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.options, ["proceed", "reject"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask fails closed in json/print headless sessions while the no-profile fallback keeps the legacy heuristic", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-ask-headless-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const issued = writeCheckpointAskFixture(root);
    const { tools, fireSessionStart } = registerToolsWithSessionSink();
    const ask = tools.get("workflow_checkpoint_ask")!;
    const status = tools.get("workflow_status")!;

    for (const mode of ["json", "print"]) {
      fireSessionStart({ mode, hasUI: false, cwd: root, ui: {} });
      const rejected = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, { cwd: root, hasUI: false } as never);
      assert.equal((rejected.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED", mode);
    }

    // No captured profile (older hosts, direct tool harnesses): the legacy
    // per-call heuristic decides — interactive contexts pass, worker
    // contexts are rejected.
    const fallback = registerToolsWithSessionSink();
    const mainCtx = await fallback.tools.get("workflow_status")!.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true } as never);
    assert.equal((mainCtx.details as { ok?: boolean }).ok, true);
    const workerCtx = await fallback.tools.get("workflow_status")!.execute("worker", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
    assert.equal((workerCtx.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: handoff tool schemas make the loop_iteration binding mandatory", () => {
  const { tools } = registerToolsWithSessionSink();
  const parse = (name: string, input: Record<string, unknown>): boolean =>
    (tools.get(name)!.parameters as { safeParse(value: unknown): { success: boolean } }).safeParse(input).success;

  const complete: Record<string, unknown> = { dispatch_id: "d", token: "t", capability_id: "c", run_key: "r", branch: "b", workflow: "w", profile_hash: "p", stage_cursor: "s", cursor_epoch: "e", evidence: "ev", loop_iteration: 2 };
  assert.equal(parse("workflow_complete", complete), true);
  const { loop_iteration: _completeIteration, ...completeWithout } = complete;
  assert.equal(parse("workflow_complete", completeWithout), false);

  const advance: Record<string, unknown> = { token: "t", capability_id: "c", run_key: "r", branch: "b", workflow: "w", profile_hash: "p", stage_cursor: "s", cursor_epoch: "e", evidence: "ev", loop_iteration: 1 };
  assert.equal(parse("workflow_advance", advance), true);
  const { loop_iteration: _advanceIteration, ...advanceWithout } = advance;
  assert.equal(parse("workflow_advance", advanceWithout), false);

  const checkpoint: Record<string, unknown> = { token: "t", capability_id: "c", run_key: "r", branch: "b", workflow: "w", profile_hash: "p", stage_cursor: "s", cursor_epoch: "e", checkpoint: "cp", checkpoint_id: "cp", checkpoint_kind: "implementation_approval", authorization: "human", actor_provenance: { kind: "user", ref: "terminal/test" }, decision: "proceed", loop_iteration: 1 };
  assert.equal(parse("workflow_checkpoint", checkpoint), true);
  const { loop_iteration: _checkpointIteration, ...checkpointWithout } = checkpoint;
  assert.equal(parse("workflow_checkpoint", checkpointWithout), false);

  const ask: Record<string, unknown> = { token: "t", capability_id: "c", run_key: "r", branch: "b", workflow: "w", stage_cursor: "s", cursor_epoch: "e", checkpoint: "cp", checkpoint_id: "cp", checkpoint_kind: "implementation_approval", loop_iteration: 1 };
  assert.equal(parse("workflow_checkpoint_ask", ask), true);
  const { loop_iteration: _askIteration, ...askWithout } = ask;
  assert.equal(parse("workflow_checkpoint_ask", askWithout), false);
});
