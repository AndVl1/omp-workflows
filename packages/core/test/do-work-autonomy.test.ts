/**
 * RC2+ regression tests: the static parser is a MECHANICAL `autonomyHint`,
 * never an authority. The main LLM classifies `type`/`complexity`/
 * `confidence`/`autonomous` together at PHASE-0 (in any language); the P5
 * gate reads `classification.autonomous` (the model decision), fails closed
 * on missing/non-boolean values, and never lets a static hint force a
 * workflow. Legacy top-level `TeamState.autonomous` is read-compat only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import {
  advanceCursor,
  authorizeDispatch,
  authorizeDispatchTrusted,
  beginCapability,
  completeDispatch,
  createCapability,
  reconcileTrustedTaskResult,
} from "../src/engine/durable.js";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";
import { resolveConfig } from "../src/engine/config.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { appendCheckpointDecision, checkpointPolicyHash, recordTrustedCheckpointAnswer } from "../src/engine/checkpoints.js";
import { acquireCtoIngress, suspendCtoSession } from "../src/cto/run.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { buildDispatchMarker, dispatchTaskId, parseDispatchMarker, trustedDispatchRequests } from "../src/gates/dispatch.js";
import { dodBackstop, validateTypedDoD } from "../src/gates/dod-backstop.js";
import { registerTeamWorkflow, registerWorkflowTools } from "../src/index.js";
import { flushRecorder } from "../src/observability/hooks.js";
import {
  TRUSTED_ORCHESTRATOR_WRITE_PROOF,
  createTrustedOrchestratorWriteProof,
  orchestratorWriteGate,
} from "../src/gates/orchestrator-write.js";

import { runTarget } from "../src/engine/run-store.js";
import type { TeamState, TrustedExecutionContext } from "../src/engine/types.js";
import { prepareWorkflowState } from "../src/engine/run.js";

import {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  keywordClassify,
  resolveWorkflow,
  resolveClassification,
  classificationGate,
  buildCtoPrompt,
} from "@andvl1/omp-workflows-core";

const RUN_IDS = new Map<string, string>();

function activeRunId(root: string): string {
  const runId = RUN_IDS.get(root);
  assert.ok(runId, "canonical run fixture must be initialized");
  return runId;
}

function trustedContext(root: string, branch = "main"): TrustedExecutionContext {
  return {
    session_id: `do-work-${root.split("/").at(-1) ?? "session"}`,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch,
    authority: "coordinator",
  };
}

function writeWorkflowState(root: string, state: Record<string, unknown>): string {
  const runId = typeof state.run_id === "string" ? state.run_id : (RUN_IDS.get(root) ?? randomUUID());
  const branch = typeof state.branch === "string" ? state.branch : "main";
  const target = runTarget(root, runId);
  mkdirSync(target.artifactsDir!, { recursive: true });
  const normalized = {
    schema: 2,
    run_id: runId,
    run_key: runId,
    lifecycle_status: "active",
    rework_generation: 0,
    branch,
    title: "autonomy regression",
    task: "autonomy regression",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    workflow_override: false,
    issue: null,
    required_inputs: {},
    required_input_receipts: {},
    stage_cursor: "",
    stages: [],
    artifacts: {},
    scope: {},
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    ...state,
    schema: 2,
    run_id: runId,
    run_key: runId,
    branch,
  };
  writeFileSync(target.statePath, JSON.stringify(normalized));
  RUN_IDS.set(root, runId);
  return runId;
}

function selectedState(root: string): TeamState {
  const target = runTarget(root, activeRunId(root));
  return JSON.parse(readFileSync(target.statePath, "utf8")) as TeamState;
}

function selectedController(root: string, branch = "main") {
  const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root, branch) });
  controller.bind(activeRunId(root));
  return controller;
}
function preparedController(root: string, branch = "main", sessionId = trustedContext(root, branch).session_id) {
  const runId = activeRunId(root);
  const execution = { ...trustedContext(root, branch), session_id: sessionId };
  const controller = createWorkflowSessionController({ cwd: root, context: execution });
  const prepared = controller.prepare({ mode: "resume", run_id: runId });
  assert.equal(prepared.state.run_id, runId);
  assert.equal(controller.activeClaimRunId(), runId);
  return controller;
}

function classificationGateFor(root: string, event: { agent?: string; role?: string } = { agent: "developer" }) {
  return classificationGate(event, { cwd: root, run_id: activeRunId(root) });
}

function writeRequiredArtifact(root: string, artifactId: string, value: unknown): void {
  const target = runTarget(root, activeRunId(root));
  mkdirSync(target.artifactsDir!, { recursive: true });
  writeFileSync(join(target.artifactsDir!, `${artifactId}.json`), JSON.stringify(value));
}

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function initP5ClassificationFixture(root: string): TrustedExecutionContext {
  const requestedBranch = `p5/${randomUUID()}`;
  initGit(root, requestedBranch);
  const branch = execFileSync("git", ["-C", root, "branch", "--show-current"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.equal(branch, requestedBranch, "P5 fixture must capture the initialized branch");
  return trustedContext(root, branch);
}

function writeP5WorkflowState(
  root: string,
  execution: TrustedExecutionContext,
  state: Record<string, unknown>,
): string {
  return writeWorkflowState(root, { ...state, branch: execution.branch });
}

const trustedIntakeRoles = { analyst: "analyst", "tech-researcher": "tech-researcher" } as const;

/** Publish a trusted live agent mapping covering the spec-preparation intake pool. */
function publishMapping(root: string, roles: Readonly<Record<string, string>> = trustedIntakeRoles): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(roles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(roles),
  });
  writeAgentMapping(root, mapping);
}

type RegisteredWorkflowTool = {
  name: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<{ details: unknown }>;
};

function parsePrepareInput(prepare: RegisteredWorkflowTool, value: unknown): Record<string, unknown> {
  const parser = prepare.parameters as { parse?: (input: unknown) => unknown };
  assert.equal(typeof parser.parse, "function", "workflow_prepare must expose its zod parameter parser");
  return parser.parse!(value) as Record<string, unknown>;
}
function assertAllowedToolHook(results: unknown[], label: string): void {
  assert.ok(
    results.every((result) => !result || typeof result !== "object" || (result as { block?: unknown }).block !== true),
    `${label}: ${JSON.stringify(results)}`,
  );
}

function registeredWorkflowTools(root: string): Map<string, RegisteredWorkflowTool> {
  const tools = new Map<string, RegisteredWorkflowTool>();
  const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root) });
  const runId = RUN_IDS.get(root);
  if (runId) controller.bind(runId);
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredWorkflowTool) {
      tools.set(tool.name, tool);
    },
  } as never, { cwd: root, isMainSession: () => true, getSessionController: () => controller });
  return tools;
}

test("host admission resolves session-manager cwd for mounted read and workflow tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-admission-session-cwd-"));
  try {
    writeImplementationState(root);
    const runId = activeRunId(root);
    const controller = selectedController(root);
    const tools = new Map<string, RegisteredWorkflowTool>();
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const admittedCwds: string[] = [];
    const sessionId = trustedContext(root).session_id;
    const sessionContext = {
      sessionManager: { getCwd: () => root, getSessionId: () => sessionId },
      hasUI: true,
      session_id: sessionId,
    };
    const resolveSessionCwd = (ctx: unknown): string | undefined => {
      if (!ctx || typeof ctx !== "object") return undefined;
      const manager = (ctx as { sessionManager?: { getCwd?: () => unknown } }).sessionManager;
      try {
        const cwd = manager?.getCwd?.();
        return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
      } catch {
        return undefined;
      }
    };
    const getController = (ctx: unknown, cwd: string) => {
      admittedCwds.push(cwd);
      return cwd === root ? controller : undefined;
    };
    const pi = {
      zod: { z },
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
      registerTool(tool: RegisteredWorkflowTool) {
        tools.set(tool.name, tool);
      },
    };
    registerTeamWorkflow(pi as never, {
      observability: true,
      resolveCwd: resolveSessionCwd,
      getSessionController: getController,
    });
    registerWorkflowTools(pi as never, {
      resolveCwd: resolveSessionCwd,
      isMainSession: () => true,
      getSessionController: getController,
    });

    const readEvent = {
      toolName: "read",
      toolCallId: "read-xd-workflow-instructions",
      input: { path: "xd://workflow_instructions" },
    };
    const toolCallHandlers = handlers.tool_call ?? [];
    assert.ok(toolCallHandlers.length > 0, "registered tool_call hook is required");
    assert.doesNotThrow(() => {
      for (const handler of toolCallHandlers) {
        const result = handler(readEvent, sessionContext);
        assert.notEqual(result && typeof result === "object" ? (result as { block?: unknown }).block : undefined, true);
      }
    });
    assert.ok(admittedCwds.length > 0, "the active run must reach controller-backed admission");
    assert.ok(admittedCwds.every((cwd) => cwd === root), JSON.stringify(admittedCwds));
    await flushRecorder(root);
    const eventsPath = join(root, ".work-state", "runs", runId, "observability", "events.jsonl");
    assert.match(readFileSync(eventsPath, "utf8"), /read-xd-workflow-instructions/);

    const prepare = tools.get("workflow_prepare");
    const instructions = tools.get("workflow_instructions");
    assert.ok(prepare && instructions, "workflow tools must be registered");
    const prepared = await prepare.execute(
      "session-manager-cwd-prepare",
      { mode: "resume", branch: "main", run_id: runId },
      undefined,
      undefined,
      sessionContext as never,
    );
    const preparedDetails = prepared.details as { ok?: boolean; error?: string };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    const instructionResponse = await instructions.execute(
      "session-manager-cwd-instructions",
      {},
      undefined,
      undefined,
      sessionContext as never,
    );
    const contract = instructionResponse.details as {
      workflow?: string;
      stage?: { id?: string; roles?: Array<{ role?: string; agent?: string }> };
    };
    assert.equal(contract.workflow, "debug-cycle");
    assert.equal(contract.stage?.id, "implementation");
    assert.deepEqual(contract.stage?.roles, [{ role: "developer-kotlin", agent: "developer-kotlin" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("lifecycle write routes are exact outer exemptions while handlers retain host authentication", async () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-device-route-auth-"));
  try {
    initGit(root, "main");
    const trustedSessionId = "lifecycle-main-session";
    const trusted = {
      sessionManager: { getCwd: () => root, getSessionId: () => trustedSessionId },
      mode: "tui",
      hasUI: true,
      session_id: trustedSessionId,
    };
    const trustedExecution = { ...trustedContext(root), session_id: trustedSessionId };
    const controller = createWorkflowSessionController({ cwd: root, context: trustedExecution });
    const sessionContext = (sessionId: string, mode: string, hasUI: boolean) => ({
      sessionManager: { getCwd: () => root, getSessionId: () => sessionId },
      mode,
      hasUI,
      session_id: sessionId,
    });
    const getController = (ctx: unknown, cwd: string) => {
      if (cwd !== root || !ctx || typeof ctx !== "object") return undefined;
      const value = ctx as {
        mode?: unknown;
        hasUI?: unknown;
        sessionManager?: { getSessionId?: () => unknown };
      };
      let sessionId: unknown;
      try {
        sessionId = value.sessionManager?.getSessionId?.();
      } catch {
        return undefined;
      }
      return sessionId === trustedSessionId
        && value.hasUI === true
        && (value.mode === "tui" || value.mode === "rpc")
        ? controller
        : undefined;
    };
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const tools = new Map<string, RegisteredWorkflowTool>();
    const pi = {
      zod: { z },
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
      registerTool(tool: RegisteredWorkflowTool) {
        tools.set(tool.name, tool);
      },
    };
    registerTeamWorkflow(pi as never, {
      observability: false,
      resolveCwd: ctx => {
        if (!ctx || typeof ctx !== "object") return undefined;
        try {
          const cwd = (ctx as { sessionManager?: { getCwd?: () => unknown } }).sessionManager?.getCwd?.();
          return typeof cwd === "string" ? cwd : undefined;
        } catch {
          return undefined;
        }
      },
      getSessionController: getController,
      resolveTrustedToolCallActor: () => undefined,
    });
    registerWorkflowTools(pi as never, {
      resolveCwd: ctx => {
        if (!ctx || typeof ctx !== "object") return undefined;
        try {
          const cwd = (ctx as { sessionManager?: { getCwd?: () => unknown } }).sessionManager?.getCwd?.();
          return typeof cwd === "string" ? cwd : undefined;
        } catch {
          return undefined;
        }
      },
      isMainSession: () => false,
      getSessionController: getController,
    });
    for (const handler of handlers.session_start ?? []) handler({}, trusted);
    const toolCall = handlers.tool_call?.[0];
    assert.ok(toolCall, "configured raw tool hook is required");
    const routeEvent = (path: string) => ({ toolName: "write", toolCallId: `route-${path}`, input: { path, content: "{}" } });
    const lifecycleRoutes = [
      "xd://workflow_prepare",
      "xd://workflow_instructions",
      "xd://workflow_begin",
      "xd://workflow_status",
      "xd://workflow_complete",
      "xd://workflow_checkpoint",
      "xd://workflow_checkpoint_ask",
      "xd://workflow_advance",
    ];
    assert.equal(controller.selectedRunId(), undefined, "positive route must begin without a preselected run");
    assert.equal(toolCall(routeEvent("xd://workflow_prepare"), trusted), undefined, "workflow_prepare outer write should reach its handler");
    const ctoState = tools.get("cto_state");
    assert.ok(ctoState, "registered cto_state handler is required");
    const ctoIngress = acquireCtoIngress({
      cwd: root,
      branch: "main",
      task: "generic write route CTO state",
      controller,
    });
    assert.equal(toolCall(routeEvent("xd://cto_state"), trusted), undefined, "exact cto_state write should reach its registered handler");
    const ownerRead = (await ctoState.execute(
      "trusted-cto-route-read",
      { operation: "read", run_id: ctoIngress.run_id },
      undefined,
      undefined,
      trusted as never,
    )).details as { ok?: boolean; operation?: string; state?: unknown; state_revision?: string; error?: string };
    assert.equal(ownerRead.ok, true, ownerRead.error);
    assert.equal(ownerRead.operation, "read");
    assert.ok(ownerRead.state_revision);
    const commitCandidate = structuredClone(ownerRead.state) as Record<string, unknown>;
    commitCandidate.pause = { kind: "none", reason: "generic write transport regression" };
    const ownerCommit = (await ctoState.execute(
      "trusted-cto-route-commit",
      {
        operation: "commit",
        run_id: ctoIngress.run_id,
        expected_state_revision: ownerRead.state_revision,
        state: commitCandidate,
      },
      undefined,
      undefined,
      trusted as never,
    )).details as { ok?: boolean; operation?: string; transition?: string; error?: string };
    assert.equal(ownerCommit.ok, true, ownerCommit.error);
    assert.equal(ownerCommit.operation, "commit");
    assert.equal(ownerCommit.transition, "state");
    const ctoStatePath = join(root, ".work-state", "cto", ctoIngress.run_id, "state.json");
    const committedCtoBytes = readFileSync(ctoStatePath, "utf8");
    const committedCtoState = JSON.parse(committedCtoBytes) as { pause?: { reason?: string } };
    assert.equal(committedCtoState.pause?.reason, "generic write transport regression");
    const deniedCtoContexts: Array<[string, unknown]> = [
      ["foreign", sessionContext("foreign-session", "tui", true)],
      ["worker", sessionContext("worker-session", "print", false)],
      ["unknown", { sessionManager: { getCwd: () => root }, mode: "tui", hasUI: true }],
    ];
    for (const [label, deniedContext] of deniedCtoContexts) {
      assert.equal(toolCall(routeEvent("xd://cto_state"), deniedContext), undefined, `${label} cto_state transport must defer to controller authorization`);
      const denied = (await ctoState.execute(
        `${label}-cto-route-commit`,
        {
          operation: "commit",
          run_id: ctoIngress.run_id,
          expected_state_revision: ownerRead.state_revision,
          state: commitCandidate,
        },
        undefined,
        undefined,
        deniedContext as never,
      )).details as { ok?: boolean; code?: string };
      assert.equal(denied.ok, false, `${label} cto_state commit must be denied`);
      assert.equal(denied.code, "WORKFLOW_CONTEXT_REJECTED", `${label} cto_state denial must come from controller authentication`);
      assert.equal(readFileSync(ctoStatePath, "utf8"), committedCtoBytes, `${label} cto_state denial must preserve canonical bytes`);
    }
    suspendCtoSession(controller, "session-shutdown");

    const prepare = tools.get("workflow_prepare");
    assert.ok(prepare, "workflow_prepare handler is required");
    const params = {
      mode: "new",
      task: "handler authentication",
      branch: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false },
    };
    const prepared = await prepare.execute("trusted-route", params, undefined, undefined, trusted as never);
    const preparedDetails = prepared.details as { ok?: boolean; error?: string };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    const selectedRunId = controller.selectedRunId();
    assert.ok(selectedRunId, "trusted prepare must bind the new canonical run");
    assert.equal(existsSync(runTarget(root, selectedRunId!).statePath), true, "trusted prepare must create canonical state");
    const snapshotTree = (directory: string): string => {
      const walk = (current: string, prefix: string): string[] => {
        if (!existsSync(current)) return [];
        return readdirSync(current, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name))
          .flatMap(entry => {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const path = join(current, entry.name);
            return entry.isDirectory()
              ? [`D:${relativePath}`, ...walk(path, relativePath)]
              : [`F:${relativePath}:${readFileSync(path).toString("base64")}`];
          });
      };
      return walk(directory, "").join("\n");
    };
    for (const path of lifecycleRoutes.slice(1)) {
      assert.equal(toolCall(routeEvent(path), trusted), undefined, `exact lifecycle route should reach its handler: ${path}`);
    }
    const deniedRoutes: Array<[string, unknown]> = [
      ["query", routeEvent("xd://workflow_prepare?mode=new")],
      ["cto_query", routeEvent("xd://cto_state?operation=read")],
      ["suffix", routeEvent("xd://workflow_prepare/")],
      ["selector", routeEvent("xd://workflow_prepare#selector")],
      ["traversal", routeEvent("xd://workflow_prepare/../workflow_begin")],
      ["case", routeEvent("XD://workflow_prepare")],
      ["unknown", routeEvent("xd://report_issue")],
      ["ast_edit", routeEvent("xd://ast_edit")],
      ["source", routeEvent("src/app.ts")],
      [".work-state", routeEvent(".work-state/runs/current/state.json")],
      ["cto_state_file", routeEvent(`.work-state/cto/${ctoIngress.run_id}/state.json`)],
      ["mixed", { toolName: "write", input: { path: ["xd://workflow_prepare", "src/app.ts"], content: "{}" } }],
      ["edit", { toolName: "edit", input: { path: "xd://workflow_prepare", content: "{}" } }],
      ["bash", { toolName: "bash", input: { command: "echo route" } }],
    ];
    for (const [label, event] of deniedRoutes) {
      assert.equal((toolCall(event, trusted) as { block?: boolean } | undefined)?.block, true, `${label} route must stay denied`);
    }

    const sentinel = join(root, "handler-sentinel");
    writeFileSync(sentinel, "before");
    const beforeRejectedHandlers = snapshotTree(join(root, ".work-state"));
    const foreign = await prepare.execute("foreign-route", params, undefined, undefined, sessionContext("foreign-session", "tui", true) as never);
    const headless = await prepare.execute("headless-route", params, undefined, undefined, sessionContext(trustedSessionId, "print", false) as never);
    assert.equal((foreign.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
    assert.equal((headless.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
    assert.equal(snapshotTree(join(root, ".work-state")), beforeRejectedHandlers, "foreign/headless handlers must not mutate canonical state or run inventory");
    assert.equal(readFileSync(sentinel, "utf8"), "before", "foreign/headless route handlers must not mutate state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host admission blocks cwd-required tools when the resolver has no workspace", () => {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const pi = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[name] ??= []).push(handler);
    },
  };
  registerTeamWorkflow(pi as never, {
    observability: false,
    resolveCwd: () => undefined,
    getSessionController: () => {
      throw new Error("missing cwd must not resolve a session controller");
    },
  });
  const toolCall = handlers.tool_call?.[0];
  assert.ok(toolCall, "registered tool_call hook is required");
  const context = {
    sessionManager: { getCwd: () => undefined, getSessionId: () => "missing-cwd-session" },
    hasUI: true,
    session_id: "missing-cwd-session",
  };
  for (const toolName of ["ask", "task", "write", "edit", "bash"]) {
    const result = toolCall!({ toolName, toolCallId: "missing-cwd-" + toolName, input: {} }, context);
    assert.deepEqual(result, { block: true, reason: "workflow cwd unavailable" }, toolName);
  }
  const readResult = toolCall!({ toolName: "read", toolCallId: "missing-cwd-read", input: { path: "xd://workflow_instructions" } }, context);
  assert.equal(readResult, undefined, "read remains harmless without an authoritative workspace");
});

function writeImplementationState(root: string): void {
  const profile = loadProfile("debug-cycle");
  assert.ok(profile, "debug-cycle profile must be available for scope regressions");
  initGit(root, "main");
  const prepared = prepareWorkflowState({
    cwd: root,
    branch: "main",
    task: "scope preservation regression",
    autonomous: false,
    classification: { type: "BUG_FIX", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "debug-cycle" },
    files: ["src/main/App.kt"],
    issue: null,
    mode: "new",
    request_id: "scope-fixture-new",
    execution: trustedContext(root),
  });
  const runId = prepared.state.run_id ?? randomUUID();
  writeWorkflowState(root, {
    run_id: runId,
    branch: "main",
    classification: { type: "BUG_FIX", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "debug-cycle" },
    task: "scope preservation regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: profile.stages.map((stage) => ({
      id: stage.id,
      status: stage.id === "discovery" || stage.id === "diagnose" ? "done" : stage.id === "implementation" ? "in_progress" : "pending",
    })),
    artifacts: { discovery: "discovery.json", debug: "debug.json", diagnosis: "diagnosis.json" },
    required_inputs: {
      diagnose: [{ artifact_id: "discovery", path: "discovery.json" }],
      implementation: [{ artifact_id: "diagnosis", path: "diagnosis.json" }],
    },
    scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
    profile_hash: profileHash(profile),
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  });
  writeRequiredArtifact(root, "discovery", { findings: ["scope fixture"] });
  writeRequiredArtifact(root, "debug", { observations: ["scope fixture"] });
  writeRequiredArtifact(root, "diagnosis", { root_cause: "scope fixture", evidence: ["fixture"] });
}
test("workflow_prepare: explicit resume omitting files preserves the selected run scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-scope-preserved-"));
  try {
    writeImplementationState(root);
    const runId = activeRunId(root);
    const tools = registeredWorkflowTools(root);
    const prepare = tools.get("workflow_prepare")!;
    const input = parsePrepareInput(prepare, {
      mode: "resume",
      branch: "main",
      run_id: runId,
    });
    assert.equal(input.files, undefined, "omitted files must remain undefined after schema parsing");
    const prepared = await prepare.execute("resume-scope-omitted", input, undefined, undefined, {
      cwd: root,
      hasUI: true,
      session_id: trustedContext(root).session_id,
    } as never);
    assert.equal((prepared.details as { ok?: boolean }).ok, true);

    const state = selectedState(root);
    assert.deepEqual(state.scope?.scope, ["backend-kotlin"]);
    assert.equal(state.scope?.dev_agent, "developer-kotlin");

    const instructions = tools.get("workflow_instructions")!;
    const response = await instructions.execute("resume-scope-omitted-instructions", {}, undefined, undefined, {
      cwd: root,
      hasUI: true,
      session_id: trustedContext(root).session_id,
    } as never);
    const contract = response.details as { workflow?: string; stage?: { id?: string; roles?: Array<{ role?: string; agent?: string }> } };
    assert.equal(contract.workflow, "debug-cycle");
    assert.equal(contract.stage?.id, "implementation");
    assert.deepEqual(contract.stage?.roles, [{ role: "developer-kotlin", agent: "developer-kotlin" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare: explicit resume preserves persisted scope when files is an empty list", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-scope-empty-"));
  try {
    writeImplementationState(root);
    const runId = activeRunId(root);
    const tools = registeredWorkflowTools(root);
    const prepare = tools.get("workflow_prepare")!;
    const input = parsePrepareInput(prepare, {
      mode: "resume",
      branch: "main",
      run_id: runId,
      files: [],
    });
    assert.deepEqual(input.files, []);
    const prepared = await prepare.execute("resume-scope-empty", input, undefined, undefined, {
      cwd: root,
      hasUI: true,
      session_id: trustedContext(root).session_id,
    } as never);
    assert.equal((prepared.details as { ok?: boolean }).ok, true);

    const state = selectedState(root);
    assert.deepEqual(state.scope?.scope, ["backend-kotlin"]);
    assert.equal(state.scope?.dev_agent, "developer-kotlin");

    const instructions = tools.get("workflow_instructions")!;
    const response = await instructions.execute("resume-scope-empty-instructions", {}, undefined, undefined, {
      cwd: root,
      hasUI: true,
      session_id: trustedContext(root).session_id,
    } as never);
    const contract = response.details as { workflow?: string; stage?: { id?: string; roles?: Array<{ role?: string; agent?: string }> } };
    assert.equal(contract.workflow, "debug-cycle");
    assert.equal(contract.stage?.id, "implementation");
    assert.deepEqual(contract.stage?.roles, [{ role: "developer-kotlin", agent: "developer-kotlin" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare: explicit resume preserves persisted scope despite ambient mapping changes", async () => {
  for (const mapping of ["absent", "invalid"] as const) {
    const root = mkdtempSync(join(tmpdir(), `workflow-prepare-scope-${mapping}-`));
    try {
      writeImplementationState(root);
      const runId = activeRunId(root);
      if (mapping === "invalid") {
        mkdirSync(join(root, ".omp"), { recursive: true });
        writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ scope_map: [{ glob: ["**/*.kt"], scope: "backend-kotlin" }] }) + "\n");
      }
      const tools = registeredWorkflowTools(root);
      const prepare = tools.get("workflow_prepare")!;
      const input = parsePrepareInput(prepare, {
        mode: "resume",
        branch: "main",
        run_id: runId,
        files: ["src/main/App.kt"],
      });
      const prepared = await prepare.execute(`resume-scope-${mapping}`, input, undefined, undefined, {
        cwd: root,
        hasUI: true,
        session_id: trustedContext(root).session_id,
      } as never);
      assert.equal((prepared.details as { ok?: boolean }).ok, true, mapping);
      assert.deepEqual(selectedState(root).scope?.scope, ["backend-kotlin"], mapping);
      assert.equal(selectedState(root).scope?.dev_agent, "developer-kotlin", mapping);
      const instructions = tools.get("workflow_instructions")!;
      const response = await instructions.execute(`resume-scope-${mapping}-instructions`, {}, undefined, undefined, {
        cwd: root,
        hasUI: true,
        session_id: trustedContext(root).session_id,
      } as never);
      const contract = response.details as { workflow?: string; stage?: { id?: string; roles?: Array<{ role?: string; agent?: string }> } };
      assert.equal(contract.workflow, "debug-cycle", mapping);
      assert.equal(contract.stage?.id, "implementation", mapping);
      assert.deepEqual(contract.stage?.roles, [{ role: "developer-kotlin", agent: "developer-kotlin" }], mapping);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});


function recordTypedCheckpoint(root: string, stageId: string, checkpointId: string): void {
  const state = selectedState(root);
  const policy = state.checkpoint_policy;
  const capability = state.dispatch_capability;
  assert.ok(policy, "checkpoint fixture must have a typed policy");
  assert.ok(capability?.capability_id && capability.issued_for?.cursor_epoch, "checkpoint fixture must have a capability binding");
  const rule = policy.rules[checkpointId];
  assert.ok(rule, `checkpoint fixture must define ${checkpointId}`);
  const runId = activeRunId(root);
  const trusted = recordTrustedCheckpointAnswer(state, {
    answer_id: `do-work/${stageId}/${checkpointId}`,
    channel: "terminal",
    reference: `terminal-answer/do-work/${stageId}/${checkpointId}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision: "proceed",
  });
  const typed = {
    run_id: runId,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    checkpoint_kind: rule.kind,
    decision: "proceed",
    authorization: "human" as const,
    actor: { kind: "user" as const, ref: trusted.answer.reference, proof: trusted.proof },
    capability_id: capability.capability_id,
    capability_epoch: capability.issued_for!.cursor_epoch,
    loop_iteration: capability.issued_for!.loop_iteration,
    policy_hash: checkpointPolicyHash(policy),
    rationale: "explicit typed fixture answer",
    decided_at: new Date().toISOString(),
  };
  const appended = appendCheckpointDecision(trusted.state, typed);
  assert.equal(appended.ok, true, appended.ok ? "checkpoint recorded" : `checkpoint append failed: ${appended.code}: ${appended.error}`);
  writeFileSync(runTarget(root, runId).statePath!, `${JSON.stringify(appended.state, null, 2)}\n`);
}
test("workflow_prepare: public tool rejects branch drift, detached HEAD, and non-git cwd before writes", async () => {
  const mismatch = mkdtempSync(join(tmpdir(), "workflow-prepare-mismatch-"));
  const detached = mkdtempSync(join(tmpdir(), "workflow-prepare-detached-"));
  const noGit = mkdtempSync(join(tmpdir(), "workflow-prepare-no-git-"));
  try {
    initGit(mismatch, "main");
    initGit(detached, "main");
    execFileSync("git", [
      "-C", detached,
      "-c", "user.name=Workflow Test",
      "-c", "user.email=workflow@example.invalid",
      "commit", "--quiet", "--allow-empty", "-m", "fixture",
    ], { stdio: "ignore" });
    execFileSync("git", ["-C", detached, "checkout", "--quiet", "--detach"], { stdio: "ignore" });
    const scenarios = [
      { label: "model branch mismatch", root: mismatch, branch: "feat/model", error: /branch mismatch/ },
      { label: "detached HEAD", root: detached, branch: "main", error: /detached HEAD/ },
      { label: "non-git cwd", root: noGit, branch: "main", error: /outside a git worktree/ },
    ];
    for (const scenario of scenarios) {
      type PrepareTool = {
        execute: (...args: never[]) => Promise<{ details: unknown }>;
      };
      const tools = new Map<string, PrepareTool>();
      registerWorkflowTools({
        zod: { z },
        registerTool(tool: PrepareTool & { name: string }) {
          tools.set(tool.name, tool);
        },
      } as never, {
        cwd: scenario.root,
        isMainSession: () => true,
        getSessionController: (_ctx: unknown, cwd: string) => createWorkflowSessionController({
          cwd,
          context: trustedContext(cwd, scenario.label === "model branch mismatch" ? scenario.branch : "main"),
        }),
      });
      const response = await tools.get("workflow_prepare")!.execute(
        "test",
        {
          task: "must reject before state ingress",
          branch: scenario.branch,
          classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false },
          files: [],
          issue: null,
        },
        undefined,
        undefined,
        { cwd: scenario.root, hasUI: true },
      );
      const details = response.details as { ok?: boolean; code?: string; error?: string };
      assert.equal(details.ok, false, scenario.label);
      assert.equal(details.code, "WORKFLOW_PREPARE_FAILED", scenario.label);
      assert.match(details.error ?? "", scenario.error, scenario.label);
      assert.equal(existsSync(join(scenario.root, ".work-state")), false, `${scenario.label} writes no workflow state`);
    }
  } finally {
    rmSync(mismatch, { recursive: true, force: true });
    rmSync(detached, { recursive: true, force: true });
    rmSync(noGit, { recursive: true, force: true });
  }
});
test("do-work: natural-language directive sets the hint and strips from task", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-ru-"));
  try {
    const envelope = parseWorkEnvelope("действуй автономно: исправь 500 на /api/users issue=#42", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "исправь 500 на /api/users");
    assert.equal(envelope.issue, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: [AUTONOMOUSLY] lookalike stays literal and hint is false", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-look-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root);
    assert.equal(envelope.autonomyHint, false);
    assert.equal(envelope.task, "[AUTONOMOUSLY] Fix bug", "lookalike must survive verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) /cto and /do-work share the four-field classification contract ──────



// ── (a) hint false + natural-language autonomy → model true → debug-cycle ───

test("P5 gate: natural-language autonomous task (hint false) is accepted as debug-cycle when the MODEL decides true", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-model-auto-"));
  try {
    const execution = initP5ClassificationFixture(root);
    const envelope = parseWorkEnvelope("Do this without waiting for approval — fix the login bug", root);
    assert.equal(envelope.autonomyHint, false, "parser does NOT recognize natural-language autonomy");


    // Model output: autonomous=true -> debug-cycle passes the gate.
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: true, autonomous_reason: "task explicitly waives approval" },
    });
    assert.equal(classificationGateFor(root), undefined, "model autonomous=true accepted as debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) hint true + contradictory task → model false → interactive ─────────

test("P5 gate: [AUTONOMOUS] marker can be OVERRIDDEN by the model to interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-"));
  try {
    const execution = initP5ClassificationFixture(root);
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Walk me through each step before touching code", root);
    assert.equal(envelope.autonomyHint, true, "static hint is ON");


    // Model decides autonomous=false -> interactive bug-fix passes; debug-cycle blocks.
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false, autonomous_reason: "user wants step-by-step review" },
    });
    assert.equal(classificationGateFor(root), undefined, "model false stays interactive");

    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
    });
    const blocked = classificationGateFor(root);
    assert.ok(blocked, "interactive QUICK BUG_FIX with debug-cycle is blocked");
    assert.ok(blocked?.reason?.includes("expected 'bug-fix'"), "block names the interactive resolution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) absent / non-boolean classification.autonomous blocks ───────────────

test("P5 gate: missing classification.autonomous blocks — no silent default", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-auto-"));
  try {
    const execution = initP5ClassificationFixture(root);
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
    });
    const blocked = classificationGateFor(root);
    assert.ok(blocked, "missing autonomous blocks");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: non-boolean classification.autonomous blocks — fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-nonbool-auto-"));
  try {
    const execution = initP5ClassificationFixture(root);
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
    });
    const blocked = classificationGateFor(root);
    assert.ok(blocked, "string autonomous blocks");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) workflow_override can never bypass the fail-closed autonomy gate ────

test("P5 gate: workflow_override:true cannot bypass MISSING classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-missing-"));
  try {
    const execution = initP5ClassificationFixture(root);
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      workflow_override: true,
    });
    const blocked = classificationGateFor(root);
    assert.ok(blocked, "an explicit override must not bypass a missing model autonomy field");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true cannot bypass NON-BOOLEAN classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-nonbool-"));
  try {
    const execution = initP5ClassificationFixture(root);
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
      workflow_override: true,
    });
    const blocked = classificationGateFor(root);
    assert.ok(blocked, "an explicit override must not bypass a non-boolean model autonomy field");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true still allows a VALID model autonomy decision", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-valid-"));
  try {
    const execution = initP5ClassificationFixture(root);
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
      workflow_override: true,
    });
    assert.equal(
      classificationGateFor(root),
      undefined,
      "override with a valid boolean decision passes — the override skips the mismatch check, not the autonomy gate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: a present model field wins over the legacy top-level field", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-priority-"));
  try {
    const execution = initP5ClassificationFixture(root);
    // Legacy says true, model says false — the model decision is the authority.
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
      autonomous: true,
    });
    assert.equal(classificationGateFor(root), undefined, "model false keeps it interactive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── static hint can never force autonomous ──────────────────────────────────

test("P5 gate: a static hint cannot force autonomous — hint true + model false stays interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-static-hint-"));
  try {
    const execution = initP5ClassificationFixture(root);
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Fix bug", root);
    assert.equal(envelope.autonomyHint, true);

    // Even with the marker present, the persisted model decision rules.
    writeP5WorkflowState(root, execution, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
    });
    assert.equal(classificationGateFor(root), undefined, "hint true must not force debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── engine classification is demoted and cannot pick autonomy ───────────────

test("do-work: keywordClassify guesses type/complexity only — it cannot decide autonomy", () => {
  const base = keywordClassify("fix the login bug");
  assert.equal(base.type, "BUG_FIX", "keyword guess still detects the type");
  assert.ok(!("autonomous" in base), "keyword guess has no autonomous field");
  assert.equal(resolveWorkflow(base.type, base.complexity, true), "debug-cycle", "autonomous BUG_FIX resolves to debug-cycle even at QUICK");
  assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix", "interactive QUICK BUG_FIX stays bug-fix");
});

test("do-work: type/complexity/autonomous resolve together from the model classification", () => {
  const auto = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true, workflow: "debug-cycle" };
  const interactive = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" };
  assert.equal(resolveWorkflow(auto.type, auto.complexity, auto.autonomous), auto.workflow, "model auto classification maps to debug-cycle");
  assert.equal(resolveWorkflow(interactive.type, interactive.complexity, interactive.autonomous), interactive.workflow, "model interactive classification maps to bug-fix");
});

test("engine: resolveClassification treats the MODEL classification as authoritative", () => {
  const resolved = resolveClassification({
    task: "fix the login bug",
    autonomous: true, // legacy hint — must be IGNORED when the model speaks
    classification: {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "MEDIUM",
      autonomous: false,
      autonomous_reason: "user wants review",
    },
  });
  assert.deepEqual(resolved, {
    type: "BUG_FIX",
    complexity: "QUICK",
    confidence: "MEDIUM",
    autonomous: false,
    autonomous_reason: "user wants review",
    workflow: "bug-fix", // resolved from the MODEL's autonomous, not the hint
  });
});

test("engine: resolveClassification FAILS CLOSED on incomplete model output (no keyword fallback)", () => {
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH" } }),
    /classification gate: model classification incomplete/,
    "missing autonomous blocks — no silent default",
  );
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: "true" } }),
    /classification gate: model classification incomplete/,
    "non-boolean autonomous blocks — fail closed",
  );
});

test("engine: legacy path (no model classification) uses the caller flag verbatim — never defaulted", () => {
  const resolved = resolveClassification({ task: "fix the login bug", autonomous: true });
  assert.equal(resolved.type, "BUG_FIX", "keyword guess still detects the type on the legacy path");
  assert.equal(resolved.autonomous, true, "caller-supplied flag used verbatim");
  assert.equal(resolved.workflow, "debug-cycle", "workflow resolved from the caller flag");
});

test("P5 gate: missing classification blocks; absent state allows an ordinary session", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-"));
  try {
    writeWorkflowState(root, { classification: { complexity: "QUICK" } });
    const blocked = classificationGateFor(root);
    assert.ok(blocked, "missing classification blocks subagent launch");

    rmSync(join(root, ".work-state"), { recursive: true, force: true });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "no state -> ordinary session allows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy blocks source and canonical-state writes, allows artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-policy-"));
  try {
    const runId = writeWorkflowState(root, { policy: { strict_orchestrator: true } });
    const canonicalStatePath = `.work-state/runs/${runId}/state.json`;
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const hostContext = { cwd: root, run_id: runId, hasUI: true };
    const source = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: "src/app.ts" } }, hostContext);
    assert.equal(source?.block, true);
    assert.match(source?.reason ?? "", /may write only under \.work-state/);
    const state = orchestratorWriteGate({ toolName: "edit", input: { actor: "worker", path: canonicalStatePath } }, hostContext);
    assert.equal(state?.block, true);
    assert.match(state?.reason ?? "", /canonical workflow state/);
    const artifact = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: `.work-state/runs/${runId}/artifacts/report.json` } }, hostContext);
    assert.equal(artifact, undefined);

    const mountedWorkflowTool = orchestratorWriteGate(
      { toolName: "write", input: { path: "xd://workflow_instructions", content: "{}" } },
      hostContext,
    );
    assert.equal(mountedWorkflowTool, undefined, "mounted xd tools are not project writes");
    assert.equal(
      orchestratorWriteGate(
        { toolName: "write", input: { path: "xd://report_issue", content: "tool routing failed" } },
        hostContext,
      )?.block,
      true,
      "unregistered mounted diagnostics are not lifecycle write exemptions",
    );
    const worker = orchestratorWriteGate({ toolName: "write", input: { actor: "orchestrator", path: "src/app.ts" } }, { ...hostContext, hasUI: false });
    assert.equal(worker, undefined);
    const bashEcho = orchestratorWriteGate({ toolName: "bash", input: { command: "echo hacked > src/app.ts" } }, hostContext);
    assert.equal(bashEcho?.block, true);
    const bashRemove = orchestratorWriteGate({ toolName: "bash", input: { command: "rm src/app.ts" } }, hostContext);
    assert.equal(bashRemove?.block, true);
    const accessorCanonical = {} as Record<string, unknown>;
    Object.defineProperty(accessorCanonical, "command", { get: () => `cat > ${canonicalStatePath}` });
    assert.equal(orchestratorWriteGate({ toolName: "bash", input: accessorCanonical }, hostContext)?.block, true);
    const malformedCanonical = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(malformedCanonical, "command", { value: `cat > ${canonicalStatePath}` });
    assert.equal(orchestratorWriteGate({ toolName: "bash", input: malformedCanonical }, hostContext)?.block, true);
    const bashRead = orchestratorWriteGate(
      { toolName: "bash", input: { command: "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false diff --no-ext-diff --no-textconv -- src/app.ts" } },
      hostContext,
    );
    assert.equal(bashRead, undefined);
    const workerCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: `cat > ${canonicalStatePath}` } }, { ...hostContext, hasUI: false });
    assert.equal(workerCanonicalBash?.block, true);
    const ctoCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: `awk '{print}' > .work-state/cto/run-1/state.json` } }, hostContext);
    assert.equal(ctoCanonicalBash?.block, true);
    const redirectedSource = orchestratorWriteGate({ toolName: "bash", input: { command: 'git show HEAD:src/app.ts > "$(pwd)/src/app.ts"' } }, hostContext);
    assert.equal(redirectedSource?.block, true);
    const workerCanonicalInPlace = orchestratorWriteGate({ toolName: "bash", input: { command: `awk -i inplace '{print}' ${canonicalStatePath}` } }, { ...hostContext, hasUI: false });
    assert.equal(workerCanonicalInPlace?.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered raw tool_call derives a scoped orchestrator only from the trusted adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-call-actor-bridge-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const runId = writeWorkflowState(root, {
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : "pending",
      })),
    });
    const artifactsDir = runTarget(root, runId).artifactsDir!;
    const sessionId = "trusted-main-session";
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const managerFor = (ctx: unknown): { getCwd: () => string; getSessionId: () => string } | undefined => {
      if (!ctx || typeof ctx !== "object") return undefined;
      const manager = (ctx as { sessionManager?: unknown }).sessionManager;
      return manager && typeof manager === "object" ? manager as { getCwd: () => string; getSessionId: () => string } : undefined;
    };
    const pi = {
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    };
    const controller = preparedController(root, "main", sessionId);
    registerTeamWorkflow(pi as never, {
      observability: false,
      resolveCwd: ctx => managerFor(ctx)?.getCwd(),
      getSessionController: (ctx, cwd) => {
        const manager = managerFor(ctx);
        return cwd === root && manager?.getCwd() === root && manager.getSessionId() === sessionId
          ? controller
          : undefined;
      },
      resolveTrustedToolCallActor: (ctx, cwd, selectedRunId) => {
        const manager = managerFor(ctx);
        if (
          cwd === root
          && selectedRunId === runId
          && manager?.getCwd() === root
          && manager.getSessionId() === sessionId
        ) return { actor: "orchestrator", artifactsDir };
        return undefined;
      },
    });
    const toolCall = handlers.tool_call?.[0];
    assert.ok(toolCall, "registered tool_call hook is required");
    const invoke = (input: Record<string, unknown>, ctx: unknown): { block?: boolean; reason?: string } | undefined =>
      toolCall!({ toolName: "write", input }, ctx) as { block?: boolean; reason?: string } | undefined;
    const invokeBash = (command: string, ctx: unknown): { block?: boolean; reason?: string } | undefined =>
      toolCall!({ toolName: "bash", input: { command } }, ctx) as { block?: boolean; reason?: string } | undefined;
    const invokeBashInput = (input: Record<string, unknown>, ctx: unknown): { block?: boolean; reason?: string } | undefined =>
      toolCall!({ toolName: "bash", input }, ctx) as { block?: boolean; reason?: string } | undefined;
    const trustedRawContext = {
      sessionManager: { getCwd: () => root, getSessionId: () => sessionId },
    };

    assert.equal(invoke({ path: join(artifactsDir, "discovery.json"), actor: "worker" }, trustedRawContext), undefined);
    assert.equal(invoke({ path: "src/app.ts", actor: "worker" }, trustedRawContext)?.block, true);
    assert.equal(invoke({ path: ".work-state/other.json", actor: "worker" }, trustedRawContext)?.block, true);
    assert.equal(invoke({ path: `.work-state/runs/${runId}/state.json` }, trustedRawContext)?.block, true);
    assert.equal(invoke({ path: join(artifactsDir, "..", "escape.json") }, trustedRawContext)?.block, true);

    const missingParents = join(artifactsDir, "new", "nested", "discovery.json");
    assert.equal(invoke({ path: missingParents }, trustedRawContext), undefined, "ordinary missing artifact parents remain valid");
    const escapeTarget = join(root, "escape-target");
    mkdirSync(escapeTarget);
    symlinkSync(escapeTarget, join(artifactsDir, "escape-link"));
    assert.equal(invoke({ path: join(artifactsDir, "escape-link", "discovery.json") }, trustedRawContext)?.block, true);
    symlinkSync(join(escapeTarget, "missing.json"), join(artifactsDir, "dangling"));
    assert.equal(invoke({ path: join(artifactsDir, "dangling") }, trustedRawContext)?.block, true);
    const rootAlias = join(root, "artifacts-alias");
    symlinkSync(artifactsDir, rootAlias);
    const rootSymlinkContext = {
      cwd: root,
      run_id: runId,
      actor: "orchestrator" as const,
      [TRUSTED_ORCHESTRATOR_WRITE_PROOF]: createTrustedOrchestratorWriteProof(rootAlias),
    };
    assert.equal(
      orchestratorWriteGate({ toolName: "write", input: { path: join(rootAlias, "discovery.json") } }, rootSymlinkContext)?.block,
      true,
      "a symlinked artifacts root is never a trusted write target",
    );

    execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "native-proof@example.invalid"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Native Proof"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    writeFileSync(join(root, ".gitattributes"), "tracked.txt diff=sentinel\n");
    const sentinelScript = (name: string, body: string): string => {
      const script = join(root, `${name}.sh`);
      writeFileSync(script, `#!/bin/sh\n${body}\n`);
      chmodSync(script, 0o755);
      return script;
    };
    const pagerSentinel = join(root, "pager-sentinel");
    const fsmonitorSentinel = join(root, "fsmonitor-sentinel");
    const externalDiffSentinel = join(root, "external-diff-sentinel");
    const textconvSentinel = join(root, "textconv-sentinel");
    const pager = sentinelScript("hostile-pager", `printf x > ${JSON.stringify(pagerSentinel)}\ncat`);
    const fsmonitor = sentinelScript("hostile-fsmonitor", `printf x > ${JSON.stringify(fsmonitorSentinel)}`);
    const externalDiff = sentinelScript("hostile-external-diff", `printf x > ${JSON.stringify(externalDiffSentinel)}`);
    const textconv = sentinelScript("hostile-textconv", `printf x > ${JSON.stringify(textconvSentinel)}`);
    execFileSync("git", ["add", "tracked.txt", ".gitattributes"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "hostile proof fixture"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "core.pager", pager], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "core.fsmonitor", fsmonitor], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "diff.external", externalDiff], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "diff.sentinel.textconv", textconv], { cwd: root, stdio: "ignore" });

    const safeStatus = "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false status --short";
    const safeShow = "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false show --no-ext-diff --no-textconv --stat HEAD";
    assert.equal(invokeBash("git status --short", trustedRawContext)?.block, true, "bare git proof commands stay blocked");
    assert.equal(invokeBash(safeStatus, trustedRawContext), undefined);
    assert.equal(invokeBash("git show --stat HEAD", trustedRawContext)?.block, true);
    assert.equal(invokeBash(safeShow, trustedRawContext), undefined);
    execFileSync("sh", ["-c", safeStatus], { cwd: root, stdio: "ignore" });
    execFileSync("sh", ["-c", safeShow], { cwd: root, stdio: "ignore" });
    assert.equal(existsSync(pagerSentinel), false, "sanitized show never invokes configured pager");
    assert.equal(existsSync(fsmonitorSentinel), false, "sanitized status never invokes configured fsmonitor");
    assert.equal(existsSync(externalDiffSentinel), false, "sanitized show never invokes configured external diff");
    assert.equal(existsSync(textconvSentinel), false, "sanitized show never invokes configured textconv");

    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false status --short", trustedRawContext), undefined);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false diff --no-ext-diff --no-textconv -- src/app.ts", trustedRawContext), undefined);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false show --no-ext-diff --no-textconv --stat HEAD", trustedRawContext), undefined);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false log -1 --oneline", trustedRawContext), undefined);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current", trustedRawContext), undefined);
    assert.equal(
      invokeBashInput(
        { command: "git --no-pager -c core.fsmonitor=false branch --show-current", env: { GIT_OPTIONAL_LOCKS: "0" } },
        trustedRawContext,
      ),
      undefined,
    );
    for (const command of [
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch -d main",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch -m main renamed",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --set-upstream-to=origin/main",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch main",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current extra",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current; echo changed",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current $(echo changed)",
      "GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current > branch.txt",
    ]) {
      assert.equal(invokeBash(command, trustedRawContext)?.block, true);
    }
    assert.equal(invokeBash("git --no-pager -c core.fsmonitor=false status --short", trustedRawContext)?.block, true);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false rev-parse HEAD", trustedRawContext)?.block, true);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false status --porcelain=v2", trustedRawContext)?.block, true);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false diff --no-textconv -- src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false show --no-ext-diff HEAD", trustedRawContext)?.block, true);
    assert.equal(
      invokeBashInput(
        { command: "git --no-pager -c core.fsmonitor=false diff --no-textconv -- src/app.ts", env: { GIT_OPTIONAL_LOCKS: "0" } },
        trustedRawContext,
      )?.block,
      true,
    );
    assert.equal(
      invokeBashInput(
        { command: "git --no-pager -c core.fsmonitor=false show --no-ext-diff HEAD", env: { GIT_OPTIONAL_LOCKS: "0" } },
        trustedRawContext,
      )?.block,
      true,
    );
    assert.equal(
      invokeBashInput(
        { command: "git --no-pager -c core.fsmonitor=false status --short --branch", env: { GIT_OPTIONAL_LOCKS: "0" } },
        trustedRawContext,
      ),
      undefined,
    );
    assert.equal(
      invokeBashInput(
        { command: safeStatus, env: { GIT_OPTIONAL_LOCKS: "0" } },
        trustedRawContext,
      ),
      undefined,
    );
    const inheritedEnv = Object.create({ GIT_OPTIONAL_LOCKS: "0" }) as Record<string, unknown>;
    const inheritedExtraEnv = Object.create({ GIT_PAGER: "cat" }) as Record<string, unknown>;
    Object.defineProperty(inheritedExtraEnv, "GIT_OPTIONAL_LOCKS", { value: "0", enumerable: true });
    const symbolExtraEnv = { GIT_OPTIONAL_LOCKS: "0" } as Record<string, unknown>;
    Object.defineProperty(symbolExtraEnv, Symbol("extra"), { value: "x" });
    const hiddenExtraEnv = { GIT_OPTIONAL_LOCKS: "0" } as Record<string, unknown>;
    Object.defineProperty(hiddenExtraEnv, "GIT_PAGER", { value: "cat" });
    const accessorEnv = {};
    Object.defineProperty(accessorEnv, "GIT_OPTIONAL_LOCKS", { get: () => "0" });
    const invalidEnvs: unknown[] = [
      { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      { GIT_OPTIONAL_LOCKS: "1" },
      { GIT_OPTIONAL_LOCKS: 0 },
      inheritedEnv,
      inheritedExtraEnv,
      symbolExtraEnv,
      hiddenExtraEnv,
      accessorEnv,
      null,
      ["0"],
    ];
    for (const env of invalidEnvs) {
      assert.equal(
        invokeBashInput({ command: "git --no-pager -c core.fsmonitor=false status --short", env }, trustedRawContext)?.block,
        true,
      );
      assert.equal(
        invokeBashInput({ command: safeStatus, env }, trustedRawContext)?.block,
        true,
      );
    }
    const accessorCommandInput = { command: safeStatus } as Record<string, unknown>;
    Object.defineProperty(accessorCommandInput, "command", { get: () => safeStatus });
    const accessorInputEnv = { command: "git --no-pager -c core.fsmonitor=false status --short" } as Record<string, unknown>;
    Object.defineProperty(accessorInputEnv, "env", { get: () => ({ GIT_OPTIONAL_LOCKS: "0" }) });
    for (const input of ["git --no-pager -c core.fsmonitor=false status --short", 1, true, 0, null, [], accessorCommandInput, accessorInputEnv] as unknown[]) {
      assert.equal(invokeBashInput(input as Record<string, unknown>, trustedRawContext)?.block, true);
    }
    const structuredStatus = "git --no-pager -c core.fsmonitor=false status --short";
    for (const command of [
      `${safeStatus}; echo changed`,
      `${safeStatus} $(echo changed)`,
      `${safeStatus} > proof.txt`,
      `${structuredStatus}; echo changed`,
      `${structuredStatus} $(echo changed)`,
      `${structuredStatus} > proof.txt`,
    ]) {
      assert.equal(
        invokeBashInput({ command, env: { GIT_OPTIONAL_LOCKS: "0" } }, trustedRawContext)?.block,
        true,
      );
    }
    assert.equal(invokeBash("chmod 644 src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("chmod 644 .work-state/other.json", trustedRawContext)?.block, true);
    assert.equal(invokeBash(`echo changed > ${artifactsDir}/mutation.json`, trustedRawContext)?.block, true);
    assert.equal(invokeBash("echo changed > src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("echo changed > .work-state/other.json", trustedRawContext)?.block, true);
    assert.equal(invokeBash(`echo changed > .work-state/runs/${runId}/state.json`, trustedRawContext)?.block, true);
    assert.equal(invokeBash(`mkdir -p ${artifactsDir}/new`, trustedRawContext)?.block, true);
    assert.equal(invokeBash(`mkfifo ${artifactsDir}/fifo`, trustedRawContext)?.block, true);
    assert.equal(invokeBash(`mknod ${artifactsDir}/node p`, trustedRawContext)?.block, true);
    assert.equal(invokeBash("git status --short; echo changed", trustedRawContext)?.block, true);
    assert.equal(invokeBash("pwd", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git diff --output=src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git diff --output src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git show --output=.work-state/other.json HEAD", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git diff --ext-diff -- src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git diff --textconv -- src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git -c core.pager=cat diff -- src/app.ts", trustedRawContext)?.block, true);
    assert.equal(invokeBash("git --no-pager show HEAD", trustedRawContext)?.block, true);

    const explicitWorker = {
      ...trustedRawContext,
      actor: "worker",
      hasUI: false,
    };
    assert.equal((invoke({ path: "src/app.ts" }, explicitWorker))?.block, true, "configured resolver ignores input actor");

    const foreign = {
      sessionManager: { getCwd: () => root, getSessionId: () => "foreign-session" },
    };
    assert.equal(invoke({ path: join(artifactsDir, "discovery.json") }, foreign)?.block, true);
    assert.equal(invoke({ path: "src/app.ts" }, foreign)?.block, true);
    const foreignExplicitOrchestrator = {
      ...foreign,
      actor: "orchestrator",
      hasUI: true,
    };
    assert.equal(invoke({ path: join(artifactsDir, "discovery.json") }, foreignExplicitOrchestrator)?.block, true);
    assert.equal(invoke({ path: ".work-state/other.json" }, foreignExplicitOrchestrator)?.block, true);
    assert.equal(invoke({ path: join(artifactsDir, "discovery.json"), actor: "orchestrator" }, trustedRawContext)?.block, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw tool_call authenticated no-run host admission requires an empty canonical claim", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-call-no-run-"));
  try {
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const pi = {
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    };
    registerTeamWorkflow(pi as never, {
      observability: false,
      resolveCwd: () => root,
      resolveTrustedToolCallActor: () => ({ kind: "authenticated-interactive-host-no-run" }),
    });
    const toolCall = handlers.tool_call?.[0];
    assert.ok(toolCall, "configured raw tool hook is required");
    const invoke = (toolName: string, input: Record<string, unknown>): { block?: boolean; reason?: string } | undefined =>
      toolCall!({ toolName, toolCallId: `no-run-${toolName}-${randomUUID()}`, input }, {}) as { block?: boolean; reason?: string } | undefined;
    const ordinaryCalls: Array<[string, Record<string, unknown>]> = [
      ["write", { path: "src/app.ts", content: "ordinary" }],
      ["edit", { path: "src/app.ts", oldText: "ordinary", newText: "ordinary" }],
      ["bash", { command: "echo ordinary" }],
    ];
    for (const [toolName, input] of ordinaryCalls) {
      assert.equal(invoke(toolName, input), undefined, `${toolName} should reach ordinary no-run gates without a control file`);
    }

    const controlPath = join(root, ".work-state", "run-control.json");
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const writeControl = (claim: unknown): void => {
      writeFileSync(controlPath, `${JSON.stringify({
        schema: 2,
        revision: 0,
        runs: {},
        selections: {},
        execution_claim: claim,
        prepare_receipts: {},
        selection_snapshots: {},
      })}\n`);
    };
    writeControl(null);
    for (const [toolName, input] of ordinaryCalls) {
      assert.equal(invoke(toolName, input), undefined, `${toolName} should pass with canonical execution_claim null`);
    }
    const canonicalCalls: Array<[string, Record<string, unknown>]> = [
      ["write", { path: ".work-state/cto/managed/state.json", content: "direct" }],
      ["edit", { path: ".work-state/cto/managed/state.json", oldText: "direct", newText: "bypass" }],
      ["bash", { command: "printf '{}' > .work-state/cto/managed/state.json" }],
    ];
    for (const [toolName, input] of canonicalCalls) {
      const blocked = invoke(toolName, input);
      assert.equal(blocked?.block, true, `${toolName} must deny canonical CTO state without a claim`);
      assert.match(blocked?.reason ?? "", /canonical workflow state/);
    }

    const persistedClaims: Array<[string, Record<string, unknown>]> = [
      ["active", {
        run_id: randomUUID(),
        owner_kind: "workflow",
        token: "foreign-active-token",
        coordinator_session_id: "foreign-session",
        coordinator_process_id: process.pid,
        worker_ids: [],
      }],
      ["released", {
        run_id: randomUUID(),
        owner_kind: "workflow",
        token: "foreign-released-token",
        coordinator_session_id: "foreign-session",
        coordinator_process_id: process.pid,
        worker_ids: [],
        released_at: new Date().toISOString(),
      }],
      ["other-owner", {
        run_id: "foreign-cto-owner",
        owner_kind: "cto",
        token: "foreign-cto-token",
        coordinator_session_id: "foreign-cto-session",
        coordinator_process_id: process.pid,
        worker_ids: [],
      }],
    ];
    for (const [label, claim] of persistedClaims) {
      writeControl(claim);
      for (const [toolName, input] of ordinaryCalls) {
        assert.equal(invoke(toolName, input)?.block, true, `${label} execution claim must block ${toolName}`);
      }
    }

    writeFileSync(controlPath, "{corrupt canonical control\n");
    assert.equal(invoke("bash", { command: "echo ordinary" })?.block, true, "corrupt canonical control must fail closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw tool_call blocks authority-sensitive writes when session resolution throws", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-call-resolution-failure-"));
  try {
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const pi = {
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    };
    const throwingController = {
      selectedRunId(): never {
        throw new Error("selected run unavailable");
      },
    };
    registerTeamWorkflow(pi as never, {
      observability: false,
      resolveCwd: () => root,
      getSessionController: () => throwingController as never,
      resolveTrustedToolCallActor: () => ({ kind: "authenticated-interactive-host-no-run" }),
    });
    const toolCall = handlers.tool_call?.[0];
    assert.ok(toolCall, "configured raw tool hook is required");
    const invoke = (toolName: string, input: Record<string, unknown>): { block?: boolean; reason?: string } | undefined =>
      toolCall!({ toolName, toolCallId: `resolution-failure-${toolName}-${randomUUID()}`, input }, {}) as { block?: boolean; reason?: string } | undefined;
    const ordinaryCalls: Array<[string, Record<string, unknown>]> = [
      ["write", { path: "src/app.ts", content: "ordinary" }],
      ["edit", { path: "src/app.ts", oldText: "ordinary", newText: "ordinary" }],
      ["bash", { command: "echo ordinary" }],
    ];
    for (const [toolName, input] of ordinaryCalls) {
      let result: { block?: boolean; reason?: string } | undefined;
      assert.doesNotThrow(() => {
        result = invoke(toolName, input);
      }, `${toolName} must not throw when session resolution fails`);
      assert.equal(result?.block, true, `${toolName} must fail closed when session resolution fails`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw tool_call no-run resolution is ignored for a selected run", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-tool-call-no-run-selected-"));
  try {
    const runId = writeWorkflowState(root, { policy: { strict_orchestrator: true } });
    const artifactsDir = runTarget(root, runId).artifactsDir!;
    const controller = selectedController(root);
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const pi = {
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    };
    registerTeamWorkflow(pi as never, {
      observability: false,
      resolveCwd: () => root,
      getSessionController: () => controller,
      resolveTrustedToolCallActor: () => ({ kind: "authenticated-interactive-host-no-run" }),
    });
    const toolCall = handlers.tool_call?.[0];
    assert.ok(toolCall, "configured raw tool hook is required");
    const invoke = (input: Record<string, unknown>): { block?: boolean; reason?: string } | undefined =>
      toolCall!({ toolName: "write", toolCallId: `selected-no-run-${randomUUID()}`, input }, {}) as { block?: boolean; reason?: string } | undefined;

    assert.equal(invoke({ path: "src/app.ts", content: "selected" })?.block, true, "selected source writes retain host admission denial");
    assert.equal(
      invoke({ path: join(artifactsDir, "discovery.json"), content: "{}" })?.block,
      true,
      "selected artifact writes retain proof-required denial",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy permits git publication and PR control-plane commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-git-policy-"));
  try {
    const runId = writeWorkflowState(root, { policy: { strict_orchestrator: true } });
    const hostContext = { cwd: root, run_id: runId, hasUI: true };
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const allowed = [
      'git status --short && git add src/app.ts && git commit -m "fix: publish worker changes" && git fetch origin main && git rebase origin/main && git push origin HEAD && gh pr create --fill',
      "git checkout main && git pull origin main && git checkout -b feat/example",
      "git checkout main",
      "git checkout -b feat/example",
      "git switch main",
      "git switch -c feat/example",
      "git fetch origin main",
      "git pull --rebase origin main",
      "git rebase origin/main",
      "git rebase --continue",
      "git merge --no-edit feature/worker",
      "git merge --abort",
      "git cherry-pick abc123",
      "git cherry-pick --abort",
      "git push origin HEAD",
      "gh pr create --fill",
    ];
    for (const command of allowed) {
      assert.equal(
        orchestratorWriteGate({ toolName: "bash", input: { command } }, hostContext),
        undefined,
        `control-plane command should be allowed: ${command}`,
      );
    }
    const blocked = [
      "git checkout -- src/app.ts",
      "git checkout HEAD -- src/app.ts",
      "git checkout src/app.ts",
      "git checkout -f main",
      "git checkout .",
      "git switch --discard-changes main",
      "git restore src/app.ts",
      "git reset --hard HEAD",
      "git clean -fd",
      "git stash push -m temp",
    ];
    for (const command of blocked) {
      assert.equal(
        orchestratorWriteGate({ toolName: "bash", input: { command } }, hostContext)?.block,
        true,
        `direct worktree mutation should remain blocked: ${command}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy parses edit patches and allows read-only artifact validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-patch-policy-"));
  try {
    const runId = writeWorkflowState(root, { policy: { strict_orchestrator: true } });
    const artifactDir = `.work-state/runs/${runId}/artifacts`;
    const canonicalStatePath = `.work-state/runs/${runId}/state.json`;
    const hostContext = { cwd: root, run_id: runId, hasUI: true };
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const sourcePatch = [
      "[packages/e2e/src/server.ts#064B]",
      "PUT 1.=1:",
      "+export const server = true;",
    ].join("\n");
    assert.equal(
      orchestratorWriteGate({ toolName: "edit", input: { input: sourcePatch } }, { ...hostContext, hasUI: false }),
      undefined,
      "a worker edit patch with a file header is a verifiable source path",
    );
    assert.equal(
      orchestratorWriteGate({ toolName: "edit", input: sourcePatch }, { ...hostContext, hasUI: false }),
      undefined,
      "a worker edit patch passed as the raw tool input is a verifiable source path",
    );
    const canonicalPatch = [
      `[${canonicalStatePath}#064B]`,
      "PUT 1.=1:",
      "+{}",
    ].join("\n");
    const blockedCanonicalPatch = orchestratorWriteGate(
      { toolName: "edit", input: { input: canonicalPatch } },
      hostContext,
    );
    assert.equal(blockedCanonicalPatch?.block, true);
    assert.match(blockedCanonicalPatch?.reason ?? "", /canonical workflow state/);
    const blockedHeaderlessPatch = orchestratorWriteGate(
      { toolName: "edit", input: { input: "PUT 1.=1:\n+not a file patch" } },
      hostContext,
    );
    assert.equal(blockedHeaderlessPatch?.block, true);
    assert.match(blockedHeaderlessPatch?.reason ?? "", /no verifiable path/);

    const pythonReadOnlyValidation =
      `/usr/bin/python3 -m json.tool ${artifactDir}/spec_intake_repo_map-analyst.json > /dev/null`;
    const pythonJsonReadOnlyValidation =
      `python3 -c 'import glob,json; [json.load(open(path)) for path in glob.glob("${artifactDir}/*.json")]'`;
    const nodeReadOnlyValidation =
      `node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync("${artifactDir}/spec_requirements_edge_cases.json", "utf8")); const valid=[value].every((item) => item !== null);'`;
    const nodeGlobReadOnlyValidation =
      `node -e 'const fs=require("node:fs"); const values=fs.globSync("${artifactDir}/*.json").map((path) => JSON.parse(fs.readFileSync(path, "utf8")));'`;
    for (const command of [pythonReadOnlyValidation, pythonJsonReadOnlyValidation, nodeReadOnlyValidation, nodeGlobReadOnlyValidation]) {
      assert.equal(
        orchestratorWriteGate({ toolName: "bash", input: { command } }, hostContext),
        undefined,
        "read-only artifact validation must remain allowed: " + command,
      );
    }
    for (const command of [
      `printf '{}' > ${canonicalStatePath}`,
      `printf '{}' | tee ${canonicalStatePath}`,
      `cd .work-state/runs/${runId} && printf '{}' > state.json`,
    ]) {
      const blocked = orchestratorWriteGate({ toolName: "bash", input: { command } }, hostContext);
      assert.equal(blocked?.block, true, "canonical workflow write must remain blocked: " + command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict durable transitions fail closed when no active git branch exists", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-no-git-"));
  try {
    const runId = writeWorkflowState(root, {
      branch: "feature/no-git",
      classification: { workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
    });
    const begun = beginCapability(root, undefined, { runId });
    assert.match(begun.error, /stale for the active branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("DoD gate: malformed and legacy artifacts fail closed while typed evidence passes", () => {
  const valid = validateTypedDoD({
    items: [{ criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
  });
  assert.equal(valid.ok, true);
  assert.equal(validateTypedDoD({ items: ["criterion"] }).ok, false);
  assert.equal(validateTypedDoD({ criteria: ["legacy"] }).ok, false);
  assert.equal(validateTypedDoD({ items: [{ criterion: "criterion", status: "met" }] }).ok, false);

  const root = mkdtempSync(join(tmpdir(), "dod-typed-backstop-"));
  try {
    const runId = writeWorkflowState(root, {
      stage_cursor: "summary",
      pause: { kind: "done" },
      classification: { workflow: "lightweight" },
    });
    const dodPath = join(runTarget(root, runId).artifactsDir!, "dod.json");

    writeFileSync(dodPath, JSON.stringify({ items: [{ criterion: "criterion", status: "met", evidence: "observed pass" }] }));
    const malformed = dodBackstop({}, { cwd: root, run_id: runId });
    assert.equal(malformed?.decision, "block");
    assert.match(malformed?.reason ?? "", /malformed typed artifact/);

    writeFileSync(dodPath, JSON.stringify({
      items: [{ criterion: "criterion", verify_method: "run the focused check", status: "pending" }],
    }));
    const pending = dodBackstop({}, { cwd: root, run_id: runId });
    assert.equal(pending?.decision, "block");
    assert.match(pending?.reason ?? "", /unmet or evidence-less/);

    writeFileSync(dodPath, JSON.stringify({
      items: [{ criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
    }));
    assert.deepEqual(dodBackstop({}, { cwd: root, run_id: runId }), { continue: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DoD gate: active, pending, waiting, polling, and temporary artifact states are neutral", () => {
  const root = mkdtempSync(join(tmpdir(), "dod-neutral-runtime-"));
  try {
    const runId = writeWorkflowState(root, {
      stage_cursor: "summary",
      pause: { kind: "done" },
      classification: { workflow: "lightweight" },
    });
    const statePath = runTarget(root, runId).statePath!;
    const transientStates: Record<string, unknown>[] = [
      { worker: { status: "active" } },
      { worker_status: "pending" },
      { pause: { kind: "Still Running" } },
      { wait: { kind: "nested wait" } },
      { polling: { status: "polling" } },
      { artifact_status: "temporary artifact absence" },
    ];
    for (const transient of transientStates) {
      writeFileSync(statePath, JSON.stringify({
        stage_cursor: "summary",
        pause: { kind: "done" },
        classification: { workflow: "lightweight" },
        ...transient,
      }));
      assert.equal(dodBackstop({}, { cwd: root, run_id: runId }), undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("dispatch gate requires the exact active cursor stage and roster", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cursor-"));
  try {
    const branch = "feat/test";
    initGit(root, branch);
    const profile = loadProfile("lightweight");
    assert.ok(profile, "lightweight profile must be available for strict dispatch fixture");
    const persistedProfileHash = profileHash(profile);
    const runId = writeWorkflowState(root, {
      branch,
      scope: { scope: ["backend-kotlin"], dev_agent: "developer-kotlin" },
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
      profile_hash: persistedProfileHash,
    });
    const capability = createCapability({
      run_key: runId, branch, workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    const discovery = JSON.stringify({ findings: ["dispatch fixture"] });
    writeRequiredArtifact(root, "discovery", JSON.parse(discovery));
    writeWorkflowState(root, {
      run_id: runId,
      branch,
      scope: { scope: ["backend-kotlin"], dev_agent: "developer-kotlin" },
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
      cursor_epoch: capability.state.issued_for?.cursor_epoch,
      profile_hash: persistedProfileHash,
      dispatch_capability: capability.state,
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      required_input_receipts: {
        implementation: {
          stage_id: "implementation",
          capability_id: capability.state.capability_id,
          cursor_epoch: capability.state.issued_for?.cursor_epoch,
          rework_generation: 0,
          inputs: [{ artifact_id: "discovery", path: "discovery.json", sha256: createHash("sha256").update(discovery).digest("hex") }],
        },
      },
    });
    writeRequiredArtifact(root, "discovery", JSON.parse(discovery));
    const controller = selectedController(root, branch);
    const { dispatchGate } = await import("../src/gates/dispatch.ts");
    const marker = (stage: string, roles: string, agent = "developer-kotlin") => ({
      toolName: "task",
      input: { agent, role: agent, task: `<!-- omp-dispatch run=${runId} stage=${stage} kind=single cursor=${capability.state.issued_for?.cursor_epoch} roles=${roles} -->` },
    });
    const missing = dispatchGate({ toolName: "task", input: { agent: "developer-kotlin", task: "Implement the stage without a marker" } }, { cwd: root, controller });
    assert.equal(missing?.block, true, "missing structured marker must fail closed");
    const malformed = dispatchGate(marker("implementation", "developer-kotlin", "backend-kotlin"), { cwd: root, controller });
    assert.equal(malformed?.block, true, "malformed structured marker must fail closed");
    const wrong = dispatchGate(marker("discovery", "analyst"), { cwd: root, controller });
    assert.equal(wrong?.block, true);
    const right = dispatchGate(marker("implementation", "developer-kotlin"), { cwd: root, controller });
    assert.equal(right, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch markers bind to the persisted cursor epoch", () => {
  const stage = { id: "implementation", title: "Implementation", type: "single" as const, role: "go" };
  const marker = buildDispatchMarker("run-1", stage, ["go"], "go", "epoch-1");
  assert.equal(parseDispatchMarker(marker)?.cursor, "epoch-1");
});

test("strict runtime issues opaque capabilities and reconciles native task results", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-runtime-"));
  try {
    initGit(root, "feature/capability");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const runId = writeWorkflowState(root, {
      branch: "feature/capability",
      task: "capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: { discovery: "discovery.json" },
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });
    publishMapping(root, { "developer-kotlin": "developer-kotlin" });
    writeRequiredArtifact(root, "discovery", { task: "capability test", branch: "feature/capability" });
    const begun = beginCapability(root, undefined, { runId });
    assert.equal(begun.ok, true, begun.ok ? undefined : begun.error);
    if (!begun.ok || !begun.handoff) return;
    const handoff = begun.handoff;
    const fullProfileHash = profileHash(profile);
    const expectedFingerprint = `${fullProfileHash.slice(0, 30)}${fullProfileHash.slice(-2)}`;
    assert.notEqual(expectedFingerprint, fullProfileHash);
    assert.equal(handoff.profile_hash, expectedFingerprint);
    const wrongProfileHash = `${handoff.profile_hash.slice(0, -1)}${handoff.profile_hash.endsWith("0") ? "1" : "0"}`;
    const wrongBinding = authorizeDispatch(root, {
      run_id: runId,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: wrongProfileHash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      loop_iteration: handoff.loop_iteration,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    });
    assert.equal(wrongBinding.ok, false);
    if (wrongBinding.ok) return;
    const persisted = readFileSync(runTarget(root, runId).statePath!, "utf8");
    assert.doesNotMatch(persisted, new RegExp(handoff.dispatch_token));
    assert.doesNotMatch(persisted, new RegExp(handoff.advance_token));

    const stage = profile.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const controller = selectedController(root, "feature/capability");
    const marker = buildDispatchMarker(handoff.run_key, stage, ["developer-kotlin"], "developer-kotlin", handoff.cursor_epoch);
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-1",
      input: { agent: "developer-kotlin", role: "developer-kotlin", task: marker },
    }, { cwd: root, session_id: trustedContext(root, "feature/capability").session_id, controller });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(request.requests.length, 1);
    const preauthorized = authorizeDispatch(root, {
      run_id: runId,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      loop_iteration: handoff.loop_iteration,
      role: "developer-kotlin",
      token: handoff.dispatch_token,
      origin_session_id: trustedContext(root, "feature/capability").session_id,
    });
    assert.equal(preauthorized.ok, true);
    const authorized = authorizeDispatchTrusted(root, request.requests[0]!);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const duplicateAuthorization = authorizeDispatchTrusted(root, request.requests[0]!);
    assert.equal(duplicateAuthorization.ok, true);
    if (!duplicateAuthorization.ok || !duplicateAuthorization.record) return;
    assert.equal(duplicateAuthorization.record.id, authorized.record.id);

    const reconciled = reconcileTrustedTaskResult(root, {
      run_id: runId,
      tool_call_id: "tool-1",
      outcome: "succeeded",
      evidence: "native task result",
    });
    const artifactsDir = runTarget(root, runId).artifactsDir!;
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "result.json"), "{}");
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "capability test", branch: "feature/capability" }));
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({
      ready: true,
      validation_run: true,
      validation_evidence: "focused durable capability test",
      files_touched: ["src/main.ts"],
    }));
    const replay = completeDispatch(root, {
      token: handoff.dispatch_token,
      run_id: runId,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      loop_iteration: handoff.loop_iteration,
      role: "developer-kotlin",
      agent: "developer-kotlin",
      tool_call_id: "tool-1",
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "explicit workflow evidence",
      artifact_ids: ["result"],
    }, { runId });
    assert.equal(replay.ok, true, JSON.stringify(replay));

    // Checkpoint permission is a separate typed transition. Legacy
    // mode/autonomous prose is migration input and cannot authorize advance.
    recordTypedCheckpoint(root, "implementation", "approve_implementation");
    assert.equal(selectedState(root).typed_checkpoint_decisions?.length, 1);

    const advanced = advanceCursor(root, {
      token: handoff.advance_token,
      run_id: runId,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      loop_iteration: handoff.loop_iteration,
      evidence: "implementation completed",
    }, { runId });
    assert.equal(advanced.ok, true, advanced.ok ? undefined : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.equal(advanced.handoff?.expected_roster[0]?.role, "code-reviewer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("beginCapability reissues secrets for an active dispatch without losing its record", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-resume-"));
  try {
    const branch = "feature/resume-capability";
    initGit(root, branch);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const runId = writeWorkflowState(root, {
      branch,
      task: "resume capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: { discovery: "discovery.json" },
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });
    publishMapping(root, { "developer-kotlin": "developer-kotlin" });
    writeRequiredArtifact(root, "discovery", { task: "resume capability test", branch });

    const first = beginCapability(root, undefined, { runId });
    assert.equal(first.ok, true);
    if (!first.ok || !first.handoff) return;
    const auth = {
      run_id: runId,
      token: first.handoff.dispatch_token,
      capability_id: first.handoff.capability_id,
      run_key: first.handoff.run_key,
      branch: first.handoff.branch,
      workflow: first.handoff.workflow,
      profile_hash: first.handoff.profile_hash,
      stage_cursor: first.handoff.stage_cursor,
      cursor_epoch: first.handoff.cursor_epoch,
      loop_iteration: first.handoff.loop_iteration,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;

    const resumed = beginCapability(root, undefined, { runId });
    assert.equal(resumed.ok, true);
    if (!resumed.ok || !resumed.handoff) return;
    assert.equal(resumed.handoff.capability_id, first.handoff.capability_id);
    assert.notEqual(resumed.handoff.dispatch_token, first.handoff.dispatch_token);
    assert.equal(resumed.state.dispatch_capability?.dispatches[0]?.id, authorized.record.id);

    const stale = completeDispatch(root, {
      ...auth,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "stale handoff must be rejected",
    }, { runId });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "invalid secret");

    const recovered = completeDispatch(root, {
      ...auth,
      token: resumed.handoff.dispatch_token,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "resumed handoff completed the dispatch",
    }, { runId });
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native task hook leaves spawned and scheduled results pending", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-async-"));
  try {
    const branch = "feature/async-capability";
    initGit(root, branch);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const runId = writeWorkflowState(root, {
      branch,
      task: "async capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      profile_hash: profileHash(profile),
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: { discovery: "discovery.json" },
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });
    publishMapping(root, { "developer-kotlin": "developer-kotlin" });
    writeRequiredArtifact(root, "discovery", { task: "async capability test", branch });
    const controller = preparedController(root, branch);
    const begun = beginCapability(root, undefined, { runId });
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const stage = profile.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["developer-kotlin"], "developer-kotlin", begun.handoff.cursor_epoch);
    const taskInput = { agent: "developer-kotlin", role: "developer-kotlin", task: marker };
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    registerTeamWorkflow({
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    } as never, {
      observability: false,
      getSessionController: (_ctx, cwd) => cwd === root ? controller : undefined,
    });
    const invoke = (name: string, event: unknown): unknown[] => {
      const registered = handlers[name] ?? [];
      assert.ok(registered.length > 0, `expected ${name} handler registration`);
      return registered.map((handler) => handler(event, { cwd: root, hasUI: false, session_id: trustedContext(root, branch).session_id }));
    };
    const allowed = invoke("tool_call", {
      toolName: "task",
      toolCallId: "tool-async",
      input: taskInput,
    });
    assertAllowedToolHook(allowed, "async initial tool call");
    const onToolResults = handlers.tool_result ?? [];
    assert.ok(onToolResults.length > 0);
    const malformedMigrationResults: unknown[] = [
      { completion_envelope: { completed_by: "migration", identity: { source: "migration" } } },
      { results: [{ index: 0, exitCode: 0, completed_by: "migration", terminal_signal: "migration_verified", output: "x" }] },
      { results: [{ index: 0, exitCode: 0, work_identity: { source: "migration" }, output: "x" }] },
    ];
    for (const details of malformedMigrationResults) {
      const beforeMigrationProtocol = readFileSync(runTarget(root, runId).statePath!, "utf8");
      const event = {
        toolName: "task",
        toolCallId: "tool-async",
        input: taskInput,
        content: [],
        isError: false,
        details,
      };
      for (const handler of onToolResults) handler(event, { cwd: root, session_id: trustedContext(root, branch).session_id });
      assert.equal(
        readFileSync(runTarget(root, runId).statePath!, "utf8"),
        beforeMigrationProtocol,
        "migration provenance in reserved native result fields must not mutate the live dispatch",
      );
      const unchanged = selectedState(root).dispatch_capability?.dispatches[0];
      assert.equal(unchanged?.status, "authorized");
      assert.equal(unchanged?.completion, undefined);
    }

    const preProviderRepeat = invoke("tool_call", {
      toolName: "task",
      toolCallId: "tool-async",
      input: taskInput,
    });
    assertAllowedToolHook(preProviderRepeat, "async same-ID pre-provider repeat");


    for (const state of ["spawned", "scheduled"]) {
      const event = {
        toolName: "task",
        toolCallId: "tool-async",
        input: taskInput,
        content: [],
        isError: false,
        details: { async: { state } },
      };
      for (const handler of onToolResults) handler(event, { cwd: root, session_id: trustedContext(root, branch).session_id });
    }
    const persisted = selectedState(root);
    assert.equal(persisted.dispatch_capability?.dispatches[0]?.status, "pending");
    assert.equal(persisted.dispatch_capability?.dispatches[0]?.pending?.pending_reason, "awaiting_result");
    assert.equal(persisted.dispatch_capability?.dispatches[0]?.pending?.provider_ref, "tool-async");
    assert.equal(persisted.dispatch_capability?.dispatches[0]?.completion, undefined);
    const beforeRetry = JSON.stringify(persisted.dispatch_capability?.dispatches);
    const sameIdRetry = invoke("tool_call", {
      toolName: "task",
      toolCallId: "tool-async",
      input: taskInput,
    });
    assert.ok(
      sameIdRetry.some((result) => result && typeof result === "object" && "block" in result && result.block === true),
      "pending async work cannot be physically redispatched under the original tool call ID",
    );
    assert.equal(JSON.stringify(selectedState(root).dispatch_capability?.dispatches), beforeRetry, "blocked same-ID async redispatch is non-mutating");
    const retry = invoke("tool_call", {
      toolName: "task",
      toolCallId: "tool-async-retry",
      input: taskInput,
    });
    assert.ok(retry.some((result) => result && typeof result === "object" && "block" in result && result.block === true), "pending async work cannot be physically redispatched");
    assert.equal(JSON.stringify(selectedState(root).dispatch_capability?.dispatches), beforeRetry, "blocked async redispatch is non-mutating");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native task result reconciles its immutable origin after the manager moves to another worktree", () => {
  const rootA = mkdtempSync(join(tmpdir(), "dispatch-origin-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "dispatch-origin-b-"));
  try {
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const seed = (root: string, branch: string, task: string) => {
      initGit(root, branch);
      const runId = writeWorkflowState(root, {
        branch,
        task,
        classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
        profile_hash: profileHash(profile),
        stage_cursor: "implementation",
        stages: profile.stages.map((stage) => ({
          id: stage.id,
          status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
        })),
        artifacts: { discovery: "discovery.json" },
        required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
        scope: { scope: ["backend-kotlin"], dev_agent: "developer-kotlin" },
        policy: { strict_orchestrator: true },
        pause: { kind: "none", reason: "" },
      });
      publishMapping(root, { "developer-kotlin": "developer-kotlin" });
      writeRequiredArtifact(root, "discovery", { task, branch });
      const controller = preparedController(root, branch);
      const begun = beginCapability(root, undefined, { runId });
      assert.equal(begun.ok, true);
      const stage = profile.stages.find((candidate) => candidate.id === "implementation");
      if (!begun.ok || !begun.handoff) throw new Error(`failed to seed ${branch}`);
      const taskId = dispatchTaskId(
        begun.handoff.capability_id,
        begun.handoff.run_key,
        begun.handoff.branch,
        begun.handoff.workflow,
        begun.handoff.stage_cursor,
        "developer-kotlin",
      );
      const marker = buildDispatchMarker(
        begun.handoff.run_key,
        stage,
        ["developer-kotlin"],
        "developer-kotlin",
        begun.handoff.cursor_epoch,
        begun.handoff.capability_id,
        "developer-kotlin",
        taskId,
      );
      return {
        runId,
        handoff: begun.handoff,
        taskId,
        controller,
        sessionId: trustedContext(root, branch).session_id,
        taskInput: { agent: "developer-kotlin", role: "developer-kotlin", task: marker },
      };
    };
    const a = seed(rootA, "feature/origin-a", "origin A");
    const b = seed(rootB, "feature/origin-b", "origin B");
    const controllers = new Map([[rootA, a.controller], [rootB, b.controller]]);
    const preauthorized = authorizeDispatch(rootA, {
      run_id: a.runId,
      token: a.handoff.dispatch_token,
      capability_id: a.handoff.capability_id,
      run_key: a.handoff.run_key,
      branch: a.handoff.branch,
      workflow: a.handoff.workflow,
      profile_hash: a.handoff.profile_hash,
      stage_cursor: a.handoff.stage_cursor,
      cursor_epoch: a.handoff.cursor_epoch,
      loop_iteration: a.handoff.loop_iteration,
      role: "developer-kotlin",
      slot_id: "developer-kotlin",
      task_id: a.taskId,
      agent: "developer-kotlin",
      origin_session_id: a.sessionId,
    });
    assert.equal(preauthorized.ok, true, preauthorized.ok ? undefined : JSON.stringify({ error: preauthorized.error, handoff: a.handoff, state: selectedState(rootA) }));
    if (!preauthorized.ok || !preauthorized.record) return;
    assert.equal(preauthorized.record.tool_call_id, undefined);
    assert.equal(preauthorized.record.origin_session_id, a.sessionId);
    const beforeCrossOriginBootstrap = readFileSync(runTarget(rootA, a.runId).statePath!, "utf8");

    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    registerTeamWorkflow({
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    } as never, {
      observability: false,
      getSessionController: (_ctx, cwd) => controllers.get(cwd),
    });
    const invoke = (name: string, event: unknown, ctx: unknown): unknown[] => {
      const registered = handlers[name] ?? [];
      assert.ok(registered.length > 0, `expected ${name} handler registration`);
      return registered.map((handler) => handler(event, ctx));
    };
    const crossOriginBootstrap = invoke("tool_call", {
      toolName: "task",
      toolCallId: "cross-origin-bootstrap",
      input: a.taskInput,
    }, {
      cwd: rootA,
      hasUI: false,
      session_id: b.sessionId,
    });
    assert.ok(
      crossOriginBootstrap.some((result) => result && typeof result === "object" && "block" in result && result.block === true),
      `cross-origin preauthorization bootstrap must be blocked: ${JSON.stringify(crossOriginBootstrap)}`,
    );
    assert.equal(
      readFileSync(runTarget(rootA, a.runId).statePath!, "utf8"),
      beforeCrossOriginBootstrap,
      "cross-origin bootstrap must not replace the preauthorized work identity",
    );

    const originToolCall = {
      toolName: "task",
      toolCallId: "origin-tool",
      input: a.taskInput,
    };
    const toolCallResults = invoke("tool_call", originToolCall, {
      cwd: rootA,
      hasUI: false,
      session_id: a.sessionId,
    });
    assertAllowedToolHook(toolCallResults, "origin initial tool call");
    const rebound = selectedState(rootA).dispatch_capability?.dispatches[0];
    assert.equal(rebound?.tool_call_id, "origin-tool", "same-origin first bind records the provider call identity");
    assert.equal(rebound?.origin_session_id, a.sessionId);


    const beforeB = readFileSync(runTarget(rootB, b.runId).statePath!, "utf8");
    const lateResultContext = {
      sessionManager: { getCwd: () => rootB, getSessionId: () => b.sessionId },
      session_id: b.sessionId,
    };
    const migrationReport = JSON.stringify({ source: "migration", migration_id: "migration-root-1", status: "imported" });
    const resultEvent = {
      toolName: "task",
      toolCallId: "origin-tool",
      input: a.taskInput,
      content: [{ type: "text", text: migrationReport }],
      isError: false,
      details: {
        results: [{
          index: 0,
          id: "developer-kotlin",
          agent: "developer-kotlin",
          task: a.taskInput.task,
          exitCode: 0,
          output: migrationReport,
          stderr: "",
          error: "",
          aborted: false,
        }],
      },
    };
    invoke("tool_result", resultEvent, lateResultContext);
    const afterA = selectedState(rootA);
    assert.equal(afterA.dispatch_capability?.dispatches[0]?.status, "succeeded");
    assert.equal(afterA.dispatch_capability?.dispatches[0]?.completion?.evidence, migrationReport);
    assert.equal(readFileSync(runTarget(rootB, b.runId).statePath!, "utf8"), beforeB, "the moved manager must not mutate B");

    const afterFirstResultA = readFileSync(runTarget(rootA, a.runId).statePath!, "utf8");
    invoke("tool_result", resultEvent, lateResultContext);
    assert.equal(readFileSync(runTarget(rootA, a.runId).statePath!, "utf8"), afterFirstResultA, "replayed result must not add mutation");

    const mismatchedInput = {
      ...resultEvent,
      input: b.taskInput,
    };
    invoke("tool_result", mismatchedInput, lateResultContext);
    assert.equal(readFileSync(runTarget(rootA, a.runId).statePath!, "utf8"), afterFirstResultA, "mismatched origin input must be rejected");
    const beforeUnknown = readFileSync(runTarget(rootB, b.runId).statePath!, "utf8");
    invoke("tool_result", { ...resultEvent, toolCallId: "unknown-origin" }, lateResultContext);
    assert.equal(readFileSync(runTarget(rootB, b.runId).statePath!, "utf8"), beforeUnknown, "unknown origin must be non-mutating");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
test("trusted reconciliation preserves every dispatch in a consilium batch", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-batch-"));
  try {
    const branch = "feature/batch-capability";
    initGit(root, branch);
    const profile = loadProfile("review");
    assert.ok(profile);
    const runId = writeWorkflowState(root, {
      branch,
      task: "batch capability test",
      classification: { type: "REVIEW", complexity: "COMPLEX", confidence: "HIGH", autonomous: true, workflow: "review" },
      profile_hash: profileHash(profile),
      stage_cursor: "review",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "review" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: { discovery: "discovery.json" },
      required_inputs: { review: [{ artifact_id: "discovery", path: "discovery.json" }] },
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });
    publishMapping(root, { "code-reviewer": "code-reviewer", qa: "qa", "developer-kotlin": "developer-kotlin" });
    writeRequiredArtifact(root, "discovery", { task: "batch capability test", branch });
    const controller = preparedController(root, branch);
    const begun = beginCapability(root, undefined, { runId });
    if (!begun.ok || !begun.handoff) return;
    const markerFor = (role: string) => begun.handoff!.dispatch_markers.find((entry) => entry.role === role)?.marker ?? "";
    const taskInput = {
      tasks: [
        { role: "qa", agent: "qa", task: markerFor("qa") },
        { role: "code-reviewer", agent: "code-reviewer", task: markerFor("code-reviewer") },
      ],
    };
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    registerTeamWorkflow({
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    } as never, {
      observability: false,
      getSessionController: (_ctx, cwd) => cwd === root ? controller : undefined,
    });
    const invoke = (name: string, event: unknown): unknown[] => {
      const registered = handlers[name] ?? [];
      assert.ok(registered.length > 0, `expected ${name} handler registration`);
      return registered.map((handler) => handler(event, { cwd: root, hasUI: false, session_id: trustedContext(root, branch).session_id }));
    };
    const toolCallResults = invoke("tool_call", {
      toolName: "task",
      toolCallId: "tool-batch",
      input: taskInput,
    });
    assertAllowedToolHook(toolCallResults, "batch initial tool call");
    const failedRow = { index: 0, id: "qa", agent: "qa", task: markerFor("qa"), exitCode: 1, output: "", stderr: "qa evidence", error: "qa evidence", aborted: false };
    const succeededRow = { index: 1, id: "code-reviewer", agent: "code-reviewer", task: markerFor("code-reviewer"), exitCode: 0, output: "review evidence", stderr: "", error: "", aborted: false };
    invoke("tool_result", {
      toolName: "task",
      toolCallId: "tool-batch",
      input: taskInput,
      content: [],
      isError: false,
      details: { results: [succeededRow] },
    });
    const partialState = selectedState(root);
    assert.equal(partialState.dispatch_capability?.dispatches[0]?.status, "pending");
    assert.equal(partialState.dispatch_capability?.dispatches[0]?.pending?.pending_reason, "transport_reconnect");
    assert.equal(partialState.dispatch_capability?.dispatches[1]?.status, "succeeded");
    const retryInput = { tasks: [taskInput.tasks[0]] };
    const beforeRetryDispatches = JSON.stringify(selectedState(root).dispatch_capability?.dispatches);
    const retryResults = invoke("tool_call", {
      toolName: "task",
      toolCallId: "tool-batch-retry",
      input: retryInput,
    });
    assert.ok(
      retryResults.some((result) => result && typeof result === "object" && "block" in result && result.block === true),
      "transport-reconnect pending slots must not be redispatched under a new tool call",
    );
    assert.equal(JSON.stringify(selectedState(root).dispatch_capability?.dispatches), beforeRetryDispatches, "blocked redispatch is non-mutating");
    const resultEvent = {
      toolName: "task",
      toolCallId: "tool-batch",
      input: taskInput,
      content: [],
      isError: false,
      details: { results: [failedRow, succeededRow] },
    };
    invoke("tool_result", resultEvent);
    const reconciledState = selectedState(root);
    assert.deepEqual(
      reconciledState.dispatch_capability?.dispatches.map((dispatch) => dispatch.status),
      ["failed", "succeeded"],
    );
    assert.deepEqual(
      reconciledState.dispatch_capability?.dispatches.map((dispatch) => dispatch.completion?.evidence),
      ["qa evidence", "review evidence"],
    );
    const afterTerminal = readFileSync(runTarget(root, runId).statePath!, "utf8");
    invoke("tool_result", resultEvent);
    assert.equal(readFileSync(runTarget(root, runId).statePath!, "utf8"), afterTerminal, "replayed terminal rows are idempotent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("advance handoff resolves the next stage roster", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-handoff-"));
  try {
    const branch = "feat/handoff";
    initGit(root, branch);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const runId = writeWorkflowState(root, {
      branch,
      task: "handoff",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : stage.id === "discovery" ? "done" as const : "pending" as const })),
      artifacts: { discovery: "discovery.json", implementation: "implementation.json" },
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: { scope: ["backend-kotlin"], dev_agent: "developer-kotlin" },
      pause: { kind: "none", reason: "" },
    });
    publishMapping(root, { "developer-kotlin": "developer-kotlin" });
    writeRequiredArtifact(root, "discovery", { task: "handoff", branch });
    const begun = beginCapability(root, undefined, { runId });
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const issued = begun.handoff;
    writeRequiredArtifact(root, "implementation", {
      ready: true,
      validation_run: true,
      validation_evidence: "focused handoff test",
      files_touched: ["src/main.ts"],
    });
    const authInput = {
      run_id: runId,
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: runId,
      branch,
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      cursor_epoch: issued.cursor_epoch,
      loop_iteration: issued.loop_iteration,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, authInput);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const completed = completeDispatch(root, {
      ...authInput,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "task completed",
    }, { runId });
    assert.equal(completed.ok, true);
    recordTypedCheckpoint(root, "implementation", "approve_implementation");
    assert.equal(selectedState(root).typed_checkpoint_decisions?.length, 1);
    const advanced = advanceCursor(root, {
      ...authInput,
      token: issued.advance_token,
      evidence: "stage completed",
    }, { runId });
    assert.equal(advanced.ok, true, advanced.ok ? undefined : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.deepEqual(advanced.state.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }]);
    assert.equal(advanced.state.dispatch_capability?.kind, "single");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow contract supports an explicit stateless profile lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-stateless-"));
  try {
    const contract = resolveWorkflowContract(root, { requireState: false, workflow: "lightweight", branch: "main" });
    assert.equal(contract.state.path, null);
    assert.equal(contract.state.artifactsDir, null);
    assert.equal(contract.provenance.statePath, null);
    assert.equal(contract.stage.id, "discovery");
    assert.equal(contract.stage.artifact_schemas.discovery?.type, "object");
    assert.deepEqual(contract.stage.artifact_schemas.discovery?.required, ["task", "branch"]);
    assert.equal(contract.stage.artifact_schemas.dod?.properties?.items?.items?.type, "object");
    assert.deepEqual(contract.stage.artifact_schemas.dod?.properties?.items?.items?.required, ["criterion", "verify_method", "status"]);
    assert.equal(contract.state.dispatch.allowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow contract exposes the canonical run artifact directory", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-run-artifacts-"));
  try {
    const branch = "fix/artifact-path";
    initGit(root, branch);
    const prepared = prepareWorkflowState({
      task: "fix artifact path",
      cwd: root,
      branch,
      autonomous: true,
      mode: "new",
      request_id: "artifact-path-new",
      execution: trustedContext(root, branch),
      classification: {
        type: "BUG_FIX",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: true,
        workflow: "debug-cycle",
      },
      files: [],
      issue: null,
    });
    const runId = prepared.state.run_id!;
    const contract = resolveWorkflowContract(root, { branch, runId });
    const expectedArtifactsDir = join(root, ".work-state", "runs", runId, "artifacts");

    assert.equal(prepared.artifactsDir, expectedArtifactsDir);
    assert.equal(contract.state.artifactsDir, expectedArtifactsDir);
    assert.equal(contract.state.path, prepared.statePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_instructions preserves typed recovery details from contract resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-instructions-recovery-details-"));
  try {
    writeImplementationState(root);
    const runId = activeRunId(root);
    const target = runTarget(root, runId);
    const state = JSON.parse(readFileSync(target.statePath!, "utf8")) as Record<string, unknown>;
    state.required_inputs = {
      implementation: [{ artifact_id: "missing", path: "missing.json" }],
    };
    writeFileSync(target.statePath!, JSON.stringify(state));
    const instructions = registeredWorkflowTools(root).get("workflow_instructions");
    assert.ok(instructions);
    const response = await instructions.execute(
      "workflow-instructions-recovery-details",
      {},
      undefined,
      undefined,
      { cwd: root, hasUI: true, session_id: trustedContext(root).session_id } as never,
    );
    const details = response.details as { code?: string; details?: { code?: string; error?: string } };
    assert.equal(details.code, "WORKFLOW_RESOLUTION_FAILED");
    assert.equal(details.details?.code, "RECOVERY_REQUIRED");
    assert.match(details.details?.error ?? "", /recovery_required/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
