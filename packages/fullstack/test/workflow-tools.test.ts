import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeDispatch, completeDispatch, createCapability } from "../../core/src/engine/durable.js";
import { z } from "zod";
import { TEST_CONTEXT, TEST_SESSION_MANAGER } from "../../core/test/fixtures/registrar-host.js";
import {
  dispatchGate,
  buildAgentMapping,
  loadProfile,
  resolveConfig,
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
import { closeWorkflowActivation, openWorkflowActivation } from "@andvl1/omp-workflows-core/registry";
import { beginHeldRegistration, type HeldRegistration } from "./fixtures/guarded-registration.js";
import { writeFullstackActivationMarker } from "../src/activation-marker.js";

function registerWorkflowToolsForTest(root: string, pi: Parameters<typeof registerWorkflowTools>[0]): HeldRegistration {
  const registration = beginHeldRegistration(root, ["workflow_registration", "workflow_tools"], fullstackOwnerForCwd(root), ["workflow_tools"]);
  try {
    registerWorkflowTools({ ...pi, on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "session_start") handler({}, TEST_CONTEXT(root)); } } as never, registration.token);
    registration.commit();
    return registration;
  } catch (error) {
    registration.close();
    throw error;
  }
}

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

function writeSpecificationBeginFixture(root: string): void {
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
    task: "specify marker regression",
    stage_cursor: "specify",
    stages: [{ id: "specify", status: "in_progress" }],
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
const trustedIntakeRoles = { "specification-analyst": "analyst" } as const;
const FULLSTACK_VALID_CONSTITUTION = "# Project Constitution\n\nVersion: 1.0.0\n\n## I. Quality\n\n- Human review is required.\n";

/** Publish a trusted live agent mapping covering the specification pool. */
function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: trustedIntakeRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(trustedIntakeRoles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(trustedIntakeRoles),
    source: "fullstack",
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
  });
  writeAgentMapping(root, mapping);
}

test("fullstack: constitution tools are owned by the bundle and registered exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-constitution-contract-"));
  let registration: HeldRegistration | undefined;
  try {
    const names: string[] = [];
    registration = registerWorkflowToolsForTest(root, {
    zod: { z },
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
  } as never);
  assert.deepEqual(
    names.filter((name) => name === "ensure_project_constitution"
      || name === "present_constitution_draft"
      || name === "constitution_checkpoint_ask_selected"
      || name === "decide_constitution_checkpoint"),
      ["ensure_project_constitution", "present_constitution_draft", "constitution_checkpoint_ask_selected", "decide_constitution_checkpoint"],
    );
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: constitution approval exposes the registered host UI Ask and checkpoint contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-constitution-schema-"));
  let registration: HeldRegistration | undefined;
  try {
    const tools = new Map<string, { name: string; description?: string; parameters: unknown }>();
    registration = registerWorkflowToolsForTest(root, {
    zod: { z },
    registerTool(tool: { name: string; description?: string; parameters: unknown }) {
      tools.set(tool.name, tool);
    },
  } as never);

  const ask = tools.get("constitution_checkpoint_ask_selected");
  const checkpoint = tools.get("workflow_checkpoint");
  assert.ok(ask, "fullstack must register the dedicated constitution host UI Ask tool");
  assert.ok(checkpoint, "fullstack must register the concrete checkpoint tool");
  assert.match(ask.description ?? "", /host's native UI/u);
  assert.match(checkpoint.description ?? "", /Human authorization requires/u);

  const askSchema = ask.parameters as { safeParse?: (value: unknown) => { success: boolean } };
  const checkpointSchema = checkpoint.parameters as { safeParse?: (value: unknown) => { success: boolean } };
  assert.equal(typeof askSchema.safeParse, "function", "constitution Ask must expose a concrete runtime schema");
  assert.equal(typeof checkpointSchema.safeParse, "function", "checkpoint must expose a concrete runtime schema");
  const handoff = {
    feature_id: "constitution-feature",
    run_key: "run-constitution",
    gate_id: "constitution-gate",
    checkpoint_id: "constitution-gate.checkpoint.v1",
    draft_sha256: "a".repeat(64),
    checkpoint_kind: "constitution_approval",
  };
  assert.equal(askSchema.safeParse?.({ ...handoff, question: "Review the constitution." }).success, true);
  assert.equal(
    checkpointSchema.safeParse?.({
      advance_token: "token",
      capability_id: "capability",
      run_key: handoff.run_key,
      branch: "main",
      workflow: "spec-preparation",
      profile_hash: "profile",
      stage_cursor: "specify",
      cursor_epoch: "epoch",
      checkpoint: handoff.checkpoint_id,
      checkpoint_id: handoff.checkpoint_id,
      checkpoint_kind: "specification_phase_approval",
      authorization: "human",
      actor_provenance: { kind: "user", ref: "terminal:answer", proof: { answer_id: "answer", nonce: "nonce", channel: "terminal", reference: "terminal:answer", binding: "binding" } },
      decision: "approve_continue",
      rationale: "approved",
    }).success,
    true,
  );
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: public constitution handlers expose the required next Ask in the built registration path", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-constitution-runtime-"));
  let registration: HeldRegistration | undefined;
  try {
    const tools = new Map<string, RegisteredTool>();
    registration = registerWorkflowToolsForTest(root, {
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const context = TEST_CONTEXT(root);
    const selector = { feature_id: "fullstack-constitution", run_key: "fullstack-constitution-run" };
    const ensure = await tools.get("ensure_project_constitution")!.execute("test", {
      ...selector,
      origin_kind: "native_direct",
      origin_run_key: selector.run_key,
      origin_stage: "specify",
    }, undefined, undefined, context as never);
    const ensured = ensure.details as { ok?: boolean; value?: { gate_id?: string } };
    assert.equal(ensured.ok, true);
    const present = await tools.get("present_constitution_draft")!.execute("test", {
      ...selector,
      gate_id: ensured.value!.gate_id,
      document: FULLSTACK_VALID_CONSTITUTION,
    }, undefined, undefined, context as never);
    const details = present.details as {
      ok?: boolean;
      required_next_tool?: { name?: string; arguments?: Record<string, unknown> };
    };
    assert.equal(details.ok, true);
    assert.equal(details.required_next_tool?.name, "constitution_checkpoint_ask_selected");
    const ask = await tools.get("constitution_checkpoint_ask_selected")!.execute(
      "test",
      details.required_next_tool!.arguments!,
      undefined,
      undefined,
      { ...context, ui: { askDialog: async (questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>) => ({ kind: "submit" as const, results: [{ id: questions[0]?.id ?? "", question: questions[0]?.question ?? "", options: (questions[0]?.options ?? []).map(option => option.label), multi: false, selectedOptions: ["request_changes"], note: "needs review" }] }) } } as never,
    );
    const askDetails = ask.details as { ok?: boolean; transition?: string; actor_provenance?: { kind?: string; proof?: unknown } };
    assert.equal(askDetails.ok, true);
    assert.equal(askDetails.transition, "constitution_checkpoint_answer");
    assert.equal(askDetails.actor_provenance?.kind, "user");
    assert.ok(askDetails.actor_provenance?.proof);
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_begin exposes role-bound dispatch markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-marker-handoff-"));
  let registration: HeldRegistration | undefined;
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeSpecificationBeginFixture(root);
    publishMapping(root);
    const tools = new Map<string, RegisteredTool>();
    registration = registerWorkflowToolsForTest(root, {
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
      TEST_CONTEXT(root) as never,
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
    assert.equal(details.handoff?.stage_cursor, "specify");
    assert.equal(details.ok, true);
    const markers = details.handoff?.dispatch_markers ?? [];
    assert.deepEqual(
      markers.map(({ role, agent }) => ({ role, agent })),
      [
        { role: "specification-analyst", agent: "analyst" },
      ],
    );
    for (const marker of markers) {
      assert.match(marker.marker, /<!-- omp-dispatch run=main stage=specify kind=single/);
      assert.match(marker.marker, new RegExp(`cursor=${details.handoff?.cursor_epoch}`));
      assert.match(marker.marker, new RegExp(`role=${marker.role}`));
    }
    const instructions = tools.get("workflow_instructions")!;
    const instructionResponse = await instructions.execute("test", {}, undefined, undefined, TEST_CONTEXT(root) as never);
    const instructionDetails = instructionResponse.details as { stage?: { slot_artifacts?: Record<string, string[]> } };
    assert.deepEqual(instructionDetails.stage?.slot_artifacts, {
      "specification-analyst": ["specify_draft"],
    });
    const gate = dispatchGate({
      toolName: "task",
      input: {
        tasks: markers.map(({ role, agent, marker }) => ({
          role,
          agent,
          task: `${marker}\nComplete the declared specify work.`,
        })),
      },
    }, { cwd: root });
    assert.equal(gate, undefined);
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_instructions exposes declared artifact schemas", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-artifact-schemas-"));
  let registration: HeldRegistration | undefined;
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeBeginFixture(root, "main");
    const tools = new Map<string, RegisteredTool>();
    registration = registerWorkflowToolsForTest(root, {
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);
    const instructions = tools.get("workflow_instructions")!;
    const response = await instructions.execute("test", {}, undefined, undefined, TEST_CONTEXT(root) as never);
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
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: workflow_status exposes completion artifact bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-status-artifacts-"));
  let registration: HeldRegistration | undefined;
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
    registration = registerWorkflowToolsForTest(root, {
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
    const response = await status.execute("test", {}, undefined, undefined, TEST_CONTEXT(root) as never);
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
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow tools register and fail closed with structured responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-workflow-fail-closed-"));
  let registration: HeldRegistration | undefined;
  try {
    const tools = new Map<string, RegisteredTool>();
  registration = registerWorkflowToolsForTest(root, {
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
  assert.deepEqual([...tools.keys()], ["workflow_prepare", "do_work_claim", "workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_start_native_specification_phase", "workflow_finalize_native_specification_phase", "workflow_dispatch_specification_phase", "workflow_persist_specification_phase", "workflow_begin_phase_validation", "workflow_validate_phase", "workflow_checkpoint", "workflow_checkpoint_ask_selected", "workflow_advance", "workflow_specification_conformance", "workflow_complete_specification_execution", "workflow_finalize_import_handoff", "ensure_project_constitution", "present_constitution_draft", "constitution_checkpoint_ask_selected", "decide_constitution_checkpoint", "constitution_impact_assess", "constitution_impact_ask_selected", "constitution_impact_apply", "cto_prepare", "cto_preflight", "cto_checkpoint_ask_selected", "cto_mapping_resume", "cto_confirm", "cto_dispatch", "cto_specification_conformance", "cto_close_specification_execution_wave", "cto_specification_prepare", "cto_specification_review", "cto_specification_decide", "cto_specification_advance", "lecture_acquire"]);
  for (const name of tools.keys()) {
    assert.ok(tools.get(name)?.parameters, `${name} exposes a parameter schema`);
  }
  const lectureAcquire = tools.get("lecture_acquire")!;
  const workerLectureResult = await lectureAcquire.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionId: () => "worker-session", getCwd: () => process.cwd() }, hasUI: false } as never);
  assert.equal((workerLectureResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  const lectureUnavailableResult = await lectureAcquire.execute("test", {}, undefined, undefined, null);
  assert.equal((lectureUnavailableResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");

  const begin = tools.get("workflow_begin")!;
  const workerBeginResult = await begin.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionId: () => "worker-session", getCwd: () => process.cwd() }, hasUI: false } as never);
  assert.equal((workerBeginResult.details as { code?: string }).code, "REGISTRATION_FAILED", "guarded workflow registrars fail closed before a foreign-root worker context can execute");
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
    advance_token: "token",
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
  assert.equal((beginResult.details as { code?: string }).code, "REGISTRATION_FAILED");
  assert.equal((statusResult.details as { code?: string }).code, "REGISTRATION_FAILED");
  assert.equal((completeResult.details as { code?: string }).code, "REGISTRATION_FAILED");
  assert.equal((advanceResult.details as { code?: string }).code, "REGISTRATION_FAILED");
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: workflow_prepare schema accepts PRODUCT_DISCOVERY classifications", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-workflow-prepare-schema-"));
  let registration: HeldRegistration | undefined;
  try {
    const tools = new Map<string, RegisteredTool>();
  registration = registerWorkflowToolsForTest(root, {
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
    adaptive_preparation: {
      complexity: "COMPLEX",
      confidence: "HIGH",
      scopeClarity: "clear",
      securityRisk: false,
      infrastructureRisk: false,
    },
  });
  assert.equal(parsed.success, true);
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_prepare persists PHASE-0 state in the canonical session cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-canonical-"));
  let registration: HeldRegistration | undefined;
  const canonicalRoot = realpathSync(canonical);
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    mkdirSync(join(canonical, ".work-state"), { recursive: true });
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
    registration = registerWorkflowToolsForTest(canonical, {
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const prepare = tools.get("workflow_prepare")!;
    TEST_SESSION_MANAGER.cwd = canonical;
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
        adaptive_preparation: {
          complexity: "QUICK",
          confidence: "HIGH",
          scopeClarity: "clear",
          securityRisk: false,
          infrastructureRisk: false,
        },
      },
      undefined,
      undefined,
      { cwd: stale, sessionManager: TEST_SESSION_MANAGER, hasUI: true } as never,
    );

    const details = response.details as { ok?: boolean; state_path?: string; state?: { branch?: string } };
    assert.equal(details.ok, true);
    assert.equal(details.state?.branch, "main");
    assert.equal(realpathSync(details.state_path!), join(canonicalRoot, ".work-state", "team-state.json"));
    const state = JSON.parse(readFileSync(details.state_path!, "utf8")) as {
      branch: string;
      task: string;

      classification?: { type: string; autonomous: boolean; workflow?: string };
      scope?: { scope: string[] };
    };

    const begin = tools.get("workflow_begin")!;
    TEST_SESSION_MANAGER.cwd = canonical;
    const beginResponse = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      TEST_CONTEXT(canonical) as never,
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
      TEST_CONTEXT(canonical) as never,
    );
    assert.equal((reopenResponse.details as { ok?: boolean }).ok, true);
    const resumedBegin = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      TEST_CONTEXT(canonical) as never,
    );
    assert.equal((resumedBegin.details as { ok?: boolean }).ok, true);
  } finally {
    registration?.close();
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});
test("fullstack: workflow_begin follows the canonical session cwd, not a stale context cwd", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-canonical-"));
  let registration: HeldRegistration | undefined;
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-stale-"));
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    writeBeginFixture(canonical, "main");
    // This is the exact failure shape from the report: state says `main`,
    // but the stale context directory has no active git branch.
    writeBeginFixture(stale, "main");

    const tools = new Map<string, RegisteredTool>();
    registration = registerWorkflowToolsForTest(canonical, {
      zod: { z },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never);

    const begin = tools.get("workflow_begin")!;
    TEST_SESSION_MANAGER.cwd = canonical;
    const response = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: stale, sessionManager: TEST_SESSION_MANAGER, hasUI: true } as never,
    );

    const details = response.details;
    if (!details || typeof details !== "object" || !("ok" in details)) throw new Error("workflow_begin response has no ok field");
    assert.equal(details.ok, true);
  } finally {
    registration?.close();
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});
test("fullstack: mutable schema defaults are factories", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-workflow-schema-defaults-"));
  let registration: HeldRegistration | undefined;
  try {
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
    registration = registerWorkflowToolsForTest(root, {
      zod: { z: strictZ },
      registerTool() {},
    } as never);
  });
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: explicit preset feeds the core owner-aware service", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-owner-"));
  let activation: ReturnType<typeof openWorkflowActivation> | undefined;
  let repeat: ReturnType<typeof openWorkflowActivation> | undefined;
  try {
    assert.equal(fullstackPreset.roles["backend-kotlin"], "developer-kotlin");
    assert.ok(fullstackPreset.scopeMap.some(entry => entry.scope === "frontend"));
    assert.ok(fullstackPreset.flags.has_security?.includes("**/auth/**"));
    assert.ok(fullstackPreset.modelRoles.some(entry => entry.role === "architect"));

    const owner = fullstackOwnerForCwd(root);
    assert.equal(owner.owner_id, FULLSTACK_BUNDLE_ID);
    assert.equal(owner.bundle_id, FULLSTACK_BUNDLE_ID);
    assert.equal(owner.provenance.cwd, root);

    writeFullstackActivationMarker(root);
    const first = openWorkflowActivation(root, ["workflow_registration"], owner);
    assert.equal(first.ok, true);
    if (first.ok) activation = first;
    repeat = openWorkflowActivation(root, ["workflow_registration"], owner);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.ok && repeat.idempotent, true);

    const conflict = openWorkflowActivation(root, ["workflow_registration"], { ...owner, owner_id: "private-omp" });
    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.code, "owner_conflict");
  } finally {
    if (repeat?.ok) closeWorkflowActivation(repeat);
    if (activation?.ok) closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint accepts only the typed decision envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-workflow-checkpoint-schema-"));
  let registration: HeldRegistration | undefined;
  try {
    const tools = new Map<string, RegisteredTool>();
  registration = registerWorkflowToolsForTest(root, {
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  const checkpoint = tools.get("workflow_checkpoint")!;
  const parameters = checkpoint.parameters as { safeParse(input: unknown): { success: boolean } };
  const typedEnvelope = {
    advance_token: "token",
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
  assert.equal(parameters.safeParse({ ...typedEnvelope, token: "token" }).success, false);
  assert.equal(
    parameters.safeParse({
      ...typedEnvelope,
      mode: "interactive",
      actor: "user",
    }).success,
    false,
  );
  assert.equal(parameters.safeParse({ ...typedEnvelope, unexpected: true }).success, false);
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_advance schema bounds authorization fields and line-inert evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-workflow-advance-schema-"));
  let registration: HeldRegistration | undefined;
  try {
    const tools = new Map<string, RegisteredTool>();
  registration = registerWorkflowToolsForTest(root, {
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  const advance = tools.get("workflow_advance");
  assert.ok(advance, "workflow_advance must be mounted");
  const parameters = advance.parameters as { safeParse(input: unknown): { success: boolean } };
  const envelope = {
    feature_id: "feature-one",
    advance_token: "advance-token",
    capability_id: "capability",
    run_key: "run",
    branch: "main",
    workflow: "workflow",
    profile_hash: "profile-hash",
    stage_cursor: "stage",
    cursor_epoch: "epoch",
    evidence: "bounded evidence",
  };
  assert.equal(parameters.safeParse(envelope).success, true);
  assert.equal(parameters.safeParse({ ...envelope, evidence: "é".repeat(4097) }).success, false, "evidence is bounded by UTF-8 bytes, not only characters");
  assert.equal(parameters.safeParse({ ...envelope, evidence: "line one\nline two" }).success, false, "evidence is line-inert");
  assert.equal(parameters.safeParse({ ...envelope, advance_token: "x".repeat(4097) }).success, false, "advance tokens are bounded");
  assert.equal(parameters.safeParse({ ...envelope, feature_id: "../escape" }).success, false, "feature selectors are canonical safe ids");
  assert.equal(parameters.safeParse({ ...envelope, token: "legacy-token" }).success, false, "legacy token alias is rejected");
  } finally {
    registration?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: F7 core lifecycle exports remain public", () => {
  for (const hook of [recordWorkPending, recordWorkTerminal]) {
    assert.equal(typeof hook, "function");
  }
});
