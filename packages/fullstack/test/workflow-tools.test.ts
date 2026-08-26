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
  authorizeDispatch,
  completeDispatch,
  loadProfile,
  claimWorkflowOwner,
  resetWorkflowOwners,
  workflowOwnerFor,
  setCtoControlPlane,
  setTeamControlPlane,
  recordWorkPending,
  recordWorkTerminal,
  writeConfig,
} from "@andvl1/omp-workflows-core";
import {
  FULLSTACK_BUNDLE_ID,
  fullstackOwnerForCwd,
  fullstackPreset,
  registerWorkflowTools,
} from "../src/index.js";

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

test("fullstack: workflow_begin exposes role-bound dispatch markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-marker-handoff-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeConsiliumBeginFixture(root);
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

  assert.deepEqual([...tools.keys()], ["workflow_prepare", "workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance"]);
  for (const name of tools.keys()) {
    assert.ok(tools.get(name)?.parameters, `${name} exposes a parameter schema`);
  }

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
