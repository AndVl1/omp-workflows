import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dispatchGate, createCapability, authorizeDispatch, completeDispatch, loadProfile, writeState } from "@andvl1/omp-workflows-core";
import { registerWorkflowTools } from "../src/index.js";
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
        { role: "analyst", agent: "analyst" },
        { role: "tech-researcher", agent: "tech-researcher" },
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

  assert.deepEqual([...tools.keys()], ["workflow_prepare", "workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance", "workflow_handoff"]);
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
  const handoff = tools.get("workflow_handoff")!;
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
  const handoffResult = await handoff.execute("test", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    workflow: "spec-preparation",
    profile_hash: "hash",
    stage_cursor: "handoff",
    target_workflow: "full-feature",
    approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
  }, undefined, undefined, null);

  for (const response of [beginResult, statusResult, completeResult, advanceResult, handoffResult]) {
    assert.equal(response.details && typeof response.details, "object");
    assert.equal((response.details as { ok?: boolean }).ok, false);
    assert.match(response.content[0].text, /\"ok\":false/);
  }
  assert.equal((beginResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((statusResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((completeResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((advanceResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((handoffResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");

  // workflow_handoff is main-session-only, exactly like the other control tools.
  const workerHandoffResult = await handoff.execute("worker", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    workflow: "spec-preparation",
    profile_hash: "hash",
    stage_cursor: "handoff",
    target_workflow: "full-feature",
    approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerHandoffResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
});

test("fullstack: workflow_handoff delegates to the engine and returns the one-time target envelope", async () => {
  const branch = "feat/handoff-tool";
  const root = mkdtempSync(join(tmpdir(), "workflow-handoff-tool-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
    const sourceProfile = loadProfile("spec-preparation");
    assert.ok(sourceProfile, "shipped spec-preparation profile must load");
    const persistedHash = profileHash(sourceProfile);
    const issued = createCapability({
      run_key: branch, branch, workflow: "spec-preparation", profile_hash: persistedHash,
      stage_cursor: "handoff", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1, branch, run_key: branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
      task: "tool handoff", workflow_override: false, issue: null,
      stage_cursor: "handoff",
      stages: sourceProfile.stages.map((s) => ({ id: s.id, status: "done" as const })),
      artifacts: {}, pause: { kind: "done" as const, reason: "" },
      policy: { strict_orchestrator: true }, profile_hash: persistedHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: { ...issued.state, status: "complete" as const, dispatches: [] },
      updated_at: new Date().toISOString(),
    }, { featureSlug: "handoff-tool" });
    const artifactsDir = join(root, ".work-state", "features", "handoff-tool", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "spec_handoff.json"), JSON.stringify({ goal: "g", scope: ["s"], acceptance_criteria: ["a"] }));
    writeFileSync(join(artifactsDir, "spec-preparation.json"), JSON.stringify({ ready: true }));
    writeFileSync(join(artifactsDir, "workflow_approval.json"), JSON.stringify({
      type: "workflow_approval", version: 1, decision: "approved",
      run_key: branch, workflow: "spec-preparation", stage: "handoff",
      actor: "user", decided_at: "2026-08-02T00:00:00.000Z",
    }));

    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({ zod: { z }, registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never);
    const handoff = tools.get("workflow_handoff")!;
    const result = await handoff.execute("test", {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch, branch, workflow: "spec-preparation",
      profile_hash: persistedHash, stage_cursor: "handoff",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
      actor: "orchestrator",
      handoff_context: { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "approved" },
    }, undefined, undefined, { cwd: root } as never);
    const details = result.details as {
      ok: boolean;
      transition?: string;
      route?: unknown;
      handoff?: { workflow: string; stage_cursor: string; dispatch_token: string; advance_token: string };
      audit?: { id: string };
      state?: { workflow: string; stage_cursor: string };
      code?: string;
      error?: string;
    };
    assert.equal(details.ok, true, details.error);
    assert.equal(details.transition, "handoff");
    assert.equal(details.handoff?.workflow, "full-feature");
    assert.equal(details.handoff?.stage_cursor, "discovery");
    assert.ok(details.audit?.id, "audit record id present in the success envelope");
    assert.equal(details.state?.workflow, "full-feature");
    assert.equal(details.state?.stage_cursor, "discovery");

    // The safe result exposes the typed catalogue route metadata.
    const route = details.route as { id?: string; kind?: string; disposition?: string; source_workflow?: string; target_stage?: string; description?: string } | undefined;
    assert.equal(route?.id, "spec-handoff->full-feature");
    assert.equal(route?.kind, "feature-intake");
    assert.equal(route?.disposition, "enabled");
    assert.equal(route?.source_workflow, "spec-preparation");
    assert.equal(route?.target_stage, "discovery");
    assert.ok(route?.description, "human-readable route meaning is exposed");
    assert.equal((details.audit as { route?: { id?: string } }).route?.id, "spec-handoff->full-feature");

    // Plaintext secrets live only in the one-time envelope; state persists hashes.
    const persisted = JSON.parse(readFileSync(join(root, ".work-state", "features", "handoff-tool", "state.json"), "utf8")) as {
      dispatch_capability: { dispatch_token_hash: string; advance_token_hash: string };
    };
    assert.notEqual(persisted.dispatch_capability.dispatch_token_hash, details.handoff?.dispatch_token);
    assert.notEqual(persisted.dispatch_capability.advance_token_hash, details.handoff?.advance_token);

    // Engine rejection surfaces as the structured REJECTED envelope.
    const rejected = await handoff.execute("test", {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch, branch, workflow: "spec-preparation",
      profile_hash: persistedHash, stage_cursor: "handoff",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
    }, undefined, undefined, { cwd: root } as never);
    const rejectedDetails = rejected.details as { ok: boolean; code?: string; error?: string };
    assert.equal(rejectedDetails.ok, false);
    assert.equal(rejectedDetails.code, "WORKFLOW_HANDOFF_REJECTED");
    assert.match(rejectedDetails.error ?? "", /capability identity mismatch|not a completed handoff source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_prepare persists PHASE-0 state in the canonical session cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
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
