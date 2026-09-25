import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  dispatchGate,
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
  prepareWorkflowState,
  runTarget,
  registerWorkflowTools as registerCoreWorkflowTools,
  type IssuedCapability,
} from "@andvl1/omp-workflows-core";
import {
  FULLSTACK_BUNDLE_ID,
  fullstackOwnerForCwd,
  fullstackPreset,
  isMainSessionContext,
  registerWorkflowTools,
  resolveSessionCwd,
  default as ompWorkflowsFullstack,
} from "../src/index.js";
import { registerLectureAcquireTool } from "../src/tools/lecture-acquire.js";

class TestBus {
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  on(channel: string, listener: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set<(value: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  }

  emit(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(value);
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

type SessionManagerFixture = {
  getCwd: () => string;
  getSessionId: () => string;
  getSessionFile: () => string;
  getHeader: () => { type: "session"; id: string; cwd: string; timestamp: string };
};

const sessionManagerFixtures = new Map<string, SessionManagerFixture>();

function sessionManagerFor(cwd: string, sessionId: string): SessionManagerFixture {
  const key = `${cwd}\u0000${sessionId}`;
  const existing = sessionManagerFixtures.get(key);
  if (existing) return existing;
  const manager: SessionManagerFixture = {
    getCwd: () => cwd,
    getSessionId: () => sessionId,
    getSessionFile: () => join(cwd, ".omp", "sessions", `${sessionId}.jsonl`),
    getHeader: () => ({
      type: "session",
      id: sessionId,
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  };
  sessionManagerFixtures.set(key, manager);
  return manager;
}
type MutableSessionManagerFixture = SessionManagerFixture & { switchTo: (sessionId: string) => void };

function mutableSessionManagerFor(cwd: string, initialSessionId: string): MutableSessionManagerFixture {
  let sessionId = initialSessionId;
  return {
    getCwd: () => cwd,
    getSessionId: () => sessionId,
    getSessionFile: () => join(cwd, ".omp", "sessions", `${sessionId}.jsonl`),
    getHeader: () => ({
      type: "session",
      id: sessionId,
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    switchTo: (nextSessionId: string) => { sessionId = nextSessionId; },
  };
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
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    publishMapping(root);
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const hostContext = {
      cwd: root,
      hasUI: true,
      mode: "tui",
      session_id: "session-direct",
      sessionManager: sessionManagerFor(root, "session-direct"),
    };
    const prepare = tools.get("workflow_prepare")!;
    const preparedResponse = await prepare.execute(
      "marker-fixture-prepare",
      {
        mode: "new",
        task: "consilium marker regression",
        branch: "main",
        classification: { type: "SPEC", complexity: "COMPLEX", confidence: "HIGH", autonomous: true, workflow: "spec-preparation" },
      },
      undefined,
      undefined,
      hostContext as never,
    );
    const preparedDetails = preparedResponse.details as {
      ok?: boolean;
      error?: string;
      state?: { run_id?: string };
      artifacts_dir?: string;
    };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    const preparedRunId = preparedDetails.state?.run_id;
    if (!preparedRunId) throw new Error("marker fixture preparation did not select a canonical run");
    const artifactsDir = preparedDetails.artifacts_dir ?? runTarget(root, preparedRunId).artifactsDir;
    if (!artifactsDir) throw new Error("marker fixture artifacts directory is unavailable");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "product_spec.json"), JSON.stringify({
      recommendation: "proceed",
      value_proposition: "make the specification handoff traceable",
      opportunity: "the workflow needs durable product context",
      target_users: ["workflow maintainers"],
      solution_direction: "persist the approved product direction as canonical JSON",
      success_metrics: ["handoff preserves product context"],
      guardrail_metrics: ["no product context is silently dropped"],
      scope: ["canonical product context"],
      anti_scope: ["application implementation"],
      risks: ["fixture context may become stale"],
      validation_plan: ["verify canonical artifact consumption"],
      evidence_trace: [],
      open_decisions: [],
    }) + "\n");

    const begin = tools.get("workflow_begin")!;
    const response = await begin.execute("marker-fixture-begin", {}, undefined, undefined, hostContext as never);
    const details = response.details as {
      ok?: boolean;
      error?: string;
      handoff?: {
        run_key: string;
        stage_cursor: string;
        cursor_epoch: string;
        dispatch_markers?: Array<{ role: string; agent: string; marker: string }>;
      };
    };
    assert.equal(details.ok, true, details.error);
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
      assert.match(marker.marker, new RegExp(`<!-- omp-dispatch run=${details.handoff?.run_key} stage=intake_repo_map kind=consilium`));
      assert.match(marker.marker, new RegExp(`cursor=${details.handoff?.cursor_epoch}`));
      assert.match(marker.marker, new RegExp(`role=${marker.role}`));
    }
    const instructions = tools.get("workflow_instructions")!;
    const instructionResponse = await instructions.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
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
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_instructions exposes declared artifact schemas", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-artifact-schemas-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const prepared = prepareWorkflowState({
      cwd: root,
      branch: "main",
      task: "artifact schema fixture",
      autonomous: false,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      mode: "new",
      execution: {
        session_id: "session-direct",
        caller: "host",
        process_id: process.pid,
        worktree: root,
        branch: "main",
        authority: "coordinator",
      },
    });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const instructions = tools.get("workflow_instructions")!;
    const response = await instructions.execute("test", { selector: { run_id: prepared.state.run_id } }, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
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
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: workflow_status exposes completion artifact bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-status-artifacts-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const issued = await writeCheckpointAskFixture(root, tools);
    const binding = issued.state.issued_for!;
    const rosterEntry = issued.state.expected_roster?.[0];
    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_id: binding.run_key,
      run_key: binding.run_key,
      branch: binding.branch,
      workflow: binding.workflow,
      profile_hash: binding.profile_hash,
      stage_cursor: binding.stage_cursor,
      cursor_epoch: binding.cursor_epoch,
      loop_iteration: binding.loop_iteration,
      role: rosterEntry?.role ?? "developer-kotlin",
      agent: rosterEntry?.agent ?? "developer-kotlin",
      tool_call_id: "tool-status-artifact",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    assert.ok(authorized.ok && authorized.record);
    const artifactsDir = runTarget(root, issued.state.issued_for!.run_key).artifactsDir!;
    mkdirSync(artifactsDir, { recursive: true });
    const statusStatePath = runTarget(root, issued.state.issued_for!.run_key).statePath!;
    const statusState = JSON.parse(readFileSync(statusStatePath, "utf8")) as { artifacts?: Record<string, string> };
    statusState.artifacts = { ...(statusState.artifacts ?? {}), implementation: "implementation.json" };
    writeFileSync(statusStatePath, `${JSON.stringify(statusState)}\n`);
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({
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
    }, { runId: issued.state.issued_for!.run_key });
    assert.equal(completed.ok, true, completed.ok ? undefined : completed.error);
    const status = tools.get("workflow_status")!;
    const response = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
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
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
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

test("fullstack: workflow_prepare rejects a contradictory explicit cwd before mutating canonical state", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-prepare-stale-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
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
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: canonical, ui: {} });

    const prepare = tools.get("workflow_prepare")!;
    const prepareInput = {
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
    };
    const workflowStateSnapshot = (cwd: string) => {
      const workStateRoot = join(cwd, ".work-state");
      const controlPath = join(workStateRoot, "run-control.json");
      const controlExists = existsSync(controlPath);
      return {
        rootExists: existsSync(workStateRoot),
        runsExists: existsSync(join(workStateRoot, "runs")),
        controlExists,
        controlRaw: controlExists ? readFileSync(controlPath, "utf8") : null,
      };
    };
    const canonicalBefore = workflowStateSnapshot(canonical);
    const staleBefore = workflowStateSnapshot(stale);

    const rejected = await prepare.execute(
      "stale-context",
      prepareInput,
      undefined,
      undefined,
      { cwd: stale, sessionManager: sessionManagerFor(canonical, "session-direct"), mode: "tui", session_id: "session-direct", hasUI: true } as never,
    );
    const rejectedDetails = rejected.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(rejectedDetails.ok, false);
    assert.equal(rejectedDetails.code, "WORKFLOW_CONTEXT_REJECTED", rejectedDetails.error);
    assert.deepEqual(workflowStateSnapshot(canonical), canonicalBefore, "a contradictory context must not mutate canonical workflow state");
    assert.deepEqual(workflowStateSnapshot(stale), staleBefore, "a contradictory context must not write workflow state under the stale cwd");
    assert.equal(
      existsSync(join(canonical, ".work-state", "run-control.json")),
      false,
      "a contradictory context must not create canonical workflow state",
    );

    const response = await prepare.execute(
      "canonical-context",
      prepareInput,
      undefined,
      undefined,
      { cwd: canonical, sessionManager: sessionManagerFor(canonical, "session-direct"), mode: "tui", session_id: "session-direct", hasUI: true } as never,
    );
    const details = response.details as { ok?: boolean; state_path?: string; state?: { run_id?: string; branch?: string } };
    assert.equal(details.ok, true);
    assert.equal(details.state?.branch, "main");
    assert.equal(details.state_path, runTarget(canonical, details.state?.run_id ?? "").statePath);
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
      { cwd: canonical, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(canonical, "session-direct"), hasUI: true } as never,
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
      "test-resume",
      {
        mode: "resume",
        run_id: details.state?.run_id,
        branch: "main",
      },
      undefined,
      undefined,
      { cwd: canonical, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(canonical, "session-direct"), hasUI: true } as never,
    );
    assert.equal((reopenResponse.details as { ok?: boolean; error?: string }).ok, true, (reopenResponse.details as { error?: string }).error);
    const resumedBegin = await begin.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: canonical, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(canonical, "session-direct"), hasUI: true } as never,
    );
    assert.equal((resumedBegin.details as { ok?: boolean }).ok, true);
  } finally {
    await fireSessionShutdown({ cwd: canonical, mode: "tui", hasUI: true });
    rmSync(canonical, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
  }
});

test("fullstack: workflow_begin rejects a contradictory explicit cwd without mutating canonical state", async () => {
  const canonical = mkdtempSync(join(tmpdir(), "omp-workflow-canonical-"));
  const stale = mkdtempSync(join(tmpdir(), "omp-workflow-stale-"));
  let fireSessionShutdown: ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
  try {
    execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const toolsAndLifecycle = registerToolsWithSessionSink();
    fireSessionShutdown = toolsAndLifecycle.fireSessionShutdown;
    await toolsAndLifecycle.fireSessionStart({ mode: "tui", hasUI: true, cwd: canonical, ui: {} });
    const prepare = toolsAndLifecycle.tools.get("workflow_prepare")!;
    const prepared = await prepare.execute(
      "canonical-fixture-prepare",
      {
        mode: "new",
        task: "canonical begin regression",
        branch: "main",
        classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      },
      undefined,
      undefined,
      { cwd: canonical, sessionManager: sessionManagerFor(canonical, "session-direct"), mode: "tui", session_id: "session-direct", hasUI: true } as never,
    );
    const preparedDetails = prepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    const runId = preparedDetails.state?.run_id;
    if (!runId) throw new Error("canonical begin fixture did not return a run id");
    const before = workflowMutationSnapshot(canonical, runId);

    const begin = toolsAndLifecycle.tools.get("workflow_begin")!;
    const response = await begin.execute(
      "stale-context-begin",
      {},
      undefined,
      undefined,
      { cwd: stale, sessionManager: sessionManagerFor(canonical, "session-direct"), mode: "tui", session_id: "session-direct", hasUI: true } as never,
    );
    const details = response.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(details.ok, false);
    assert.equal(details.code, "WORKFLOW_CONTEXT_REJECTED", details.error);
    assertWorkflowMutationUnchanged(before, workflowMutationSnapshot(canonical, runId), "stale workflow_begin");
  } finally {
    await fireSessionShutdown?.({ cwd: canonical, mode: "tui", hasUI: true });
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

async function writeCheckpointAskFixture(
  root: string,
  tools: Map<string, RegisteredTool>,
  context?: Record<string, unknown>,
): Promise<IssuedCapability> {
  // workflow_prepare resolves scope from the caller's registered preset; keep
  // the fixture configuration explicit, but establish the run and claim only
  // through the registered host lifecycle tools below.
  writeConfig(
    join(root, ".omp", "team.config.json"),
    {
      roles: fullstackPreset.roles,
      scope_map: fullstackPreset.scopeMap,
      flags: fullstackPreset.flags,
      scope_runtime_classes: fullstackPreset.scopeRuntimeClasses,
      scope_ui_classes: fullstackPreset.scopeUiClasses,
    },
    { cwd: root },
  );
  const hostContext = context ?? {
    cwd: root,
    hasUI: true,
    mode: "tui",
    session_id: "session-direct",
    sessionManager: sessionManagerFor(root, "session-direct"),
  };
  const prepare = tools.get("workflow_prepare");
  const begin = tools.get("workflow_begin");
  if (!prepare || !begin) throw new Error("workflow lifecycle tools are not registered");
  const preparedResponse = await prepare.execute(
    "checkpoint-fixture-prepare",
    {
      mode: "new",
      task: "checkpoint ask ingest",
      branch: "main",
      classification: {
        type: "FEATURE",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: false,
        workflow: "lightweight",
      },
      files: ["src/main/App.kt"],
    },
    undefined,
    undefined,
    hostContext as never,
  );
  const preparedDetails = preparedResponse.details as {
    ok?: boolean;
    error?: string;
    state?: { run_id?: string };
  };
  if (!preparedDetails.ok || !preparedDetails.state?.run_id) {
    throw new Error(preparedDetails.error ?? "workflow_prepare did not select a canonical run");
  }
  const runId = preparedDetails.state.run_id;
  const statePath = runTarget(root, runId).statePath;
  const artifactsDir = runTarget(root, runId).artifactsDir;
  if (!statePath || !artifactsDir) throw new Error("canonical checkpoint fixture paths are unavailable");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    stages?: Array<{ id: string; status: string }>;
    artifacts?: Record<string, string>;
    [key: string]: unknown;
  };
  // Arm the implementation stage through the canonical state selected by
  // workflow_prepare. The active execution claim remains the controller's
  // exact binding while the fixture supplies the declared discovery input.
  state.artifacts = { ...(state.artifacts ?? {}), discovery: "discovery.json" };
  state.stage_cursor = "implementation";
  state.stages = (state.stages ?? []).map((stage) => ({
    ...stage,
    status: stage.id === "discovery" ? "done" : stage.id === "implementation" ? "in_progress" : "pending",
  }));
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({
    task: "checkpoint ask ingest",
    branch: "main",
  }) + "\n");
  const begunResponse = await begin.execute("checkpoint-fixture-begin", {}, undefined, undefined, hostContext as never);
  const begunDetails = begunResponse.details as {
    ok?: boolean;
    error?: string;
    handoff?: {
      capability_id: string;
      dispatch_token: string;
      advance_token: string;
    };
  };
  if (!begunDetails.ok || !begunDetails.handoff) {
    throw new Error(begunDetails.error ?? "workflow_begin did not return a capability handoff");
  }
  const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
    dispatch_capability?: IssuedCapability["state"];
  };
  if (!persisted.dispatch_capability) throw new Error("workflow_begin did not persist a dispatch capability");
  return {
    capability_id: begunDetails.handoff.capability_id,
    dispatch_token: begunDetails.handoff.dispatch_token,
    advance_token: begunDetails.handoff.advance_token,
    state: persisted.dispatch_capability,
  };
}

function checkpointAskAuth(issued: IssuedCapability) {
  const binding = issued.state.issued_for!;
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: binding.run_key,
    branch: binding.branch,
    workflow: binding.workflow,
    stage_cursor: binding.stage_cursor,
    cursor_epoch: binding.cursor_epoch,
    loop_iteration: binding.loop_iteration,
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
    mode: "tui",
    session_id: "session-direct",
    sessionManager: sessionManagerFor(root, "session-direct"),
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
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const issued = await writeCheckpointAskFixture(root, tools);
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
    const ingested = JSON.parse(readFileSync(runTarget(root, issued.state.issued_for!.run_key).statePath!, "utf8")) as Record<string, unknown>;
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
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      run_key: issued.state.issued_for!.run_key,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      authorization: "human",
      actor_provenance: details.actor_provenance,
      decision: "proceed",
      rationale: "approved at the terminal",
    }, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    const recordedDetails = recorded.details as { ok?: boolean; error?: string };
    assert.equal(recordedDetails.ok, true, recordedDetails.error);
    const decided = JSON.parse(readFileSync(runTarget(root, issued.state.issued_for!.run_key).statePath!, "utf8")) as Record<string, unknown>;
    const typed = decided.typed_checkpoint_decisions as Array<Record<string, unknown>>;
    assert.equal(typed?.length, 1);
    assert.equal(typed[0]?.authorization, "human");
    assert.equal((typed[0]?.actor as Record<string, unknown>)?.kind, "user");
    const consumed = (decided.trusted_checkpoint_answers as Array<Record<string, unknown>>)[0];
    assert.ok(consumed?.consumed_at, "the human answer is consumed after the decision");
  } finally {
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint rejects a decision that diverges from the recorded human answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-diverge-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const issued = await writeCheckpointAskFixture(root, tools);
    const ask = tools.get("workflow_checkpoint_ask")!;
    const askResponse = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, askDialogContext(root, askToolSelection(["proceed"]), []) as never);
    const askDetails = askResponse.details as { ok?: boolean; error?: string; actor_provenance?: unknown };
    assert.equal(askDetails.ok, true, askDetails.error);

    const checkpoint = tools.get("workflow_checkpoint")!;
    const envelope = {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      authorization: "human",
      actor_provenance: askDetails.actor_provenance,
    };
    const diverged = await checkpoint.execute("test", { ...envelope, decision: "reject", rationale: "model override" }, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    const divergedDetails = diverged.details as { ok?: boolean; error?: string };
    assert.equal(divergedDetails.ok, false);
    assert.match(divergedDetails.error ?? "", /stale or mismatched/);
    const decided = await checkpoint.execute("test", { ...envelope, decision: "proceed", rationale: "as answered" }, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    const decidedDetails = decided.details as { ok?: boolean; error?: string };
    assert.equal(decidedDetails.ok, true, decidedDetails.error);
  } finally {
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask records nothing on decline, timeout, custom text, or unknown selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-decline-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const issued = await writeCheckpointAskFixture(root, tools);
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
      const state = JSON.parse(readFileSync(runTarget(root, issued.state.issued_for!.run_key).statePath!, "utf8")) as Record<string, unknown>;
      assert.equal(state.trusted_checkpoint_answers, undefined, `${label} must not ingest an answer`);
    }
  } finally {
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask fails closed without UI, for unauthenticated callers, and stays idempotent when resolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-closed-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const issued = await writeCheckpointAskFixture(root, tools);
    const ask = tools.get("workflow_checkpoint_ask")!;
    const calls: FakeAskDialogQuestion[][] = [];

    // Headless session: hasUI is true but no UI surface is bound.
    const unavailable = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
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
    }, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    assert.equal((recorded.details as { ok?: boolean; error?: string }).ok, true, (recorded.details as { error?: string }).error);
    const callsAfterAnswer = calls.length;
    const replay = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, askDialogContext(root, undefined, calls) as never);
    const replayDetails = replay.details as { ok?: boolean; already_recorded?: boolean; decision?: string; error?: string };
    assert.equal(replayDetails.ok, true, replayDetails.error);
    assert.equal(replayDetails.already_recorded, true);
    assert.equal(replayDetails.decision, "proceed");
    assert.equal(calls.length, callsAfterAnswer, "resolved checkpoints never re-prompt the human");
  } finally {
    await fireSessionShutdown({ cwd: root, mode: "tui", hasUI: true });
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
type WorkflowMutationSnapshot = {
  stateRaw: string;
  controlRaw: string;
  runCount: number;
  claim: unknown;
};

function workflowMutationSnapshot(root: string, runId: string): WorkflowMutationSnapshot {
  const statePath = runTarget(root, runId).statePath;
  if (!statePath) throw new Error("canonical run state path is unavailable");
  const controlPath = join(root, ".work-state", "run-control.json");
  const controlRaw = readFileSync(controlPath, "utf8");
  const control = JSON.parse(controlRaw) as { runs?: Record<string, unknown>; execution_claim?: unknown };
  return {
    stateRaw: readFileSync(statePath, "utf8"),
    controlRaw,
    runCount: Object.keys(control.runs ?? {}).length,
    claim: control.execution_claim,
  };
}

function assertWorkflowMutationUnchanged(before: WorkflowMutationSnapshot, after: WorkflowMutationSnapshot, label: string): void {
  assert.equal(after.runCount, before.runCount, label + ": run count changed");
  assert.equal(after.stateRaw, before.stateRaw, label + ": state bytes changed");
  assert.equal(after.controlRaw, before.controlRaw, label + ": control bytes changed");
  assert.deepEqual(after.claim, before.claim, label + ": execution claim changed");
}

type RegisteredCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function readExecutionClaim(root: string): Record<string, unknown> | null {
  const control = JSON.parse(readFileSync(join(root, ".work-state", "run-control.json"), "utf8")) as {
    execution_claim?: unknown;
  };
  return control.execution_claim && typeof control.execution_claim === "object"
    ? control.execution_claim as Record<string, unknown>
    : null;
}

function registerToolsWithSessionSink(): {
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  hostContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
  fireSessionStart: (ctx: Record<string, unknown>) => Promise<void>;
  fireSessionSwitch: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>;
  fireSessionStop: (ctx: Record<string, unknown>, eventOverrides?: Record<string, unknown>) => Promise<void>;
  fireSessionShutdown: (ctx: Record<string, unknown>, eventOverrides?: Record<string, unknown>) => Promise<void>;
} {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const sessionStops: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const sessionSwitches: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const lifecycle: {
    sessionStart?: (event: unknown, ctx: unknown) => unknown;
    sessionSwitch?: (event: unknown, ctx: unknown) => unknown;
    sessionStop?: (event: unknown, ctx: unknown) => unknown;
    sessionShutdown?: (event: unknown, ctx: unknown) => unknown;
  } = {};
  // Mirror the production entrypoint's lifecycle ingress without registering
  // its unrelated commands/tools into this focused harness.
  ompWorkflowsFullstack({
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "session_start" && !lifecycle.sessionStart) lifecycle.sessionStart = handler;
      if (event === "session_switch" && !lifecycle.sessionSwitch) lifecycle.sessionSwitch = handler;
      if (event === "session_stop" && !lifecycle.sessionStop) lifecycle.sessionStop = handler;
      if (event === "session_shutdown" && !lifecycle.sessionShutdown) lifecycle.sessionShutdown = handler;
    },
    registerCommand(name: string, options: RegisteredCommand) {
      commands.set(name, options);
    },
    setLabel() {},
    sendUserMessage() {},
  } as never);
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "session_start") sessionStarts.push(handler);
      if (event === "session_switch") sessionSwitches.push(handler);
      if (event === "session_stop") sessionStops.push(handler);
    },
  } as never);
  const hostContext = (ctx: Record<string, unknown>): Record<string, unknown> => {
    const sessionId = typeof ctx.session_id === "string" ? ctx.session_id : "session-direct";
    const supplied = ctx.sessionManager;
    const manager = supplied && typeof supplied === "object"
      ? supplied as SessionManagerFixture
      : sessionManagerFor(String(ctx.cwd ?? ""), sessionId);
    return {
      ...ctx,
      session_id: sessionId,
      sessionManager: manager,
    };
  };
  return {
    commands,
    tools,
    hostContext,
    fireSessionStart: async (ctx) => {
      const normalized = hostContext(ctx);
      await lifecycle.sessionStart?.({ type: "session_start" }, normalized);
      await Promise.all(sessionStarts.map(handler => handler({ type: "session_start" }, normalized)));
    },
    fireSessionSwitch: async (event, ctx) => {
      const normalized = hostContext(ctx);
      await lifecycle.sessionSwitch?.(event, normalized);
      await Promise.all(sessionSwitches.map(handler => handler(event, normalized)));
    },
    fireSessionStop: async (ctx, eventOverrides = {}) => {
      const normalized = hostContext(ctx);
      const manager = normalized.sessionManager as SessionManagerFixture;
      const event = {
        type: "session_stop",
        session_id: manager.getSessionId(),
        session_file: manager.getSessionFile(),
        ...eventOverrides,
      };
      await lifecycle.sessionStop?.(event, normalized);
      await Promise.all(sessionStops.map(handler => handler(event, normalized)));
    },
    fireSessionShutdown: async (ctx, eventOverrides = {}) => {
      const normalized = hostContext(ctx);
      await lifecycle.sessionShutdown?.({ type: "session_shutdown", ...eventOverrides }, normalized);
    },
  };
}

test("fullstack: workflow tools trust the authoritative host profile across TUI, RPC, rpc-ui, json, print, and worker contexts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-context-eligibility-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const status = tools.get("workflow_status")!;

    // Prepare through the trusted controller so the positive status read is
    // backed by the session's canonical run selection, not a raw state seed.
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const prepare = tools.get("workflow_prepare")!;
    const prepared = await prepare.execute("host-profile-prepare", {
      mode: "new",
      task: "host profile eligibility",
      branch: "main",
      classification: {
        type: "FEATURE",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: false,
        workflow: "lightweight",
      },
    }, undefined, undefined, {
      cwd: root,
      hasUI: true,
      mode: "tui",
      session_id: "session-direct",
      sessionManager: sessionManagerFor(root, "session-direct"),
    } as never);
    const preparedDetails = prepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    const hostRunId = preparedDetails.state?.run_id;
    if (!hostRunId) throw new Error("trusted host preparation did not return the selected canonical run id");
    const tui = await status.execute("test-tui", {}, undefined, undefined, { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    assert.equal((tui.details as { ok?: boolean; error?: string }).ok, true, (tui.details as { error?: string }).error);

    // Plain rpc keeps the authenticated interactive profile on every
    // command/tool callback; connected RPC is not a headless worker.
    // Separate json/print fixtures below cover explicit headless denial.
    await fireSessionStart({ mode: "rpc", hasUI: true, cwd: root, ui: { select: async () => undefined } });
    const rpcResume = await prepare.execute("host-profile-rpc-resume", {
      mode: "resume",
      run_id: hostRunId,
      branch: "main",
    }, undefined, undefined, {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      session_id: "session-direct",
      sessionManager: sessionManagerFor(root, "session-direct"),
    } as never);
    const rpcResumeDetails = rpcResume.details as { ok?: boolean; error?: string };
    assert.equal(rpcResumeDetails.ok, true, rpcResumeDetails.error);
    const rpc = await status.execute("test-rpc", {}, undefined, undefined, { cwd: root, hasUI: true, mode: "rpc", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    assert.equal((rpc.details as { code?: string }).code, undefined);
    assert.equal((rpc.details as { ok?: boolean; error?: string }).ok, true, (rpc.details as { error?: string }).error);

    const mutationBeforeHeadless = workflowMutationSnapshot(root, hostRunId);
    let mutationAfterHeadless = mutationBeforeHeadless;
    // Same-identity headless session_start revokes interactive authority only.
    // It retains the ordinary execution claim and captured controller until a
    // verified interactive stop, shutdown, or replacement event.
    for (const mode of ["json", "print"]) {
      await fireSessionStart({ mode, hasUI: false, cwd: root, ui: {} });
      const afterHeadlessStart = workflowMutationSnapshot(root, hostRunId);
      assertWorkflowMutationUnchanged(mutationAfterHeadless, afterHeadlessStart, mode);
      mutationAfterHeadless = afterHeadlessStart;
      const deniedPrepare = await prepare.execute("headless-" + mode, {
        mode: "new",
        task: "headless " + mode + " must not mutate workflow state",
        branch: "main",
        classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      }, undefined, undefined, { cwd: root, hasUI: false } as never);
      const deniedPrepareDetails = deniedPrepare.details as { code?: string; error?: string };
      assert.equal(deniedPrepareDetails.code, "WORKFLOW_CONTEXT_REJECTED", mode + ": " + deniedPrepareDetails.error);
      assertWorkflowMutationUnchanged(mutationAfterHeadless, workflowMutationSnapshot(root, hostRunId), mode + " prepare");
      const headless = await status.execute("test", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
      assert.equal((headless.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED", mode);
    }

    // Task subagent/worker sessions run with mode "print" and no UI (the
    // installed host initializes subagent runners without mode or UI) and
    // fail closed exactly like headless runs.
    const worker = await status.execute("worker", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
    assert.equal((worker.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
    // A later trusted primary start re-enables the authenticated RPC profile
    // after the headless authority revocation; workflow_prepare must establish
    // the exact active claim again before mutation.
    await fireSessionStart({ mode: "rpc", hasUI: true, cwd: root, ui: { select: async () => undefined } });
    const reenabled = await status.execute("test-reenabled", {}, undefined, undefined, { cwd: root, hasUI: true, mode: "rpc", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    assert.equal((reenabled.details as { ok?: boolean; error?: string }).ok, true, (reenabled.details as { error?: string }).error);
    const replayed = await prepare.execute("test-reenabled-prepare", {
      mode: "resume",
      run_id: hostRunId,
      branch: "main",
    }, undefined, undefined, {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      session_id: "session-direct",
      sessionManager: sessionManagerFor(root, "session-direct"),
    } as never);
    assert.equal((replayed.details as { ok?: boolean; error?: string }).ok, true, (replayed.details as { error?: string }).error);

    // A foreign worker start must not poison the still-trusted primary profile.
    await fireSessionStart({ mode: "print", hasUI: false, cwd: root, session_id: "worker-session", ui: {} });
    const mutationBeforeWorker = workflowMutationSnapshot(root, hostRunId);
    const deniedWorkerPrepare = await prepare.execute("worker-prepare", {
      mode: "new",
      task: "foreign worker must not mutate workflow state",
      branch: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    }, undefined, undefined, {
      cwd: root,
      hasUI: false,
      mode: "print",
      session_id: "worker-session",
      sessionManager: { getCwd: () => root, getSessionId: () => "worker-session" },
    } as never);
    const deniedWorkerPrepareDetails = deniedWorkerPrepare.details as { code?: string; error?: string };
    assert.equal(deniedWorkerPrepareDetails.code, "WORKFLOW_CONTEXT_REJECTED", deniedWorkerPrepareDetails.error);
    assertWorkflowMutationUnchanged(mutationBeforeWorker, workflowMutationSnapshot(root, hostRunId), "foreign worker");
    const workerContext = await status.execute("worker-context", {}, undefined, undefined, {
      cwd: root,
      hasUI: false,
      mode: "print",
      session_id: "worker-session",
      sessionManager: { getCwd: () => root, getSessionId: () => "worker-session" },
    } as never);
    assert.equal((workerContext.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
    const primaryAfterWorker = await status.execute("primary-after-worker", {}, undefined, undefined, { cwd: root, hasUI: true, mode: "rpc", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never);
    assert.equal((primaryAfterWorker.details as { ok?: boolean; error?: string }).ok, true, (primaryAfterWorker.details as { error?: string }).error);
  } finally {
    await fireSessionShutdown({ cwd: root, hasUI: true, mode: "rpc" });
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: CTO claim switch is manager-bound and admits only the verified successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-claim-switch-"));
  const toolsAndLifecycle = registerToolsWithSessionSink();
  const ownerManager = mutableSessionManagerFor(root, "owner-old");
  ownerManager.getSessionFile = () => {
    const sessionId = ownerManager.getSessionId();
    const fileName = sessionId === "owner-old"
      ? "history-old.jsonl"
      : sessionId === "owner-new"
        ? "history-new.jsonl"
        : "history-final.jsonl";
    return join(root, ".omp", "sessions", fileName);
  };
  const ownerContext = (): Record<string, unknown> => ({
    cwd: root,
    mode: "tui",
    hasUI: true,
    session_id: ownerManager.getSessionId(),
    sessionManager: ownerManager,
    ui: { notify() {} },
  });
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await toolsAndLifecycle.fireSessionStart(ownerContext());
    const cto = toolsAndLifecycle.commands.get("cto");
    if (!cto) throw new Error("registered /cto command is unavailable");
    await cto.handler("Bound CTO switch", ownerContext());

    const ownerClaim = readExecutionClaim(root);
    assert.ok(ownerClaim, "the /cto command must publish an execution claim");
    assert.equal(ownerClaim.owner_kind, "cto");
    const previousOwnerSessionFile = ownerManager.getSessionFile();
    // Explicitly malformed lifecycle identity must not be treated as absent
    // while the context half still points at a plausible successor.
    ownerManager.switchTo("owner-new");
    await toolsAndLifecycle.fireSessionSwitch(
      {
        type: "session_switch",
        reason: "new",
        previousSessionFile: previousOwnerSessionFile,
        session_id: 42,
      },
      ownerContext(),
    );
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "malformed switch identity cannot release the CTO claim");
    ownerManager.switchTo("owner-old");
    await toolsAndLifecycle.fireSessionStop(ownerContext(), { session_file: 42 });
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "malformed stop identity cannot release the CTO claim");
    await toolsAndLifecycle.fireSessionStop(ownerContext(), { session_id: "owner-old", sessionId: "other-owner" });
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "contradictory lifecycle aliases cannot release the CTO claim");
    await toolsAndLifecycle.fireSessionShutdown(ownerContext(), { cwd: 42 });
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "malformed shutdown identity cannot release the CTO claim");
    await toolsAndLifecycle.fireSessionStop(ownerContext(), {
      sessionManager: {
        getCwd: () => root,
        getSessionId: () => "owner-old",
        getSessionFile: () => 42,
      },
    });
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "malformed manager getter cannot release the CTO claim");
    ownerManager.switchTo("owner-new");
    await toolsAndLifecycle.fireSessionSwitch(
      { type: "session_switch", reason: "new", previousSessionFile: previousOwnerSessionFile, actor: "foreign" },
      ownerContext(),
    );
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "contradictory event actor cannot release the CTO claim");
    ownerManager.switchTo("owner-old");

    const foreignManager = mutableSessionManagerFor(root, "foreign-old");
    await toolsAndLifecycle.fireSessionStart({
      cwd: root,
      mode: "tui",
      hasUI: true,
      session_id: "foreign-old",
      sessionManager: foreignManager,
      ui: { notify() {} },
    });
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "foreign manager session_start cannot reset the CTO claim");
    const previousForeignSessionFile = foreignManager.getSessionFile();
    foreignManager.switchTo("foreign-new");
    await toolsAndLifecycle.fireSessionSwitch(
      { type: "session_switch", reason: "new", previousSessionFile: previousForeignSessionFile },
      {
        cwd: root,
        mode: "tui",
        hasUI: true,
        session_id: "foreign-new",
        sessionManager: foreignManager,
        ui: { notify() {} },
      },
    );
    assert.deepEqual(readExecutionClaim(root), ownerClaim, "foreign manager session_switch cannot release the CTO claim");

    ownerManager.switchTo("owner-new");
    const successorContext = ownerContext();
    await toolsAndLifecycle.fireSessionSwitch(
      { type: "session_switch", reason: "new", previousSessionFile: previousOwnerSessionFile },
      successorContext,
    );
    const releasedOwnerClaim = readExecutionClaim(root);
    assert.equal(releasedOwnerClaim, null, "a zero-pending CTO switch removes the inactive common claim");
    const controlAfterSwitch = JSON.parse(readFileSync(join(root, ".work-state", "run-control.json"), "utf8")) as {
      execution_claim?: Record<string, unknown> | null;
      cto_releases?: Record<string, Record<string, unknown>>;
    };
    assert.equal(controlAfterSwitch.execution_claim, null, "a zero-pending CTO switch must persist an explicit null execution claim");
    const ownerRelease = controlAfterSwitch.cto_releases?.[String(ownerClaim.run_id)];
    assert.ok(ownerRelease, "same-manager switch must retain CTO release provenance");
    assert.equal(ownerRelease.reason, "session-replacement");
    assert.equal(ownerRelease.issuance_token, ownerClaim.token);
    assert.equal(typeof ownerRelease.released_at, "string", "same-manager switch must record release history");

    await cto.handler("Successor CTO command", successorContext);
    const successorClaim = readExecutionClaim(root);
    assert.ok(successorClaim, "the successor host must admit a fresh CTO claim");
    assert.equal(successorClaim.coordinator_session_id, "owner-new");
    assert.notEqual(successorClaim.run_id, ownerClaim.run_id);

    const oldContext = {
      ...successorContext,
      session_id: "owner-old",
    };
    await assert.rejects(
      () => cto.handler("stale old context", oldContext),
      /WORKFLOW_CONTEXT_REJECTED|trusted CTO session unavailable/,
    );
    assert.deepEqual(readExecutionClaim(root), successorClaim, "old context cannot reset the successor claim");
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeCorruption = readFileSync(controlPath, "utf8");
    const control = JSON.parse(beforeCorruption) as { execution_claim?: Record<string, unknown> };
    const staleClaim = { ...successorClaim, token: "corrupt-bound-token" };
    writeFileSync(controlPath, `${JSON.stringify({ ...control, execution_claim: staleClaim })}\n`);
    const previousSuccessorSessionFile = ownerManager.getSessionFile();
    ownerManager.switchTo("owner-final");
    await toolsAndLifecycle.fireSessionSwitch(
      { type: "session_switch", reason: "new", previousSessionFile: previousSuccessorSessionFile },
      ownerContext(),
    );
    assert.deepEqual(readExecutionClaim(root), staleClaim, "a corrupt private token must not release on switch");
    ownerManager.switchTo("owner-new");
    await toolsAndLifecycle.fireSessionShutdown(ownerContext());
    assert.deepEqual(readExecutionClaim(root), staleClaim, "a corrupt private token must not release on shutdown");
    writeFileSync(controlPath, beforeCorruption);
  } finally {
    await toolsAndLifecycle.fireSessionShutdown(ownerContext());
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: ordinary switch with a captured session file requires exact old-file proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-ordinary-switch-file-proof-"));
  const toolsAndLifecycle = registerToolsWithSessionSink();
  const manager = mutableSessionManagerFor(root, "ordinary-old");
  const context = (): Record<string, unknown> => ({
    cwd: root,
    mode: "tui",
    hasUI: true,
    session_id: manager.getSessionId(),
    sessionManager: manager,
    ui: { notify() {} },
  });
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await toolsAndLifecycle.fireSessionStart(context());
    const prepare = toolsAndLifecycle.tools.get("workflow_prepare");
    if (!prepare) throw new Error("workflow_prepare tool is unavailable");
    const oldPrepared = await prepare.execute(
      "ordinary-switch-old-prepare",
      {
        mode: "new",
        task: "ordinary switch old run",
        branch: "main",
        classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      },
      undefined,
      undefined,
      context() as never,
    );
    const oldDetails = oldPrepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(oldDetails.ok, true, oldDetails.error);
    const oldRunId = oldDetails.state?.run_id;
    if (!oldRunId) throw new Error("ordinary switch old fixture did not return a run id");
    const oldClaim = readExecutionClaim(root);
    assert.ok(oldClaim, "ordinary old run must publish an execution claim");
    assert.equal(oldClaim.owner_kind, "workflow");
    assert.equal(oldClaim.coordinator_session_id, "ordinary-old");
    assert.equal(oldClaim.run_id, oldRunId);
    const previousSessionFile = manager.getSessionFile();
    manager.switchTo("ordinary-new");
    await toolsAndLifecycle.fireSessionSwitch(
      { type: "session_switch", reason: "new", previousSessionFile: join(root, ".omp", "sessions", "wrong-old.jsonl") },
      context(),
    );
    assert.deepEqual(readExecutionClaim(root), oldClaim, "a mismatched old session file cannot release the ordinary claim");
    manager.switchTo("ordinary-final");
    await toolsAndLifecycle.fireSessionSwitch(
      { type: "session_switch", reason: "new", previousSessionFile },
      context(),
    );
    assert.equal(readExecutionClaim(root), null, "the exact old session file proof releases the old ordinary claim");
    const status = toolsAndLifecycle.tools.get("workflow_status");
    if (!status) throw new Error("workflow_status tool is unavailable");
    const successorStatus = (await status.execute("ordinary-switch-successor", {}, undefined, undefined, context() as never)).details as {
      ok?: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(successorStatus.ok, false);
    assert.equal(successorStatus.code, "no_active_run", successorStatus.error);
    const successorPrepared = await prepare.execute(
      "ordinary-switch-successor-prepare",
      {
        mode: "new",
        task: "ordinary successor run",
        branch: "main",
        classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      },
      undefined,
      undefined,
      context() as never,
    );
    const successorDetails = successorPrepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(successorDetails.ok, true, successorDetails.error);
    const successorRunId = successorDetails.state?.run_id;
    if (!successorRunId) throw new Error("ordinary successor fixture did not return a run id");
    assert.notEqual(successorRunId, oldRunId, "successor admission must not resume the old run");
    const successorClaim = readExecutionClaim(root);
    assert.ok(successorClaim, "ordinary successor prepare must publish a fresh claim");
    assert.equal(successorClaim.owner_kind, "workflow");
    assert.equal(successorClaim.coordinator_session_id, "ordinary-final");
    assert.equal(successorClaim.run_id, successorRunId);
    const selectedSuccessor = (await status.execute("ordinary-switch-selected", {}, undefined, undefined, context() as never)).details as {
      ok?: boolean;
      run_id?: string;
      error?: string;
    };
    assert.equal(selectedSuccessor.ok, true, selectedSuccessor.error);
    assert.equal(selectedSuccessor.run_id, successorRunId);
  } finally {
    await toolsAndLifecycle.fireSessionShutdown(context());
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: retained dispatcher claim is gated by a same-manager headless profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-headless-dispatcher-"));
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const commands = new Map<string, RegisteredCommand>();
  const wakes: string[] = [];
  const ownerManager = mutableSessionManagerFor(root, "dispatcher-owner");
  // Independent managers can report the same cwd and session id without
  // gaining authority over the resident dispatcher.
  const foreignManager = mutableSessionManagerFor(root, "dispatcher-owner");
  const ownerContext = (): Record<string, unknown> => ({
    cwd: root,
    mode: "tui",
    hasUI: true,
    session_id: ownerManager.getSessionId(),
    sessionManager: ownerManager,
    ui: { notify() {}, select: async () => undefined },
  });
  const headlessOwnerContext = (): Record<string, unknown> => ({
    cwd: root,
    mode: "print",
    hasUI: false,
    session_id: ownerManager.getSessionId(),
    sessionManager: ownerManager,
    ui: {},
  });
  const foreignHeadlessContext = (): Record<string, unknown> => ({
    cwd: root,
    mode: "print",
    hasUI: false,
    session_id: foreignManager.getSessionId(),
    sessionManager: foreignManager,
    ui: {},
  });
  const eventBus = new TestBus();
  const pi = {
    zod: { z },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool() {},
    registerCommand(name: string, options: RegisteredCommand) {
      commands.set(name, options);
    },
    setLabel() {},
    sendUserMessage(message: string) {
      if (message.startsWith("[CTO-INBOX]")) wakes.push(message);
    },
    appendEntry() {},
    registerMessageRenderer() {},
    events: eventBus,
  };
  const originalSetInterval = globalThis.setInterval;
  const dispatcherTicks: Array<() => void> = [];
  const flushDispatcher = async (): Promise<void> => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  };
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "mock" }) + "\n");
    ompWorkflowsFullstack(pi as never);

    const sessionStarts = handlers.session_start ?? [];
    const startDispatcher = sessionStarts[sessionStarts.length - 1];
    if (!startDispatcher) throw new Error("fullstack dispatcher session_start handler is unavailable");
    const fireSessionStart = async (ctx: Record<string, unknown>): Promise<void> => {
      for (const handler of sessionStarts) await handler({ type: "session_start" }, ctx);
    };
    const fireSessionIngress = async (ctx: Record<string, unknown>): Promise<void> => {
      for (const handler of sessionStarts.slice(0, -1)) await handler({ type: "session_start" }, ctx);
    };

    // Capture the exact owner/controller before the dispatcher is started, so
    // the retained binding is already claimed when the headless boundary hits.
    await fireSessionIngress(ownerContext());
    const cto = commands.get("cto");
    if (!cto) throw new Error("registered /cto command is unavailable");
    await cto.handler("Headless dispatcher gate", ownerContext());
    // Keep the real dispatcher loop but drive its fixed 10s production tick
    // deterministically for this focused lifecycle regression.
    globalThis.setInterval = ((handler: unknown, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10_000 && typeof handler === "function") {
        dispatcherTicks.push(() => (handler as (...values: unknown[]) => void)(...args));
        return originalSetInterval(() => undefined, 60_000);
      }
      return originalSetInterval(handler as never, timeout, ...args as never[]);
    }) as typeof globalThis.setInterval;
    await fireSessionStart(ownerContext());
    await flushDispatcher();
    const dispatcherTick = dispatcherTicks[0];
    if (!dispatcherTick) throw new Error("dispatcher interval callback is unavailable");
    const dispatcherLeasePath = join(root, ".omp", "cto-dispatcher.lock");
    const leaseBeforeHeadless = readFileSync(dispatcherLeasePath, "utf8");
    const controlPath = join(root, ".work-state", "run-control.json");
    const controlBeforeStale = readFileSync(controlPath, "utf8");

    const inboxDir = join(root, ".omp", "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const foreignTaskPath = join(inboxDir, "foreign-headless-task.json");
    writeFileSync(foreignTaskPath, JSON.stringify({
      id: "foreign-headless-task",
      text: "foreign headless must not revoke the owner",
      at: new Date().toISOString(),
    }) + "\n");

    // A foreign headless callback must not invalidate the owner or its lease.
    await fireSessionStart(foreignHeadlessContext());
    dispatcherTick();
    await flushDispatcher();
    assert.equal(wakes.length, 1, "foreign headless callback must not revoke the owner");
    assert.equal(existsSync(foreignTaskPath), false, "the still-trusted owner must consume its task");

    const taskPath = join(inboxDir, "headless-task.json");
    writeFileSync(taskPath, JSON.stringify({
      id: "headless-dispatcher-task",
      text: "wake only after trusted interactive reentry",
      at: new Date().toISOString(),
    }) + "\n");

    // Same-manager headless invalidation retains the controller and dispatcher
    // lease but removes the claim proof from every drain/poll/wake tick.
    await fireSessionStart(headlessOwnerContext());
    dispatcherTick();
    await flushDispatcher();
    assert.equal(readFileSync(dispatcherLeasePath, "utf8"), leaseBeforeHeadless, "headless invalidation must retain the dispatcher lease");
    assert.equal(wakes.length, 1, "headless primary must not wake the host");
    assert.equal(existsSync(taskPath), true, "headless primary must leave the local task durable");

    // Exact interactive reentry restores the primary profile on the existing
    // binding; the retained dispatcher can then consume the queued task.
    await fireSessionStart(ownerContext());
    dispatcherTick();
    await flushDispatcher();
    assert.equal(readFileSync(dispatcherLeasePath, "utf8"), leaseBeforeHeadless, "interactive reentry must reuse the retained dispatcher lease");
    assert.equal(wakes.length, 2, "trusted reentry must reactivate the retained dispatcher claim");
    assert.match(wakes[1] ?? "", /\[CTO-INBOX\]/);
    assert.equal(existsSync(taskPath), false, "trusted reentry must consume the queued task");
    const control = JSON.parse(controlBeforeStale) as { execution_claim?: Record<string, unknown> };
    const staleClaim = { ...(control.execution_claim ?? {}), token: "corrupt-dispatcher-bound-token" };
    writeFileSync(controlPath, `${JSON.stringify({ ...control, execution_claim: staleClaim })}\n`);
    try {
      dispatcherTick();
      await flushDispatcher();
      assert.deepEqual(readExecutionClaim(root), staleClaim, "stale dispatcher binding must preserve the owner claim");
      assert.equal(readFileSync(dispatcherLeasePath, "utf8"), leaseBeforeHeadless, "stale dispatcher binding must retain its lease");
      assert.equal(wakes.length, 2, "stale dispatcher binding must not wake the host");
    } finally {
      writeFileSync(controlPath, controlBeforeStale);
    }

  } finally {
    for (const handler of handlers.session_shutdown ?? []) {
      await handler({ type: "session_shutdown" }, ownerContext());
    }
    globalThis.setInterval = originalSetInterval;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: raw tool_call derives artifact-only orchestrator authority from the captured host", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-raw-tool-call-actor-"));
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    zod: { z },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    setLabel() {},
    sendUserMessage() {},
  };
  const emit = async (name: string, event: unknown, ctx: unknown): Promise<unknown[]> =>
    Promise.all((handlers[name] ?? []).map(handler => handler(event, ctx)));
  const mutableManager = mutableSessionManagerFor(root, "session-direct");
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    ompWorkflowsFullstack(pi as never);
    const host = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      session_id: "session-direct",
      sessionManager: mutableManager,
    };
    await emit("session_start", { type: "session_start" }, host);
    const issued = await writeCheckpointAskFixture(root, tools, host);
    const runId = issued.state.issued_for!.run_key;
    const artifactsDir = runTarget(root, runId).artifactsDir!;
    // Idle stop releases the controller's exact claim while retaining the
    // selected run. The next raw call must remain denied until the registered
    // workflow_prepare resume rebinds that claim.
    await emit("session_stop", {
      type: "session_stop",
      session_id: mutableManager.getSessionId(),
      session_file: mutableManager.getSessionFile(),
    }, host);
    await emit("session_start", { type: "session_start" }, host);
    const raw = {
      sessionManager: mutableManager,
    };
    const invoke = async (input: Record<string, unknown>, ctx: unknown): Promise<{ block?: boolean; reason?: string } | undefined> => {
      const results = await emit("tool_call", { toolName: "write", input }, ctx);
      return results.find(value => value && typeof value === "object" && (value as { block?: unknown }).block === true) as { block?: boolean; reason?: string } | undefined;
    };
    const invokeBash = async (command: string, ctx: unknown): Promise<{ block?: boolean; reason?: string } | undefined> => {
      const results = await emit("tool_call", { toolName: "bash", input: { command } }, ctx);
      return results.find(value => value && typeof value === "object" && (value as { block?: unknown }).block === true) as { block?: boolean; reason?: string } | undefined;
    };
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, raw))?.reason, "trusted host actor unavailable");
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, { ...raw, hasUI: false }))?.block, true, "explicit headless raw context is rejected");
    const prepare = tools.get("workflow_prepare");
    if (!prepare) throw new Error("workflow_prepare was not registered");
    const prepared = await prepare.execute("raw-first-prepare", {
      mode: "resume",
      run_id: runId,
      branch: "main",
    }, undefined, undefined, host as never);
    const preparedDetails = prepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(preparedDetails.ok, true, preparedDetails.error);
    assert.equal(preparedDetails.state?.run_id, runId);
    assert.equal(await invoke({ path: join(artifactsDir, "discovery.json") }, raw), undefined);
    assert.equal((await invokeBash("git status --short", raw))?.block, true);
    assert.equal(
      (await invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false status --short", raw))?.block,
      undefined,
    );
    assert.equal((await invokeBash("git diff -- src/app.ts", raw))?.block, true);
    assert.equal(
      (await invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false diff --no-ext-diff --no-textconv -- src/app.ts", raw))?.block,
      undefined,
    );
    assert.equal((await invokeBash("git show --stat HEAD", raw))?.block, true);
    assert.equal(
      (await invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false show --no-ext-diff --no-textconv --stat HEAD", raw))?.block,
      undefined,
    );
    assert.equal((await invokeBash("git log -1 --oneline", raw))?.block, true);
    assert.equal(
      (await invokeBash("GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false log -1 --oneline", raw))?.block,
      undefined,
    );
    assert.equal((await invoke({ path: "src/app.ts", actor: "worker" }, raw))?.block, true);
    assert.equal((await invoke({ path: ".work-state/other.json" }, raw))?.block, true);
    assert.equal((await invokeBash("chmod 644 src/app.ts", raw))?.block, true);
    assert.equal((await invokeBash("chmod 644 .work-state/other.json", raw))?.block, true);
    assert.equal((await invokeBash(`echo changed > ${artifactsDir}/mutation.json`, raw))?.block, true);
    assert.equal((await invokeBash("echo changed > src/app.ts", raw))?.block, true);
    assert.equal((await invokeBash("echo changed > .work-state/other.json", raw))?.block, true);
    assert.equal((await invokeBash(`mkdir -p ${artifactsDir}/new`, raw))?.block, true);
    const foreign = {
      sessionManager: { getCwd: () => root, getSessionId: () => "foreign-session" },
    };
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, foreign))?.block, true);
    assert.equal((await invoke({ path: "src/app.ts" }, foreign))?.block, true);
    const foreignInteractive = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      session_id: "foreign-session",
      sessionManager: foreign.sessionManager,
      actor: "orchestrator",
    };
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, foreignInteractive))?.block, true);
    assert.equal(await invoke({ path: join(artifactsDir, "discovery.json") }, raw), undefined, "foreign raw context cannot replace the captured controller");
    // A conflicting event identity must not use the owner ctx as a bypass.
    const foreignEvent = {
      type: "session_stop",
      cwd: root,
      session_id: "foreign-session",
      session_file: join(root, ".omp", "sessions", "foreign-session.jsonl"),
    };
    await emit("session_stop", foreignEvent, host);
    await emit("session_shutdown", {
      type: "session_shutdown",
      cwd: root,
      session_id: "foreign-session",
      session_file: join(root, ".omp", "sessions", "foreign-session.jsonl"),
    }, host);
    assert.equal(await invoke({ path: join(artifactsDir, "discovery.json") }, raw), undefined);

    // Foreign lifecycle events cannot release the retained host claim.
    await emit("session_stop", {
      type: "session_stop",
      session_id: "foreign-session",
      session_file: join(root, ".omp", "sessions", "foreign-session.jsonl"),
    }, foreignInteractive);
    await emit("session_shutdown", {
      type: "session_shutdown",
      session_id: "foreign-session",
      session_file: join(root, ".omp", "sessions", "foreign-session.jsonl"),
    }, foreignInteractive);
    assert.equal(await invoke({ path: join(artifactsDir, "discovery.json") }, raw), undefined);

    // An exact idle stop releases the claim but retains the authenticated
    // controller/selection; a retained selection without a claim is not the
    // no-run branch and therefore receives no raw orchestrator actor.
    await emit("session_stop", {
      type: "session_stop",
      session_id: mutableManager.getSessionId(),
      session_file: mutableManager.getSessionFile(),
    }, host);
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, raw))?.reason, "trusted host actor unavailable");
    const resumed = await prepare.execute("raw-idle-resume", {
      mode: "resume",
      run_id: runId,
      branch: "main",
    }, undefined, undefined, host as never);
    const resumedDetails = resumed.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(resumedDetails.ok, true, resumedDetails.error);
    assert.equal(resumedDetails.state?.run_id, runId);
    assert.equal(await invoke({ path: join(artifactsDir, "discovery.json") }, raw), undefined, "atomic prepare rebinds raw orchestrator authority");

    // A real OMP replacement mutates the same manager before emitting
    // session_switch. The old ordinary claim must be released only after the
    // captured manager, old session file, and interactive profile agree.
    const previousSessionFile = mutableManager.getSessionFile();
    mutableManager.switchTo("replacement-session");
    const replacement = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      session_id: "replacement-session",
      sessionManager: mutableManager,
    };
    const staleRaw = { sessionManager: mutableManager, session_id: "session-direct" };
    await emit("session_switch", {
      type: "session_switch",
      reason: "resume",
      previousSessionFile,
    }, replacement);
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, staleRaw))?.block, true);
    const replacementPrepared = await prepare.execute("raw-replacement-prepare", {
      mode: "resume",
      run_id: runId,
      branch: "main",
    }, undefined, undefined, replacement as never);
    const replacementDetails = replacementPrepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(replacementDetails.ok, true, replacementDetails.error);
    assert.equal(replacementDetails.state?.run_id, runId);
    const replacementRaw = { sessionManager: mutableManager };
    assert.equal(await invoke({ path: join(artifactsDir, "discovery.json") }, replacementRaw), undefined);
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, staleRaw))?.block, true);
    await emit("session_shutdown", { type: "session_shutdown" }, replacement);
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, replacementRaw))?.block, true);

    // The same-identity headless start is an explicit invalidation boundary.
    const reboundHost = { ...replacement };
    await emit("session_start", { type: "session_start" }, reboundHost);
    const reboundPrepared = await prepare.execute("raw-rebind-after-shutdown", {
      mode: "resume",
      run_id: runId,
      branch: "main",
    }, undefined, undefined, reboundHost as never);
    const reboundDetails = reboundPrepared.details as { ok?: boolean; error?: string; state?: { run_id?: string } };
    assert.equal(reboundDetails.ok, true, reboundDetails.error);
    assert.equal(reboundDetails.state?.run_id, runId);
    await emit("session_start", { type: "session_start" }, { mode: "print", hasUI: false, cwd: root, session_id: "replacement-session", sessionManager: mutableManager });
    assert.equal((await invoke({ path: join(artifactsDir, "discovery.json") }, replacementRaw))?.block, true, "headless transition cannot retain orchestrator authority");
  } finally {
    await emit("session_shutdown", { type: "session_shutdown" }, { mode: "tui", hasUI: true, cwd: root, session_id: "replacement-session", sessionManager: mutableManager });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: captured claim-free host with no selected run reaches ordinary tools but keeps safety gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-raw-tool-call-no-run-"));
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const pi = {
    zod: { z },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool() {},
    registerCommand() {},
    setLabel() {},
    sendUserMessage() {},
  };
  const emit = async (name: string, event: unknown, ctx: unknown): Promise<unknown[]> =>
    Promise.all((handlers[name] ?? []).map(handler => handler(event, ctx)));
  const invoke = async (
    toolName: string,
    input: Record<string, unknown>,
    ctx: unknown,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    const results = await emit("tool_call", { toolName, input }, ctx);
    return results.find(value => value && typeof value === "object" && (value as { block?: unknown }).block === true) as { block?: boolean; reason?: string } | undefined;
  };
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    ompWorkflowsFullstack(pi as never);
    const host = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      session_id: "session-no-run",
      sessionManager: sessionManagerFor(root, "session-no-run"),
    };
    await emit("session_start", { type: "session_start" }, host);

    // With no selected run and no execution claim, the authenticated host
    // reaches the ordinary tool gates instead of the blanket admission block.
    assert.equal(await invoke("write", { path: "src/app.ts" }, {
      sessionManager: host.sessionManager,
    }), undefined);
    assert.equal(await invoke("edit", { path: "src/app.ts" }, {
      sessionManager: host.sessionManager,
    }), undefined);
    assert.equal(await invoke("bash", { command: "printf safe" }, {
      sessionManager: host.sessionManager,
    }), undefined);

    // Normal safety behavior remains active after the no-run admission.
    assert.equal((await invoke("write", { path: ".env" }, {
      sessionManager: host.sessionManager,
    }))?.block, true);
    assert.equal((await invoke("bash", { command: "rm -rf /" }, {
      sessionManager: host.sessionManager,
    }))?.block, true);

    // Foreign, copied-identity-mismatched, and headless contexts cannot use
    // the captured host's no-run authority, even when they forge an actor.
    const foreign = {
      actor: "orchestrator",
      sessionManager: { getCwd: () => root, getSessionId: () => "foreign-session" },
    };
    assert.equal((await invoke("write", { path: "src/app.ts" }, foreign))?.block, true);
    assert.equal((await invoke("write", { path: "src/app.ts" }, {
      actor: "orchestrator",
      session_id: "mismatched-session",
      sessionManager: host.sessionManager,
    }))?.block, true);
    await emit("session_start", { type: "session_start" }, {
      mode: "print",
      hasUI: false,
      cwd: root,
      session_id: host.session_id,
      sessionManager: host.sessionManager,
    });
    assert.equal((await invoke("write", { path: "src/app.ts" }, {
      sessionManager: host.sessionManager,
    }))?.block, true);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown" }, {
      mode: "tui",
      hasUI: true,
      cwd: root,
      session_id: "session-no-run",
      sessionManager: sessionManagerFor(root, "session-no-run"),
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask ingests the connected RPC client's select answer from the session profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-ask-rpc-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    const rpcToolContext = {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      session_id: "session-direct",
      sessionManager: sessionManagerFor(root, "session-direct"),
    };
    const ask = tools.get("workflow_checkpoint_ask")!;
    const calls: Array<{ title: string; options: string[] }> = [];
    // Plain-rpc session: the profile carries the live select bridge; the
    // per-call tool context stays UI-less exactly as the host wires it.
    await fireSessionStart({
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
    const issued = await writeCheckpointAskFixture(root, tools, rpcToolContext);
    const response = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, rpcToolContext as never);
    const details = response.details as { ok?: boolean; error?: string; decision?: string; loop_iteration?: number; channel?: string; actor_provenance?: { kind?: string } };
    assert.equal(details.ok, true, details.error);
    assert.equal(details.decision, "proceed");
    assert.equal(details.channel, "terminal");
    assert.equal(details.loop_iteration, issued.state.issued_for!.loop_iteration);
    assert.equal(details.actor_provenance?.kind, "user");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.options, ["proceed", "reject"]);
  } finally {
    await fireSessionShutdown({ cwd: root, hasUI: true, mode: "rpc" });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: workflow_checkpoint_ask fails closed in json/print headless sessions while the no-profile fallback keeps the legacy heuristic", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-checkpoint-ask-headless-"));
  const { tools, fireSessionStart, fireSessionShutdown } = registerToolsWithSessionSink();
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
    await fireSessionStart({ mode: "tui", hasUI: true, cwd: root, ui: {} });
    const issued = await writeCheckpointAskFixture(root, tools);
    const ask = tools.get("workflow_checkpoint_ask")!;

    for (const mode of ["json", "print"]) {
      await fireSessionStart({ mode, hasUI: false, cwd: root, ui: {} });
      const rejected = await ask.execute("test", checkpointAskAuth(issued), undefined, undefined, { cwd: root, hasUI: false } as never);
      assert.equal((rejected.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED", mode);
    }

    // No captured profile (older hosts, direct tool harnesses): the legacy
    // per-call heuristic decides — interactive contexts pass, worker
    // contexts are rejected.
    const fallbackTools = new Map<string, RegisteredTool>();
    registerCoreWorkflowTools({
      zod: { z },
      registerTool(tool: RegisteredTool) {
        fallbackTools.set(tool.name, tool);
      },
    } as never);
    const mainCtx = await fallbackTools.get("workflow_status")!.execute(
      "test",
      {},
      undefined,
      undefined,
      { cwd: root, hasUI: true, mode: "tui", session_id: "session-direct", sessionManager: sessionManagerFor(root, "session-direct") } as never,
    );
    assert.equal((mainCtx.details as { ok?: boolean }).ok, true);
    const workerCtx = await fallbackTools.get("workflow_status")!.execute("worker", {}, undefined, undefined, { cwd: root, hasUI: false } as never);
    assert.equal((workerCtx.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  } finally {
    await fireSessionShutdown({ cwd: root, hasUI: true, mode: "tui" });
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
