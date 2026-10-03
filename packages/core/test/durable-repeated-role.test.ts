/**
 * br-eu6 regression tests: repeated semantic stage roles resolve to stable
 * unique dispatch slot identities, and `advanceCursor` atomically arms the
 * next stage's ready capability together with its `in_progress` cursor.
 *
 *   - full-feature `exploration` composed as an explicit three-slot selection
 *     (analyst + tech-researcher + second analyst) issues a valid consilium
 *     capability without "invalid capability roster" errors
 *   - single-role selections scale to the wave-004 multiplicity maxima
 *     (analyst x3, tech-researcher x2) while a fourth analyst still fails closed
 *   - orchestrator -> consilium and single -> single transitions land on an
 *     executable `in_progress` stage with a `ready` capability (no ready
 *     capability is persisted while its stage cursor is pending)
 *   - unique-role rosters keep bare slot identities (unchanged behavior)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash, registerWorkflowProfiles, type Profile } from "../src/engine/profile.js";
import { resolveStageDispatchSlots, selectRoster } from "../src/engine/stage.js";
import { createCapability, beginCapability as rawBeginCapability, authorizeDispatch as rawAuthorizeDispatch, completeDispatch as rawCompleteDispatch, advanceCursor as rawAdvanceCursor, recordCheckpointDecision as rawRecordCheckpointDecision, type CapabilityHandoff } from "../src/engine/durable.js";
import { checkpointPolicyHash, recordTrustedCheckpointAnswer } from "../src/engine/checkpoints.js";
import { resolveConfig } from "../src/engine/config.js";
import { resolveWorkflowContract as rawResolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { buildAgentMapping, writeAgentMapping, type AgentMappingState } from "../src/engine/agent-mapping.js";
import { buildDispatchMarker, parseDispatchMarker, dispatchGate } from "../src/gates/dispatch.js";

import { prepareWorkflowState } from "../src/engine/run.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TeamState } from "../src/engine/types.js";

import { registerWorkflowTools } from "../src/index.js";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";
import { z as zod } from "zod";
import {
  admitOrdinaryBatchWorkers,
  admitOrdinaryWorker,
  createCoreFixture,
  details,
  submission,
  terminalOrdinaryBatchWorkers,
  terminalWorker,
  type Harness,
  type Handoff,
} from "./reliable-stage-execution-fixture.js";
const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };
const RUN_ID = "99999999-9999-4999-8999-999999999999";
function publicAuth(handoff: Handoff): {
  token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  loop_iteration: number;
} {
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
  };
}
async function prepareRegistered(harness: Harness, profile?: Profile): Promise<void> {
  const prepared = harness.controller.prepare({ mode: "resume", run_id: RUN_ID });
  assert.equal(prepared.state.run_id, RUN_ID, `${profile?.name ?? "registered"} resume must select the fixture run`);
  assert.equal(harness.controller.activeClaimRunId(), RUN_ID, "registered fixture must hold the active execution claim");
}
async function beginRegistered(harness: Harness, selection?: unknown): Promise<Handoff> {
  const tool = harness.tools.get("workflow_begin");
  assert.ok(tool, "registered workflow_begin must be available");
  const result = details((await tool.execute(
    "durable-repeated-role-begin",
    selection === undefined ? {} : { selection },
    undefined,
    undefined,
    harness.context,
  )).details);
  assert.equal(result.ok, true, JSON.stringify(result));
  const handoff = result.handoff;
  assert.ok(handoff && typeof handoff === "object" && !Array.isArray(handoff), JSON.stringify(result));
  return handoff as Handoff;
}
async function submitRegistered(harness: Harness, context: unknown, id: string, outputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = harness.tools.get("workflow_submit_result");
  assert.ok(tool, "registered workflow_submit_result must be available");
  return details((await tool.execute(id, submission(outputs), undefined, undefined, context)).details);
}
async function advanceRegistered(harness: Harness, handoff: Handoff, evidence: string): Promise<Record<string, unknown>> {
  const tool = harness.tools.get("workflow_advance");
  assert.ok(tool, "registered workflow_advance must be available");
  return details((await tool.execute(
    "durable-repeated-role-advance",
    { ...publicAuth(handoff), evidence },
    undefined,
    undefined,
    harness.context,
  )).details);
}
async function humanCheckpoint(harness: Harness, handoff: Handoff, checkpoint: string, checkpointKind: string): Promise<Record<string, unknown>> {
  const askTool = harness.tools.get("workflow_checkpoint_ask");
  assert.ok(askTool, "registered workflow_checkpoint_ask must be available");
  const asked = details((await askTool.execute(
    "durable-repeated-role-checkpoint-ask",
    {
      token: handoff.advance_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      checkpoint,
      checkpoint_id: checkpoint,
      checkpoint_kind: checkpointKind,
      loop_iteration: handoff.loop_iteration,
    },
    undefined,
    undefined,
    harness.context,
  )).details);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const checkpointTool = harness.tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "registered workflow_checkpoint must be available");
  return details((await checkpointTool.execute(
    "durable-repeated-role-checkpoint-record",
    {
      ...publicAuth(handoff),
      checkpoint,
      checkpoint_id: checkpoint,
      checkpoint_kind: checkpointKind,
      authorization: "human",
      actor_provenance: asked.actor_provenance,
      decision: asked.decision,
      rationale: "registered human checkpoint fixture",
    },
    undefined,
    undefined,
    harness.context,
  )).details);
}
function beginCapability(root: string, selection?: Parameters<typeof rawBeginCapability>[1], options?: Parameters<typeof rawBeginCapability>[2]) {
  return rawBeginCapability(root, selection, { runId: RUN_ID, ...options });
}
function authorizeDispatch(root: string, input: Parameters<typeof rawAuthorizeDispatch>[1]) {
  return rawAuthorizeDispatch(root, { run_id: RUN_ID, run_key: RUN_ID, ...input });
}
function completeDispatch(root: string, input: Parameters<typeof rawCompleteDispatch>[1]) {
  if (input.artifact_ids?.length) {
    const statePath = join(root, ".work-state", "runs", RUN_ID, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    const artifacts = { ...(state.artifacts ?? {}) };
    for (const id of input.artifact_ids) artifacts[id] = `artifacts/${id}.json`;
    writeFileSync(statePath, JSON.stringify({ ...state, artifacts }) + "\n");
  }
  return rawCompleteDispatch(root, { run_id: RUN_ID, run_key: RUN_ID, ...input }, { runId: RUN_ID });
}
function advanceCursor(root: string, input: Parameters<typeof rawAdvanceCursor>[1], options?: Parameters<typeof rawAdvanceCursor>[2]) {
  return rawAdvanceCursor(root, { run_id: RUN_ID, run_key: RUN_ID, ...input }, { runId: RUN_ID, ...options });
}
function recordCheckpointDecision(root: string, input: Parameters<typeof rawRecordCheckpointDecision>[1]) {
  return rawRecordCheckpointDecision(root, { run_id: RUN_ID, run_key: RUN_ID, ...input });
}
function writeCanonicalFixture(root: string, state: TeamState): void {
  const capability = state.dispatch_capability
    ? { ...state.dispatch_capability, issued_for: state.dispatch_capability.issued_for ? { ...state.dispatch_capability.issued_for, run_key: RUN_ID } : state.dispatch_capability.issued_for }
    : undefined;
  const canonical: TeamState = {
    ...state,
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: state.lifecycle_status ?? "active",
    state_revision: state.state_revision ?? 1,
    required_inputs: state.required_inputs ?? {},
    required_input_receipts: state.required_input_receipts ?? {},
    ...(state.checkpoint_policy ? { checkpoint_policy: state.checkpoint_policy } : (state.classification?.workflow ? { checkpoint_policy: loadProfile(state.classification.workflow)?.checkpoint_policy } : {})),
    ...(capability ? { dispatch_capability: capability } : {}),
  };
  const runDir = join(root, ".work-state", "runs", RUN_ID);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  const profile = canonical.classification?.workflow ? loadProfile(canonical.classification.workflow) : null;
  const currentStage = profile?.stages.find((stage) => stage.id === canonical.stage_cursor);
  const artifacts = { ...(canonical.artifacts ?? {}) };
  for (const id of currentStage?.consumes ?? []) {
    artifacts[id] ??= `artifacts/${id}.json`;
    const artifactPath = join(runDir, "artifacts", `${id}.json`);
    if (!existsSync(artifactPath)) writeFileSync(artifactPath, JSON.stringify({ task: canonical.task, branch: canonical.branch, summary: id, findings: [] }) + "\n");
  }
  writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...canonical, artifacts }) + "\n");
}
function readCanonicalState(root: string) {
  const statePath = join(root, ".work-state", "runs", RUN_ID, "state.json");
  if (!existsSync(statePath)) return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
  return { state: JSON.parse(readFileSync(statePath, "utf8")) as TeamState, statePath, stateDir: join(root, ".work-state", "runs", RUN_ID), artifactsDir: join(root, ".work-state", "runs", RUN_ID, "artifacts"), isLegacy: false, isStale: false };
}
function resolveWorkflowContract(root: string) {
  return rawResolveWorkflowContract(root, { runId: RUN_ID });
}

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function trustedCheckpoint(root: string, stageId: string, checkpointId: string, decision: string, channel: "terminal" | "escalation" = "terminal") {
  const resolved = readCanonicalState(root);
  assert.ok(resolved.state, "checkpoint fixture state must resolve");
  const trusted = recordTrustedCheckpointAnswer(resolved.state, {
    answer_id: `durable/${stageId}/${checkpointId}`,
    channel,
    reference: `${channel}-answer/durable/${stageId}/${checkpointId}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision,
  });
  writeCanonicalFixture(root, trusted.state);

  return trusted;
}

const poolRoles = {
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  architect: "architect",
} as const;

/** Publish a trusted live agent mapping for the full-feature selection pool. */
function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: poolRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(poolRoles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(poolRoles),
  });
  writeAgentMapping(root, mapping);
}
const THREE_SLOT_SELECTION = {
  occurrences: [
    { role: "analyst", reason: "codebase probe" },
    { role: "tech-researcher", reason: "prior art" },
    { role: "analyst", facet: "second-probe", reason: "second probe" },
  ],
};
test("br-eu6: pool selection normalizes repeated roles to unique dispatch slots and keeps semantic roles", () => {
  const profile = loadProfile("full-feature");
  assert.ok(profile, "full-feature profile must be available");
  const exploration = profile.stages.find((stage) => stage.id === "exploration");
  assert.ok(exploration, "full-feature exploration stage must exist");
  assert.ok(exploration.roster_policy, "exploration declares an allowed-pool roster policy");
  const ctx = { cwd: process.cwd(), flags: NO_SCOPE, resolveDevAgent: () => null as string | null };
  const selected = selectRoster(exploration, {
    ...ctx,
    resolveAgent: (role) => role,
    selected_occurrences: THREE_SLOT_SELECTION.occurrences.map((occurrence) => ({ ...occurrence })),
  });
  assert.equal(selected.ok, true, selected.ok ? "selection accepted" : selected.error);
  if (!selected.ok) return;
  assert.deepEqual(selected.slots.map((slot) => slot.slot), ["analyst#1", "tech-researcher", "analyst#2"], "repeated roles get unique numbered slots");
  assert.deepEqual(selected.slots.map((slot) => slot.role), ["analyst", "tech-researcher", "analyst"], "semantic roles are preserved");
  assert.equal(new Set(selected.slots.map((slot) => slot.slot)).size, 3, "slot identities must not be deduplicated");
  // Architecture pool: repeated architect occurrences keep unique slots.
  const architecture = profile.stages.find((stage) => stage.id === "architecture");
  assert.ok(architecture);
  assert.ok(architecture.roster_policy, "architecture declares an allowed-pool roster policy");
  const unique = selectRoster(architecture, {
    ...ctx,
    resolveAgent: (role) => role,
    selected_occurrences: [
      { role: "architect", facet: "minimal-change" },
      { role: "architect", facet: "clean-architecture" },
      { role: "architect", facet: "pragmatic-balance" },
    ],
  });
  assert.equal(unique.ok, true, unique.ok ? "architecture selection accepted" : unique.error);
  if (!unique.ok) return;
  assert.deepEqual(unique.slots.map((slot) => slot.slot), ["architect#1", "architect#2", "architect#3"]);
  assert.deepEqual(unique.slots.map((slot) => slot.role), ["architect", "architect", "architect"]);
});

const ANALYST_TRIO_SELECTION = {
  occurrences: [
    { role: "analyst", reason: "first probe" },
    { role: "analyst", facet: "second-probe", reason: "second probe" },
    { role: "analyst", facet: "third-probe", reason: "third probe" },
  ],
};

const RESEARCHER_PAIR_SELECTION = {
  occurrences: [
    { role: "tech-researcher", reason: "prior art" },
    { role: "tech-researcher", facet: "standards", reason: "standards probe" },
  ],
};

test("br-eu6: single-role exploration selections fill repeated slots up to the wave-004 multiplicity maxima", () => {
  const profile = loadProfile("full-feature");
  assert.ok(profile, "full-feature profile must be available");
  const exploration = profile.stages.find((stage) => stage.id === "exploration");
  assert.ok(exploration, "full-feature exploration stage must exist");
  assert.ok(exploration.roster_policy, "exploration declares an allowed-pool roster policy");
  assert.equal(exploration.roster_policy.max_workers, 3, "overall worker bound stays at three");
  assert.equal(exploration.roster_policy.multiplicity.analyst?.max, 3, "analyst multiplicity max is three");
  assert.equal(exploration.roster_policy.multiplicity["tech-researcher"]?.max, 3, "tech-researcher multiplicity max is three");
  const ctx = { cwd: process.cwd(), flags: NO_SCOPE, resolveDevAgent: () => null as string | null };

  const analysts = selectRoster(exploration, {
    ...ctx,
    resolveAgent: (role) => role,
    selected_occurrences: ANALYST_TRIO_SELECTION.occurrences.map((occurrence) => ({ ...occurrence })),
  });
  assert.equal(analysts.ok, true, analysts.ok ? "explicit analyst trio accepted" : analysts.error);
  if (!analysts.ok) return;
  assert.deepEqual(analysts.slots.map((slot) => slot.slot), ["analyst#1", "analyst#2", "analyst#3"], "analyst trio normalizes to stable repeated-role slots");
  assert.deepEqual(analysts.slots.map((slot) => slot.role), ["analyst", "analyst", "analyst"], "semantic analyst roles are preserved");
  assert.equal(analysts.selection.selected.length, 3, "the frozen selection keeps three analyst entries");

  // Fail-closed behavior is preserved: a fourth analyst exceeds every bound.
  const overflow = selectRoster(exploration, {
    ...ctx,
    resolveAgent: (role) => role,
    selected_occurrences: [
      ...ANALYST_TRIO_SELECTION.occurrences.map((occurrence) => ({ ...occurrence })),
      { role: "analyst", reason: "overflow probe" },
    ],
  });
  assert.equal(overflow.ok, false, "a fourth analyst must still be rejected");
  if (overflow.ok) return;
  assert.match(overflow.error, /exceeds multiplicity maximum/);

  const researchers = selectRoster(exploration, {
    ...ctx,
    resolveAgent: (role) => role,
    selected_occurrences: RESEARCHER_PAIR_SELECTION.occurrences.map((occurrence) => ({ ...occurrence })),
  });
  assert.equal(researchers.ok, true, researchers.ok ? "explicit tech-researcher pair accepted" : researchers.error);
  if (!researchers.ok) return;
  assert.deepEqual(researchers.slots.map((slot) => slot.slot), ["tech-researcher#1", "tech-researcher#2"], "tech-researcher pair normalizes to stable repeated-role slots");
  assert.deepEqual(researchers.slots.map((slot) => slot.role), ["tech-researcher", "tech-researcher"], "semantic tech-researcher roles are preserved");
});

test("br-eu6: full-feature exploration issues a valid consilium capability; marker validation cannot collapse analyst slots", () => {
  const root = mkdtempSync(join(tmpdir(), "br-eu6-cap-"));
  try {
    initGit(root, "feat/repeat");
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const exploration = profile.stages.find((stage) => stage.id === "exploration");
    assert.ok(exploration);
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/repeat",
      run_key: RUN_ID,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
      task: "repeated analyst regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "exploration",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "exploration" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: NO_SCOPE,
      updated_at: new Date().toISOString(),
    });

    publishMapping(root);
    const begun = beginCapability(root, THREE_SLOT_SELECTION);
    assert.equal(begun.ok, true, begun.ok ? "consilium capability with repeated roles must not be rejected" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    const handoff = begun.handoff;
    assert.equal(handoff.kind, "consilium");
    assert.deepEqual(handoff.expected_roster, [
      { role: "analyst#1", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
      { role: "analyst#2", agent: "analyst" },
    ], "both analyst slots resolve to the analyst agent");

    const roles = ["analyst#1", "tech-researcher", "analyst#2"];
    const markerFor = (role: string): string => buildDispatchMarker(handoff.run_key, exploration, roles, role, handoff.cursor_epoch);
    assert.equal(parseDispatchMarker(markerFor("analyst#1"))?.role, "analyst#1");
    assert.equal(parseDispatchMarker(markerFor("analyst#2"))?.role, "analyst#2");

    // A batch dispatching both analyst occurrences passes the gate.
    const batch = dispatchGate({ toolName: "task", input: { tasks: [
      { agent: "analyst", task: markerFor("analyst#1") },
      { agent: "tech-researcher", task: markerFor("tech-researcher") },
      { agent: "analyst", task: markerFor("analyst#2") },
    ] } }, { cwd: root });
    assert.equal(batch, undefined, "gate accepts two distinct analyst slots");

    // Collapsing both occurrences onto one slot must be rejected.
    const collapsed = dispatchGate({ toolName: "task", input: { tasks: [
      { agent: "analyst", task: markerFor("analyst#1") },
      { agent: "tech-researcher", task: markerFor("tech-researcher") },
      { agent: "analyst", task: markerFor("analyst#1") },
    ] } }, { cwd: root });
    assert.equal(collapsed?.block, true, "marker validation cannot collapse analyst slots");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("br-eu6: single-to-single advance arms the next stage; required inputs are read before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-eu6-single-"));
  initGit(root, "feat/single");
  const profile = loadProfile("lightweight");
  assert.ok(profile);
  const persistedProfileHash = profileHash(profile);
  const issued = createCapability({
    run_key: RUN_ID, branch: "feat/single", workflow: "lightweight", profile_hash: persistedProfileHash,
    stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
  });
  writeCanonicalFixture(root, {
    schema: 1,
    branch: "feat/single",
    run_key: RUN_ID,
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "single to single",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "done" as const : stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedProfileHash,
    scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  });
  const harness = createCoreFixture({
    root,
    branch: "feat/single",
    workflowProfiles: [profile],
    roles: {
      "${scope.dev_agent}": "developer-kotlin",
      "developer-kotlin": "developer-kotlin",
      "code-reviewer": "code-reviewer",
    },
  });
  try {
    await prepareRegistered(harness, profile);
    const handoff = await beginRegistered(harness);
    assert.equal(handoff.kind, "single");
    assert.deepEqual(handoff.expected_roster, [{ role: "developer-kotlin", agent: "developer-kotlin" }]);
    const worker = await admitOrdinaryWorker(harness, handoff, "single-to-single");
    const submitted = await submitRegistered(harness, worker.childContext, "single-to-single-submit", {
      implementation: { ready: true, validation_run: true, validation_evidence: "focused single-to-single regression", files_touched: ["src/index.ts"] },
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await terminalWorker(harness, worker);

    const implementationStage = profile.stages.find((stage) => stage.id === "implementation");
    assert.ok(implementationStage?.checkpoint === "approve_implementation");
    const implementationPolicy = profile.checkpoint_policy;
    assert.ok(implementationPolicy);
    const implementationRule = implementationPolicy.rules.approve_implementation;
    assert.ok(implementationRule);
    const checkpoint = await humanCheckpoint(harness, handoff, "approve_implementation", implementationRule.kind);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));

    const advanced = await advanceRegistered(harness, handoff, "implementation completed");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    const advancedState = readCanonicalState(root).state;
    assert.ok(advancedState);
    assert.equal(advancedState.stage_cursor, "code_review");
    assert.equal(advancedState.dispatch_capability?.status, "ready");
    assert.equal(advancedState.dispatch_capability?.kind, "single");
    assert.deepEqual(advancedState.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }]);
    assert.equal(advancedState.stages.find((s) => s.id === "code_review")?.status, "in_progress", "single-to-single lands on an executable in_progress stage");

    const codeReview = profile.stages.find((stage) => stage.id === "code_review");
    assert.ok(codeReview);
    const marker = buildDispatchMarker(RUN_ID, codeReview, ["code-reviewer"], "code-reviewer", advancedState.cursor_epoch!);
    const blockedBeforeRead = dispatchGate({ toolName: "task", input: { agent: "code-reviewer", role: "code-reviewer", task: marker } }, { cwd: root });
    assert.equal(blockedBeforeRead?.reason, "dispatch gate: recovery_required: required inputs must be read and hash-receipted before dispatch");

    // Public workflow_begin reads code_review's declared implementation input,
    // hashes the exact artifact bytes, and persists the capability-bound receipt.
    const begun = await beginRegistered(harness);
    assert.deepEqual(begun.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }]);
    const gate = dispatchGate({ toolName: "task", input: { agent: "code-reviewer", role: "code-reviewer", task: begun.dispatch_markers[0]!.marker } }, { cwd: root });
    assert.equal(gate, undefined, "required-input read receipt makes the armed next stage executable");
  } finally {
    await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});


const ARCHITECT_PAIR_SELECTION = {
  occurrences: [
    { role: "architect", facet: "minimal-change", reason: "option one" },
    { role: "architect", facet: "clean-architecture", reason: "option two" },
  ],
};

/** Persist a hostile but fully hash-consistent mapping pair (config + runtime file). */
function publishHostileMapping(root: string, roles: Record<string, string>, availableAgents: string[]): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents,
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(roles),
  });
  writeAgentMapping(root, mapping);
}

/** Fresh in-memory discovery result: the trusted handoff shape. */
function freshMapping(roles: Record<string, string>, availableAgents: string[]): AgentMappingState {
  return buildAgentMapping({ roles, availableAgents, extraRoles: [], genericFallbackRoles: Object.keys(roles) });
}

test("wave-004: advance into architecture stays semantically unselected; workflow_begin selects multiple architects", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-arch-"));
  initGit(root, "feat/arch");
  const profile = loadProfile("full-feature");
  assert.ok(profile);
  const persistedProfileHash = profileHash(profile);
  const issued = createCapability({
    run_key: RUN_ID, branch: "feat/arch", workflow: "full-feature", profile_hash: persistedProfileHash,
    stage_cursor: "clarify", kind: "none", expected_roster: [],
  });
  writeCanonicalFixture(root, {
    schema: 1,
    branch: "feat/arch",
    run_key: RUN_ID,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
    task: "multi-architect selection regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "clarify",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" || stage.id === "exploration" ? "done" as const : stage.id === "clarify" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedProfileHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  });
  const artifactsDir = join(root, ".work-state", "runs", RUN_ID, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "arch", branch: "feat/arch", constraints: [] }));
  writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "explored" }));
  writeFileSync(join(artifactsDir, "clarifications.json"), JSON.stringify({ questions: [], answers: ["proceed"] }));
  const harness = createCoreFixture({ root, branch: "feat/arch", workflowProfiles: [profile], roles: poolRoles });
  publishMapping(root);
  try {
    await prepareRegistered(harness, profile);
    const clarify = await beginRegistered(harness);
    const submitted = await submitRegistered(harness, harness.context, "wave004-clarify-submit", {
      clarifications: { questions: [], answers: ["proceed"] },
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const clarifyStage = profile.stages.find((stage) => stage.id === "clarify");
    assert.ok(clarifyStage?.checkpoint === "user_answers");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.user_answers;
    assert.ok(rule);
    const checkpoint = await humanCheckpoint(harness, clarify, "user_answers", rule.kind);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));

    const advanced = await advanceRegistered(harness, clarify, "clarify completed");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    const advancedState = readCanonicalState(root).state;
    assert.ok(advancedState);
    assert.equal(advancedState.stage_cursor, "architecture");
    assert.equal(advancedState.dispatch_capability, undefined, "the deferred-roster advance leaves no capability behind: begin issues the deferred stage's own capability");
    assert.equal(advancedState.stages.find((s) => s.id === "architecture")?.status, "pending", "architecture is not armed by advance");
    assert.equal(advancedState.roster_selection, undefined, "no default architect roster is frozen before begin");

    const begun = await beginRegistered(harness, ARCHITECT_PAIR_SELECTION);
    assert.equal(begun.kind, "consilium");
    assert.deepEqual(begun.expected_roster, [
      { role: "architect#1", agent: "architect" },
      { role: "architect#2", agent: "architect" },
    ], "both architect occurrences resolve to numbered executable slots");
    const afterBegin = readCanonicalState(root).state;
    assert.equal(afterBegin?.roster_selection?.selected.length, 2, "the semantic selection is frozen with both occurrences");
    const workers = await admitOrdinaryBatchWorkers(harness, begun, "wave004-architect");
    assert.equal(workers.length, 2);
    for (const [index, worker] of workers.entries()) {
      const slot = begun.expected_roster[index]!;
      const result = await submitRegistered(harness, worker.childContext, `wave004-architect-submit-${index}`, {
        architecture: {
          options: [{ id: `option-${index + 1}`, summary: `Architecture option ${index + 1}` }],
          chosen: `option-${index + 1}`,
          rationale: "registered producer fixture",
        },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(slot.agent, "architect");
    }
    await terminalOrdinaryBatchWorkers(harness, workers);
  } finally {
    await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fixture state parked on the architecture stage with upstream stages done. */
function writeArchitectureFixture(root: string, branch: string): void {
  initGit(root, branch);
  const profile = loadProfile("full-feature");
  assert.ok(profile);
  const persistedProfileHash = profileHash(profile);
  const runDir = join(root, ".work-state", "runs", RUN_ID);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "exploration.json"), JSON.stringify({ summary: "exploration" }) + "\n");
  writeFileSync(join(runDir, "artifacts", "clarifications.json"), JSON.stringify({ answers: [] }) + "\n");
  writeCanonicalFixture(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
    task: "trusted mapping provenance regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "architecture",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" || stage.id === "exploration" || stage.id === "clarify" ? "done" as const : stage.id === "architecture" ? "in_progress" as const : "pending" as const })),
    artifacts: { exploration: "artifacts/exploration.json", clarifications: "artifacts/clarifications.json" },
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    checkpoint_policy: profile.checkpoint_policy,
    profile_hash: persistedProfileHash,
    scope: NO_SCOPE,
    updated_at: new Date().toISOString(),
  });
}

test("wave-004: trusted mapping handoff wins over a tampered persisted mapping; malformed handoff fails closed; fallback stays compatible", () => {
  const control = mkdtempSync(join(tmpdir(), "wave004-hostile-control-"));
  const trusted = mkdtempSync(join(tmpdir(), "wave004-hostile-trusted-"));
  try {
    writeArchitectureFixture(control, "feat/hostile-control");
    writeArchitectureFixture(trusted, "feat/hostile-trusted");
    const hostileRoles = { ...poolRoles, architect: "omp-attacker" };
    const hostilePool = [...Object.values(poolRoles), "omp-attacker"];
    publishHostileMapping(control, hostileRoles, hostilePool);
    publishHostileMapping(trusted, hostileRoles, hostilePool);

    const controlBegun = beginCapability(control, ARCHITECT_PAIR_SELECTION);
    assert.equal(controlBegun.ok, true, controlBegun.ok ? "fallback begin accepted" : controlBegun.error);
    if (controlBegun.ok && controlBegun.handoff) {
      assert.deepEqual(controlBegun.handoff.expected_roster.map((entry) => entry.agent), ["omp-attacker", "omp-attacker"], "without a handoff the persisted workspace mapping still resolves the roster");
    }

    const trustedBegun = beginCapability(trusted, ARCHITECT_PAIR_SELECTION, { trustedMapping: freshMapping({ ...poolRoles }, Object.values(poolRoles)) });
    assert.equal(trustedBegun.ok, true, trustedBegun.ok ? "trusted begin accepted" : trustedBegun.error);
    if (!trustedBegun.ok || !trustedBegun.handoff) return;
    assert.deepEqual(trustedBegun.handoff.expected_roster, [
      { role: "architect#1", agent: "architect" },
      { role: "architect#2", agent: "architect" },
    ], "the trusted in-memory mapping wins over the tampered persisted file");

    const malformed = beginCapability(trusted, ARCHITECT_PAIR_SELECTION, { trustedMapping: { schema: 99 } as unknown as AgentMappingState });
    assert.equal(malformed.ok, false, "a malformed trusted handoff fails closed");
    if (malformed.ok) return;
    assert.match(malformed.error, /trusted agent mapping handoff is malformed/);
    assert.doesNotMatch(malformed.error, /regenerate the agent mapping/, "a malformed handoff never falls back to the persisted file");
    const nullHandoff = beginCapability(trusted, ARCHITECT_PAIR_SELECTION, { trustedMapping: null as unknown as AgentMappingState });
    assert.equal(nullHandoff.ok, false, "a runtime-null handoff fails closed instead of selecting the persisted mapping");
    if (!nullHandoff.ok) assert.match(nullHandoff.error, /trusted agent mapping handoff is malformed/);
    const junkHandoff = beginCapability(trusted, ARCHITECT_PAIR_SELECTION, { trustedMapping: "workspace-file" as unknown as AgentMappingState });
    assert.equal(junkHandoff.ok, false, "a non-object handoff fails closed instead of selecting the persisted mapping");
    if (!junkHandoff.ok) assert.match(junkHandoff.error, /trusted agent mapping handoff is malformed/);
  } finally {
    rmSync(control, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("wave-004: non-roster advance arming consumes the trusted mapping override", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-advance-mapping-"));
  let harness: Harness | undefined;
  try {
    initGit(root, "feat/trusted-advance");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: RUN_ID, branch: "feat/trusted-advance", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/trusted-advance",
      run_key: RUN_ID,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "trusted advance override",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "done" as const : stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    });
    mkdirSync(join(root, ".work-state", "runs", RUN_ID, "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "runs", RUN_ID, "artifacts", "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "trusted advance override regression", files_touched: ["src/index.ts"] }));

    harness = createCoreFixture({
      root,
      branch: "feat/trusted-advance",
      workflowProfiles: [profile],
      roles: { "${scope.dev_agent}": "developer-kotlin", "developer-kotlin": "developer-kotlin", "code-reviewer": "omp-attacker" },
    });
    publishHostileMapping(root, { "${scope.dev_agent}": "developer-kotlin", "code-reviewer": "omp-attacker" }, ["developer-kotlin", "omp-attacker"]);
    await prepareRegistered(harness, profile);
    const handoff = await beginRegistered(harness);
    assert.deepEqual(handoff.expected_roster, [{ role: "developer-kotlin", agent: "developer-kotlin" }]);
    const worker = await admitOrdinaryWorker(harness, handoff, "trusted-advance");
    const submitted = await submitRegistered(harness, worker.childContext, "durable-repeated-role-trusted-submit", {
      implementation: {
        ready: true,
        validation_run: true,
        validation_evidence: "trusted advance override regression",
        files_touched: ["src/index.ts"],
      },
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await terminalWorker(harness, worker);
    const implementationStage = profile.stages.find((stage) => stage.id === "implementation");
    assert.ok(implementationStage?.checkpoint === "approve_implementation");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.approve_implementation;
    assert.ok(rule);
    const checkpoint = await humanCheckpoint(harness, handoff, "approve_implementation", rule.kind);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));

    const auth = publicAuth(handoff);
    const malformedAdvance = advanceCursor(root, { ...auth, evidence: "stage completed" }, { trustedMapping: { schema: 99 } as unknown as AgentMappingState });
    assert.equal(malformedAdvance.ok, false, "a malformed trusted handoff fails the advance closed");
    if (!malformedAdvance.ok) assert.match(malformedAdvance.error, /trusted agent mapping handoff is malformed/);
    const nullAdvance = advanceCursor(root, { ...auth, evidence: "stage completed" }, { trustedMapping: null as unknown as AgentMappingState });
    assert.equal(nullAdvance.ok, false, "a runtime-null advance handoff fails closed instead of selecting the persisted mapping");
    if (!nullAdvance.ok) assert.match(nullAdvance.error, /trusted agent mapping handoff is malformed/);
    const advanced = advanceCursor(root, { ...auth, evidence: "stage completed" }, { trustedMapping: freshMapping({ "${scope.dev_agent}": "developer-kotlin", "code-reviewer": "code-reviewer" }, ["developer-kotlin", "code-reviewer"]) });
    assert.equal(advanced.ok, true, advanced.ok ? "trusted advance ok" : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.deepEqual(advanced.state.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }], "the trusted mapping names the code-reviewer slot, never the tampered file's agent");
  } finally {
    if (harness) await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const LOOP_ROSTER_PROFILE: Profile = {
  name: "loop-roster-regression",
  title: "Loop roster regression",
  description: "roster-policy loop target for durable re-entry tests",
  match: { type: ["OPS"] },
  stages: [
    {
      id: "design", title: "Design", type: "consilium", parallel: true, produces: "design",
      roster_policy: {
        allowed_roles: ["architect"], required_roles: ["architect"], required_facets: [],
        min_workers: 1, max_workers: 2,
        multiplicity: { architect: { min: 1, max: 2 } },
        prefer_distinct_agents: true, selection_mode: "pre_dispatch_minimum_valid",
        triggers: { complexity: [], confidence: [], scope_flags: [], evidence: [] },
        budget: { token_limit: null, dollar_limit: null },
      },
    },
    {
      id: "review", title: "Review", type: "single", role: "reviewer", consumes: ["design"], produces: "review",
      loop: { back_to: "design", until: "verdict == approve", max_iterations: 2, on_exhausted: "escalate_user" },
    },
  ],
};

test("wave-004: loop re-entry into a roster-policy target defers the roster; explicit begin reselects", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-loop-roster-"));
  let harness: Harness | undefined;
  try {
    initGit(root, "feat/loop-roster");
    const profile = LOOP_ROSTER_PROFILE;
    const persistedProfileHash = profileHash(profile);
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/loop-roster",
      run_key: RUN_ID,
      classification: { type: "OPS", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "loop-roster-regression" },
      task: "roster-policy loop re-entry regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "design",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "design" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: NO_SCOPE,
      cursor_epoch: "fixture-epoch-0",
      updated_at: new Date().toISOString(),
    });
    mkdirSync(join(root, ".work-state", "runs", RUN_ID, "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "runs", RUN_ID, "artifacts", "design.json"), JSON.stringify({ chosen: "option-1" }));

    harness = createCoreFixture({
      root,
      branch: "feat/loop-roster",
      workflowProfiles: [profile],
      roles: { architect: "architect", reviewer: "reviewer" },
    });
    publishMapping(root);
    await prepareRegistered(harness, profile);
    const begun = await beginRegistered(harness, { occurrences: [{ role: "architect", reason: "option one" }] });
    assert.deepEqual(begun.expected_roster, [{ role: "architect", agent: "architect" }]);
    const designWorker = await admitOrdinaryWorker(harness, begun, "loop-design");
    const designSubmitted = await submitRegistered(harness, designWorker.childContext, "durable-repeated-role-design-submit", {
      design: { chosen: "option-1" },
    });
    assert.equal(designSubmitted.ok, true, JSON.stringify(designSubmitted));
    await terminalWorker(harness, designWorker);

    const armed = await advanceRegistered(harness, begun, "design completed");
    assert.equal(armed.ok, true, JSON.stringify(armed));
    const reviewHandoff = await beginRegistered(harness);
    assert.deepEqual(reviewHandoff.expected_roster, [{ role: "reviewer", agent: "reviewer" }]);
    const reviewWorker = await admitOrdinaryWorker(harness, reviewHandoff, "loop-review");
    const reviewSubmitted = await submitRegistered(harness, reviewWorker.childContext, "durable-repeated-role-review-submit", {
      review: {
        verdict: "needs_changes",
        findings: [{ title: "flagged edge case", severity: "MEDIUM", confidence: 90, zone: "backend-kotlin" }],
        iterations: 1,
      },
    });
    assert.equal(reviewSubmitted.ok, true, JSON.stringify(reviewSubmitted));
    await terminalWorker(harness, reviewWorker);

    const reentered = await advanceRegistered(harness, reviewHandoff, "review FAIL");
    assert.equal(reentered.ok, true, JSON.stringify(reentered));
    const reenteredState = readCanonicalState(root).state;
    assert.ok(reenteredState);
    assert.equal(reenteredState.stage_cursor, "design", "cursor re-enters the roster-policy target");
    assert.equal(reenteredState.dispatch_capability, undefined, "the deferred-roster loop re-entry leaves no capability behind");
    assert.equal(reenteredState.stages.find((s) => s.id === "design")?.status, "pending", "the loop target stays pending");
    assert.equal(reenteredState.loop_state?.status, "running");
    assert.equal(reenteredState.loop_state?.reentries, 1, "iteration history is recorded");
    assert.notEqual(reenteredState.roster_selections?.["design"]?.capability_epoch, reenteredState.cursor_epoch, "no roster is frozen for the fresh loop epoch");

    const rebegun = await beginRegistered(harness, { occurrences: [{ role: "architect", facet: "second-pass" }] });
    assert.equal(rebegun.cursor_epoch, reenteredState.cursor_epoch, "begin binds to the fresh loop epoch");
    assert.deepEqual(rebegun.expected_roster, [{ role: "architect", agent: "architect" }]);
    const slot = authorizeDispatch(root, {
      ...publicAuth(rebegun),
      token: rebegun.dispatch_token,
      role: "architect",
      agent: "architect",
    });
    assert.equal(slot.ok, true, slot.ok ? "reselected loop iteration is executable" : slot.error);
  } finally {
    if (harness) await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave-004: workflow tools invoke beforeBegin per transition with the exact current cwd; hook rejection fails advance closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-tool-hook-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "wave004-tool-hook-other-"));
  try {
    initGit(root, "feat/tool-hook");
    initGit(otherRoot, "feat/tool-hook");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/tool-hook",
      run_key: RUN_ID,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "per-transition hook regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: "fixture-epoch-0",
      updated_at: new Date().toISOString(),
    });
    const otherBootstrap = JSON.parse(readFileSync(join(root, ".work-state", "runs", RUN_ID, "state.json"), "utf8")) as TeamState;
    const { dispatch_capability: _rootCapability, ...otherState } = otherBootstrap;
    writeCanonicalFixture(otherRoot, otherState);

    const calls: string[] = [];
    const responses: Array<AgentMappingState | undefined | null> = [undefined, undefined, null];
    let hookFailure: Error | null = null;
    const registered: Array<{ name: string; execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ details: { ok: boolean; code?: string; error?: string; handoff?: CapabilityHandoff } }> }> = [];
    const pi = {
      zod: { z: zod },
      registerTool: (tool: { name: string; execute: never }) => registered.push(tool as never),
    };
    const controllerContext = {
      session_id: "repeated-tool-session",
      caller: "host" as const,
      process_id: process.pid,
      worktree: root,
      branch: "feat/tool-hook",
      authority: "coordinator" as const,
    };
    const controller = createWorkflowSessionController({ cwd: root, context: controllerContext });
    const otherController = createWorkflowSessionController({
      cwd: otherRoot,
      context: {
        session_id: "repeated-tool-session-other",
        caller: "host",
        process_id: process.pid,
        worktree: otherRoot,
        branch: "feat/tool-hook",
        authority: "coordinator",
      },
    });
    const otherPrepared = otherController.prepare({ mode: "resume", run_id: RUN_ID });
    assert.equal(otherPrepared.state.run_id, RUN_ID);
    assert.equal(otherController.activeClaimRunId(), RUN_ID);
    const prepared = controller.prepare({ mode: "resume", run_id: RUN_ID });
    assert.equal(prepared.state.run_id, RUN_ID);
    assert.equal(controller.activeClaimRunId(), RUN_ID);
    registerWorkflowTools(pi as unknown as Parameters<typeof registerWorkflowTools>[0], {
      isMainSession: () => true,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      getSessionController: (_ctx: unknown, cwd: string) => cwd === root ? controller : cwd === otherRoot ? otherController : null,
      beforeBegin: (cwd: string) => {
        calls.push(cwd);
        if (hookFailure) throw hookFailure;
        return responses.shift();
      },
    });
    const beginTool = registered.find((tool) => tool.name === "workflow_begin");
    const advanceTool = registered.find((tool) => tool.name === "workflow_advance");
    assert.ok(beginTool && advanceTool, "workflow tools registered");

    // Begin consumes its own per-call hook with the begin cwd.
    const begun = await beginTool.execute("id", {}, undefined, undefined, { cwd: root, session_id: "repeated-tool-session" });
    assert.equal(begun.details.ok, true, begun.details.error ?? "begin ok");
    assert.deepEqual(calls, [root], "begin invoked the hook with its exact cwd");
    const handoff = begun.details.handoff;
    assert.ok(handoff);

    // A later advance re-invokes the hook with the advance's own cwd — never
    // a cached mapping from the earlier transition or another project.
    const advancedOther = await advanceTool.execute("id", {
      token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, loop_iteration: handoff.loop_iteration, evidence: "stage completed",
    }, undefined, undefined, { cwd: otherRoot, session_id: "repeated-tool-session-other" });
    assert.deepEqual(calls, [root, otherRoot], "advance re-invoked the hook with its own cwd");
    assert.equal(advancedOther.details.ok, false, "the other project's bound session lacks the matching capability");

    // Runtime null from the hook fails the advance closed (no fallback).
    const advancedNull = await advanceTool.execute("id", {
      token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, loop_iteration: handoff.loop_iteration, evidence: "stage completed",
    }, undefined, undefined, { cwd: root, session_id: "repeated-tool-session" });
    assert.deepEqual(calls, [root, otherRoot, root], "null case re-invoked the hook");
    assert.equal(advancedNull.details.ok, false);
    assert.match(advancedNull.details.error ?? "", /trusted agent mapping handoff is malformed/);

    hookFailure = new Error("stale discovery markers");
    // A throwing hook (stale marker/freshness failure) fails the advance closed.
    const advancedThrow = await advanceTool.execute("id", {
      token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, loop_iteration: handoff.loop_iteration, evidence: "stage completed",
    }, undefined, undefined, { cwd: root, session_id: "repeated-tool-session" });
    assert.equal(advancedThrow.details.ok, false);
    assert.match(advancedThrow.details.error ?? "", /stale discovery markers/);
    hookFailure = null;
    const state = readCanonicalState(root);
    assert.equal(state.state?.stage_cursor, "implementation", "failed hook calls never advanced the cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("wave-004: a malicious outer-valid trusted handoff fails closed before any roster resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-outer-valid-"));
  try {
    writeArchitectureFixture(root, "feat/outer-valid");
    const base = {
      schema: 1 as const,
      generated_at: new Date().toISOString(),
      preferences_hash: "fixture-preferences",
    };
    // Passes the retired outer structural gate (schema/generated_at/hash/
    // available_agents/resolved_roles all present) but resolves 'architect'
    // to an agent host discovery never returned — a ghost dispatch target.
    const ghostAgent = {
      ...base,
      available_agents: ["architect"],
      resolved_roles: { architect: "omp-ghost" },
      diagnostics: {},
      unresolved_roles: [],
    };
    const ghostBegin = beginCapability(root, ARCHITECT_PAIR_SELECTION, { trustedMapping: ghostAgent as unknown as AgentMappingState });
    assert.equal(ghostBegin.ok, false, "a resolved agent outside available_agents fails the begin closed");
    if (!ghostBegin.ok) {
      assert.match(ghostBegin.error, /trusted agent mapping handoff is malformed/);
      assert.match(ghostBegin.error, /resolved_roles\.architect names agent 'omp-ghost' outside available_agents/);
      assert.doesNotMatch(ghostBegin.error, /regenerate the agent mapping/, "the hostile persisted file is never offered as a fallback");
    }
    // A role that is unresolved and resolved at once breaks the invariant.
    const disjoint = {
      ...base,
      available_agents: ["architect"],
      resolved_roles: { architect: "architect" },
      diagnostics: {},
      unresolved_roles: ["architect"],
    };
    const disjointBegin = beginCapability(root, ARCHITECT_PAIR_SELECTION, { trustedMapping: disjoint as unknown as AgentMappingState });
    assert.equal(disjointBegin.ok, false);
    if (!disjointBegin.ok) assert.match(disjointBegin.error, /unresolved_roles names 'architect' which resolved_roles also resolves/);
    // A resolved role carrying an 'unavailable' diagnostic contradicts itself.
    const conflicted = {
      ...base,
      available_agents: ["architect"],
      resolved_roles: { architect: "architect" },
      diagnostics: { architect: { requested: "architect", candidates: ["architect"], status: "unavailable" } },
      unresolved_roles: [],
    };
    const conflictedBegin = beginCapability(root, ARCHITECT_PAIR_SELECTION, { trustedMapping: conflicted as unknown as AgentMappingState });
    assert.equal(conflictedBegin.ok, false);
    if (!conflictedBegin.ok) assert.match(conflictedBegin.error, /resolved role 'architect' carries an 'unavailable' diagnostic/);
    // Every rejection left the persisted workflow state untouched.
    const untouched = readCanonicalState(root);
    assert.equal(untouched.state?.stage_cursor, "architecture");
    assert.equal(untouched.state?.dispatch_capability, undefined, "the fixture started deferred and rejection must not mint a capability");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave-004: trusted advance fails closed when the next stage's role is missing from the handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-advance-missing-role-"));
  let harness: Harness | undefined;
  try {
    initGit(root, "feat/missing-next-role");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: RUN_ID, branch: "feat/missing-next-role", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/missing-next-role",
      run_key: RUN_ID,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "trusted advance missing next role",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "done" as const : stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    });
    mkdirSync(join(root, ".work-state", "runs", RUN_ID, "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "runs", RUN_ID, "artifacts", "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "missing next role regression", files_touched: ["src/index.ts"] }));

    harness = createCoreFixture({
      root,
      branch: "feat/missing-next-role",
      workflowProfiles: [profile],
      roles: { "${scope.dev_agent}": "developer-kotlin", "developer-kotlin": "developer-kotlin" },
    });
    publishHostileMapping(root, { "${scope.dev_agent}": "developer-kotlin" }, ["developer-kotlin"]);
    await prepareRegistered(harness, profile);
    const handoff = await beginRegistered(harness);
    assert.deepEqual(handoff.expected_roster, [{ role: "developer-kotlin", agent: "developer-kotlin" }]);
    const worker = await admitOrdinaryWorker(harness, handoff, "missing-next-role");
    const submitted = await submitRegistered(harness, worker.childContext, "durable-repeated-role-missing-role-submit", {
      implementation: {
        ready: true,
        validation_run: true,
        validation_evidence: "missing next role regression",
        files_touched: ["src/index.ts"],
      },
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await terminalWorker(harness, worker);
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.approve_implementation;
    assert.ok(rule);
    const checkpoint = await humanCheckpoint(harness, handoff, "approve_implementation", rule.kind);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));

    // The handoff omits the code_review role entirely: the next stage's slot
    // must fail closed instead of falling back to config or the role name.
    const missing = advanceCursor(root, { ...publicAuth(handoff), evidence: "stage completed" }, {
      trustedMapping: freshMapping({ "${scope.dev_agent}": "developer-kotlin" }, ["developer-kotlin"]),
    });
    assert.equal(missing.ok, false, "a next role missing from the handoff fails the advance closed");
    if (!missing.ok) {
      assert.match(missing.error, /next stage 'code_review' dispatch roster unresolved/);
      assert.match(missing.error, /'code-reviewer' is missing or unavailable in the trusted agent mapping handoff/);
    }
    const untouched = readCanonicalState(root);
    assert.equal(untouched.state?.stage_cursor, "implementation", "a failed advance never moves the cursor");
    assert.equal(untouched.state?.cursor_epoch, issued.state.issued_for!.cursor_epoch, "a failed advance never rotates the epoch");
  } finally {
    if (harness) await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const LOOP_NON_ROSTER_PROFILE: Profile = {
  name: "loop-non-roster-regression",
  title: "Loop non-roster regression",
  description: "non-roster loop target for trusted mapping strictness tests",
  match: { type: ["OPS"] },
  stages: [
    { id: "build", title: "Build", type: "single", role: "builder", produces: "build" },
    {
      id: "check", title: "Check", type: "single", role: "checker", consumes: ["build"], produces: "check",
      loop: { back_to: "build", until: "verdict == approve", max_iterations: 2, on_exhausted: "escalate_user" },
    },
  ],
};

test("wave-004: trusted role resolution is strict at begin and loop re-entry; the no-handoff fallback stays valid", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-loop-missing-role-"));
  let harness: Harness | undefined;
  try {
    initGit(root, "feat/loop-missing-role");
    const profile = LOOP_NON_ROSTER_PROFILE;
    registerWorkflowProfiles([profile]);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: RUN_ID, branch: "feat/loop-missing-role", workflow: "loop-non-roster-regression", profile_hash: persistedProfileHash,
      stage_cursor: "build", kind: "single", expected_roster: [{ role: "builder", agent: "builder" }],
    });
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/loop-missing-role",
      run_key: RUN_ID,
      classification: { type: "OPS", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "loop-non-roster-regression" },
      task: "trusted loop target strictness regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "build",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "build" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: NO_SCOPE,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    });
    publishMapping(root);
    const artifactsDir = join(root, ".work-state", "runs", RUN_ID, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "build.json"), JSON.stringify({ ready: true }));
    writeFileSync(join(artifactsDir, "check.json"), JSON.stringify({ verdict: "needs_changes", findings: [] }));

    // Begin with a handoff that omits the stage's role fails closed…
    const strictBegin = beginCapability(root, undefined, { trustedMapping: freshMapping({ checker: "checker" }, ["checker"]) });
    assert.equal(strictBegin.ok, false, "a begin role missing from the handoff fails closed");
    if (!strictBegin.ok) {
      assert.match(strictBegin.error, /workflow stage 'build' dispatch roster unresolved/);
      assert.match(strictBegin.error, /'builder' is missing or unavailable in the trusted agent mapping handoff/);
    }
    // …while the same begin without a handoff keeps the persisted fallback.
    const fallbackBegin = beginCapability(root);
    assert.equal(fallbackBegin.ok, true, fallbackBegin.ok ? "no-handoff fallback begin accepted" : fallbackBegin.error);
    if (!fallbackBegin.ok || !fallbackBegin.handoff) return;
    assert.deepEqual(fallbackBegin.handoff.expected_roster, [{ role: "builder", agent: "builder" }], "the fallback resolves the role by name without a handoff");

    harness = createCoreFixture({
      root,
      branch: "feat/loop-missing-role",
      workflowProfiles: [profile],
      roles: { builder: "builder", checker: "checker" },
    });
    publishHostileMapping(root, { builder: "builder", checker: "checker" }, ["builder", "checker"]);
    await prepareRegistered(harness, profile);
    const buildHandoff = fallbackBegin.handoff as Handoff;
    const buildWorker = await admitOrdinaryWorker(harness, buildHandoff, "loop-build");
    const buildSubmitted = await submitRegistered(harness, buildWorker.childContext, "durable-repeated-role-build-submit", {
      build: { ready: true },
    });
    assert.equal(buildSubmitted.ok, true, JSON.stringify(buildSubmitted));
    await terminalWorker(harness, buildWorker);

    // The advance into check consumes the trusted mapping for the next role.
    const fullMapping = freshMapping({ builder: "builder", checker: "checker" }, ["builder", "checker"]);
    const armed = advanceCursor(root, { ...publicAuth(buildHandoff), evidence: "build completed" }, { trustedMapping: fullMapping });
    assert.equal(armed.ok, true, armed.ok ? "trusted advance into check ok" : armed.error);
    if (!armed.ok || !armed.handoff) return;
    assert.deepEqual(armed.handoff.expected_roster, [{ role: "checker", agent: "checker" }]);
    const checkHandoff = await beginRegistered(harness);
    assert.deepEqual(checkHandoff.expected_roster, [{ role: "checker", agent: "checker" }]);
    const checkWorker = await admitOrdinaryWorker(harness, checkHandoff, "loop-check");
    const checkSubmitted = await submitRegistered(harness, checkWorker.childContext, "durable-repeated-role-check-submit", {
      check: {
        verdict: "needs_changes",
        findings: [],
      },
    });
    assert.equal(checkSubmitted.ok, true, JSON.stringify(checkSubmitted));
    await terminalWorker(harness, checkWorker);

    // Loop re-entry with a handoff missing the loop target's role fails
    // closed — the cursor, epoch and loop history stay untouched.
    const missingLoop = advanceCursor(root, { ...publicAuth(checkHandoff), evidence: "check FAIL" }, {
      trustedMapping: freshMapping({ checker: "checker" }, ["checker"]),
    });
    assert.equal(missingLoop.ok, false, "a loop target role missing from the handoff fails the re-entry closed");
    if (!missingLoop.ok) {
      assert.match(missingLoop.error, /loop target stage 'build' dispatch roster unresolved/);
      assert.match(missingLoop.error, /'builder' is missing or unavailable in the trusted agent mapping handoff/);
    }
    const untouched = readCanonicalState(root);
    assert.equal(untouched.state?.stage_cursor, "check", "a failed re-entry never moves the cursor");
    assert.equal(untouched.state?.cursor_epoch, armed.handoff.cursor_epoch, "a failed re-entry never rotates the epoch");
    assert.equal(untouched.state?.loop_state, undefined, "a failed re-entry never records loop history");

    // The complete handoff re-enters and arms the loop target from it.
    const reentered = advanceCursor(root, { ...publicAuth(checkHandoff), evidence: "check FAIL" }, { trustedMapping: fullMapping });
    assert.equal(reentered.ok, true, reentered.ok ? "trusted loop re-entry ok" : reentered.error);
    if (!reentered.ok || !reentered.handoff) return;
    assert.equal(reentered.state.stage_cursor, "build");
    assert.equal(reentered.state.loop_state?.reentries, 1);
    assert.deepEqual(reentered.handoff.expected_roster, [{ role: "builder", agent: "builder" }], "the re-armed builder slot resolves through the trusted handoff");
  } finally {
    if (harness) await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave-004: deferred roster advance masks the prior stage selection until begin refreezes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-deferred-mask-"));
  let harness: Harness | undefined;
  try {
    initGit(root, "feat/deferred-mask");
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    // A real frozen selection from the exploration stage (the prior stage).
    const explorationStage = profile.stages.find((stage) => stage.id === "exploration");
    assert.ok(explorationStage?.roster_policy);
    const frozenExploration = selectRoster(explorationStage, {
      cwd: root,
      flags: NO_SCOPE,
      resolveDevAgent: () => null,
      profile_hash: persistedProfileHash,
      run_key: RUN_ID,
      workflow: "full-feature",
      capability_epoch: "stale-exploration-epoch",
      resolveAgent: (role) => role,
    });
    assert.equal(frozenExploration.ok, true, frozenExploration.ok ? "exploration selection frozen" : frozenExploration.error);
    if (!frozenExploration.ok) return;
    const issued = createCapability({
      run_key: RUN_ID, branch: "feat/deferred-mask", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", kind: "none", expected_roster: [],
    });
    writeCanonicalFixture(root, {
      schema: 1,
      branch: "feat/deferred-mask",
      run_key: RUN_ID,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
      task: "deferred roster masking regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "clarify",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" || stage.id === "exploration" ? "done" as const : stage.id === "clarify" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: NO_SCOPE,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      roster_selection: frozenExploration.selection,
      roster_selections: { exploration: frozenExploration.selection },
      updated_at: new Date().toISOString(),
    });
    const artifactsDir = join(root, ".work-state", "runs", RUN_ID, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "mask", branch: "feat/deferred-mask", constraints: [] }));
    writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "explored" }));

    harness = createCoreFixture({
      root,
      branch: "feat/deferred-mask",
      workflowProfiles: [profile],
      roles: poolRoles,
    });
    publishMapping(root);
    await prepareRegistered(harness, profile);
    const begun = await beginRegistered(harness);
    const submitted = await submitRegistered(harness, harness.context, "durable-repeated-role-clarify-submit", {
      clarifications: { questions: [], answers: ["proceed"] },
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const clarifyStage = profile.stages.find((stage) => stage.id === "clarify");
    assert.ok(clarifyStage?.checkpoint === "user_answers");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.user_answers;
    assert.ok(rule);
    const checkpoint = await humanCheckpoint(harness, begun, "user_answers", rule.kind);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));

    const advanced = await advanceRegistered(harness, begun, "clarify completed");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    const advancedState = readCanonicalState(root).state;
    assert.ok(advancedState);
    assert.equal(advancedState.stage_cursor, "architecture");
    assert.equal(advancedState.dispatch_capability?.roster_selection, undefined, "the completed capability carries no selection data");
    // The prior stage's selection is masked from the live mirror and the
    // completed capability, while the per-stage history retains it.
    assert.equal(advancedState.roster_selection, undefined, "the exploration selection no longer rides on the state mirror");
    assert.equal(advancedState.roster_selections?.exploration?.stage_id, "exploration", "the audit history retains the exploration selection");

    // workflow_instructions (the stage contract) exposes no stale selection.
    const beforeBegin = resolveWorkflowContract(root);
    assert.ok(beforeBegin.stage.roster_policy, "the allowed pool stays visible for composition");
    assert.equal(beforeBegin.stage.roster_selection, null, "no stale selection leaks into the architecture instructions");
    assert.equal(beforeBegin.stage.dispatch.permitted, false);
    assert.equal(beforeBegin.stage.dispatch.selection_id, null);
    assert.equal(beforeBegin.stage.provenance.control_plane.roster_selection, "none");

    // workflow_begin refreezes a selection; the contract now exposes it.
    const architecture = await beginRegistered(harness, ARCHITECT_PAIR_SELECTION);
    const afterBegin = resolveWorkflowContract(root);
    assert.equal(afterBegin.stage.roster_selection?.stage_id, "architecture", "the fresh selection is exposed for its own stage");
    assert.equal(afterBegin.stage.roster_selection?.capability_epoch, architecture.cursor_epoch, "the fresh selection is bound to the live cursor epoch");
    assert.equal(afterBegin.stage.dispatch.selection_id, afterBegin.stage.roster_selection?.snapshot_id);
    assert.equal(afterBegin.stage.dispatch.permitted, true, "a current selection satisfies the dispatch gate");
  } finally {
    if (harness) await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
