import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { once } from "node:events";
import { z } from "zod";
import { flushRecorder } from "../src/observability/hooks.js";
import {
  acquireExecutionClaim,
  beginCapability,
  createWorkflowSessionController,
  finalizeCanonicalRun,
  handoverExecutionClaim,
  listRuns,
  persistCanonicalRun,
  readRunState,
  runTarget,
  registerTeamWorkflow,
  registerWorkflowCommands,
  registerWorkflowTools,
  selectSession,
  updateCanonicalRun,
  workflowOwnerFor,
  run,
  registerWorkflowProfiles,
  type TaskCaller,
} from "../src/index.js";
import { acquireCtoIngress, suspendCtoSession } from "../src/cto/run.js";
import { appendWave, newCtoState, readCtoState, writeCtoState } from "../src/cto/state.js";
import { authorizeDispatch, completeDispatch, createCapability, materializeMigratedDispatches } from "../src/engine/durable.js";
import { beginLifecycleTransaction, recoverLifecycleTransactions, commitLifecycleTransaction } from "../src/engine/lifecycle-journal.js";
import { discoverLegacySources, migrateLegacySource } from "../src/engine/run-migration.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { buildDispatchMarker } from "../src/gates/dispatch.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { prepareWorkflowState } from "../src/engine/run.js";
import { publishCtoClaim, readRunControl, releaseExecutionClaim } from "../src/engine/run-store.js";
import { normalizePersistedState } from "../src/engine/state.js";
import { DISPATCH_ORIGIN_LOCATOR_ENV, rememberDispatchOriginLocator } from "../src/dispatch-origin-locator.js";
const coreIndexUrl = new URL("../src/index.ts", import.meta.url).href;
const ctoStateUrl = new URL("../src/cto/state.ts", import.meta.url).href;
const ctoRunEngineUrl = new URL("../src/cto/run.ts", import.meta.url).href;
const runStoreUrl = new URL("../src/engine/run-store.ts", import.meta.url).href;
const runEngineUrl = new URL("../src/engine/run.ts", import.meta.url).href;
const migrationEngineUrl = new URL("../src/engine/run-migration.ts", import.meta.url).href;
const durableEngineUrl = new URL("../src/engine/durable.ts", import.meta.url).href;
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

type ToolHandler = (...args: unknown[]) => unknown;
type RegisteredTool = { name: string; execute: (...args: unknown[]) => Promise<{ details: unknown }> };
type RegisteredCommand = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
type FakePi = {
  pi: {
    zod: { z: typeof z };
    setLabel: () => void;
    on: (name: string, handler: ToolHandler) => void;
    events: { on: (name: string, handler: ToolHandler) => void };
    registerTool: (tool: RegisteredTool) => void;
    registerCommand: (name: string, command: RegisteredCommand) => void;
    sendUserMessage: (prompt: string) => void;
  };
  handlers: Map<string, ToolHandler[]>;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  messages: string[];
  emit: (name: string, ...args: unknown[]) => Promise<unknown[]>;
};

const BRANCH = "feature/process-acceptance";
const CLASSIFICATION = { type: "FEATURE" as const, complexity: "QUICK" as const, confidence: "HIGH" as const, autonomous: false, workflow: "lightweight" };
const MIGRATION_PRODUCT_SPEC = JSON.stringify({
  recommendation: "proceed",
  value_proposition: "A traceable specification keeps migration inputs reviewable.",
  opportunity: "Legacy workflow inputs can be resumed without fabricating authority.",
  target_users: ["workflow maintainers"],
  solution_direction: "Preserve declared inputs and immutable evidence while migrating.",
  success_metrics: ["required product input is readable before dispatch"],
  guardrail_metrics: ["migration does not alter source bytes"],
  scope: ["legacy migration"],
  anti_scope: ["worker re-dispatch"],
  risks: ["source evidence may be incomplete"],
  validation_plan: [],
  evidence_trace: ["status: verified — migration fixture"],
  open_decisions: [],
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return root;
}
function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", BRANCH], { stdio: "ignore" });
}
function context(root: string, sessionId: string, processId = process.pid): TrustedExecutionContext {
  return { session_id: sessionId, caller: "host", process_id: processId, worktree: root, branch: BRANCH, authority: "coordinator" };
}
function preparedController(root: string, execution: TrustedExecutionContext, runId: string) {
  const controller = createWorkflowSessionController({ cwd: root, context: execution });
  const prepared = controller.prepare({ mode: "resume", run_id: runId });
  assert.equal(prepared.state.run_id, runId);
  assert.equal(controller.activeClaimRunId(), runId);
  return controller;
}
function identity(runId: string): WorkIdentity {
  return {
    run_id: runId, wave_id: "wave-1", slice_id: "slice-1", session_id: "worker-session", workflow: "lightweight",
    stage_id: "implementation", stage_cursor: "implementation", capability_id: "cap-old", capability_epoch: "epoch-old",
    loop_iteration: 1, slot_id: "dev", task_id: "task-1", dispatch_id: "dispatch-1", attempt: 1, worker_id: "worker-1",
  };
}
function canonicalState(runId: string, overrides: Partial<TeamState> = {}): TeamState {
  return {
    schema: 2, run_id: runId, run_key: runId, lifecycle_status: "active", rework_generation: 0,
    branch: BRANCH, title: "process acceptance", task: "process acceptance", classification: CLASSIFICATION,
    workflow_override: true, issue: null, stage_cursor: "implementation", stages: [{ id: "implementation", status: "in_progress" }],
    required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] }, required_input_receipts: {},
    artifacts: { discovery: "artifacts/discovery.json" }, pause: { kind: "none", reason: "" }, policy: { strict_orchestrator: true },
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "dev" },
    profile_hash: profileHash(loadProfile("lightweight")!), updated_at: new Date().toISOString(), ...overrides,
  };
}
function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({
    roles: { dev: "dev" },
    scope_map: [{ glob: ["**/*"], scope: "dev", dev_agent: "dev" }],
  }) + "\n");
  const config = resolveConfig(root);
  writeAgentMapping(root, buildAgentMapping({ roles: config.roles, availableAgents: ["dev"], extraRoles: config.scope_map.map((entry) => entry.dev_agent), genericFallbackRoles: ["dev"] }));
}
function fakePi(): FakePi {
  const handlers = new Map<string, ToolHandler[]>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const messages: string[] = [];
  const on = (name: string, handler: ToolHandler): void => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  return {
    handlers, tools, commands, messages,
    pi: {
      zod: { z },
      setLabel() {},
      on,
      events: { on },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      sendUserMessage(prompt) { messages.push(prompt); },
    },
    async emit(name, ...args) {
      return Promise.all((handlers.get(name) ?? []).map((handler) => handler(...args)));
    },
  };
}
function childScript(script: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, ...args], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}
type ClaimHolder = { child: ChildProcess; ready: Promise<void> };
function holdClaim(root: string, runId: string): ClaimHolder {
  const script = `const { acquireExecutionClaim } = await import(${JSON.stringify(coreIndexUrl)}); const [root,runId]=process.argv.slice(1); acquireExecutionClaim(root,{run_id:runId,context:{session_id:'dead-coordinator',caller:'host',process_id:process.pid,worktree:root,branch:'${BRANCH}',authority:'coordinator'},worker_ids:['worker-pending']}); console.log('ready'); process.stdin.resume();`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, runId], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`claim holder readiness timed out; output=${output}`));
      child.kill("SIGKILL");
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; if (!settled && output.includes("ready")) { settled = true; clearTimeout(timeout); resolve(); } });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.once("close", (code, signal) => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`claim holder exited before readiness (${code ?? signal ?? "unknown"}); output=${output}`)); }
    });
  });
  return { child, ready };
}
function waitChildClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}
function blockOnMarker(script: string, args: string[], marker: string): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, ...args], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`fault child readiness timed out; output=${output}`));
      child.kill("SIGKILL");
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!settled && output.includes(marker)) { settled = true; clearTimeout(timeout); resolve(); }
    });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.once("close", (code, signal) => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`fault child exited before marker (${code ?? signal ?? "unknown"}); output=${output}`)); }
    });
  });
  return { child, ready };
}
function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// Host03: tool callbacks use the controller's immutable selected run, not the previous cwd cache.
test("process acceptance: host tool events rotate observability from A to B without before_agent_start", async () => {
  const root = scratch("rl-host-observability");
  try {
    initGit(root);
    const controller = createWorkflowSessionController({ cwd: root, context: context(root, "host-observability") });
    const bus = fakePi();
    registerTeamWorkflow(bus.pi as never, { cwd: root, observability: true, getSessionController: () => controller });
    const a = controller.prepare({ mode: "new", task: "A", classification: CLASSIFICATION });
    await bus.emit("tool_call", { toolName: "workflow_status", toolCallId: "call-a", input: {} }, { cwd: root, session_id: "host-observability" });
    const b = controller.prepare({ mode: "new", task: "B", classification: CLASSIFICATION });
    await bus.emit("tool_call", { toolName: "workflow_status", toolCallId: "call-b", input: {} }, { cwd: root, session_id: "host-observability" });
    await flushRecorder(root);
    const aEvents = readFileSync(join(root, ".work-state", "runs", a.state.run_id!, "observability", "events.jsonl"), "utf8");
    const bEvents = readFileSync(join(root, ".work-state", "runs", b.state.run_id!, "observability", "events.jsonl"), "utf8");
    assert.match(aEvents, /call-a/);
    assert.match(bEvents, /call-b/);
    assert.doesNotMatch(bEvents, /call-a/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Host05/11: the read-only list snapshot is the exact selector consumed by prepare.
test("process acceptance: public list snapshot item resolves into prepare without control mutation", () => {
  const root = scratch("rl-host-list-snapshot");
  try {
    initGit(root);
    const controller = createWorkflowSessionController({ cwd: root, context: context(root, "list-session") });
    const first = controller.prepare({ mode: "new", task: "snapshot target", classification: CLASSIFICATION });
    const beforeList = readRunControl(root);
    const snapshot = controller.readSelector().list({ branch: BRANCH });
    const afterList = readRunControl(root);
    assert.deepEqual(afterList, beforeList, "read-only list must not mutate run-control");
    assert.ok(snapshot.snapshot_id);
    const item = snapshot.candidates.findIndex((candidate) => candidate.run_id === first.state.run_id);
    assert.ok(item >= 0);
    const selected = controller.prepare({
      mode: "resume",
      selector: { list_item: { snapshot_id: snapshot.snapshot_id, index: item, run_id: first.state.run_id! } },
    });
    assert.equal(selected.state.run_id, first.state.run_id);
    assert.equal(selected.transition?.operation, "resume");
    const after = readRunControl(root);
    assert.deepEqual(after.selection_snapshots, beforeList.selection_snapshots);
    assert.equal(after.runs[first.state.run_id!]?.run_id, beforeList.runs[first.state.run_id!]?.run_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Host02: retries are keyed by the host call id, not task text.
test("process acceptance: workflow_prepare host retry exact-replays and rejects changed payload", async () => {
  const root = scratch("rl-host-retry");
  try {
    initGit(root);
    const controller = createWorkflowSessionController({ cwd: root, context: context(root, "retry-session") });
    const bus = fakePi();
    registerWorkflowTools(bus.pi as never, { cwd: root, getSessionController: () => controller });
    await bus.emit("session_start", {}, { cwd: root, mode: "tui", hasUI: true, session_id: "retry-session" });
    const prepare = bus.tools.get("workflow_prepare");
    assert.ok(prepare);
    const params = { mode: "new", task: "retry task", branch: BRANCH, classification: CLASSIFICATION };
    const first = await prepare.execute("host-call-42", params, undefined, undefined, { cwd: root, hasUI: true, session_id: "retry-session" });
    const replay = await prepare.execute("host-call-42", params, undefined, undefined, { cwd: root, hasUI: true, session_id: "retry-session" });
    const changed = await prepare.execute("host-call-42", { ...params, task: "changed task" }, undefined, undefined, { cwd: root, hasUI: true, session_id: "retry-session" });
    const f = record(first.details); const r = record(replay.details); const c = record(changed.details);
    assert.equal(f.ok, true); assert.equal(r.ok, true);
    const fTransition = record(f.transition); const rTransition = record(r.transition);
    assert.equal(rTransition.selected_run_id, fTransition.selected_run_id);
    assert.equal(listRuns(root, { branch: BRANCH }).length, 1);
    assert.equal(c.ok, false);
    assert.match(String(c.error), /lifecycle_request_conflict|different payload/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process acceptance: registered cto_state performs read/CAS/barrier/terminal lifecycle", async () => {
  const root = scratch("rl-registered-cto-state");
  try {
    initGit(root);
    const ownerSessionFile = join(root, "registered-cto-owner.jsonl");
    const ownerManager = {
      getCwd: () => root,
      getSessionId: () => "registered-cto-owner",
      getSessionFile: () => ownerSessionFile,
      getHeader: () => ({ id: "registered-cto-owner", cwd: root }),
    };
    const ownerContext = {
      ...context(root, "registered-cto-owner"),
      cwd: root,
      mode: "tui",
      hasUI: true,
      sessionFile: ownerSessionFile,
      sessionManager: ownerManager,
      ui: { notify() {} },
    };
    const ownerController = createWorkflowSessionController({ cwd: root, context: context(root, ownerContext.session_id) });
    const foreignSessionFile = join(root, "registered-cto-foreign.jsonl");
    const foreignManager = {
      getCwd: () => root,
      getSessionId: () => "registered-cto-foreign",
      getSessionFile: () => foreignSessionFile,
      getHeader: () => ({ id: "registered-cto-foreign", cwd: root }),
    };
    const foreignContext = {
      ...context(root, "registered-cto-foreign"),
      cwd: root,
      mode: "tui",
      hasUI: true,
      sessionFile: foreignSessionFile,
      sessionManager: foreignManager,
      ui: { notify() {} },
    };
    const foreignController = createWorkflowSessionController({ cwd: root, context: context(root, foreignContext.session_id) });
    const bus = fakePi();
    const registrationOptions = {
      cwd: root,
      resolveCwd: () => root,
      observability: false,
      getSessionController: (value: unknown) => value === ownerContext
        ? ownerController
        : value === foreignContext
          ? foreignController
          : undefined,
    };
    registerTeamWorkflow(bus.pi as never, registrationOptions);
    registerWorkflowTools(bus.pi as never, registrationOptions);
    registerWorkflowCommands(bus.pi as never, registrationOptions);
    await bus.emit("session_start", { type: "session_start" }, ownerContext);
    const ctoCommand = bus.commands.get("cto");
    assert.ok(ctoCommand, "registered /cto command is present");
    await ctoCommand.handler("registered cto state", ownerContext);
    assert.equal(bus.messages.length, 1, "registered /cto command sends exactly one prompt");
    const ingressRunId = readRunControl(root).execution_claim?.run_id;
    assert.ok(ingressRunId, "registered /cto command acquires a claim before prompting");
    const ingressState = readCtoState(ingressRunId, root);
    assert.ok(ingressState);
    const ingress = { run_id: ingressRunId, state: ingressState };
    const ctoState = bus.tools.get("cto_state");
    assert.ok(ctoState);
    const invoke = async (callId: string, value: unknown, executionContext = ownerContext) =>
      record((await ctoState.execute(callId, value, undefined, undefined, executionContext)).details);
    const read = async (callId: string, executionContext = ownerContext) =>
      invoke(callId, { operation: "read", run_id: ingress.run_id }, executionContext);
    const ownerRead = await read("registered-cto-read-r1");
    assert.equal(ownerRead.ok, true, JSON.stringify(ownerRead));
    const revisionR1 = String(ownerRead.state_revision);
    const statePath = join(root, ".work-state", "cto", ingress.run_id, "state.json");
    const domainR2 = readCtoState(ingress.run_id, root);
    assert.ok(domainR2);
    appendWave(domainR2!, {
      id: "wave-domain-r2",
      source: "acceptance",
      source_id: "domain-r2",
      task: "domain inbox wave",
    }, root);
    const beforeStale = readFileSync(statePath, "utf8");
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeStaleControl = readFileSync(controlPath, "utf8");
    const stale = structuredClone(ownerRead.state) as Record<string, unknown>;
    stale.pause = { kind: "none", reason: "stale overwrite" };
    const staleResult = record((await ctoState.execute(
      "registered-cto-stale",
      { operation: "commit", run_id: ingress.run_id, expected_state_revision: revisionR1, state: stale },
      undefined,
      undefined,
      ownerContext,
    )).details);
    assert.equal(staleResult.ok, false);
    assert.match(String(staleResult.error), /stale|revision|conflict/i);
    assert.equal(readFileSync(statePath, "utf8"), beforeStale, "stale registered commit preserves domain wave bytes");
    assert.equal(readFileSync(controlPath, "utf8"), beforeStaleControl, "stale registered commit preserves control bytes");

    const progressRead = await read("registered-cto-read-progress");
    const progress = structuredClone(progressRead.state) as Record<string, unknown>;
    progress.pause = { kind: "none", reason: "progress" };
    const committedProgress = record((await ctoState.execute(
      "registered-cto-commit-progress",
      { operation: "commit", run_id: ingress.run_id, expected_state_revision: String(progressRead.state_revision), state: progress },
      undefined,
      undefined,
      ownerContext,
    )).details);
    assert.equal(committedProgress.ok, true, JSON.stringify(committedProgress));

    const beforeForeignState = readFileSync(statePath, "utf8");
    const beforeForeignControl = readFileSync(controlPath, "utf8");
    const foreignRead = await read("registered-cto-foreign-read", foreignContext);
    assert.equal(foreignRead.ok, false);
    assert.equal(foreignRead.code, "WORKFLOW_CONTEXT_REJECTED");
    assert.equal(readFileSync(statePath, "utf8"), beforeForeignState, "foreign read preserves domain state bytes");
    assert.equal(readFileSync(controlPath, "utf8"), beforeForeignControl, "foreign read preserves control bytes");

    const freshRead = await read("registered-cto-read-r2");
    const pending = structuredClone(freshRead.state) as Record<string, unknown>;
    pending.pending = { identity: identity(ingress.run_id), status: "pending", updated_at: new Date().toISOString() };
    const malformedTyped = structuredClone(freshRead.state) as Record<string, unknown>;
    malformedTyped.pending = { identity: identity(ingress.run_id), status: "bogus", updated_at: new Date().toISOString() };
    malformedTyped.child_join = {};
    malformedTyped.completion_envelope = { outcome: "pending" };
    const beforeMalformedState = readFileSync(statePath, "utf8");
    const beforeMalformedControl = readFileSync(controlPath, "utf8");
    const malformedResult = record((await ctoState.execute(
      "registered-cto-malformed-typed",
      { operation: "commit", run_id: ingress.run_id, expected_state_revision: String(freshRead.state_revision), state: malformedTyped },
      undefined,
      undefined,
      ownerContext,
    )).details);
    assert.equal(malformedResult.ok, false);
    assert.match(String(malformedResult.error), /pending|child_join|completion|invalid/i);
    assert.equal(readFileSync(statePath, "utf8"), beforeMalformedState, "malformed typed candidate preserves state bytes");
    assert.equal(readFileSync(controlPath, "utf8"), beforeMalformedControl, "malformed typed candidate preserves control bytes");
    const pendingCommit = record((await ctoState.execute(
      "registered-cto-pending",
      { operation: "commit", run_id: ingress.run_id, expected_state_revision: String(freshRead.state_revision), state: pending },
      undefined,
      undefined,
      ownerContext,
    )).details);
    assert.equal(pendingCommit.ok, true, JSON.stringify(pendingCommit));

    const pendingRead = await read("registered-cto-read-r3");
    const omission = structuredClone(pendingRead.state) as Record<string, unknown>;
    omission.pause = { kind: "done", reason: "finished" };
    delete omission.pending;
    const beforeBarrierDenial = readFileSync(statePath, "utf8");
    const barrierDenied = record((await ctoState.execute(
      "registered-cto-barrier-denied",
      { operation: "commit", run_id: ingress.run_id, expected_state_revision: String(pendingRead.state_revision), state: omission },
      undefined,
      undefined,
      ownerContext,
    )).details);
    assert.equal(barrierDenied.ok, false);
    assert.match(String(barrierDenied.error), /pending|barrier|busy/i);
    assert.equal(readFileSync(statePath, "utf8"), beforeBarrierDenial, "barrier denial preserves state bytes");

    const settled = structuredClone(pendingRead.state) as Record<string, unknown>;
    settled.pause = { kind: "done", reason: "finished" };
    (settled.pending as Record<string, unknown>).status = "succeeded";
    const terminal = record((await ctoState.execute(
      "registered-cto-terminal",
      { operation: "commit", run_id: ingress.run_id, expected_state_revision: String(pendingRead.state_revision), state: settled },
      undefined,
      undefined,
      ownerContext,
    )).details);
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    assert.equal(readRunControl(root).execution_claim, null, "terminal registered commit releases the claim");
    assert.equal(ownerController.activeCtoClaim(), undefined, "terminal commit clears only the originating binding");

    const next = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "next registered cto run",
      controller: ownerController,
    });
    assert.notEqual(next.run_id, ingress.run_id, "a released terminal run does not get reused for a new task");
    suspendCtoSession(ownerController, "session-shutdown");
    const firstRelease = readRunControl(root).cto_releases[next.run_id];
    assert.ok(firstRelease);
    const resumedController = createWorkflowSessionController({ cwd: root, context: context(root, "registered-cto-resume-1") });
    const resumed = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "resume registered cto run",
      run_id: next.run_id,
      controller: resumedController,
    });
    assert.equal(resumed.claim.claim.release_receipt, firstRelease?.release_receipt, "claimless reacquire carries the verified release receipt");
    suspendCtoSession(resumedController, "session-replacement");
    const resumedAgainController = createWorkflowSessionController({ cwd: root, context: context(root, "registered-cto-resume-2") });
    const resumedAgain = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "repeat resume registered cto run",
      run_id: next.run_id,
      controller: resumedAgainController,
    });
    assert.equal(resumedAgain.claim.claim.release_receipt, firstRelease?.release_receipt, "repeat suspension preserves original issuance receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("process acceptance: registered CTO journal faults retain A and protect foreign B", async () => {
  const root = scratch("rl-cto-terminal-journal");
  try {
    initGit(root);
    const owner = createWorkflowSessionController({ cwd: root, context: context(root, "journal-owner") });
    const ingress = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "journal terminal recovery",
      controller: owner,
    });
    suspendCtoSession(owner, "session-shutdown");
    const child = await childScript(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [root, runId] = process.argv.slice(1);
      const originalRename = fs.renameSync.bind(fs);
      let fault;
      const injected = [];
      fs.renameSync = ((from, to) => {
        originalRename(from, to);
        const destination = String(to);
        if (fault === "pre-marker" && destination.includes("/lifecycle-transactions/") && destination.endsWith("/transaction.json")) {
          fault = undefined;
          injected.push("pre-marker");
          throw new Error("cto terminal pre-marker fault");
        }
        if (fault === "post-state" && destination.includes("/.work-state/cto/") && destination.endsWith("/state.json")) {
          fault = undefined;
          injected.push("post-state");
          throw new Error("cto terminal post-state publication fault");
        }
      });
      syncBuiltinESMExports();
      const { z } = await import("zod");
      const {
        createWorkflowSessionController,
        readRunControl,
        recoverLifecycleTransactions,
        registerTeamWorkflow,
        registerWorkflowCommands,
        registerWorkflowTools,
      } = await import(${JSON.stringify(coreIndexUrl)});
      const { acquireCtoIngress, readCtoStateForModel, suspendCtoSession } = await import(${JSON.stringify(ctoRunEngineUrl)});
      const { setCtoPause } = await import(${JSON.stringify(ctoStateUrl)});
      const { ctoClaimCredentials } = await import(${JSON.stringify(new URL("../src/engine/host-controller.ts", import.meta.url).href)});
      const makeContext = (session_id, sessionFile) => ({
        session_id,
        caller: "host",
        process_id: process.pid,
        worktree: root,
        branch: ${JSON.stringify(BRANCH)},
        authority: "coordinator",
        cwd: root,
        mode: "tui",
        hasUI: true,
        sessionFile,
        sessionManager: {
          getCwd: () => root,
          getSessionId: () => session_id,
          getSessionFile: () => sessionFile,
          getHeader: () => ({ id: session_id, cwd: root }),
        },
        ui: { notify() {} },
      });
      const ownerFile = root + "/journal-owner.jsonl";
      const ownerContext = makeContext("journal-origin", ownerFile);
      const controllerA = createWorkflowSessionController({ cwd: root, context: {
        session_id: "journal-origin",
        caller: "host",
        process_id: process.pid,
        worktree: root,
        branch: ${JSON.stringify(BRANCH)},
        authority: "coordinator",
      }});
      const controllers = new Map([[ownerContext, controllerA]]);
      const handlers = new Map();
      const commands = new Map();
      const tools = new Map();
      const on = (name, handler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      };
      const pi = {
        zod: { z },
        events: { on },
        on,
        setLabel() {},
        registerTool(tool) { tools.set(tool.name, tool); },
        registerCommand(name, command) { commands.set(name, command); },
        sendUserMessage() {},
      };
      const registration = {
        cwd: root,
        resolveCwd: () => root,
        observability: false,
        getSessionController: (ctx) => controllers.get(ctx),
      };
      registerTeamWorkflow(pi, registration);
      registerWorkflowTools(pi, registration);
      registerWorkflowCommands(pi, registration);
      const originalReleaseA = readRunControl(root).cto_releases[runId];
      const reacquired = acquireCtoIngress({
        cwd: root,
        branch: ${JSON.stringify(BRANCH)},
        task: "journal terminal recovery",
        run_id: runId,
        controller: controllerA,
      });
      const statePath = reacquired.statePath;
      const controlPath = root + "/.work-state/run-control.json";
      const beforePreState = fs.readFileSync(statePath, "utf8");
      const beforePreControl = fs.readFileSync(controlPath, "utf8");
      fault = "pre-marker";
      let preFailed = false;
      try {
        setCtoPause(reacquired.state, "done", "journal pre-marker", root);
      } catch {
        preFailed = true;
      }
      const afterPreState = fs.readFileSync(statePath, "utf8");
      const afterPreControl = fs.readFileSync(controlPath, "utf8");
      const preCredentials = ctoClaimCredentials(controllerA);
      const preBindingRetained = preCredentials !== undefined
        && preCredentials.run_id === runId
        && preCredentials.token === reacquired.claim.claim.token
        && preCredentials.ownership_epoch === reacquired.claim.claim.ownership_epoch;
      recoverLifecycleTransactions(root);
      const afterRollbackState = fs.readFileSync(statePath, "utf8");
      const afterRollbackControl = fs.readFileSync(controlPath, "utf8");
      const preBindingVerified = controllerA.activeCtoClaim()?.run_id === runId;

      fault = "post-state";
      let postFailed = false;
      try {
        setCtoPause(reacquired.state, "done", "journal committed", root);
      } catch {
        postFailed = true;
      }
      const committedState = fs.readFileSync(statePath, "utf8");
      const committedControl = fs.readFileSync(controlPath, "utf8");
      recoverLifecycleTransactions(root);
      const recoveredRelease = readRunControl(root).cto_releases[runId];
      const originalIssuanceRetained = originalReleaseA !== undefined
        && recoveredRelease !== undefined
        && recoveredRelease.schema === originalReleaseA.schema
        && recoveredRelease.run_id === originalReleaseA.run_id
        && recoveredRelease.branch === originalReleaseA.branch
        && recoveredRelease.ownership_epoch === originalReleaseA.ownership_epoch
        && recoveredRelease.coordinator_session_id === originalReleaseA.coordinator_session_id
        && (recoveredRelease.coordinator_process_id ?? undefined) === (originalReleaseA.coordinator_process_id ?? undefined)
        && recoveredRelease.worker_ids.length === originalReleaseA.worker_ids.length
        && recoveredRelease.worker_ids.every((workerId, index) => workerId === originalReleaseA.worker_ids[index])
        && recoveredRelease.issuance_token === originalReleaseA.issuance_token
        && recoveredRelease.released_at === originalReleaseA.released_at
        && recoveredRelease.reason === originalReleaseA.reason
        && recoveredRelease.release_receipt === originalReleaseA.release_receipt
        && recoveredRelease.snapshot_hash === originalReleaseA.snapshot_hash;
      const recoveredControl = fs.readFileSync(controlPath, "utf8");
      const nextCommand = commands.get("cto");
      if (!nextCommand) throw new Error("registered /cto command is missing");
      await nextCommand.handler("journal next ingress", ownerContext);
      const nextRunId = readRunControl(root).execution_claim?.run_id;
      const nextBinding = nextRunId === undefined ? undefined : controllerA.activeCtoClaim()?.run_id;

      const controllerCFile = root + "/journal-c.jsonl";
      const controllerCContext = makeContext("journal-c", controllerCFile);
      const controllerC = createWorkflowSessionController({ cwd: root, context: {
        session_id: "journal-c",
        caller: "host",
        process_id: process.pid,
        worktree: root,
        branch: ${JSON.stringify(BRANCH)},
        authority: "coordinator",
      }});
      controllers.set(controllerCContext, controllerC);
      suspendCtoSession(controllerA, "session-replacement");
      const ingressC = acquireCtoIngress({
        cwd: root,
        branch: ${JSON.stringify(BRANCH)},
        task: "foreign B replacement",
        controller: controllerC,
      });
      fault = "post-state";
      try {
        setCtoPause(ingressC.state, "done", "late A cleanup", root);
      } catch {}
      recoverLifecycleTransactions(root);
      const controllerBFile = root + "/journal-b.jsonl";
      const controllerBContext = makeContext("journal-b", controllerBFile);
      const controllerB = createWorkflowSessionController({ cwd: root, context: {
        session_id: "journal-b",
        caller: "host",
        process_id: process.pid,
        worktree: root,
        branch: ${JSON.stringify(BRANCH)},
        authority: "coordinator",
      }});
      controllers.set(controllerBContext, controllerB);
      const ingressB = acquireCtoIngress({
        cwd: root,
        branch: ${JSON.stringify(BRANCH)},
        task: "foreign B current",
        controller: controllerB,
      });
      const foreignStateBefore = fs.readFileSync(ingressB.statePath, "utf8");
      const foreignControlBefore = fs.readFileSync(controlPath, "utf8");
      const foreignBindingBefore = controllerB.activeCtoClaim()?.run_id === ingressB.run_id;
      let lateCleanupRejected = false;
      try {
        readCtoStateForModel(controllerC, root, ingressC.run_id);
      } catch {
        lateCleanupRejected = true;
      }
      const foreignStateAfter = fs.readFileSync(ingressB.statePath, "utf8");
      const foreignControlAfter = fs.readFileSync(controlPath, "utf8");
      const foreignBindingAfter = controllerB.activeCtoClaim()?.run_id === ingressB.run_id;
      const cCredentials = ctoClaimCredentials(controllerC);
      const cBindingRetained = cCredentials !== undefined
        && cCredentials.run_id === ingressC.run_id
        && cCredentials.token === ingressC.claim.claim.token
        && cCredentials.ownership_epoch === ingressC.claim.claim.ownership_epoch;
      console.log("JOURNAL_RESULT " + JSON.stringify({
        preInjected: injected.includes("pre-marker"),
        preFailed,
        preBindingRetained,
        preBindingVerified,
        preStateUnchanged: beforePreState === afterPreState && beforePreState === afterRollbackState,
        preControlUnchanged: beforePreControl === afterPreControl && beforePreControl === afterRollbackControl,
        postInjected: injected.includes("post-state"),
        postFailed,
        committedStateChanged: committedState !== beforePreState,
        committedControlChanged: committedControl !== beforePreControl,
        recoveredControlChanged: recoveredControl !== beforePreControl,
        originalIssuanceRetained,
        nextRunId,
        nextBinding,
        foreignRunId: ingressB.run_id,
        foreignStatePreserved: foreignStateBefore === foreignStateAfter,
        foreignControlPreserved: foreignControlBefore === foreignControlAfter,
        foreignBindingBefore,
        foreignBindingAfter,
        lateCleanupRejected,
        cBindingRetained,
      }));
      suspendCtoSession(controllerB, "session-shutdown");
    `, [root, ingress.run_id]);
    assert.equal(child.code, 0, child.output);
    const resultLine = child.output.split("\n").find((line) => line.startsWith("JOURNAL_RESULT "));
    assert.ok(resultLine, child.output);
    const result = JSON.parse(resultLine!.slice("JOURNAL_RESULT ".length)) as Record<string, unknown>;
    assert.equal(result.preInjected, true, child.output);
    assert.equal(result.preFailed, true, child.output);
    assert.equal(result.preBindingRetained, true, child.output);
    assert.equal(result.preBindingVerified, true, child.output);
    assert.equal(result.preStateUnchanged, true, child.output);
    assert.equal(result.preControlUnchanged, true, child.output);
    assert.equal(result.postInjected, true, child.output);
    assert.equal(result.postFailed, true, child.output);
    assert.equal(result.committedStateChanged, true, child.output);
    assert.equal(result.committedControlChanged, false, child.output);
    assert.equal(result.recoveredControlChanged, true, child.output);
    assert.equal(result.originalIssuanceRetained, true, child.output);
    assert.match(String(result.nextRunId), /^journal-next-ingress-/);
    assert.equal(result.nextBinding, result.nextRunId, child.output);
    assert.equal(result.foreignStatePreserved, true, child.output);
    assert.equal(result.foreignControlPreserved, true, child.output);
    assert.equal(result.foreignBindingBefore, true, child.output);
    assert.equal(result.foreignBindingAfter, true, child.output);
    assert.equal(result.lateCleanupRejected, true, child.output);
    assert.equal(result.cBindingRetained, true, child.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// Host10: terminal ownership is detached while historical state remains readable.
test("process acceptance: releasing a terminal controller clears selected enforcement", () => {
  const root = scratch("rl-host-terminal-detach");
  try {
    initGit(root);
    const controller = createWorkflowSessionController({ cwd: root, context: context(root, "terminal-session") });
    const prepared = controller.prepare({ mode: "new", task: "terminal", classification: CLASSIFICATION });
    const claim = readRunControl(root).execution_claim;
    assert.ok(claim);
    updateCanonicalRun(root, prepared.state.run_id!, (state) => ({
      ...state,
      stages: state.stages.map((stage) => ({ ...stage, status: "done" as const })),
      pause: { kind: "none", reason: "" },
    }));
    finalizeCanonicalRun(root, prepared.state.run_id!, claim.token);
    assert.equal(readRunState(root, prepared.state.run_id!)?.lifecycle_status, "complete");
    assert.equal(controller.selectedRunId(), undefined);
    const second = createWorkflowSessionController({ cwd: root, context: context(root, "terminal-reader") });
    selectSession(root, context(root, "terminal-reader"), prepared.state.run_id!, BRANCH, true);
    assert.equal(second.selectedRunId(), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
// Invalid canonical JSON cannot be treated as quiescent while releasing a live reservation.
test("process acceptance: invalid canonical state blocks claim release and preserves ownership", () => {
  const root = scratch("rl-invalid-release");
  try {
    initGit(root);
    const runId = randomUUID();
    const execution = context(root, "invalid-release");
    persistCanonicalRun(root, canonicalState(runId), { context: execution });
    const claim = readRunControl(root).execution_claim;
    assert.ok(claim);
    writeFileSync(join(root, ".work-state", "runs", runId, "state.json"), "{}\n");
    assert.throws(
      () => releaseExecutionClaim(root, { run_id: runId, token: claim.token, receipt: "invalid-state" }),
      (error: unknown) => { assert.equal(record(error).code, "recovery_required"); return true; },
    );
    assert.deepEqual(readRunControl(root).execution_claim, claim);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
// A legacy claim attachment must reject a malformed canonical CTO image before
// it can acquire a new claim, while preserving both persisted images.
test("process acceptance: malformed legacy CTO publication fails closed under the workspace lock", () => {
  const root = scratch("rl-malformed-cto-publication");
  try {
    const runId = "malformed-cto-publication";
    const sessionId = "legacy-cto-owner";
    const execution = context(root, sessionId);
    const planCreatedAt = "2026-09-24T00:00:00.000Z";
    const state = newCtoState({
      id: runId,
      task: "legacy CTO publication",
      branch: BRANCH,
      autonomous: false,
      owner_session: sessionId,
      plan: { id: runId, task: "legacy CTO publication", teams: [], created_at: planCreatedAt },
    });
    writeCtoState(state, root);
    const statePath = join(root, ".work-state", "cto", runId, "state.json");
    const malformed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    (malformed.plan as Record<string, unknown>).created_at = "";
    const malformedBytes = `${JSON.stringify(malformed, null, 2)}\n`;
    writeFileSync(statePath, malformedBytes);
    assert.equal(malformed.schema, 2);
    assert.equal(malformed.id, runId);
    assert.equal(malformed.task, state.task);
    assert.equal(malformed.branch, BRANCH);

    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = existsSync(controlPath) ? readFileSync(controlPath, "utf8") : null;
    assert.throws(
      () => publishCtoClaim(root, {
        run_id: runId,
        branch: BRANCH,
        context: execution,
        state_snapshot: { branch: BRANCH, terminal: false, owner_session: sessionId },
        legacy_owner_session_id: sessionId,
      }),
      (error: unknown) => {
        const value = record(error);
        assert.equal(value.code, "recovery_required");
        assert.match(String(value.message), /plan\.created_at/);
        return true;
      },
    );
    assert.equal(readFileSync(statePath, "utf8"), malformedBytes);
    assert.equal(existsSync(controlPath), beforeControl !== null);
    if (beforeControl !== null) assert.equal(readFileSync(controlPath, "utf8"), beforeControl);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// A child killed during artifact snapshot must leave the prior claim, selection, and state intact.
test("process acceptance: interrupted rework snapshot preserves prior ownership", async () => {
  const root = scratch("rl-rework-snapshot-crash");
  let child: ChildProcess | undefined;
  try {
    initGit(root);
    const runId = randomUUID();
    const owner = context(root, "rework-owner");
    persistCanonicalRun(root, canonicalState(runId), { context: owner });
    const artifacts = join(root, ".work-state", "runs", runId, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "snapshot evidence" }));
    updateCanonicalRun(root, runId, (state) => ({
      ...state,
      lifecycle_status: "complete",
      pause: { kind: "done", reason: "completed" },
      stages: state.stages.map((stage) => ({ ...stage, status: "done" as const })),
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      artifacts: { discovery: "artifacts/discovery.json" },
    }));
    const statePath = join(root, ".work-state", "runs", runId, "state.json");
    const liveClaim = readRunControl(root).execution_claim;
    assert.ok(liveClaim);
    releaseExecutionClaim(root, { run_id: runId, token: liveClaim!.token, receipt: "rework-snapshot-setup-release" });
    const beforeState = readFileSync(statePath, "utf8");
    const beforeControl = readFileSync(join(root, ".work-state", "run-control.json"), "utf8");
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [root, runId] = process.argv.slice(1);
      const originalRead = fs.readFileSync.bind(fs);
      const blocker = new Int32Array(new SharedArrayBuffer(4));
      fs.readFileSync = ((path, ...args) => {
        if (String(path).includes("/runs/" + runId + "/artifacts/")) {
          console.log("rework-snapshot-read");
          Atomics.wait(blocker, 0, 0);
        }
        return originalRead(path, ...args);
      });
      syncBuiltinESMExports();
      const { prepareWorkflowState } = await import(${JSON.stringify(runEngineUrl)});
      await prepareWorkflowState({
        cwd: root, branch: ${JSON.stringify(BRANCH)}, task: "ignored", autonomous: false,
        classification: ${JSON.stringify(CLASSIFICATION)}, files: [], issue: null, mode: "rework",
        run_id: runId, feedback: "snapshot fault", affected_stage: "implementation",
        request_id: "snapshot-fault-rework",
        execution: { session_id: "rework-child", caller: "host", process_id: process.pid, worktree: root, branch: ${JSON.stringify(BRANCH)}, authority: "coordinator" },
      });
    `;
    const blocked = blockOnMarker(script, [root, runId], "rework-snapshot-read");
    child = blocked.child;
    await blocked.ready;
    child.kill("SIGKILL");
    await waitChildClose(child);
    const recoveryReader = createWorkflowSessionController({ cwd: root, context: context(root, "rework-recovery-reader") });
    recoveryReader.readSelector().list({ branch: BRANCH });
    assert.equal(readFileSync(statePath, "utf8"), beforeState);
    assert.equal(readFileSync(join(root, ".work-state", "run-control.json"), "utf8"), beforeControl);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitChildClose(child);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
// A cold process rebuilds native-result origin from persisted authorization and the original input marker.
test("process acceptance: cold native result replay mutates the origin run once", async () => {
  const root = scratch("rl-cold-native-result");
  const locatorRoot = scratch("rl-cold-native-result-locator");
  const previousLocatorRoot = process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
  process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = locatorRoot;
  try {
    initGit(root); publishMapping(root);
    const runId = randomUUID();
    const owner = context(root, "native-origin");
    persistCanonicalRun(root, canonicalState(runId), { context: owner });
    const artifacts = join(root, ".work-state", "runs", runId, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "native result" }));
    const controller = preparedController(root, owner, runId);
    const begun = beginCapability(root, undefined, { runId });
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    const stage = loadProfile("lightweight")!.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["dev"], "dev", begun.handoff.cursor_epoch);
    const input = { agent: "dev", role: "dev", task: marker };
    const bus = fakePi();
    registerTeamWorkflow(bus.pi as never, { cwd: root, observability: false, getSessionController: () => controller });
    const hookResults = await bus.emit("tool_call", { toolName: "task", toolCallId: "cold-tool", input }, { cwd: root, hasUI: false, session_id: owner.session_id });
    assert.ok(hookResults.every((result) => !result || !(typeof result === "object" && (result as Record<string, unknown>).block === true)), JSON.stringify(hookResults));
    assert.equal(readRunState(root, runId)?.dispatch_capability?.dispatches[0]?.status, "authorized");
    const child = await childScript(`
      const { createWorkflowSessionController, registerTeamWorkflow } = await import(${JSON.stringify(coreIndexUrl)});
      const [root, marker, originSession] = process.argv.slice(1);
      const handlers = {};
      const pi = {
        setLabel() {},
        on(name, handler) { (handlers[name] ??= []).push(handler); },
      };
      const controller = createWorkflowSessionController({ cwd: root, context: { session_id: originSession, caller: "host", process_id: process.pid, worktree: root, branch: ${JSON.stringify(BRANCH)}, authority: "coordinator" } });
      registerTeamWorkflow(pi, { cwd: root, observability: false, getSessionController: () => controller });
      console.log(JSON.stringify({ registeredHandlers: Object.keys(handlers), originSession }));
      const event = {
        toolName: "task", toolCallId: "cold-tool",
        input: { agent: "dev", role: "dev", task: marker },
        content: [{ type: "text", text: "cold process complete" }],
        isError: false,
        details: { results: [{ index: 0, task: marker, id: "cold-result", exitCode: 0, output: "cold process complete", stderr: "" }] },
      };
      const first = [];
      for (const handler of handlers.tool_result ?? []) first.push(await handler(event, { cwd: root, session_id: "cold-replay" }));
      const second = [];
      for (const handler of handlers.tool_result ?? []) second.push(await handler(event, { cwd: root, session_id: "cold-replay" }));
      console.log(JSON.stringify({ first, second }));
    `, [root, marker, owner.session_id]);
    assert.equal(child.code, 0, child.output);
    assert.equal(child.signal, null);
    const state = readRunState(root, runId)!;
    const dispatches = state.dispatch_capability?.dispatches ?? [];
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]?.status, "succeeded");
    assert.equal(dispatches[0]?.work_identity?.run_id, runId);
    assert.equal(dispatches[0]?.completion?.evidence, "cold process complete");
    assert.equal(dispatches[0]?.completion?.work_identity?.dispatch_id, dispatches[0]?.id);
  } finally {
    if (previousLocatorRoot === undefined) delete process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
    else process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = previousLocatorRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(locatorRoot, { recursive: true, force: true });
  }
});

// A fresh host session with no selected run still reconciles through the
// exact persisted dispatch ledger; callback session identity is unrelated.
test("process acceptance: fresh-session late native result uses exact durable locator", async () => {
  const root = scratch("rl-fresh-session-durable-result");
  const locatorRoot = scratch("rl-fresh-session-durable-result-locator");
  const previousLocatorRoot = process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
  process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = locatorRoot;
  try {
    initGit(root); publishMapping(root);
    const runId = randomUUID();
    const owner = context(root, "durable-origin");
    persistCanonicalRun(root, canonicalState(runId), { context: owner });
    const artifacts = join(root, ".work-state", "runs", runId, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "fresh session result" }));
    const ownerController = preparedController(root, owner, runId);
    const begun = beginCapability(root, undefined, { runId });
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.ok(begun.ok && begun.handoff);
    const stage = loadProfile("lightweight")!.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["dev"], "dev", begun.handoff.cursor_epoch);
    const input = { agent: "dev", role: "dev", task: marker };
    const ownerBus = fakePi();
    registerTeamWorkflow(ownerBus.pi as never, { cwd: root, observability: false, getSessionController: () => ownerController });
    const hookResults = await ownerBus.emit("tool_call", { toolName: "task", toolCallId: "fresh-session-tool", input }, { cwd: root, hasUI: false, session_id: owner.session_id });
    assert.ok(hookResults.every((result) => !result || !(typeof result === "object" && (result as Record<string, unknown>).block === true)), JSON.stringify(hookResults));
    assert.equal(readRunState(root, runId)?.dispatch_capability?.dispatches[0]?.status, "authorized");

    const child = await childScript(`
      const { createWorkflowSessionController, registerTeamWorkflow } = await import(${JSON.stringify(coreIndexUrl)});
      const [root, marker] = process.argv.slice(1);
      const handlers = {};
      const pi = {
        setLabel() {},
        on(name, handler) { (handlers[name] ??= []).push(handler); },
      };
      const controller = createWorkflowSessionController({ cwd: root, context: { session_id: "fresh-host-session", caller: "host", process_id: process.pid, worktree: root, branch: ${JSON.stringify(BRANCH)}, authority: "coordinator" } });
      if (controller.selectedRunId() !== undefined) throw new Error("fresh host session unexpectedly inherited a selected run");
      registerTeamWorkflow(pi, { cwd: root, observability: false, getSessionController: () => controller });
      const event = {
        toolName: "task", toolCallId: "fresh-session-tool",
        input: { agent: "dev", role: "dev", task: marker },
        content: [{ type: "text", text: "fresh-session complete" }],
        isError: false,
        details: { results: [{ index: 0, task: marker, id: "fresh-session-result", exitCode: 0, output: "fresh-session complete", stderr: "" }] },
      };
      for (const handler of handlers.tool_result ?? []) await handler(event, { cwd: root, session_id: "late-callback-session" });
      console.log(JSON.stringify({ selectedRunId: controller.selectedRunId() ?? null }));
    `, [root, marker]);
    assert.equal(child.code, 0, child.output);
    assert.equal(child.signal, null);
    const state = readRunState(root, runId)!;
    assert.equal(state.dispatch_capability?.dispatches[0]?.status, "succeeded");
    assert.equal(state.dispatch_capability?.dispatches[0]?.completion?.evidence, "fresh-session complete");
  } finally {
    if (previousLocatorRoot === undefined) delete process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
    else process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = previousLocatorRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(locatorRoot, { recursive: true, force: true });
  }
});

test("process acceptance: fresh restart uses the persisted origin workspace", async () => {
  const rootA = scratch("rl-fresh-cross-worktree-a");
  const rootB = scratch("rl-fresh-cross-worktree-b");
  const locatorRoot = scratch("rl-fresh-cross-worktree-locator");
  const previousLocatorRoot = process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
  process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = locatorRoot;
  try {
    initGit(rootA); publishMapping(rootA);
    initGit(rootB); publishMapping(rootB);
    const runId = randomUUID();
    const owner = context(rootA, "cross-worktree-origin");
    persistCanonicalRun(rootA, canonicalState(runId), { context: owner });
    const artifacts = join(rootA, ".work-state", "runs", runId, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "cross-worktree fresh result" }));
    const ownerController = preparedController(rootA, owner, runId);
    const begun = beginCapability(rootA, undefined, { runId });
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.ok(begun.ok && begun.handoff);
    const stage = loadProfile("lightweight")!.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["dev"], "dev", begun.handoff.cursor_epoch);
    const input = { agent: "dev", role: "dev", task: marker };
    const ownerBus = fakePi();
    registerTeamWorkflow(ownerBus.pi as never, { cwd: rootA, observability: false, getSessionController: () => ownerController });
    const hookResults = await ownerBus.emit("tool_call", { toolName: "task", toolCallId: "cross-worktree-tool", input }, { cwd: rootA, hasUI: false, session_id: owner.session_id });
    assert.ok(hookResults.every((result) => !result || !(typeof result === "object" && (result as Record<string, unknown>).block === true)), JSON.stringify(hookResults));
    assert.equal(readRunState(rootA, runId)?.dispatch_capability?.dispatches[0]?.status, "authorized");
    const child = await childScript(`
      const { registerTeamWorkflow, createWorkflowSessionController } = await import(${JSON.stringify(coreIndexUrl)});
      const [root, marker] = process.argv.slice(1);
      const handlers = {};
      const pi = {
        setLabel() {},
        on(name, handler) { (handlers[name] ??= []).push(handler); },
      };
      const controller = createWorkflowSessionController({ cwd: root, context: { session_id: "fresh-cross-worktree-host", caller: "host", process_id: process.pid, worktree: root, branch: ${JSON.stringify(BRANCH)}, authority: "coordinator" } });
      registerTeamWorkflow(pi, { cwd: root, observability: false, getSessionController: () => controller });
      const event = {
        toolName: "task", toolCallId: "cross-worktree-tool",
        input: { agent: "dev", role: "dev", task: marker },
        content: [{ type: "text", text: "cross-worktree complete" }],
        isError: false,
        details: { results: [{ index: 0, task: marker, id: "cross-worktree-result", exitCode: 0, output: "cross-worktree complete", stderr: "" }] },
      };
      for (const handler of handlers.tool_result ?? []) await handler(event, { cwd: root, session_id: "fresh-cross-worktree-host" });
    `, [rootB, marker]);
    assert.equal(child.code, 0, child.output);
    assert.equal(child.signal, null);
    const state = readRunState(rootA, runId)!;
    assert.equal(state.dispatch_capability?.dispatches[0]?.status, "succeeded", "locator discovery must recover the original workspace before canonical verification");
    assert.equal(state.dispatch_capability?.dispatches[0]?.completion?.evidence, "cross-worktree complete");
  } finally {
    if (previousLocatorRoot === undefined) delete process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
    else process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = previousLocatorRoot;
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(locatorRoot, { recursive: true, force: true });
  }
});

test("process acceptance: ambiguous durable locator candidates reject without mutating either origin", async () => {
  const rootA = scratch("rl-ambiguous-origin-a");
  const rootB = scratch("rl-ambiguous-origin-b");
  const callbackRoot = scratch("rl-ambiguous-origin-callback");
  const locatorRoot = scratch("rl-ambiguous-origin-locator");
  const previousLocatorRoot = process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
  process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = locatorRoot;
  try {
    initGit(rootA); publishMapping(rootA);
    initGit(rootB); publishMapping(rootB);
    initGit(callbackRoot); publishMapping(callbackRoot);
    const runId = randomUUID();
    const owner = context(rootA, "ambiguous-origin");
    persistCanonicalRun(rootA, canonicalState(runId), { context: owner });
    const artifacts = join(rootA, ".work-state", "runs", runId, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "ambiguous locator" }));
    const ownerController = preparedController(rootA, owner, runId);
    const begun = beginCapability(rootA, undefined, { runId });
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.ok(begun.ok && begun.handoff);
    const stage = loadProfile("lightweight")!.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["dev"], "dev", begun.handoff.cursor_epoch);
    const input = { agent: "dev", role: "dev", task: marker };
    const ownerBus = fakePi();
    registerTeamWorkflow(ownerBus.pi as never, { cwd: rootA, observability: false, getSessionController: () => ownerController });
    const hookResults = await ownerBus.emit("tool_call", { toolName: "task", toolCallId: "ambiguous-origin-tool", input }, { cwd: rootA, hasUI: false, session_id: owner.session_id });
    assert.ok(hookResults.every((result) => !result || !(typeof result === "object" && (result as Record<string, unknown>).block === true)), JSON.stringify(hookResults));
    const originState = readRunState(rootA, runId)!;
    const dispatch = originState.dispatch_capability?.dispatches[0];
    assert.ok(dispatch);
    cpSync(join(rootA, ".work-state"), join(rootB, ".work-state"), { recursive: true });
    const identity = dispatch.work_identity;
    assert.equal(rememberDispatchOriginLocator("ambiguous-origin-tool", {
      cwd: rootB,
      run_id: runId,
      dispatch_id: dispatch.id,
      ...(dispatch.origin_session_id ? { origin_session_id: dispatch.origin_session_id } : {}),
      ...(identity?.capability_id ? { capability_id: identity.capability_id } : {}),
      ...(identity?.stage_id ? { stage_id: identity.stage_id } : {}),
      ...(identity?.capability_epoch ? { cursor_epoch: identity.capability_epoch } : {}),
      ...(identity?.slot_id ? { slot_id: identity.slot_id } : {}),
      ...(identity?.task_id ? { task_id: identity.task_id } : {}),
    }), true);
    const child = await childScript(`
      const { registerTeamWorkflow, createWorkflowSessionController } = await import(${JSON.stringify(coreIndexUrl)});
      const [root, marker] = process.argv.slice(1);
      const handlers = {};
      const pi = {
        setLabel() {},
        on(name, handler) { (handlers[name] ??= []).push(handler); },
      };
      const controller = createWorkflowSessionController({ cwd: root, context: { session_id: "ambiguous-callback", caller: "host", process_id: process.pid, worktree: root, branch: ${JSON.stringify(BRANCH)}, authority: "coordinator" } });
      registerTeamWorkflow(pi, { cwd: root, observability: false, getSessionController: () => controller });
      const event = {
        toolName: "task", toolCallId: "ambiguous-origin-tool",
        input: { agent: "dev", role: "dev", task: marker },
        content: [{ type: "text", text: "ambiguous complete" }],
        isError: false,
        details: { results: [{ index: 0, task: marker, id: "ambiguous-result", exitCode: 0, output: "ambiguous complete", stderr: "" }] },
      };
      for (const handler of handlers.tool_result ?? []) await handler(event, { cwd: root, session_id: "ambiguous-callback" });
    `, [callbackRoot, marker]);
    assert.equal(child.code, 0, child.output);
    assert.equal(child.signal, null);
    assert.equal(readRunState(rootA, runId)?.dispatch_capability?.dispatches[0]?.status, "authorized");
    assert.equal(readRunState(rootB, runId)?.dispatch_capability?.dispatches[0]?.status, "authorized");
  } finally {
    if (previousLocatorRoot === undefined) delete process.env[DISPATCH_ORIGIN_LOCATOR_ENV];
    else process.env[DISPATCH_ORIGIN_LOCATOR_ENV] = previousLocatorRoot;
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(callbackRoot, { recursive: true, force: true });
    rmSync(locatorRoot, { recursive: true, force: true });
  }
});

test("workflow tools ignore a foreign session_stop without dropping the trusted controller", async () => {
  const root = scratch("rl-session-stop-identity");
  try {
    initGit(root); publishMapping(root);
    const owner = context(root, "trusted-stop-session");
    const controller = createWorkflowSessionController({ cwd: root, context: owner });
    const bus = fakePi();
    registerWorkflowTools(bus.pi as never, { cwd: root, getSessionController: () => controller });
    await bus.emit("session_start", {}, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const prepare = bus.tools.get("workflow_prepare")!;
    const params = { mode: "new", task: "session stop identity", classification: CLASSIFICATION };
    const first = await prepare.execute("session-stop-prepare", params, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const firstValue = record(first.details);
    assert.equal(firstValue.ok, true, JSON.stringify(firstValue));
    const firstState = record(firstValue.state);
    const runId = String(firstState.run_id);
    const claimBefore = readRunControl(root).execution_claim;
    await bus.emit("session_start", {}, { cwd: root, mode: "print", hasUI: false, session_id: "foreign-worker-session" });
    await bus.emit("session_stop", { session_id: "foreign-worker-session" }, { cwd: root, mode: "print", hasUI: false, session_id: "foreign-worker-session" });
    await bus.emit("session_start", {}, { cwd: root, mode: "print", hasUI: false, session_id: owner.session_id });
    const status = await bus.tools.get("workflow_status")!.execute("foreign-stop-status", {}, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const statusValue = record(status.details);
    assert.equal(statusValue.ok, true, JSON.stringify(statusValue));
    assert.equal(statusValue.run_id, runId);
    const replay = await prepare.execute("session-stop-prepare", params, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(record(replay.details).ok, true, JSON.stringify(replay.details));
    assert.deepEqual(readRunControl(root).execution_claim, claimBefore);
    await bus.emit("session_stop", { session_id: owner.session_id }, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.notEqual(readRunControl(root).execution_claim, null, "idle stop retains the coordinator claim");
    const afterStop = await bus.tools.get("workflow_status")!.execute("same-session-after-stop", {}, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(record(afterStop.details).ok, true, "retained host session keeps read access after idle stop");
    await bus.emit("session_shutdown", { type: "session_shutdown" }, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(readRunControl(root).execution_claim, null, "verified owner shutdown releases coordinator claim");
    const afterShutdown = await bus.tools.get("workflow_status")!.execute("same-session-after-shutdown", {}, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(record(afterShutdown.details).code, "WORKFLOW_CONTEXT_REJECTED", "shutdown clears only the exact host identity");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow tools release only the captured manager/session-file owner on session_switch", async () => {
  const root = scratch("rl-session-switch-proof");
  try {
    initGit(root); publishMapping(root);
    let sessionId = "switch-old";
    let sessionFile = join(root, "old-session.jsonl");
    const manager = {
      getCwd: () => root,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    };
    const foreignManager = {
      getCwd: () => root,
      getSessionId: () => "foreign-switch",
      getSessionFile: () => join(root, "foreign-session.jsonl"),
    };
    const oldContext = context(root, sessionId);
    const oldController = createWorkflowSessionController({ cwd: root, context: oldContext });
    const newController = createWorkflowSessionController({ cwd: root, context: { ...oldContext, session_id: "switch-new" } });
    const bus = fakePi();
    const managerFor = (value: unknown): unknown => (
      value && typeof value === "object" && !Array.isArray(value) && "sessionManager" in value
        ? value.sessionManager
        : undefined
    );
    registerWorkflowTools(bus.pi as never, {
      cwd: root,
      getSessionController: (ctx) => (managerFor(ctx) === manager ? oldController : newController),
    });
    const hostContext = { sessionManager: manager, mode: "tui", hasUI: true };
    await bus.emit("session_start", {}, hostContext);
    oldController.prepare({ mode: "new", task: "switch-owned", classification: CLASSIFICATION });
    const claimBefore = readRunControl(root).execution_claim;
    assert.ok(claimBefore);
    sessionId = "switch-new";
    sessionFile = join(root, "new-session.jsonl");
    await bus.emit(
      "session_switch",
      { type: "session_switch", reason: "resume", previousSessionFile: join(root, "wrong-session.jsonl") },
      hostContext,
    );
    assert.deepEqual(readRunControl(root).execution_claim, claimBefore, "mismatched previous session file cannot release the old claim");
    await bus.emit(
      "session_switch",
      { type: "session_switch", reason: "resume", previousSessionFile: join(root, "old-session.jsonl") },
      hostContext,
    );
    assert.equal(readRunControl(root).execution_claim, null, "the authenticated same-manager switch releases the old owner");
    // A different manager in the same cwd is never a release authority.
    const secondController = createWorkflowSessionController({ cwd: root, context: context(root, "foreign-owner") });
    secondController.prepare({ mode: "new", task: "foreign-switch-owned", classification: CLASSIFICATION });
    const foreignClaim = readRunControl(root).execution_claim;
    assert.ok(foreignClaim);
    await bus.emit(
      "session_switch",
      { type: "session_switch", reason: "new", previousSessionFile: join(root, "new-session.jsonl") },
      { sessionManager: foreignManager, mode: "tui", hasUI: true },
    );
    assert.deepEqual(readRunControl(root).execution_claim, foreignClaim, "foreign manager cannot release the current owner");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow tools do not adopt a replacement after a stale CTO switch proof", async () => {
  const root = scratch("rl-stale-cto-switch-proof");
  try {
    initGit(root); publishMapping(root);
    let sessionId = "stale-cto-old";
    let sessionFile = join(root, "stale-cto-old.jsonl");
    const manager = {
      getCwd: () => root,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    };
    const oldContext = context(root, "stale-cto-old");
    const oldController = createWorkflowSessionController({ cwd: root, context: oldContext });
    const newController = createWorkflowSessionController({ cwd: root, context: context(root, "stale-cto-new") });
    let resolverCalls = 0;
    const bus = fakePi();
    registerWorkflowTools(bus.pi as never, {
      cwd: root,
      getSessionController: () => {
        resolverCalls += 1;
        return sessionId === "stale-cto-old" ? oldController : newController;
      },
    });
    const hostContext = { sessionManager: manager, mode: "tui", hasUI: true };
    await bus.emit("session_start", {}, hostContext);
    const ingress = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "stale CTO switch",
      controller: oldController,
    });
    const controlPath = join(root, ".work-state", "run-control.json");
    const beforeControl = readFileSync(controlPath, "utf8");
    const control = readRunControl(root);
    assert.ok(control.execution_claim);
    writeFileSync(controlPath, JSON.stringify({
      ...control,
      execution_claim: { ...control.execution_claim, token: "stale-switch-token" },
    }) + "\n");
    const staleControl = readFileSync(controlPath, "utf8");
    assert.notEqual(staleControl, beforeControl);

    sessionId = "stale-cto-new";
    sessionFile = join(root, "stale-cto-new.jsonl");
    await bus.emit(
      "session_switch",
      { type: "session_switch", reason: "resume", previousSessionFile: join(root, "stale-cto-old.jsonl") },
      hostContext,
    );
    assert.equal(resolverCalls, 1, "stale proof returns before resolving or adopting the replacement controller");
    assert.equal(readFileSync(controlPath, "utf8"), staleControl, "stale switch does not release or rewrite the old CTO claim");
    assert.equal(ingress.run_id, readRunControl(root).execution_claim?.run_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process acceptance: active claim proof drops on idle release, takeover, and corruption", () => {
  const root = scratch("rl-active-claim-proof");
  try {
    initGit(root); publishMapping(root);
    const owner = context(root, "claim-proof-owner");
    const controller = createWorkflowSessionController({ cwd: root, context: owner });
    assert.equal(controller.activeClaimRunId(), undefined);
    const prepared = controller.prepare({ mode: "new", task: "claim proof", classification: CLASSIFICATION });
    const runId = prepared.state.run_id!;
    assert.equal(controller.activeClaimRunId(), runId);
    const pending = beginLifecycleTransaction({ cwd: root, operation: "claim", before: {}, after: {} });
    const pendingJournal = join(root, ".work-state", "lifecycle-transactions", pending.transaction_id, "transaction.json");
    assert.equal(controller.activeClaimRunId(), undefined, "pending lifecycle journals fail the ownership proof closed");
    assert.equal(existsSync(pendingJournal), true, "activeClaimRunId must not repair or publish a pending journal");
    rmSync(join(root, ".work-state", "lifecycle-transactions", pending.transaction_id), { recursive: true, force: true });
    assert.equal(controller.activeClaimRunId(), runId);
    const claim = readRunControl(root).execution_claim;
    assert.ok(claim);
    controller.release("idle-proof");
    assert.equal(controller.selectedRunId(), runId, "idle release retains the selected run");
    assert.equal(controller.activeClaimRunId(), undefined);

    const takeover = context(root, "claim-proof-takeover");
    const replacement = acquireExecutionClaim(root, { run_id: runId, context: takeover });
    const replacementController = createWorkflowSessionController({ cwd: root, context: takeover });
    replacementController.bind(runId, replacement.claim.token);
    assert.equal(replacementController.activeClaimRunId(), runId);
    assert.equal(controller.activeClaimRunId(), undefined, "the old token/session cannot prove the replacement claim");

    const controlPath = join(root, ".work-state", "run-control.json");
    writeFileSync(controlPath, JSON.stringify({
      ...readRunControl(root),
      execution_claim: { ...replacement.claim, token: 42 },
    }) + "\n");
    assert.equal(replacementController.activeClaimRunId(), undefined, "corrupt canonical claims fail closed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow shutdown revokes local authority even when canonical release is unreadable", async () => {
  const root = scratch("rl-shutdown-release-failure");
  try {
    initGit(root); publishMapping(root);
    const owner = context(root, "shutdown-release-failure");
    const controller = createWorkflowSessionController({ cwd: root, context: owner });
    const bus = fakePi();
    registerWorkflowTools(bus.pi as never, { cwd: root, getSessionController: () => controller });
    const hostContext = { cwd: root, mode: "tui" as const, hasUI: true, session_id: owner.session_id };
    await bus.emit("session_start", {}, hostContext);
    const prepared = controller.prepare({ mode: "new", task: "shutdown release failure", classification: CLASSIFICATION });
    const claimBefore = readRunControl(root).execution_claim;
    assert.ok(claimBefore);
    const controlPath = join(root, ".work-state", "run-control.json");
    writeFileSync(join(root, ".work-state", "runs", prepared.state.run_id!, "state.json"), "{}\n");
    await bus.emit("session_stop", { session_id: owner.session_id }, hostContext);
    assert.deepEqual(
      record(JSON.parse(readFileSync(controlPath, "utf8"))).execution_claim,
      claimBefore,
      "failed idle release preserves canonical ownership",
    );
    await bus.emit("session_shutdown", { type: "session_shutdown" }, hostContext);
    assert.deepEqual(
      record(JSON.parse(readFileSync(controlPath, "utf8"))).execution_claim,
      claimBefore,
      "failed shutdown release preserves canonical ownership",
    );
    const afterShutdown = await bus.tools.get("workflow_status")!.execute("release-failure-after-shutdown", {}, undefined, undefined, hostContext);
    assert.equal(record(afterShutdown.details).code, "WORKFLOW_CONTEXT_REJECTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process acceptance: selected but unclaimed host cannot manufacture orchestrator writes", async () => {
  const root = scratch("rl-selected-unclaimed-actor");
  try {
    initGit(root); publishMapping(root);
    const owner = context(root, "selected-unclaimed-host");
    const controller = createWorkflowSessionController({ cwd: root, context: owner });
    const prepared = controller.prepare({ mode: "new", task: "selected but idle", classification: CLASSIFICATION });
    const bus = fakePi();
    registerTeamWorkflow(bus.pi as never, {
      cwd: root,
      getSessionController: () => controller,
      resolveTrustedToolCallActor: () => ({ actor: "orchestrator", artifactsDir: runTarget(root, prepared.state.run_id!).artifactsDir }),
    });
    registerWorkflowTools(bus.pi as never, { cwd: root, getSessionController: () => controller });
    await bus.emit("session_start", {}, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    controller.release("selected-unclaimed");
    assert.equal(controller.selectedRunId(), prepared.state.run_id);
    assert.equal(controller.activeClaimRunId(), undefined);
    const statePath = join(root, ".work-state", "runs", prepared.state.run_id!, "state.json");
    const persistedState = readFileSync(statePath, "utf8");
    unlinkSync(statePath);
    assert.throws(() => controller.selectedRunId(), (error: unknown) => {
      assert.equal(record(error).code, "recovery_required");
      return true;
    });
    const missingResults = await bus.emit(
      "tool_call",
      { toolName: "write", toolCallId: "selected-missing-write", input: { path: join(root, "missing.txt"), content: "unsafe" } },
      { cwd: root, session_id: owner.session_id, actor: "orchestrator" },
    );
    assert.ok(missingResults.some(value => value && typeof value === "object" && "block" in value && value.block === true), JSON.stringify(missingResults));
    assert.equal(existsSync(statePath), false, "raw authority reads must not repair a missing selected run");
    writeFileSync(statePath, persistedState);
    assert.equal(controller.selectedRunId(), prepared.state.run_id);
    const results = await bus.emit(
      "tool_call",
      { toolName: "write", toolCallId: "selected-unclaimed-write", input: { path: join(root, "source.txt"), content: "unsafe" } },
      { cwd: root, session_id: owner.session_id, actor: "orchestrator" },
    );
    assert.ok(results.some(value => value && typeof value === "object" && "block" in value && value.block === true), JSON.stringify(results));
    const begin = bus.tools.get("workflow_begin")!;
    const deniedBegin = await begin.execute("selected-unclaimed-begin", {}, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(record(deniedBegin.details).code, "WORKFLOW_CONTEXT_REJECTED");
    const rebind = await bus.tools.get("workflow_prepare")!.execute("selected-unclaimed-rebind", { mode: "resume", run_id: prepared.state.run_id }, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(record(rebind.details).ok, true, JSON.stringify(rebind.details));
    assert.equal(controller.activeClaimRunId(), prepared.state.run_id);
    const allowedBegin = await begin.execute("selected-unclaimed-begin-rebound", {}, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.notEqual(record(allowedBegin.details).code, "WORKFLOW_CONTEXT_REJECTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow_status preserves structured selector failure details", async () => {
  const root = scratch("rl-selector-error-details");
  try {
    initGit(root); publishMapping(root);
    const owner = context(root, "selector-details-session");
    const controller = createWorkflowSessionController({ cwd: root, context: owner });
    const bus = fakePi();
    registerWorkflowTools(bus.pi as never, { cwd: root, getSessionController: () => controller });
    await bus.emit("session_start", {}, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const first = controller.prepare({ mode: "new", task: "duplicate selector title", classification: CLASSIFICATION });
    const second = controller.prepare({ mode: "new", task: "duplicate selector title", classification: CLASSIFICATION });
    const status = await bus.tools.get("workflow_status")!.execute("selector-details", { selector: { title: "duplicate selector title" } }, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const value = status.details as { ok?: boolean; code?: string; details?: { code?: string; branch?: string; unchanged?: boolean; next_action?: string; candidates?: Array<{ run_id: string }> } };
    assert.equal(value.ok, false);
    assert.equal(value.code, "WORKFLOW_STATUS_FAILED");
    assert.equal(value.details?.code, "run_selection_required");
    assert.equal(value.details?.branch, BRANCH);
    assert.equal(value.details?.unchanged, true);
    assert.equal(typeof value.details?.next_action, "string");
    assert.deepEqual(new Set(value.details?.candidates?.map((candidate) => candidate.run_id)), new Set([first.state.run_id, second.state.run_id]));
    const prepare = await bus.tools.get("workflow_prepare")!.execute("selector-prepare-details", { mode: "resume", selector: { title: "duplicate selector title" } }, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const prepareValue = prepare.details as { code?: string; details?: { code?: string; candidates?: Array<{ run_id: string }> } };
    assert.equal(prepareValue.code, "WORKFLOW_PREPARE_FAILED");
    assert.equal(prepareValue.details?.code, "run_selection_required");
    assert.deepEqual(new Set(prepareValue.details?.candidates?.map((candidate) => candidate.run_id)), new Set([first.state.run_id, second.state.run_id]));
    await bus.emit("session_stop", { session_id: owner.session_id }, { cwd: root, session_id: owner.session_id });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow_prepare command intent reserves through selector errors and commits once", async () => {
  const root = scratch("rl-command-intent-boundary");
  try {
    initGit(root); publishMapping(root);
    const owner = context(root, "command-intent-session");
    const controller = createWorkflowSessionController({ cwd: root, context: owner });
    const bus = fakePi();
    registerWorkflowTools(bus.pi as never, { cwd: root, getSessionController: () => controller });
    await bus.emit("session_start", {}, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const first = controller.prepare({ mode: "new", task: "command intent duplicate", classification: CLASSIFICATION });
    const second = controller.prepare({ mode: "new", task: "command intent duplicate", classification: CLASSIFICATION });
    const intent = controller.issueCommandIntent("resume");
    const prepare = bus.tools.get("workflow_prepare")!;
    const failed = await prepare.execute("command-intent-failed", {
      mode: "resume", selector: { title: "command intent duplicate" }, command_intent_id: intent.intent_id,
    }, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const failedValue = record(failed.details);
    assert.equal(failedValue.ok, false);
    assert.equal(record(failedValue.details).code, "run_selection_required");
    const corrected = await prepare.execute("command-intent-corrected", {
      mode: "resume", selector: { run_id: second.state.run_id }, command_intent_id: intent.intent_id,
    }, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    assert.equal(record(corrected.details).ok, true, JSON.stringify(corrected.details));
    const claimAfterCommit = readRunControl(root).execution_claim;
    const replay = await prepare.execute("command-intent-replay", {
      mode: "resume", selector: { run_id: second.state.run_id }, command_intent_id: intent.intent_id,
    }, undefined, undefined, { cwd: root, mode: "tui", hasUI: true, session_id: owner.session_id });
    const replayValue = record(replay.details);
    assert.equal(replayValue.ok, false);
    assert.equal(replayValue.code, "WORKFLOW_PREPARE_FAILED");
    assert.equal(record(replayValue.details).code, "lifecycle_request_conflict");
    assert.deepEqual(readRunControl(root).execution_claim, claimAfterCommit);
    assert.notEqual(second.state.run_id, first.state.run_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Resume walks past completed A and executes B exactly once.
test("process acceptance: completed stage A resume advances stage B once", async () => {
  const root = scratch("rl-resume-next-stage");
  const profile: Profile = {
    name: "acceptance-resume-next",
    title: "Acceptance resume next",
    description: "two stage resume fixture",
    match: { type: ["FEATURE"] },
    stages: [
      { id: "stage_a", title: "A", type: "single", role: "dev" },
      { id: "stage_b", title: "B", type: "single", role: "dev" },
    ],
  };
  registerWorkflowProfiles([profile]);
  try {
    initGit(root); publishMapping(root);
    const execution = context(root, "resume-next");
    const prepared = prepareWorkflowState({
      cwd: root, branch: BRANCH, task: "resume next", autonomous: false,
      classification: { ...CLASSIFICATION, workflow: profile.name }, files: [], issue: null,
      mode: "new", request_id: "resume-next-new", execution,
    });
    const runId = prepared.state.run_id!;
    updateCanonicalRun(root, runId, (state) => {
      const { pending: _pending, dispatch_capability: _capability, ...withoutTransient } = state;
      return {
        ...withoutTransient, lifecycle_status: "paused", pause: { kind: "background_wait", reason: "resume next stage" },
        stage_cursor: "stage_b", stages: [{ id: "stage_a", status: "done" }, { id: "stage_b", status: "pending" }],
      };
    });
    assert.equal(readRunState(root, runId)?.run_id, runId);
    let calls = 0;
    const taskTool: TaskCaller = {
      async call() {
        calls += 1;
        return { id: "stage-b-result", output: "B done", artifacts: {}, exitCode: 0 };
      },
      async batch() { return []; },
    };
    const result = await run({
      cwd: root, branch: BRANCH, task: "resume next", autonomous: false,
      classification: { ...CLASSIFICATION, workflow: profile.name }, files: [], issue: null,
      mode: "resume", run_id: runId, request_id: "resume-next-run", execution, taskTool,
    });
    assert.equal(result.outcomes[0]?.status, "done", JSON.stringify(result));
    assert.equal(calls, 1);
    assert.equal(readRunState(root, runId)?.stages.find((stage) => stage.id === "stage_a")?.status, "done");
    assert.equal(readRunState(root, runId)?.stages.find((stage) => stage.id === "stage_b")?.status, "done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Native begin must persist a hash-bound input receipt and refuse a missing input.
test("process acceptance: native begin reads mandatory inputs before authorize and fails closed when missing", () => {
  const root = scratch("rl-native-inputs");
  try {
    initGit(root); publishMapping(root);
    const runId = randomUUID();
    persistCanonicalRun(root, canonicalState(runId));
    const artifacts = join(root, ".work-state", "runs", runId, "artifacts"); mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "read first" }));
    const begun = beginCapability(root, undefined, { runId });
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.ok(begun.ok && begun.handoff);
    const state = readRunState(root, runId)!;
    assert.equal(state.required_input_receipts?.implementation?.capability_id, state.dispatch_capability?.capability_id);
    const auth = authorizeDispatch(root, { run_id: runId, token: begun.handoff!.dispatch_token, capability_id: begun.handoff!.capability_id, run_key: runId, branch: BRANCH, workflow: "lightweight", profile_hash: state.profile_hash!, stage_cursor: "implementation", cursor_epoch: begun.handoff!.cursor_epoch, loop_iteration: begun.handoff!.loop_iteration, role: "dev", slot_id: "dev", agent: "dev" });
    assert.equal(auth.ok, true, auth.ok ? "" : auth.error);

    const missing = scratch("rl-native-missing");
    try {
      initGit(missing); publishMapping(missing); const missingId = randomUUID(); persistCanonicalRun(missing, canonicalState(missingId));
      const refused = beginCapability(missing, undefined, { runId: missingId });
      assert.equal(refused.ok, false);
      if (!refused.ok) assert.match(refused.error, /recovery_required|required input/i);
    } finally { rmSync(missing, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Rework changes generation; stale proof is rejected while the newly issued capability authorizes.
test("process acceptance: public rework advances generation and stale proof cannot authorize fresh work", () => {
  const root = scratch("rl-rework-generation");
  try {
    initGit(root); publishMapping(root);
    const execution = context(root, "rework-session");
    const prepared = prepareWorkflowState({
      cwd: root, branch: BRANCH, task: "rework task", autonomous: false, classification: CLASSIFICATION,
      files: ["src/main.ts"], issue: null, mode: "new", request_id: "rework-new", execution,
    });
    const runId = prepared.state.run_id!;
    const old = createCapability({
      run_key: runId, branch: BRANCH, workflow: "lightweight", profile_hash: profileHash(loadProfile("lightweight")!),
      stage_cursor: "implementation", rework_generation: 0, kind: "single", expected_roster: [{ role: "dev", agent: "dev" }],
    });
    mkdirSync(prepared.artifactsDir, { recursive: true });
    writeFileSync(join(prepared.artifactsDir, "discovery.json"), JSON.stringify({ goal: "before rework" }));
    updateCanonicalRun(root, runId, (state) => ({
      ...state, stage_cursor: "implementation", dispatch_capability: old.state, cursor_epoch: old.state.issued_for!.cursor_epoch,
      required_inputs: { implementation: [{ artifact_id: "discovery", path: "discovery.json" }] },
      artifacts: { discovery: "artifacts/discovery.json" },
    }));
    updateCanonicalRun(root, runId, (state) => ({
      ...state, lifecycle_status: "complete", pause: { kind: "done", reason: "completed" },
      stages: state.stages.map((stage) => ({ ...stage, status: "done" as const })),
    }));
    const reworked = prepareWorkflowState({
      cwd: root, branch: BRANCH, task: "ignored", autonomous: false, classification: CLASSIFICATION,
      files: [], issue: null, mode: "rework", run_id: runId, feedback: "fix implementation", affected_stage: "implementation",
      request_id: "rework-apply", execution,
    });
    assert.equal(reworked.state.rework_generation, 1);
    const stale = authorizeDispatch(root, {
      token: old.dispatch_token, capability_id: old.capability_id, run_key: runId, branch: BRANCH,
      workflow: "lightweight", profile_hash: old.state.issued_for!.profile_hash, stage_cursor: "implementation",
      cursor_epoch: old.state.issued_for!.cursor_epoch, loop_iteration: old.state.issued_for!.loop_iteration, role: "dev", slot_id: "dev", agent: "dev",
    });
    assert.equal(stale.ok, false);
    mkdirSync(reworked.artifactsDir, { recursive: true });
    writeFileSync(join(reworked.artifactsDir, "discovery.json"), JSON.stringify({ goal: "stable" }));
    const fresh = beginCapability(root, undefined, { runId });
    assert.equal(fresh.ok, true, fresh.ok ? "" : fresh.error);
    if (!fresh.ok || !fresh.handoff) return;
    const now = readRunState(root, runId)!;
    assert.equal(now.dispatch_capability?.issued_for.rework_generation, 1);
    const authorized = authorizeDispatch(root, {
      run_id: runId, token: fresh.handoff.dispatch_token, capability_id: fresh.handoff.capability_id, run_key: runId, branch: BRANCH,
      workflow: "lightweight", profile_hash: now.profile_hash!, stage_cursor: "implementation",
      cursor_epoch: fresh.handoff.cursor_epoch, loop_iteration: fresh.handoff.loop_iteration, role: "dev", slot_id: "dev", agent: "dev",
    });
    assert.equal(authorized.ok, true, authorized.ok ? "" : authorized.error);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Handover after a real coordinator process dies preserves pending worker reservation.
test("process acceptance: dead coordinator handover preserves pending workers and blocks an independent start", async () => {
  const root = scratch("rl-handover");
  let holder: ClaimHolder | undefined;
  try {
    initGit(root);
    const runId = randomUUID();
    persistCanonicalRun(root, canonicalState(runId, { pending: { identity: identity(runId), status: "pending", pending_reason: "provider_running", updated_at: new Date().toISOString() } }));
    holder = holdClaim(root, runId);
    await holder.ready;
    holder.child.kill("SIGKILL");
    await waitChildClose(holder.child);
    const claim = readRunControl(root).execution_claim;
    assert.ok(claim);
    const handover = handoverExecutionClaim(root, { run_id: runId, context: context(root, "handover"), token: claim.token, release_receipt: "provider-confirmed" });
    assert.equal(handover.claim.run_id, runId);
    assert.deepEqual(handover.claim.worker_ids, ["worker-pending"]);
    assert.throws(
      () => acquireExecutionClaim(root, { run_id: randomUUID(), context: context(root, "independent") }),
      (error: unknown) => { assert.equal(record(error).code, "run_busy"); return true; },
    );
  } finally {
    if (holder && holder.child.exitCode === null) {
      holder.child.kill("SIGKILL");
      await waitChildClose(holder.child);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// Journal recovery runs after a child crash and never overwrites an external generation.
test("process acceptance: child transaction crash preserves before/external and committed generations", async () => {
  const root = scratch("rl-journal-child"); const path = join(root, "scratch", "value.txt"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "before");
  try {
    const prepared = await childScript(`const {beginLifecycleTransaction} = await import(${JSON.stringify(coreIndexUrl)}); const {writeFileSync} = await import('node:fs'); const [root,path] = process.argv.slice(1); beginLifecycleTransaction({cwd:root,operation:'migration',before:{[path]:'before'},after:{[path]:'committed'}}); writeFileSync(path,'external'); process.kill(process.pid,'SIGKILL');`, [root, path]);
    assert.equal(prepared.signal, "SIGKILL"); recoverLifecycleTransactions(root); assert.equal(readFileSync(path, "utf8"), "external");
    writeFileSync(path, "before");
    const committed = beginLifecycleTransaction({ cwd: root, operation: "migration", before: { [path]: "before" }, after: { [path]: "committed" } });
    commitLifecycleTransaction(root, committed.transaction_id); writeFileSync(path, "newer");
    const child = await childScript(`const {recoverLifecycleTransactions} = await import(${JSON.stringify(coreIndexUrl)}); recoverLifecycleTransactions(process.argv[1]); process.kill(process.pid,'SIGKILL');`, [root]);
    assert.equal(child.signal, "SIGKILL"); assert.equal(readFileSync(path, "utf8"), "newer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Migration CAS and immutable evidence projection, including a binary slot artifact.
test("process acceptance: migration source conflict is unchanged and succeeded binary evidence is not redispatched", async () => {
  const root = scratch("rl-migration-cas");
  try {
    initGit(root);
    const legacyDir = join(root, ".work-state", "features", "legacy-slot"); const artifacts = join(legacyDir, "artifacts"); mkdirSync(artifacts, { recursive: true });
    const binary = Buffer.from([0, 1, 2, 255, 42]); writeFileSync(join(artifacts, "binary.bin"), binary);
    const bomNote = Buffer.from([0xef, 0xbb, 0xbf, 0x6e, 0x6f, 0x74, 0x65, 0x0a]);
    writeFileSync(join(artifacts, "bom.txt"), bomNote);
    const designDoc = Buffer.from("design evidence\n", "utf8");
    mkdirSync(join(legacyDir, "docs"), { recursive: true });
    writeFileSync(join(legacyDir, "docs", "design.md"), designDoc);
    const legacyCompletedAt = new Date().toISOString();
    writeFileSync(join(artifacts, "discovery.json"), JSON.stringify({ goal: "legacy input" }));
    writeFileSync(join(artifacts, "product_spec.json"), MIGRATION_PRODUCT_SPEC);
    const legacyCapability = createCapability({
      run_key: BRANCH, branch: BRANCH, workflow: "spec-preparation", profile_hash: profileHash(loadProfile("spec-preparation")!),
      stage_cursor: "intake_repo_map", rework_generation: 0, kind: "consilium",
      expected_roster: [{ role: "analyst", agent: "analyst" }, { role: "tech-researcher", agent: "tech-researcher" }],
    }).state;
    const legacyIdentity: WorkIdentity = {
      ...identity(BRANCH),
      run_id: BRANCH, workflow: "spec-preparation", stage_id: "intake_repo_map", stage_cursor: "intake_repo_map",
      capability_id: legacyCapability.capability_id, capability_epoch: legacyCapability.issued_for!.cursor_epoch,
      dispatch_id: "legacy-dispatch", slot_id: "analyst", task_id: "legacy-task",
    };
    const legacy = {
      schema: 1, branch: BRANCH, run_key: BRANCH, classification: { ...CLASSIFICATION, type: "SPEC", workflow: "spec-preparation" }, task: "docs/design.md", workflow_override: true, issue: null,
      completion_intent: { mode: "complete_outcome", acceptance: "dod_and_artifacts", source: "user", rationale: "legacy completion evidence" },
      stage_cursor: "intake_repo_map", stages: [{ id: "intake_repo_map", status: "in_progress" }, { id: "requirements_edge_cases", status: "pending" }],
      artifacts: { discovery: "artifacts/discovery.json", product_spec: "artifacts/product_spec.json", binary: "artifacts/binary.bin", bom: "artifacts/bom.txt", design: "docs/design.md" },
      scope: { scope: ["analyst", "tech-researcher"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "analyst" },
      pause: { kind: "none", reason: "docs/design.md" },
      dispatch_capability: {
        ...legacyCapability, status: "complete",
        dispatches: [{
          id: "legacy-dispatch", role: "analyst", agent: "analyst", status: "succeeded", attempt: 1, created_at: legacyCompletedAt, completed_at: legacyCompletedAt,
          work_identity: legacyIdentity,
          completion: {
            dispatch_id: "legacy-dispatch", cursor_epoch: legacyCapability.issued_for!.cursor_epoch, outcome: "succeeded",
            artifact_ids: ["binary.bin", "bom.txt"], evidence: "discovery.json", completed_by: "workflow_complete",
            completed_at: legacyCompletedAt, work_identity: legacyIdentity,
          },
          completion_envelope: {
            schema_version: 1, identity: legacyIdentity, outcome: "succeeded", terminal_signal: "workflow_complete",
            artifact_refs: [], evidence_ref: null, conflict_ref: null,
            completed_by: "workflow_complete", emitted_at: legacyCompletedAt,
          },
        }, {
          id: "legacy-dispatch-other-stage", role: "analyst", agent: "analyst", status: "succeeded", attempt: 1,
          created_at: legacyCompletedAt, completed_at: legacyCompletedAt,
          work_identity: { stage_id: "requirements_edge_cases", stage_cursor: "requirements_edge_cases" },
          completion: {
            dispatch_id: "legacy-dispatch-other-stage", cursor_epoch: legacyCapability.issued_for!.cursor_epoch, outcome: "succeeded",
            artifact_ids: [], evidence: "stage-local identityless legacy completion", completed_by: "workflow_complete",
            completed_at: legacyCompletedAt,
          },
        }],
        pending: [],
      },
      updated_at: new Date().toISOString(),
    };
    writeFileSync(join(legacyDir, "state.json"), JSON.stringify(legacy));
    const discovery = discoverLegacySources(root);
    const source = discovery.sources.find((candidate) => candidate.source_id === "feature:legacy-slot");
    assert.ok(source, JSON.stringify(discovery));
    const sourceForMigration = source!;
    const changed = { ...legacy, task: "changed after preflight" };
    writeFileSync(join(legacyDir, "state.json"), JSON.stringify(changed));
    const conflict = migrateLegacySource(root, sourceForMigration);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "migration_conflict");
    assert.equal(existsSync(join(root, ".work-state", "runs")), false);

    const rejectMalformedLegacy = (mutate: (dispatch: Record<string, unknown>) => void): void => {
      const malformedLegacy = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
      const malformedCapability = malformedLegacy.dispatch_capability as Record<string, unknown>;
      const malformedDispatches = malformedCapability.dispatches as Array<Record<string, unknown>>;
      mutate(malformedDispatches[0]!);
      writeFileSync(join(legacyDir, "state.json"), JSON.stringify(malformedLegacy));
      const malformedSource = discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "feature:legacy-slot");
      assert.ok(malformedSource);
      const malformedMigration = migrateLegacySource(root, malformedSource!);
      assert.equal(malformedMigration.ok, false);
      if (!malformedMigration.ok) assert.equal(malformedMigration.code, "recovery_required");
      assert.equal(existsSync(join(root, ".work-state", "runs")), false);
    };
    rejectMalformedLegacy((dispatch) => {
      const completion = dispatch.completion as Record<string, unknown>;
      completion.dispatch_id = "wrong-dispatch";
    });
    rejectMalformedLegacy((dispatch) => {
      const identity = dispatch.work_identity as Record<string, unknown>;
      identity.stage_cursor = "requirements_edge_cases";
    });
    rejectMalformedLegacy((dispatch) => {
      const completion = dispatch.completion as Record<string, unknown>;
      const identity = completion.work_identity as Record<string, unknown>;
      identity.slot_id = "tech-researcher";
    });
    writeFileSync(join(legacyDir, "state.json"), JSON.stringify(legacy));
    publishMapping(root);
    writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { analyst: "analyst", "tech-researcher": "tech-researcher" } }) + "\n");
    const migratedConfig = resolveConfig(root);
    writeAgentMapping(root, buildAgentMapping({ roles: migratedConfig.roles, availableAgents: ["analyst", "tech-researcher"], extraRoles: migratedConfig.scope_map.map((entry) => entry.dev_agent), genericFallbackRoles: ["analyst", "tech-researcher"] }));
    const child = await childScript(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [root] = process.argv.slice(1);
      const originalRename = fs.renameSync.bind(fs);
      let injected = false;
      fs.renameSync = ((from, to) => {
        originalRename(from, to);
        if (!injected && String(to).includes("/runs/") && String(to).endsWith("/state.json")) {
          injected = true;
          throw new Error("post-publication migration fault");
        }
      });
      syncBuiltinESMExports();
      const { discoverLegacySources, migrateLegacySource } = await import(${JSON.stringify(migrationEngineUrl)});
      try { migrateLegacySource(root, discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "feature:legacy-slot")); }
      catch { /* injected after-image exception is the scenario under test */ }
    `, [root]);
    assert.equal(child.code, 0, child.output);
    createWorkflowSessionController({ cwd: root, context: context(root, "migration-recovery") }).readSelector().list({ branch: BRANCH });
    const candidate = listRuns(root, { branch: BRANCH, includeTerminal: true })[0];
    assert.ok(candidate);
    const migratedState = readRunState(root, candidate.run_id)!;
    const migrated = { ok: true as const, run_id: candidate.run_id, migration_id: migratedState.migration!.id };
    const canonical = migratedState;
    assert.equal(canonical.task, "docs/design.md");
    assert.equal(canonical.migration_succeeded_slots?.intake_repo_map?.[0]?.dispatch_id, "legacy-dispatch");
    assert.equal(canonical.migration_succeeded_slots?.intake_repo_map?.[0]?.slot_id, "analyst");
    assert.equal(canonical.migration_succeeded_slots?.requirements_edge_cases?.[0]?.slot_id, "analyst");
    const laterStageCapability = createCapability({
      run_key: migrated.run_id, branch: BRANCH, workflow: "spec-preparation",
      profile_hash: profileHash(loadProfile("spec-preparation")!), stage_cursor: "requirements_edge_cases",
      rework_generation: 0, kind: "single", expected_roster: [{ role: "analyst", agent: "fresh-analyst" }],
    });
    const laterStageMaterialized = materializeMigratedDispatches(
      canonical,
      laterStageCapability.state,
      "spec-preparation",
      "requirements_edge_cases",
      runTarget(root, migrated.run_id),
    );
    assert.equal(laterStageMaterialized.ok, true, laterStageMaterialized.ok ? "" : laterStageMaterialized.error);
    if (laterStageMaterialized.ok) {
      assert.deepEqual(
        laterStageMaterialized.records.map((record) => ({ id: record.id, role: record.role, agent: record.agent })),
        [{ id: "legacy-dispatch-other-stage", role: "analyst", agent: "fresh-analyst" }],
      );
    }
    assert.ok(typeof canonical.artifacts?.design === "string" && canonical.artifacts.design.endsWith(`/runs/${migrated.run_id}/docs/design.md`));
    const begun = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.ok(begun.ok && begun.handoff);
    const liveAuthorized = authorizeDispatch(root, { run_id: migrated.run_id, token: begun.handoff!.dispatch_token, ...begun.handoff!, role: "tech-researcher", agent: "tech-researcher" });
    assert.equal(liveAuthorized.ok, true, liveAuthorized.ok ? "" : liveAuthorized.error);
    const dispatches = readRunState(root, migrated.run_id)?.dispatch_capability?.dispatches ?? [];
    assert.equal(dispatches.filter((dispatch) => dispatch.id === "legacy-dispatch").length, 1);
    const imported = dispatches.find((dispatch) => dispatch.id === "legacy-dispatch");

    assert.ok(imported);
    assert.equal(imported!.status, "succeeded");
    assert.equal(imported!.attempt, 0);
    assert.equal(imported!.tool_call_id, undefined);
    assert.equal(imported!.origin_session_id, undefined);
    assert.equal(imported!.pending, undefined);
    assert.equal(imported!.work_identity, undefined);
    assert.equal(imported!.completion?.completed_by, "migration");
    assert.equal(imported!.completion_envelope?.completed_by, "migration");
    assert.equal(imported!.completion_envelope?.terminal_signal, "migration_verified");
    assert.equal(imported!.completion_envelope?.identity.source, "migration");
    assert.equal(imported!.completion_envelope?.identity.migration_id, migrated.migration_id);
    const beforeLiveAttempt = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8");
    const liveAttempt = completeDispatch(root, {
      run_id: migrated.run_id, run_key: begun.handoff!.run_key, branch: begun.handoff!.branch, workflow: begun.handoff!.workflow,
      profile_hash: begun.handoff!.profile_hash, stage_cursor: begun.handoff!.stage_cursor, cursor_epoch: begun.handoff!.cursor_epoch,
      loop_iteration: begun.handoff!.loop_iteration, capability_id: begun.handoff!.capability_id, token: begun.handoff!.dispatch_token,
      role: "analyst", agent: "analyst", dispatch_id: "legacy-dispatch", outcome: "succeeded", evidence: "must not complete imported migration",
    }, { runId: migrated.run_id });
    assert.equal(liveAttempt.ok, false);
    assert.equal(readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8"), beforeLiveAttempt);
    const preservedBom = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "revisions", migrated.migration_id, "artifacts", "bom.txt"));
    assert.deepEqual(preservedBom, bomNote);
    assert.equal(dispatches.filter((dispatch) => dispatch.status === "authorized").length, 1);
    const preservedDesign = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "revisions", migrated.migration_id, "state", "docs", "design.md"));
    assert.deepEqual(preservedDesign, designDoc);
    const preserved = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "revisions", migrated.migration_id, "artifacts", "binary.bin"));
    assert.deepEqual(preserved, binary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
// Identity-less legacy success imports as a migration projection while the remaining live slot stays executable.
test("process acceptance: identity-less migration preserves a live consilium slot", () => {
  const root = scratch("rl-migration-identityless-live-slot");
  let externalRevision: string | undefined;
  try {
    initGit(root);
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { analyst: "analyst", "tech-researcher": "tech-researcher" } }) + "\n");
    const config = resolveConfig(root);
    writeAgentMapping(root, buildAgentMapping({ roles: config.roles, availableAgents: ["analyst", "tech-researcher"], extraRoles: config.scope_map.map((entry) => entry.dev_agent), genericFallbackRoles: ["analyst", "tech-researcher"] }));
    const legacyDir = join(root, ".work-state", "features", "identityless");
    const artifacts = join(legacyDir, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const artifact = Buffer.from(JSON.stringify({ facts: [{ source: "legacy analyst" }] }));
    writeFileSync(join(artifacts, "spec_intake_repo_map.json"), artifact);
    writeFileSync(join(artifacts, "product_spec.json"), MIGRATION_PRODUCT_SPEC);
    const runKey = BRANCH;
    const legacyCompletedAt = new Date().toISOString();
    const capability = createCapability({
      run_key: runKey, branch: BRANCH, workflow: "spec-preparation", profile_hash: profileHash(loadProfile("spec-preparation")!),
      stage_cursor: "intake_repo_map", rework_generation: 0, kind: "consilium",
      expected_roster: [{ role: "analyst", agent: "analyst" }, { role: "tech-researcher", agent: "tech-researcher" }],
    }).state;
    const legacy = {
      schema: 1, branch: BRANCH, run_key: runKey,
      classification: { ...CLASSIFICATION, type: "SPEC", workflow: "spec-preparation" },
      task: "identity-less migration", workflow_override: true, issue: null,
      completion_intent: { mode: "complete_outcome", acceptance: "dod_and_artifacts", source: "user", rationale: "verified legacy slot" },
      stage_cursor: "intake_repo_map", stages: [{ id: "intake_repo_map", status: "in_progress" }],
      artifacts: { spec_intake_repo_map: "artifacts/spec_intake_repo_map.json", product_spec: "artifacts/product_spec.json" },
      scope: { scope: ["analyst", "tech-researcher"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "analyst" },
      pause: { kind: "none", reason: "" },
      dispatch_capability: {
        ...capability, status: "complete",
        dispatches: [{
          id: "legacy-identityless", role: "analyst", agent: "analyst", status: "succeeded", attempt: 1,
          created_at: legacyCompletedAt, completed_at: legacyCompletedAt,
          completion: {
            dispatch_id: "legacy-identityless", cursor_epoch: capability.issued_for!.cursor_epoch, outcome: "succeeded",
            artifact_ids: ["spec_intake_repo_map"], evidence: "spec_intake_repo_map.json", completed_by: "workflow_complete",
            completed_at: legacyCompletedAt,
          },
        }],
        pending: [],
      },
      updated_at: new Date().toISOString(),
    };
    writeFileSync(join(legacyDir, "state.json"), JSON.stringify(legacy));
    const emptyDir = join(root, ".work-state", "features", "identityless-empty");
    mkdirSync(join(emptyDir, "artifacts"), { recursive: true });
    writeFileSync(join(emptyDir, "artifacts", "product_spec.json"), MIGRATION_PRODUCT_SPEC);
    const emptyLegacy = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    emptyLegacy.artifacts = { product_spec: "artifacts/product_spec.json" };
    const emptyCapability = emptyLegacy.dispatch_capability as Record<string, unknown>;
    const emptyDispatches = emptyCapability.dispatches as Array<Record<string, unknown>>;
    emptyDispatches[0]!.id = "legacy-empty";
    const emptyCompletion = emptyDispatches[0]!.completion as Record<string, unknown>;
    emptyCompletion.dispatch_id = "legacy-empty";
    emptyCompletion.artifact_ids = [];
    emptyCompletion.evidence = "verified no declared artifacts";
    writeFileSync(join(emptyDir, "state.json"), JSON.stringify(emptyLegacy));
    const emptySource = discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "feature:identityless-empty");
    assert.ok(emptySource);
    const emptyMigrated = migrateLegacySource(root, emptySource!);
    assert.equal(emptyMigrated.ok, true, emptyMigrated.ok ? "" : emptyMigrated.error);
    if (!emptyMigrated.ok) return;
    const emptyBegun = beginCapability(root, undefined, { runId: emptyMigrated.run_id });
    assert.ok(emptyBegun.ok && emptyBegun.handoff);
    const emptyImported = readRunState(root, emptyMigrated.run_id)?.dispatch_capability?.dispatches.find((dispatch) => dispatch.id === "legacy-empty");
    assert.equal(emptyImported?.attempt, 0);
    const repeatedDir = join(root, ".work-state", "features", "identityless-repeated");
    mkdirSync(join(repeatedDir, "artifacts"), { recursive: true });
    writeFileSync(join(repeatedDir, "artifacts", "product_spec.json"), MIGRATION_PRODUCT_SPEC);
    const repeatedLegacy = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    repeatedLegacy.artifacts = { product_spec: "artifacts/product_spec.json" };
    const repeatedCapability = repeatedLegacy.dispatch_capability as Record<string, unknown>;
    const repeatedDispatches = repeatedCapability.dispatches as Array<Record<string, unknown>>;
    repeatedDispatches[0]!.id = "legacy-repeated-one";
    const repeatedFirstCompletion = repeatedDispatches[0]!.completion as Record<string, unknown>;
    repeatedFirstCompletion.dispatch_id = "legacy-repeated-one";
    repeatedFirstCompletion.artifact_ids = [];
    repeatedDispatches.push({
      id: "legacy-repeated-two", role: "analyst", agent: "analyst", status: "succeeded", attempt: 1,
      created_at: legacyCompletedAt, completed_at: legacyCompletedAt,
      completion: {
        dispatch_id: "legacy-repeated-two", cursor_epoch: capability.issued_for!.cursor_epoch, outcome: "succeeded",
        artifact_ids: [], evidence: "second identityless slot", completed_by: "workflow_complete", completed_at: legacyCompletedAt,
      },
    });
    writeFileSync(join(repeatedDir, "state.json"), JSON.stringify(repeatedLegacy));
    const repeatedSource = discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "feature:identityless-repeated");
    assert.ok(repeatedSource);
    const repeatedMigration = migrateLegacySource(root, repeatedSource!);
    assert.equal(repeatedMigration.ok, true, repeatedMigration.ok ? "" : repeatedMigration.error);
    if (!repeatedMigration.ok) return;
    const repeatedState = readRunState(root, repeatedMigration.run_id)!;
    const repeatedSlots = repeatedState.migration_succeeded_slots?.intake_repo_map ?? [];
    assert.deepEqual(repeatedSlots.map((slot) => slot.slot_id), ["analyst#1", "analyst#2"]);
    assert.notEqual(repeatedSlots[0]?.dispatch_id, repeatedSlots[1]?.dispatch_id);
    const duplicateDir = join(root, ".work-state", "features", "identityless-duplicate");
    mkdirSync(join(duplicateDir, "artifacts"), { recursive: true });
    writeFileSync(join(duplicateDir, "artifacts", "product_spec.json"), MIGRATION_PRODUCT_SPEC);
    const duplicateLegacy = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    duplicateLegacy.artifacts = { product_spec: "artifacts/product_spec.json" };
    const duplicateCapability = duplicateLegacy.dispatch_capability as Record<string, unknown>;
    const duplicateDispatches = duplicateCapability.dispatches as Array<Record<string, unknown>>;
    duplicateDispatches[0]!.id = "legacy-duplicate-identityless";
    const duplicateFirstCompletion = duplicateDispatches[0]!.completion as Record<string, unknown>;
    duplicateFirstCompletion.dispatch_id = "legacy-duplicate-identityless";
    duplicateFirstCompletion.artifact_ids = [];
    const duplicateIdentity = { stage_id: "intake_repo_map", stage_cursor: "intake_repo_map", slot_id: "analyst#1" };
    duplicateDispatches.push({
      id: "legacy-duplicate-explicit", role: "analyst", agent: "analyst", status: "succeeded", attempt: 1,
      created_at: legacyCompletedAt, completed_at: legacyCompletedAt, work_identity: duplicateIdentity,
      completion: {
        dispatch_id: "legacy-duplicate-explicit", cursor_epoch: capability.issued_for!.cursor_epoch, outcome: "succeeded",
        artifact_ids: [], evidence: "derived duplicate slot", completed_by: "workflow_complete", completed_at: legacyCompletedAt,
        work_identity: duplicateIdentity,
      },
    });
    writeFileSync(join(duplicateDir, "state.json"), JSON.stringify(duplicateLegacy));
    const controlPath = join(root, ".work-state", "run-control.json");
    const canonicalControlBeforeDuplicate = readFileSync(controlPath, "utf8");
    const runsBeforeDuplicate = listRuns(root, { branch: BRANCH, includeTerminal: true }).map((run) => run.run_id).sort();
    const duplicateSource = discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "feature:identityless-duplicate");
    assert.ok(duplicateSource);
    const duplicateMigration = migrateLegacySource(root, duplicateSource!);
    assert.equal(duplicateMigration.ok, false);
    if (!duplicateMigration.ok) assert.equal(duplicateMigration.code, "recovery_required");
    assert.equal(readFileSync(controlPath, "utf8"), canonicalControlBeforeDuplicate);
    assert.deepEqual(listRuns(root, { branch: BRANCH, includeTerminal: true }).map((run) => run.run_id).sort(), runsBeforeDuplicate);
    const source = discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "feature:identityless");
    assert.ok(source);
    const migrated = migrateLegacySource(root, source!);
    assert.equal(migrated.ok, true, migrated.ok ? "" : migrated.error);
    if (!migrated.ok) return;
    const proofPath = join(root, ".work-state", "runs", migrated.run_id, "revisions", migrated.migration_id, "succeeded-slots.json");
    const proofBytes = readFileSync(proofPath);
    const canonicalBeforeProofFault = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8");
    rmSync(proofPath);
    const blockedMissingProof = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(blockedMissingProof.ok, false);
    assert.equal(readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8"), canonicalBeforeProofFault);
    writeFileSync(proofPath, proofBytes);
    const statePath = join(root, ".work-state", "runs", migrated.run_id, "state.json");
    const originalStateBytes = readFileSync(statePath);
    const originalProofBytes = readFileSync(proofPath);
    const tamperedState = JSON.parse(originalStateBytes.toString("utf8")) as TeamState;
    tamperedState.migration_succeeded_slots!.intake_repo_map![0]!.slot_id = "tech-researcher";
    const tamperedStateBytes = Buffer.from(`${JSON.stringify(tamperedState)}\n`);
    writeFileSync(statePath, tamperedStateBytes);
    const tamperedProof = JSON.parse(originalProofBytes.toString("utf8")) as { slots?: Array<{ slot_id?: string }> };
    tamperedProof.slots![0]!.slot_id = "tech-researcher";
    writeFileSync(proofPath, `${JSON.stringify(tamperedProof)}\n`);
    const blockedSlotRebind = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(blockedSlotRebind.ok, false);
    assert.equal(readFileSync(statePath, "utf8"), tamperedStateBytes.toString("utf8"));
    writeFileSync(statePath, originalStateBytes);
    writeFileSync(proofPath, originalProofBytes);
    const omittedStageState = JSON.parse(originalStateBytes.toString("utf8")) as TeamState;
    delete omittedStageState.migration_succeeded_slots!.intake_repo_map;
    const omittedStageBytes = Buffer.from(`${JSON.stringify(omittedStageState)}\n`);
    writeFileSync(statePath, omittedStageBytes);
    const blockedOmittedStage = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(blockedOmittedStage.ok, false);
    assert.equal(readFileSync(statePath, "utf8"), omittedStageBytes.toString("utf8"));
    writeFileSync(statePath, originalStateBytes);
    const omittedSlotState = JSON.parse(originalStateBytes.toString("utf8")) as TeamState;
    omittedSlotState.migration_succeeded_slots!.intake_repo_map = [];
    const omittedSlotBytes = Buffer.from(`${JSON.stringify(omittedSlotState)}\n`);
    writeFileSync(statePath, omittedSlotBytes);
    const blockedOmittedSlot = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(blockedOmittedSlot.ok, false);
    assert.equal(readFileSync(statePath, "utf8"), omittedSlotBytes.toString("utf8"));
    writeFileSync(statePath, originalStateBytes);
    const revisionRoot = join(root, ".work-state", "runs", migrated.run_id, "revisions", migrated.migration_id);
    const revisionBackup = `${revisionRoot}.real`;
    externalRevision = mkdtempSync(join(tmpdir(), "rl-external-revision-"));
    renameSync(revisionRoot, revisionBackup);
    cpSync(revisionBackup, externalRevision, { recursive: true });
    symlinkSync(externalRevision, revisionRoot);
    const canonicalBeforeSymlinkFault = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8");
    const blockedSymlinkRevision = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(blockedSymlinkRevision.ok, false);
    assert.equal(readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8"), canonicalBeforeSymlinkFault);
    unlinkSync(revisionRoot);
    renameSync(revisionBackup, revisionRoot);
    rmSync(externalRevision, { recursive: true, force: true });
    const archiveStatePath = join(revisionRoot, "state.json");
    const archiveStateBytes = readFileSync(archiveStatePath);
    const manifestPath = join(revisionRoot, "manifest.json");
    const manifestBytes = readFileSync(manifestPath);
    const tamperedRevisionStateBytes = Buffer.concat([archiveStateBytes, Buffer.from("\n")]);
    writeFileSync(archiveStatePath, tamperedRevisionStateBytes);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { state_sha256?: string };
    manifest.state_sha256 = createHash("sha256").update(tamperedRevisionStateBytes).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const canonicalBeforeArchiveFault = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8");
    const blockedArchiveState = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.equal(blockedArchiveState.ok, false);
    assert.equal(readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8"), canonicalBeforeArchiveFault);
    writeFileSync(archiveStatePath, archiveStateBytes);
    writeFileSync(manifestPath, manifestBytes);
    const begun = beginCapability(root, undefined, { runId: migrated.run_id });
    assert.ok(begun.ok && begun.handoff);
    const imported = readRunState(root, migrated.run_id)?.dispatch_capability?.dispatches.find((dispatch) => dispatch.id === "legacy-identityless");
    assert.equal(imported?.attempt, 0);
    assert.equal(imported?.work_identity, undefined);
    const liveAuth = { ...begun.handoff!, token: begun.handoff!.dispatch_token, run_id: migrated.run_id, role: "tech-researcher", agent: "tech-researcher" };
    const authorized = authorizeDispatch(root, liveAuth);
    assert.equal(authorized.ok, true, authorized.ok ? "" : authorized.error);
    assert.ok(authorized.ok && authorized.record);
    const beforeSpoof = readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8");
    const spoof = completeDispatch(root, {
      ...liveAuth, dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "spoofed migration completion",
      completed_by: "migration", terminal_signal: "migration_verified",
    }, { runId: migrated.run_id });
    const materialized = readRunState(root, migrated.run_id)!;
    const baselineIssues: string[] = [];
    assert.ok(normalizePersistedState(materialized, baselineIssues), baselineIssues.join("; "));
    const malformed = (mutate: (dispatch: Record<string, unknown>, state: TeamState) => void): void => {
      const candidate = JSON.parse(JSON.stringify(materialized)) as TeamState;
      const dispatch = candidate.dispatch_capability!.dispatches.find((entry) => entry.id === "legacy-identityless")!;
      mutate(dispatch as unknown as Record<string, unknown>, candidate);
      const issues: string[] = [];
      assert.equal(normalizePersistedState(candidate, issues), null, issues.join("; "));
    };
    malformed((dispatch) => {
      assert.equal(dispatch.work_identity, undefined);
      const completion = dispatch.completion as Record<string, unknown>;
      const completionIdentity = completion.work_identity as Record<string, unknown>;
      const envelope = dispatch.completion_envelope as Record<string, unknown>;
      const envelopeIdentity = envelope.identity as Record<string, unknown>;
      completionIdentity.task_id = "wrong-task";
      envelopeIdentity.task_id = "wrong-task";
    });
    malformed((dispatch) => {
      const envelope = dispatch.completion_envelope as Record<string, unknown>;
      envelope.evidence_ref = "revisions/wrong/succeeded-slots.json";
    });
    malformed((dispatch) => {
      const envelope = dispatch.completion_envelope as Record<string, unknown>;
      const refs = envelope.artifact_refs as Array<Record<string, unknown>>;
      assert.ok(refs.length);
      refs[0]!.path = "/tmp/outside-revision.json";
    });
    assert.equal(spoof.ok, false);
    assert.equal(readFileSync(join(root, ".work-state", "runs", migrated.run_id, "state.json"), "utf8"), beforeSpoof);
    const completed = completeDispatch(root, {
      ...liveAuth, dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "tech researcher completed normally",
    }, { runId: migrated.run_id });
    assert.equal(completed.ok, true, completed.ok ? "" : completed.error);
  } finally {
    if (externalRevision) rmSync(externalRevision, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// A durable fan-in artifact write survives a child exception after state publication.
test("process acceptance: fan-in artifact journal recovers after state rename exception", async () => {
  const root = scratch("rl-fan-in-artifact-journal");
  try {
    initGit(root); publishMapping(root);
    writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { analyst: "analyst", "tech-researcher": "tech-researcher" } }) + "\n");
    const config = resolveConfig(root);
    writeAgentMapping(root, buildAgentMapping({ roles: config.roles, availableAgents: ["analyst", "tech-researcher"], extraRoles: config.scope_map.map((entry) => entry.dev_agent), genericFallbackRoles: ["analyst", "tech-researcher"] }));
    const runId = randomUUID();
    const profile = loadProfile("spec-preparation")!;
    const stageId = "intake_repo_map";
    const owner = context(root, "fan-in-owner");
    const capability = createCapability({
      run_key: runId, branch: BRANCH, workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: stageId, rework_generation: 0, kind: "consilium",
      expected_roster: [{ role: "analyst", agent: "analyst" }, { role: "tech-researcher", agent: "tech-researcher" }],
    });
    persistCanonicalRun(root, canonicalState(runId, {
      classification: { ...CLASSIFICATION, workflow: profile.name },
      profile_hash: profileHash(profile), stage_cursor: stageId, cursor_epoch: capability.state.issued_for.cursor_epoch,
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === stageId ? "in_progress" as const : "pending" as const })),
      artifacts: { spec_intake_repo_map: "artifacts/spec_intake_repo_map.json" },
      scope: { scope: ["analyst", "tech-researcher"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "analyst" },
      dispatch_capability: capability.state,
    }), { context: owner });
    const artifacts = join(root, ".work-state", "runs", runId, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const authBase = {
      run_id: runId, run_key: runId, branch: BRANCH, workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: stageId, cursor_epoch: capability.state.issued_for.cursor_epoch, loop_iteration: 1,
      capability_id: capability.state.capability_id, token: capability.dispatch_token,
    };
    const complete = (role: string, agent: string, value: object): void => {
      writeFileSync(join(artifacts, "spec_intake_repo_map.json"), JSON.stringify(value));
      const authorized = authorizeDispatch(root, { ...authBase, role, agent });
      assert.equal(authorized.ok, true, authorized.ok ? "" : authorized.error);
      assert.ok(authorized.ok && authorized.record, JSON.stringify(authorized));
      const result = completeDispatch(root, { ...authBase, role, agent, dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "slot complete", artifact_ids: ["spec_intake_repo_map"] }, { runId });
      assert.equal(result.ok, true, result.ok ? "" : result.error);
    };
    complete("analyst", "analyst", { facts: [{ source: "analyst" }] });
    complete("tech-researcher", "tech-researcher", { facts: [{ source: "research" }] });
    const committedEpoch = readRunState(root, runId)?.dispatch_capability?.issued_for.cursor_epoch;
    assert.ok(committedEpoch);
    const child = await childScript(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [root, authJson] = process.argv.slice(1);
      const auth = JSON.parse(authJson);
      const originalRename = fs.renameSync.bind(fs);
      let injected = false;
      fs.renameSync = ((from, to) => {
        originalRename(from, to);
        if (!injected && String(to).includes("/runs/") && String(to).endsWith("/state.json")) {
          injected = true;
          throw new Error("fan-in post-state publication fault");
        }
      });
      syncBuiltinESMExports();
      const { advanceCursor } = await import(${JSON.stringify(durableEngineUrl)});
      const result = advanceCursor(root, auth, { runId: auth.run_id });
      console.log(JSON.stringify({ injected, result }));
    `, [root, JSON.stringify({
      ...authBase, cursor_epoch: committedEpoch, token: capability.advance_token, evidence: "fan-in advance",
    })]);
    assert.match(child.output, /"injected":true/, child.output);
    assert.equal(child.code, 0, child.output);
    const artifactJournalRoot = join(root, ".work-state", "artifact-transactions");
    const pendingArtifactJournals = existsSync(artifactJournalRoot) ? readdirSync(artifactJournalRoot) : [];
    if (pendingArtifactJournals.length > 0) {
      prepareWorkflowState({
        cwd: root, branch: BRANCH, task: "recover fan-in artifact journal", autonomous: false,
        classification: { ...CLASSIFICATION, workflow: "spec-preparation" }, files: [], issue: null, mode: "resume", run_id: runId,
        request_id: "fan-in-artifact-recovery", feedback: "recover post-state-rename artifact journal",
        execution: context(root, "fan-in-recovery"),
      });
    }
    const recovered = readRunState(root, runId)!;
    assert.equal(recovered.stage_cursor, "requirements_edge_cases");
    const synthesized = JSON.parse(readFileSync(join(artifacts, "spec_intake_repo_map.json"), "utf8")) as { facts?: unknown[] };
    assert.equal(synthesized.facts?.length, 2);
    assert.equal(existsSync(join(artifacts, "spec_intake_repo_map-analyst.json")), true);
    assert.equal(existsSync(join(artifacts, "spec_intake_repo_map-tech-researcher.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Root-source archival interruption repairs unchanged observability bytes after the state rename.
test("process acceptance: interrupted legacy-root archive repairs state docs", async () => {
  const root = scratch("rl-legacy-root-archive");
  let child: ChildProcess | undefined;
  try {
    initGit(root);
    publishMapping(root);
    const work = join(root, ".work-state");
    const artifacts = join(work, "artifacts");
    const observability = join(work, "observability");
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(observability, { recursive: true });
    const discovery = JSON.stringify({ goal: "root legacy" });
    const trace = Buffer.from("telemetry\n", "utf8");
    writeFileSync(join(artifacts, "discovery.json"), discovery);
    writeFileSync(join(observability, "trace.json"), trace);
    const legacy = {
      schema: 1, branch: BRANCH, run_key: BRANCH, classification: CLASSIFICATION, task: "root legacy",
      workflow_override: true, issue: null, stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
      artifacts: { discovery: "artifacts/discovery.json" },
      pause: { kind: "none", reason: "" },
      scope: { scope: ["dev"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "dev" },
      completion_intent: { mode: "complete_outcome", acceptance: "dod_and_artifacts", source: "user", rationale: "root legacy" },
      updated_at: new Date().toISOString(),
    };
    writeFileSync(join(work, "team-state.json"), JSON.stringify(legacy));
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [root] = process.argv.slice(1);
      const originalRename = fs.renameSync.bind(fs);
      const blocker = new Int32Array(new SharedArrayBuffer(4));
      fs.renameSync = ((from, to) => {
        originalRename(from, to);
        if (String(to).includes("/legacy-archive/") && String(to).endsWith("/team-state.json")) {
          console.log("legacy-state-archived");
          Atomics.wait(blocker, 0, 0);
        }
      });
      syncBuiltinESMExports();
      const { discoverLegacySources, migrateLegacySource } = await import(${JSON.stringify(migrationEngineUrl)});
      migrateLegacySource(root, discoverLegacySources(root).sources.find((candidate) => candidate.source_id === "legacy"));
    `;
    const blocked = blockOnMarker(script, [root], "legacy-state-archived");
    child = blocked.child;
    await blocked.ready;
    child!.kill("SIGKILL");
    await waitChildClose(child!);
    const migrationId = readdirSync(join(work, "migrations"))[0]!;
    const receiptBefore = JSON.parse(readFileSync(join(work, "migrations", migrationId, "receipt.json"), "utf8")) as { run_id?: string };
    assert.equal(typeof receiptBefore.run_id, "string");
    prepareWorkflowState({
      cwd: root, branch: BRANCH, task: "recover legacy archive", autonomous: false,
      classification: CLASSIFICATION, files: [], issue: null, mode: "resume", run_id: receiptBefore.run_id,
      request_id: "legacy-archive-recovery", feedback: "recover published migration archive",
      execution: context(root, "legacy-archive-recovery"),
    });
    const archiveRoot = join(work, "legacy-archive", migrationId, "legacy-root");
    const receipt = JSON.parse(readFileSync(join(work, "migrations", migrationId, "receipt.json"), "utf8")) as { file_manifest?: Array<{ source_path?: string; archive_path?: string }> };
    const traceEntry = receipt.file_manifest?.find((entry) => entry.source_path?.endsWith("/observability/trace.json"));
    assert.ok(traceEntry);
    const archiveTracePath = join(archiveRoot, traceEntry!.archive_path!);
    assert.ok(existsSync(archiveTracePath), JSON.stringify({
      archiveRoot,
      traceEntry,
      manifest: receipt.file_manifest,
      sourceExists: traceEntry!.source_path ? existsSync(traceEntry!.source_path) : false,
    }));
    assert.deepEqual(readFileSync(archiveTracePath), trace);
    assert.deepEqual(readFileSync(join(archiveRoot, "team-state.json"), "utf8"), JSON.stringify(legacy));
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitChildClose(child);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
// CTO IDs are a separate claim namespace and can be released through the
// authenticated registered ingress.
test("process acceptance: CTO slug claim release does not enter ordinary UUID validation", () => {
  const root = scratch("rl-cto-claim");
  try {
    const firstController = createWorkflowSessionController({ cwd: root, context: context(root, "cto-first") });
    const first = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "managed CTO release",
      controller: firstController,
    });
    suspendCtoSession(firstController, "session-shutdown");
    const resumedController = createWorkflowSessionController({ cwd: root, context: context(root, "cto-resumed") });
    const resumed = acquireCtoIngress({
      cwd: root,
      branch: BRANCH,
      task: "managed CTO resume",
      run_id: first.run_id,
      controller: resumedController,
    });
    assert.equal(resumed.run_id, first.run_id);
    suspendCtoSession(resumedController, "session-shutdown");
    assert.equal(readRunControl(root).execution_claim, null);
    assert.equal(readRunControl(root).cto_releases[first.run_id]?.run_id, first.run_id);
    assert.equal(workflowOwnerFor(root, "workflow_tools"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
