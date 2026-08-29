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
import { createCapability, beginCapability, authorizeDispatch, completeDispatch, advanceCursor, recordCheckpointDecision, type CapabilityHandoff } from "../src/engine/durable.js";
import { checkpointPolicyHash, recordTrustedCheckpointAnswer } from "../src/engine/checkpoints.js";
import { resolveConfig } from "../src/engine/config.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { buildAgentMapping, writeAgentMapping, type AgentMappingState } from "../src/engine/agent-mapping.js";
import { buildDispatchMarker, parseDispatchMarker, dispatchGate } from "../src/gates/dispatch.js";
import { writeState, resolveState } from "../src/engine/state.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TeamState } from "../src/engine/types.js";

import { registerWorkflowTools } from "../src/index.js";
import { z as zod } from "zod";
const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function trustedCheckpoint(root: string, stageId: string, checkpointId: string, decision: string, channel: "terminal" | "escalation" = "terminal") {
  const resolved = resolveState(root);
  assert.ok(resolved.state, "checkpoint fixture state must resolve");
  const trusted = recordTrustedCheckpointAnswer(resolved.state, {
    answer_id: `durable/${stageId}/${checkpointId}`,
    channel,
    reference: `${channel}-answer/durable/${stageId}/${checkpointId}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision,
  });
  writeState(root, trusted.state, { target: resolved });

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
    writeState(root, {
      schema: 1,
      branch: "feat/repeat",
      run_key: "feat/repeat",
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
    }, { featureSlug: "repeat" });

    publishMapping(root);
    const begun = beginCapability(root, THREE_SLOT_SELECTION);
    assert.equal(begun.ok, true, "consilium capability with repeated roles must not be rejected");
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

test("br-eu6: both analyst slots authorize and complete independently; orchestrator-to-consilium advance defers roster-policy arming until workflow_begin", () => {
  const root = mkdtempSync(join(tmpdir(), "br-eu6-advance-"));
  try {
    initGit(root, "feat/repeat");
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/repeat", branch: "feat/repeat", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "discovery", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/repeat",
      run_key: "feat/repeat",
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
      task: "orchestrator to consilium",
      workflow_override: false,
      issue: null,
      stage_cursor: "discovery",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: NO_SCOPE,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "repeat" });
    publishMapping(root);
    const trusted = trustedCheckpoint(root, "discovery", "confirm_understanding", "proceed", "escalation");
    const artifactsDir = join(root, ".work-state", "features", "repeat", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // Schema-valid discovery artifacts (task/branch required; feature_spec
    // requires goal/scope/acceptance_criteria).
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "repeat", branch: "feat/repeat", constraints: [] }));
    writeFileSync(join(artifactsDir, "feature_spec.json"), JSON.stringify({ goal: "goal", scope: [], acceptance_criteria: ["criterion"] }));

    const discoveryStage = profile.stages.find((stage) => stage.id === "discovery");
    assert.ok(discoveryStage?.checkpoint === "confirm_understanding");
    const discoveryPolicy = profile.checkpoint_policy;
    assert.ok(discoveryPolicy);
    const discoveryRule = discoveryPolicy.rules.confirm_understanding;
    assert.ok(discoveryRule);
    const checkpoint = recordCheckpointDecision(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/repeat", branch: "feat/repeat", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "discovery", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "confirm_understanding",
      checkpoint_id: "confirm_understanding",
      checkpoint_kind: discoveryRule.kind,
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(discoveryPolicy),
      decision: "proceed",
      rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "checkpoint decision recorded" : checkpoint.error);

    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/repeat", branch: "feat/repeat", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "discovery", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      evidence: "discovery completed",
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "exploration");
    // Roster-policy stages are never roster-resolved or armed by advance:
    // the cursor parks on a pending stage with no capability and no frozen
    // selection until the explicit workflow_begin freezes the roster.
    assert.equal(advanced.handoff, undefined, "advance into a roster-policy stage issues no dispatch handoff");
    assert.equal(advanced.state.dispatch_capability?.status, "complete", "the completed stage capability cannot authorize further dispatch");
    assert.equal(advanced.state.dispatch_capability?.issued_for.stage_cursor, "discovery");
    assert.equal(advanced.state.stages.find((s) => s.id === "exploration")?.status, "pending", "the roster-policy stage stays semantically unselected");
    assert.equal(advanced.state.roster_selection, undefined, "no default roster is frozen before begin");
    const staleDispatch = authorizeDispatch(root, {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "feat/repeat", branch: "feat/repeat", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "exploration", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "analyst", agent: "analyst",
    });
    assert.equal(staleDispatch.ok, false, "dispatch before workflow_begin fails closed");

    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "default begin accepted" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    assert.equal(begun.handoff.kind, "consilium");
    assert.deepEqual(begun.handoff.expected_roster, [
      { role: "analyst", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
    ], "deterministic default: minimum analyst slot plus one distinct risk-trigger role");

    const auth = {
      token: begun.handoff.dispatch_token,
      capability_id: begun.handoff.capability_id,
      run_key: begun.handoff.run_key,
      branch: begun.handoff.branch,
      workflow: begun.handoff.workflow,
      profile_hash: begun.handoff.profile_hash,
      stage_cursor: begun.handoff.stage_cursor,
      cursor_epoch: begun.handoff.cursor_epoch,
    };
    const a1 = authorizeDispatch(root, { ...auth, role: "analyst", agent: "analyst" });
    const tr = authorizeDispatch(root, { ...auth, role: "tech-researcher", agent: "tech-researcher" });
    assert.equal(a1.ok, true);
    assert.equal(tr.ok, true);
    if (!a1.ok || !tr.ok || !a1.record || !tr.record) return;
    assert.notEqual(a1.record.id, tr.record.id, "each slot gets its own dispatch record");
    assert.notEqual(a1.record.role, tr.record.role);
    assert.equal(a1.record.agent, "analyst");
    assert.equal(tr.record.agent, "tech-researcher");

    const complete = (record: { id: string }, role: string, agent: string, artifactIds: string[] = []) =>
      completeDispatch(root, { ...auth, role, agent, dispatch_id: record.id, outcome: "succeeded", evidence: `${role} completed`, artifact_ids: artifactIds });
    // Multi-slot consilium fan-in: every slot writes slot-scoped artifacts
    // (<produce>-<slot>.json); the shared ids are synthesized deterministically
    // at advance. The analyst slot also contributes the dod.
    writeFileSync(join(artifactsDir, "exploration-analyst.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "analyst one" }));
    writeFileSync(join(artifactsDir, "exploration-tech-researcher.json"), JSON.stringify({ files_to_read: [{ path: "b.ts", why: "y" }], summary: "researcher" }));
    writeFileSync(join(artifactsDir, "dod-analyst.json"), JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] }));
    assert.equal(complete(a1.record, "analyst", "analyst", ["exploration-analyst", "dod-analyst"]).ok, true);
    assert.equal(complete(tr.record, "tech-researcher", "tech-researcher", ["exploration-tech-researcher"]).ok, true);

    const advanced2 = advanceCursor(root, { ...auth, token: begun.handoff.advance_token, evidence: "exploration completed" });
    if (!advanced2.ok) return;
    assert.equal(advanced2.state.stage_cursor, "clarify");
    // Deterministic synthesis wrote the shared artifacts for downstream consumers.
    const sharedExploration = JSON.parse(readFileSync(join(artifactsDir, "exploration.json"), "utf8")) as { files_to_read: unknown[]; summary: string };
    assert.equal(sharedExploration.files_to_read.length, 2, "synthesis concatenates per-slot arrays in roster order");
    assert.equal(sharedExploration.summary, "analyst one", "scalar disagreements resolve deterministically first-slot-wins");
    assert.ok(advanced2.state.slot_artifacts?.["exploration"]?.shared?.["exploration"], "synthesis provenance is recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("br-eu6: single-to-single advance arms a ready capability with the next stage in_progress and immediately executable", () => {
  const root = mkdtempSync(join(tmpdir(), "br-eu6-single-"));
  try {
    initGit(root, "feat/single");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/single", branch: "feat/single", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/single",
      run_key: "feat/single",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "single to single",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "single" });
    const artifactsDir = join(root, ".work-state", "features", "single", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // Schema-valid implementation artifact (files_touched is required by the
    // artifact contract; the validation gate additionally requires the
    // validation block).
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "focused single-to-single regression", files_touched: ["src/index.ts"] }));

    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "feat/single", branch: "feat/single", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "${scope.dev_agent}", agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "implementation completed" }).ok, true);

    // lightweight implementation declares a checkpoint; record it durably
    // before the advance is allowed.
    const implementationStage = profile.stages.find((stage) => stage.id === "implementation");
    assert.ok(implementationStage?.checkpoint === "approve_implementation");
    const implementationPolicy = profile.checkpoint_policy;
    assert.ok(implementationPolicy);
    const implementationRule = implementationPolicy.rules.approve_implementation;
    assert.ok(implementationRule);
    const trusted = trustedCheckpoint(root, "implementation", "approve_implementation", "proceed");
    const checkpoint = recordCheckpointDecision(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/single", branch: "feat/single", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: implementationRule.kind,
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(implementationPolicy),
      decision: "proceed",
      rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "checkpoint decision recorded" : checkpoint.error);

    const advanced = advanceCursor(root, { ...auth, token: issued.advance_token, evidence: "implementation completed" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.equal(advanced.state.dispatch_capability?.status, "ready");
    assert.equal(advanced.state.dispatch_capability?.kind, "single");
    assert.deepEqual(advanced.state.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }]);
    assert.equal(advanced.state.stages.find((s) => s.id === "code_review")?.status, "in_progress", "single-to-single lands on an executable in_progress stage");

    const codeReview = profile.stages.find((stage) => stage.id === "code_review");
    assert.ok(codeReview);
    const marker = buildDispatchMarker("feat/single", codeReview, ["code-reviewer"], "code-reviewer", advanced.state.cursor_epoch);
    const gate = dispatchGate({ toolName: "task", input: { agent: "code-reviewer", role: "code-reviewer", task: marker } }, { cwd: root });
    assert.equal(gate, undefined, "armed next stage is immediately executable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("br-eu6: reopening a stage clears stale downstream slot bindings and starts with a fresh empty capability", () => {
  const root = mkdtempSync(join(tmpdir(), "br-eu6-reopen-"));
  const branch = "feat/reopen";
  try {
    initGit(root, branch);
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: branch,
      branch,
      workflow: "full-feature",
      profile_hash: persistedProfileHash,
      stage_cursor: "exploration",
      kind: "consilium",
      expected_roster: [
        { role: "analyst#1", agent: "analyst" },
        { role: "tech-researcher", agent: "tech-researcher" },
        { role: "analyst#2", agent: "analyst" },
      ],
    });
    const initialState: TeamState = {
      schema: 1,
      branch,
      run_key: branch,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
      task: "reopen stale bindings",
      workflow_override: false,
      issue: null,
      stage_cursor: "exploration",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "done" as const : stage.id === "exploration" ? "in_progress" as const : "pending" as const })),
      artifacts: { discovery: "artifacts/discovery.json", feature_spec: "artifacts/feature_spec.json" },
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: NO_SCOPE,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    };
    writeState(root, initialState, { featureSlug: "reopen" });
    publishMapping(root);
    const artifactsDir = join(root, ".work-state", "features", "reopen", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "reopen stale bindings", branch }));
    const upstreamPath = join(artifactsDir, "discovery-upstream.json");
    writeFileSync(upstreamPath, "upstream");
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const outsidePath = join(outsideDir, "must-survive.json");
    writeFileSync(outsidePath, "outside");

    const oldArtifacts = [
      { role: "analyst#1", agent: "analyst", id: "exploration-analyst-1" },
      { role: "tech-researcher", agent: "tech-researcher", id: "exploration-tech-researcher" },
      { role: "analyst#2", agent: "analyst", id: "exploration-analyst-2" },
    ];
    for (const item of oldArtifacts) {
      writeFileSync(join(artifactsDir, item.id + ".json"), JSON.stringify({ files_to_read: [{ path: "old.ts" }], summary: "old" }));
    }
    const oldAuth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: branch,
      branch,
      workflow: "full-feature",
      profile_hash: persistedProfileHash,
      stage_cursor: "exploration",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
    };
    const oldRecords: Array<{ role: string; agent: string; id: string }> = [];
    for (const item of oldArtifacts) {
      const authorized = authorizeDispatch(root, { ...oldAuth, role: item.role, agent: item.agent });
      assert.equal(authorized.ok, true);
      if (!authorized.ok || !authorized.record) return;
      const completed = completeDispatch(root, {
        ...oldAuth,
        role: item.role,
        agent: item.agent,
        dispatch_id: authorized.record.id,
        outcome: "succeeded",
        evidence: "old completion",
        artifact_ids: [item.id],
      });
      assert.equal(completed.ok, true);
      oldRecords.push({ role: item.role, agent: item.agent, id: authorized.record.id });
    }

    const staleState = JSON.parse(readFileSync(join(root, ".work-state", "features", "reopen", "state.json"), "utf8")) as TeamState;
    staleState.stages = profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "done" as const : "pending" as const }));
    staleState.dispatch_capability = { ...staleState.dispatch_capability!, status: "complete" };
    staleState.slot_artifacts = {
      ...staleState.slot_artifacts,
      discovery: { slots: { prior: { discovery: { path: upstreamPath, hash: "upstream" } } } },
      architecture: { slots: { "architect#2": { architecture: { path: join(artifactsDir, "architecture-architect-2.json"), hash: "downstream" } } } },
    };
    const oldExplorationSlots = staleState.slot_artifacts.exploration?.slots["analyst#1"];
    if (!oldExplorationSlots) return;
    oldExplorationSlots.outside = { path: outsidePath, hash: "outside" };
    const downstreamPath = join(artifactsDir, "architecture-architect-2.json");
    writeFileSync(downstreamPath, "downstream");
    writeState(root, staleState, { featureSlug: "reopen" });

    const begun = beginCapability(root, THREE_SLOT_SELECTION);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    assert.deepEqual(begun.state.artifacts, initialState.artifacts, "upstream state.artifacts survives the reopen");
    assert.deepEqual(begun.state.dispatch_capability?.dispatches, [], "reopened capability never reuses old dispatch records");
    assert.equal(begun.state.slot_artifacts?.exploration, undefined, "reopened slot bindings are cleared");
    assert.equal(begun.state.slot_artifacts?.architecture, undefined, "downstream slot bindings are cleared");
    assert.ok(begun.state.slot_artifacts?.discovery, "upstream slot bindings remain available");
    assert.equal(existsSync(upstreamPath), true, "upstream slot artifact file remains");
    assert.equal(existsSync(outsidePath), true, "out-of-tree stale path is never removed");
    for (const item of oldArtifacts) assert.equal(existsSync(join(artifactsDir, item.id + ".json")), false, "stale slot file is removed: " + item.id);
    assert.equal(existsSync(downstreamPath), false, "downstream stale slot file is removed");

    const replay = completeDispatch(root, {
      ...oldAuth,
      dispatch_id: oldRecords[0]!.id,
      role: oldRecords[0]!.role,
      agent: oldRecords[0]!.agent,
      outcome: "succeeded",
      evidence: "stale replay",
      artifact_ids: [],
    });
    assert.equal(replay.ok, false, "the old capability cannot authorize a fresh completion");

    const fresh = begun.handoff;
    const freshAuth = {
      token: fresh.dispatch_token,
      capability_id: fresh.capability_id,
      run_key: fresh.run_key,
      branch: fresh.branch,
      workflow: fresh.workflow,
      profile_hash: fresh.profile_hash,
      stage_cursor: fresh.stage_cursor,
      cursor_epoch: fresh.cursor_epoch,
    };
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "reopen stale bindings", branch }));
    const first = oldArtifacts[0]!;
    const firstAuth = authorizeDispatch(root, { ...freshAuth, role: first.role, agent: first.agent });
    assert.equal(firstAuth.ok, true);
    if (!firstAuth.ok || !firstAuth.record) return;
    const missingOldFile = completeDispatch(root, {
      ...freshAuth,
      role: first.role,
      agent: first.agent,
      dispatch_id: firstAuth.record.id,
      outcome: "succeeded",
      evidence: "stale file replay",
      artifact_ids: [first.id],
    });
    assert.equal(missingOldFile.ok, false, "a removed old file cannot authorize fresh completion");
    if (missingOldFile.ok) return;
    assert.match(missingOldFile.error, /declared artifact missing/);

    for (const item of oldArtifacts) {
      writeFileSync(join(artifactsDir, item.id + ".json"), JSON.stringify({ files_to_read: [{ path: "fresh.ts" }], summary: "fresh " + item.role }));
      const dodId = item.id.replace("exploration-", "dod-");
      writeFileSync(join(artifactsDir, dodId + ".json"), JSON.stringify({ items: [{ criterion: "fresh", verify_method: "focused regression", status: "pending" }] }));
    }
    const freshRecords = [{ role: first.role, agent: first.agent, id: firstAuth.record.id }, ...oldArtifacts.slice(1).map((item) => {
      const authorized = authorizeDispatch(root, { ...freshAuth, role: item.role, agent: item.agent });
      assert.equal(authorized.ok, true);
      if (!authorized.ok || !authorized.record) throw new Error("fresh dispatch authorization failed");
      return { role: item.role, agent: item.agent, id: authorized.record.id };
    })];
    for (const item of freshRecords) {
      const explorationId = "exploration-" + item.role.replace(/[^A-Za-z0-9._-]/g, "-");
      const dodId = "dod-" + item.role.replace(/[^A-Za-z0-9._-]/g, "-");
      const completed = completeDispatch(root, {
        ...freshAuth,
        role: item.role,
        agent: item.agent,
        dispatch_id: item.id,
        outcome: "succeeded",
        evidence: "fresh completion",
        artifact_ids: [explorationId, dodId],
      });
      assert.equal(completed.ok, true);
    }
    const advanced = advanceCursor(root, { ...freshAuth, token: fresh.advance_token, evidence: "fresh exploration completed" });
    assert.equal(advanced.ok, true, "fresh downstream artifacts complete after stale bindings are cleared");
    if (advanced.ok) assert.equal(advanced.state.stage_cursor, "clarify");
  } finally {
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

test("wave-004: advance into architecture stays semantically unselected; workflow_begin selects multiple architects", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-arch-"));
  try {
    initGit(root, "feat/arch");
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/arch", branch: "feat/arch", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/arch",
      run_key: "feat/arch",
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
    }, { featureSlug: "arch" });
    publishMapping(root);
    const artifactsDir = join(root, ".work-state", "features", "arch", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "arch", branch: "feat/arch", constraints: [] }));
    writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "explored" }));
    writeFileSync(join(artifactsDir, "clarifications.json"), JSON.stringify({ questions: [], answers: ["proceed"] }));

    const clarifyStage = profile.stages.find((stage) => stage.id === "clarify");
    assert.ok(clarifyStage?.checkpoint === "user_answers");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.user_answers;
    assert.ok(rule);
    const trusted = trustedCheckpoint(root, "clarify", "user_answers", "proceed");
    const checkpoint = recordCheckpointDecision(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/arch", branch: "feat/arch", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "user_answers",
      checkpoint_id: "user_answers",
      checkpoint_kind: rule.kind,
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(policy),
      decision: "proceed",
      rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "checkpoint decision recorded" : checkpoint.error);

    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/arch", branch: "feat/arch", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      evidence: "clarify completed",
    });
    assert.equal(advanced.ok, true, advanced.ok ? "clarify-to-architecture advance ok" : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "architecture");
    assert.equal(advanced.handoff, undefined, "no handoff and no default roster before the explicit begin");
    assert.equal(advanced.state.dispatch_capability?.status, "complete", "only the completed stage capability remains");
    assert.equal(advanced.state.stages.find((s) => s.id === "architecture")?.status, "pending", "architecture is not armed by advance");
    assert.equal(advanced.state.roster_selection, undefined, "no default architect roster is frozen before begin");

    const begun = beginCapability(root, ARCHITECT_PAIR_SELECTION);
    assert.equal(begun.ok, true, begun.ok ? "multi-architect begin accepted" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    assert.equal(begun.handoff.kind, "consilium");
    assert.deepEqual(begun.handoff.expected_roster, [
      { role: "architect#1", agent: "architect" },
      { role: "architect#2", agent: "architect" },
    ], "both architect occurrences resolve to numbered executable slots");
    assert.equal(begun.state.roster_selection?.selected.length, 2, "the semantic selection is frozen with both occurrences");
    const auth = {
      token: begun.handoff.dispatch_token,
      capability_id: begun.handoff.capability_id,
      run_key: begun.handoff.run_key,
      branch: begun.handoff.branch,
      workflow: begun.handoff.workflow,
      profile_hash: begun.handoff.profile_hash,
      stage_cursor: begun.handoff.stage_cursor,
      cursor_epoch: begun.handoff.cursor_epoch,
    };
    const slot1 = authorizeDispatch(root, { ...auth, role: "architect#1", agent: "architect" });
    const slot2 = authorizeDispatch(root, { ...auth, role: "architect#2", agent: "architect" });
    assert.equal(slot1.ok, true, slot1.ok ? "architect#1 executable" : slot1.error);
    assert.equal(slot2.ok, true, slot2.ok ? "architect#2 executable" : slot2.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fixture state parked on the architecture stage with upstream stages done. */
function writeArchitectureFixture(root: string, branch: string, slug: string): void {
  initGit(root, branch);
  const profile = loadProfile("full-feature");
  assert.ok(profile);
  const persistedProfileHash = profileHash(profile);
  const issued = createCapability({
    run_key: branch, branch, workflow: "full-feature", profile_hash: persistedProfileHash,
    stage_cursor: "clarify", kind: "none", expected_roster: [],
  });
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
    task: "trusted mapping provenance regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "architecture",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" || stage.id === "exploration" || stage.id === "clarify" ? "done" as const : stage.id === "architecture" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedProfileHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: slug });
}

test("wave-004: trusted mapping handoff wins over a tampered persisted mapping; malformed handoff fails closed; fallback stays compatible", () => {
  const control = mkdtempSync(join(tmpdir(), "wave004-hostile-control-"));
  const trusted = mkdtempSync(join(tmpdir(), "wave004-hostile-trusted-"));
  try {
    writeArchitectureFixture(control, "feat/hostile-control", "hostile-control");
    writeArchitectureFixture(trusted, "feat/hostile-trusted", "hostile-trusted");
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

test("wave-004: non-roster advance arming consumes the trusted mapping override", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-advance-mapping-"));
  try {
    initGit(root, "feat/trusted-advance");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/trusted-advance", branch: "feat/trusted-advance", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/trusted-advance",
      run_key: "feat/trusted-advance",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "trusted advance override",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "trusted-advance" });
    publishHostileMapping(root, { "${scope.dev_agent}": "developer-kotlin", "code-reviewer": "omp-attacker" }, ["developer-kotlin", "omp-attacker"]);
    const artifactsDir = join(root, ".work-state", "features", "trusted-advance", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "trusted advance override regression", files_touched: ["src/index.ts"] }));

    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "feat/trusted-advance", branch: "feat/trusted-advance", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "${scope.dev_agent}", agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "implementation completed" }).ok, true);
    const implementationStage = profile.stages.find((stage) => stage.id === "implementation");
    assert.ok(implementationStage?.checkpoint === "approve_implementation");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.approve_implementation;
    assert.ok(rule);
    const trusted = trustedCheckpoint(root, "implementation", "approve_implementation", "proceed");
    const checkpoint = recordCheckpointDecision(root, {
      ...auth,
      token: issued.advance_token,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: rule.kind,
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(policy),
      decision: "proceed",
      rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "checkpoint recorded" : checkpoint.error);

    const malformedAdvance = advanceCursor(root, { ...auth, token: issued.advance_token, evidence: "stage completed" }, { trustedMapping: { schema: 99 } as unknown as AgentMappingState });
    assert.equal(malformedAdvance.ok, false, "a malformed trusted handoff fails the advance closed");
    if (!malformedAdvance.ok) assert.match(malformedAdvance.error, /trusted agent mapping handoff is malformed/);
    const nullAdvance = advanceCursor(root, { ...auth, token: issued.advance_token, evidence: "stage completed" }, { trustedMapping: null as unknown as AgentMappingState });
    assert.equal(nullAdvance.ok, false, "a runtime-null advance handoff fails closed instead of selecting the persisted mapping");
    if (!nullAdvance.ok) assert.match(nullAdvance.error, /trusted agent mapping handoff is malformed/);
    const advanced = advanceCursor(root, { ...auth, token: issued.advance_token, evidence: "stage completed" }, { trustedMapping: freshMapping({ "${scope.dev_agent}": "developer-kotlin", "code-reviewer": "code-reviewer" }, ["developer-kotlin", "code-reviewer"]) });
    assert.equal(advanced.ok, true, advanced.ok ? "trusted advance ok" : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.deepEqual(advanced.state.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }], "the trusted mapping names the code-reviewer slot, never the tampered file's agent");
  } finally {
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

test("wave-004: loop re-entry into a roster-policy target defers the roster; explicit begin reselects", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-loop-roster-"));
  try {
    initGit(root, "feat/loop-roster");
    registerWorkflowProfiles([LOOP_ROSTER_PROFILE]);
    const profile = loadProfile("loop-roster-regression");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    writeState(root, {
      schema: 1,
      branch: "feat/loop-roster",
      run_key: "feat/loop-roster",
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
    }, { featureSlug: "loop-roster" });
    publishMapping(root);
    const artifactsDir = join(root, ".work-state", "features", "loop-roster", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "design.json"), JSON.stringify({ chosen: "option-1" }));

    const begun = beginCapability(root, { occurrences: [{ role: "architect", reason: "option one" }] });
    assert.equal(begun.ok, true, begun.ok ? "first-iteration begin accepted" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    const designAuth = {
      token: begun.handoff.dispatch_token,
      capability_id: begun.handoff.capability_id,
      run_key: begun.handoff.run_key,
      branch: begun.handoff.branch,
      workflow: begun.handoff.workflow,
      profile_hash: begun.handoff.profile_hash,
      stage_cursor: begun.handoff.stage_cursor,
      cursor_epoch: begun.handoff.cursor_epoch,
    };
    const designDispatch = authorizeDispatch(root, { ...designAuth, role: "architect", agent: "architect" });
    assert.equal(designDispatch.ok, true);
    if (!designDispatch.ok || !designDispatch.record) return;
    assert.equal(completeDispatch(root, { ...designAuth, role: "architect", agent: "architect", dispatch_id: designDispatch.record.id, outcome: "succeeded", evidence: "design done", artifact_ids: ["design"] }).ok, true);

    const armed = advanceCursor(root, { ...designAuth, token: begun.handoff.advance_token, evidence: "design completed" });
    assert.equal(armed.ok, true, armed.ok ? "design-to-review advance ok" : armed.error);
    if (!armed.ok || !armed.handoff) return;
    const reviewAuth = {
      token: armed.handoff.dispatch_token,
      capability_id: armed.handoff.capability_id,
      run_key: armed.handoff.run_key,
      branch: armed.handoff.branch,
      workflow: armed.handoff.workflow,
      profile_hash: armed.handoff.profile_hash,
      stage_cursor: armed.handoff.stage_cursor,
      cursor_epoch: armed.handoff.cursor_epoch,
    };
    writeFileSync(join(artifactsDir, "review.json"), JSON.stringify({
      verdict: "needs_changes",
      findings: [{ title: "flagged edge case", severity: "MEDIUM", confidence: 90, zone: "backend-kotlin" }],
      iterations: 1,
    }));
    const reviewDispatch = authorizeDispatch(root, { ...reviewAuth, role: "reviewer", agent: "reviewer" });
    assert.equal(reviewDispatch.ok, true);
    if (!reviewDispatch.ok || !reviewDispatch.record) return;
    assert.equal(completeDispatch(root, { ...reviewAuth, role: "reviewer", agent: "reviewer", dispatch_id: reviewDispatch.record.id, outcome: "succeeded", evidence: "review FAIL", artifact_ids: ["review"] }).ok, true);

    const reentered = advanceCursor(root, { ...reviewAuth, token: armed.handoff.advance_token, evidence: "review FAIL" });
    assert.equal(reentered.ok, true, reentered.ok ? "loop re-entry ok" : reentered.error);
    if (!reentered.ok) return;
    assert.equal(reentered.state.stage_cursor, "design", "cursor re-enters the roster-policy target");
    assert.equal(reentered.handoff, undefined, "roster-policy loop re-entry issues no handoff");
    assert.equal(reentered.state.dispatch_capability?.status, "complete", "only the completed review capability remains");
    assert.equal(reentered.state.stages.find((s) => s.id === "design")?.status, "pending", "the loop target stays pending");
    assert.equal(reentered.state.loop_state?.status, "running");
    assert.equal(reentered.state.loop_state?.reentries, 1, "iteration history is recorded");
    assert.notEqual(reentered.state.roster_selections?.["design"]?.capability_epoch, reentered.state.cursor_epoch, "no roster is frozen for the fresh loop epoch");

    const rebegun = beginCapability(root, { occurrences: [{ role: "architect", facet: "second-pass" }] });
    assert.equal(rebegun.ok, true, rebegun.ok ? "explicit begin reselects the loop target" : rebegun.error);
    if (!rebegun.ok || !rebegun.handoff) return;
    assert.equal(rebegun.state.cursor_epoch, reentered.state.cursor_epoch, "begin binds to the fresh loop epoch");
    assert.deepEqual(rebegun.handoff.expected_roster, [{ role: "architect", agent: "architect" }]);
    const slot = authorizeDispatch(root, {
      token: rebegun.handoff.dispatch_token,
      capability_id: rebegun.handoff.capability_id,
      run_key: rebegun.handoff.run_key,
      branch: rebegun.handoff.branch,
      workflow: rebegun.handoff.workflow,
      profile_hash: rebegun.handoff.profile_hash,
      stage_cursor: rebegun.handoff.stage_cursor,
      cursor_epoch: rebegun.handoff.cursor_epoch,
      role: "architect", agent: "architect",
    });
    assert.equal(slot.ok, true, slot.ok ? "reselected loop iteration is executable" : slot.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave-004: workflow tools invoke beforeBegin per transition with the exact current cwd; hook rejection fails advance closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-tool-hook-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "wave004-tool-hook-other-"));
  try {
    initGit(root, "feat/tool-hook");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeState(root, {
      schema: 1,
      branch: "feat/tool-hook",
      run_key: "feat/tool-hook",
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
    }, { featureSlug: "tool-hook" });

    const calls: string[] = [];
    const responses: Array<AgentMappingState | undefined | null> = [undefined, undefined, null];
    let hookFailure: Error | null = null;
    const registered: Array<{ name: string; execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ details: { ok: boolean; code?: string; error?: string; handoff?: CapabilityHandoff } }> }> = [];
    const pi = {
      zod: { z: zod },
      registerTool: (tool: { name: string; execute: never }) => registered.push(tool as never),
    };
    registerWorkflowTools(pi as unknown as Parameters<typeof registerWorkflowTools>[0], {
      isMainSession: () => true,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
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
    const begun = await beginTool.execute("id", {}, undefined, undefined, { cwd: root });
    assert.equal(begun.details.ok, true, begun.details.error ?? "begin ok");
    assert.deepEqual(calls, [root], "begin invoked the hook with its exact cwd");
    const handoff = begun.details.handoff;
    assert.ok(handoff);

    // A later advance re-invokes the hook with the advance's own cwd — never
    // a cached mapping from the earlier transition or another project.
    const advancedOther = await advanceTool.execute("id", {
      token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, evidence: "stage completed",
    }, undefined, undefined, { cwd: otherRoot });
    assert.deepEqual(calls, [root, otherRoot], "advance re-invoked the hook with its own cwd");
    assert.equal(advancedOther.details.ok, false, "the other project has no workflow state");

    // Runtime null from the hook fails the advance closed (no fallback).
    const advancedNull = await advanceTool.execute("id", {
      token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, evidence: "stage completed",
    }, undefined, undefined, { cwd: root });
    assert.deepEqual(calls, [root, otherRoot, root], "null case re-invoked the hook");
    assert.equal(advancedNull.details.ok, false);
    assert.match(advancedNull.details.error ?? "", /trusted agent mapping handoff is malformed/);

    hookFailure = new Error("stale discovery markers");
    // A throwing hook (stale marker/freshness failure) fails the advance closed.
    const advancedThrow = await advanceTool.execute("id", {
      token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, evidence: "stage completed",
    }, undefined, undefined, { cwd: root });
    assert.equal(advancedThrow.details.ok, false);
    assert.match(advancedThrow.details.error ?? "", /stale discovery markers/);
    hookFailure = null;
    const state = resolveState(root);
    assert.equal(state.state?.stage_cursor, "implementation", "failed hook calls never advanced the cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("wave-004: a malicious outer-valid trusted handoff fails closed before any roster resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-outer-valid-"));
  try {
    writeArchitectureFixture(root, "feat/outer-valid", "outer-valid");
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
    const untouched = resolveState(root);
    assert.equal(untouched.state?.stage_cursor, "architecture");
    assert.equal(untouched.state?.dispatch_capability?.status, "ready");
    assert.equal(untouched.state?.dispatch_capability?.expected_roster.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave-004: trusted advance fails closed when the next stage's role is missing from the handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-advance-missing-role-"));
  try {
    initGit(root, "feat/missing-next-role");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/missing-next-role", branch: "feat/missing-next-role", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/missing-next-role",
      run_key: "feat/missing-next-role",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "trusted advance missing next role",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "missing-next-role" });
    publishHostileMapping(root, { "${scope.dev_agent}": "developer-kotlin", "code-reviewer": "omp-attacker" }, ["developer-kotlin", "omp-attacker"]);
    const artifactsDir = join(root, ".work-state", "features", "missing-next-role", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "missing next role regression", files_touched: ["src/index.ts"] }));

    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "feat/missing-next-role", branch: "feat/missing-next-role", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "${scope.dev_agent}", agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "implementation completed" }).ok, true);
    const implementationStage = profile.stages.find((stage) => stage.id === "implementation");
    assert.ok(implementationStage?.checkpoint === "approve_implementation");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.approve_implementation;
    assert.ok(rule);
    const trusted = trustedCheckpoint(root, "implementation", "approve_implementation", "proceed");
    const checkpoint = recordCheckpointDecision(root, {
      ...auth,
      token: issued.advance_token,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: rule.kind,
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(policy),
      decision: "proceed",
      rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "checkpoint recorded" : checkpoint.error);

    // The handoff omits the code_review role entirely: the next stage's slot
    // must fail closed instead of falling back to config or the role name.
    const missing = advanceCursor(root, { ...auth, token: issued.advance_token, evidence: "stage completed" }, {
      trustedMapping: freshMapping({ "${scope.dev_agent}": "developer-kotlin" }, ["developer-kotlin"]),
    });
    assert.equal(missing.ok, false, "a next role missing from the handoff fails the advance closed");
    if (!missing.ok) {
      assert.match(missing.error, /next stage 'code_review' dispatch roster unresolved/);
      assert.match(missing.error, /'code-reviewer' is missing or unavailable in the trusted agent mapping handoff/);
    }
    const untouched = resolveState(root);
    assert.equal(untouched.state?.stage_cursor, "implementation", "a failed advance never moves the cursor");
    assert.equal(untouched.state?.cursor_epoch, issued.state.issued_for!.cursor_epoch, "a failed advance never rotates the epoch");
  } finally {
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

test("wave-004: trusted role resolution is strict at begin and loop re-entry; the no-handoff fallback stays valid", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-loop-missing-role-"));
  try {
    initGit(root, "feat/loop-missing-role");
    registerWorkflowProfiles([LOOP_NON_ROSTER_PROFILE]);
    const profile = loadProfile("loop-non-roster-regression");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/loop-missing-role", branch: "feat/loop-missing-role", workflow: "loop-non-roster-regression", profile_hash: persistedProfileHash,
      stage_cursor: "build", kind: "single", expected_roster: [{ role: "builder", agent: "builder" }],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/loop-missing-role",
      run_key: "feat/loop-missing-role",
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
    }, { featureSlug: "loop-missing-role" });
    publishMapping(root);
    const artifactsDir = join(root, ".work-state", "features", "loop-missing-role", "artifacts");
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
    const buildAuth = {
      token: fallbackBegin.handoff.dispatch_token,
      capability_id: fallbackBegin.handoff.capability_id,
      run_key: fallbackBegin.handoff.run_key,
      branch: fallbackBegin.handoff.branch,
      workflow: fallbackBegin.handoff.workflow,
      profile_hash: fallbackBegin.handoff.profile_hash,
      stage_cursor: fallbackBegin.handoff.stage_cursor,
      cursor_epoch: fallbackBegin.handoff.cursor_epoch,
    };
    const buildDispatch = authorizeDispatch(root, { ...buildAuth, role: "builder", agent: "builder" });
    assert.equal(buildDispatch.ok, true);
    if (!buildDispatch.ok || !buildDispatch.record) return;
    assert.equal(completeDispatch(root, { ...buildAuth, role: "builder", agent: "builder", dispatch_id: buildDispatch.record.id, outcome: "succeeded", evidence: "build done", artifact_ids: ["build"] }).ok, true);

    // The advance into check consumes the trusted mapping for the next role.
    const fullMapping = freshMapping({ builder: "builder", checker: "checker" }, ["builder", "checker"]);
    const armed = advanceCursor(root, { ...buildAuth, token: fallbackBegin.handoff.advance_token, evidence: "build completed" }, { trustedMapping: fullMapping });
    assert.equal(armed.ok, true, armed.ok ? "trusted advance into check ok" : armed.error);
    if (!armed.ok || !armed.handoff) return;
    assert.deepEqual(armed.handoff.expected_roster, [{ role: "checker", agent: "checker" }]);
    const checkAuth = {
      token: armed.handoff.dispatch_token,
      capability_id: armed.handoff.capability_id,
      run_key: armed.handoff.run_key,
      branch: armed.handoff.branch,
      workflow: armed.handoff.workflow,
      profile_hash: armed.handoff.profile_hash,
      stage_cursor: armed.handoff.stage_cursor,
      cursor_epoch: armed.handoff.cursor_epoch,
    };
    const checkDispatch = authorizeDispatch(root, { ...checkAuth, role: "checker", agent: "checker" });
    assert.equal(checkDispatch.ok, true);
    if (!checkDispatch.ok || !checkDispatch.record) return;
    assert.equal(completeDispatch(root, { ...checkAuth, role: "checker", agent: "checker", dispatch_id: checkDispatch.record.id, outcome: "succeeded", evidence: "check FAIL", artifact_ids: ["check"] }).ok, true);

    // Loop re-entry with a handoff missing the loop target's role fails
    // closed — the cursor, epoch and loop history stay untouched.
    const missingLoop = advanceCursor(root, { ...checkAuth, token: armed.handoff.advance_token, evidence: "check FAIL" }, {
      trustedMapping: freshMapping({ checker: "checker" }, ["checker"]),
    });
    assert.equal(missingLoop.ok, false, "a loop target role missing from the handoff fails the re-entry closed");
    if (!missingLoop.ok) {
      assert.match(missingLoop.error, /loop target stage 'build' dispatch roster unresolved/);
      assert.match(missingLoop.error, /'builder' is missing or unavailable in the trusted agent mapping handoff/);
    }
    const untouched = resolveState(root);
    assert.equal(untouched.state?.stage_cursor, "check", "a failed re-entry never moves the cursor");
    assert.equal(untouched.state?.cursor_epoch, armed.handoff.cursor_epoch, "a failed re-entry never rotates the epoch");
    assert.equal(untouched.state?.loop_state, undefined, "a failed re-entry never records loop history");

    // The complete handoff re-enters and arms the loop target from it.
    const reentered = advanceCursor(root, { ...checkAuth, token: armed.handoff.advance_token, evidence: "check FAIL" }, { trustedMapping: fullMapping });
    assert.equal(reentered.ok, true, reentered.ok ? "trusted loop re-entry ok" : reentered.error);
    if (!reentered.ok || !reentered.handoff) return;
    assert.equal(reentered.state.stage_cursor, "build");
    assert.equal(reentered.state.loop_state?.reentries, 1);
    assert.deepEqual(reentered.handoff.expected_roster, [{ role: "builder", agent: "builder" }], "the re-armed builder slot resolves through the trusted handoff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wave-004: deferred roster advance masks the prior stage selection until begin refreezes it", () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-deferred-mask-"));
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
      run_key: "feat/deferred-mask",
      workflow: "full-feature",
      capability_epoch: "stale-exploration-epoch",
      resolveAgent: (role) => role,
    });
    assert.equal(frozenExploration.ok, true, frozenExploration.ok ? "exploration selection frozen" : frozenExploration.error);
    if (!frozenExploration.ok) return;
    const issued = createCapability({
      run_key: "feat/deferred-mask", branch: "feat/deferred-mask", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1,
      branch: "feat/deferred-mask",
      run_key: "feat/deferred-mask",
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
    }, { featureSlug: "deferred-mask" });
    publishMapping(root);
    const artifactsDir = join(root, ".work-state", "features", "deferred-mask", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "mask", branch: "feat/deferred-mask", constraints: [] }));
    writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "explored" }));
    writeFileSync(join(artifactsDir, "clarifications.json"), JSON.stringify({ questions: [], answers: ["proceed"] }));

    const clarifyStage = profile.stages.find((stage) => stage.id === "clarify");
    assert.ok(clarifyStage?.checkpoint === "user_answers");
    const policy = profile.checkpoint_policy;
    assert.ok(policy);
    const rule = policy.rules.user_answers;
    assert.ok(rule);
    const trusted = trustedCheckpoint(root, "clarify", "user_answers", "proceed");
    const checkpoint = recordCheckpointDecision(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/deferred-mask", branch: "feat/deferred-mask", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "user_answers",
      checkpoint_id: "user_answers",
      checkpoint_kind: rule.kind,
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(policy),
      decision: "proceed",
      rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "checkpoint decision recorded" : checkpoint.error);

    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/deferred-mask", branch: "feat/deferred-mask", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "clarify", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      evidence: "clarify completed",
    });
    assert.equal(advanced.ok, true, advanced.ok ? "clarify-to-architecture advance ok" : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "architecture");
    assert.equal(advanced.handoff, undefined, "the roster-policy stage is deferred with no handoff");
    // The prior stage's selection is masked from the live mirror and the
    // completed capability, while the per-stage history retains it.
    assert.equal(advanced.state.roster_selection, undefined, "the exploration selection no longer rides on the state mirror");
    assert.equal(advanced.state.dispatch_capability?.roster_selection, undefined, "the completed capability carries no selection data");
    assert.equal(advanced.state.roster_selections?.exploration?.stage_id, "exploration", "the audit history retains the exploration selection");

    // workflow_instructions (the stage contract) exposes no stale selection.
    const beforeBegin = resolveWorkflowContract(root);
    assert.ok(beforeBegin.stage.roster_policy, "the allowed pool stays visible for composition");
    assert.equal(beforeBegin.stage.roster_selection, null, "no stale selection leaks into the architecture instructions");
    assert.equal(beforeBegin.stage.dispatch.permitted, false);
    assert.equal(beforeBegin.stage.dispatch.selection_id, null);
    assert.equal(beforeBegin.stage.provenance.control_plane.roster_selection, "none");

    // workflow_begin refreezes a selection; the contract now exposes it.
    const begun = beginCapability(root, ARCHITECT_PAIR_SELECTION, { trustedMapping: freshMapping({ ...poolRoles }, Object.values(poolRoles)) });
    assert.equal(begun.ok, true, begun.ok ? "begin refreezes the architecture roster" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    const afterBegin = resolveWorkflowContract(root);
    assert.equal(afterBegin.stage.roster_selection?.stage_id, "architecture", "the fresh selection is exposed for its own stage");
    assert.equal(afterBegin.stage.roster_selection?.capability_epoch, begun.handoff.cursor_epoch, "the fresh selection is bound to the live cursor epoch");
    assert.equal(afterBegin.stage.dispatch.selection_id, afterBegin.stage.roster_selection?.snapshot_id);
    assert.equal(afterBegin.stage.dispatch.permitted, true, "a current selection satisfies the dispatch gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
