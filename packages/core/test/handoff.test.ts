/**
 * Handoff: cross-profile transfer of an approved completed run.
 *
 * The transition lives in durable.ts beside the other fail-closed capability
 * transitions. A handoff validates the source capability/binding, source
 * profile hash, terminal source shape (all stages done/skipped, pause done,
 * capability complete), source produced artifacts, the registered
 * source->target route, target profile/hash/stage, typed approval evidence,
 * and bounded context entirely in memory, then performs exactly one atomic
 * `writeState` to the same feature directory and returns a fresh one-time
 * target capability. Every rejection leaves canonical state and artifacts
 * byte-identical.
 *
 * Coverage:
 *   - success: target state invariants (classification/workflow_override/
 *     profile_hash/stages/cursor/capability/pause), preserved source fields,
 *     cleared source provenance, one additive HandoffRecord, hash-only
 *     secret persistence, gate/contract/begin-capability continuation;
 *   - rejection matrix: no state, stale branch, stale credentials, source
 *     profile hash drift, incomplete source, missing/free-text/mismatched
 *     approval, unknown target, target hash mismatch, unregistered route,
 *     unsafe/oversized context — all byte-identical;
 *   - duplicate/replay behavior: old envelope and fresh target envelope are
 *     both rejected deterministically without state mutation;
 *   - synthetic route with a single dispatchable target stage: dispatchGate
 *     accepts the fresh epoch/roster and rejects the old source epoch;
 *   - checkpoint-kind approval via a synthetic profile;
 *   - atomicity: a forced persist failure leaves the old state fully intact
 *     with no tmp-file debris.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, registerWorkflowProfiles, profileHash } from "../src/engine/profile.js";
import {
  advanceCursor,
  handoffWorkflow,
  registerWorkflowHandoffRoute,
  handoffRouteCatalogue,
  createCapability,
  beginCapability,
  type HandoffWorkflowInput,
} from "../src/engine/durable.js";
import { writeState, checkMonotonic, resolveState } from "../src/engine/state.js";
import { readArtifact } from "../src/engine/artifacts.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { classificationToolGate } from "../src/gates/classification.js";
import { dispatchGate, buildDispatchMarker } from "../src/gates/dispatch.js";
import { artifactSchemaFor, validateProducedArtifact } from "../src/engine/artifact-contract.js";
import type { HandoffRecord, HandoffRoute, Profile, TaskType, TeamState } from "../src/engine/types.js";

let fixtureCounter = 0;

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function statePathOf(root: string): string {
  return join(root, ".work-state", "features", "handoff-test", "state.json");
}

function artifactsDirOf(root: string): string {
  return join(root, ".work-state", "features", "handoff-test", "artifacts");
}

function snapshot(root: string): { stateHash: string; artifacts: string[] } {
  const dir = artifactsDirOf(root);
  return {
    stateHash: sha256(readFileSync(statePathOf(root), "utf8")),
    artifacts: existsSync(dir) ? readdirSync(dir).sort() : [],
  };
}

function assertUnchanged(root: string, before: { stateHash: string; artifacts: string[] }): void {
  assert.deepEqual(snapshot(root), before, "rejected handoff must not mutate canonical state or artifacts");
}

function writeApprovalArtifact(
  root: string,
  ref: string,
  overrides: Record<string, unknown> = {},
  branch = "feat/handoff",
  workflow = "spec-preparation",
  stage = "handoff",
): void {
  const dir = artifactsDirOf(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ref}.json`), JSON.stringify({
    type: "workflow_approval",
    version: 1,
    decision: "approved",
    run_key: branch,
    workflow,
    stage,
    actor: "user",
    decided_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  }));
}

function writeObservedApprovalArtifact(
  root: string,
  runKey: string,
  overrides: Record<string, unknown> = {},
  sourceWorkflow = "spec-preparation",
  sourceStage = "handoff",
): void {
  const dir = artifactsDirOf(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow_approval.json"), JSON.stringify({
    type: "workflow_approval",
    version: 1,
    decision: "approved",
    run_key: runKey,
    source_workflow: sourceWorkflow,
    source_stage: sourceStage,
    actor: "user",
    decided_at: "2026-08-21T10:56:09Z",
    ...overrides,
  }));
}

/**
 * Build a completed spec-preparation-shaped source state in a temp git repo:
 * final stage `handoff`, every stage terminal, capability complete, pause
 * done, produced artifacts + approval artifact present.
 */
function setupCompletedSpecPreparation(options: {
  branch?: string;
  wrongSourceProfileHash?: boolean;
  incompleteStages?: boolean;
  pauseNotDone?: boolean;
  capabilityNotComplete?: boolean;
  missingProducedArtifact?: boolean;
  missingApprovalArtifact?: boolean;
} = {}): { root: string; input: HandoffWorkflowInput; issued: IssuedCapability } {
  const { root, issued, branch, persistedHash } = setupCompletedSource({
    workflow: "spec-preparation",
    branch: options.branch,
    task: "spec handoff fixture",
    autonomousReason: "approved spec",
    wrongSourceProfileHash: options.wrongSourceProfileHash,
    incompleteStages: options.incompleteStages,
    pauseNotDone: options.pauseNotDone,
    capabilityNotComplete: options.capabilityNotComplete,
    missingProducedArtifact: options.missingProducedArtifact,
    missingApprovalArtifact: options.missingApprovalArtifact,
    stateArtifacts: { spec_handoff: "spec_handoff.json" },
  });
  // spec_handoff carries the approved specification (feature_spec contract).
  writeFileSync(join(artifactsDirOf(root), "spec_handoff.json"), JSON.stringify({ goal: "implement handoff", scope: ["core"], acceptance_criteria: ["handoff works"] }));
  const input = handoffInputFor(issued, branch, persistedHash, {
    target_workflow: "full-feature",
    handoff_context: { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "spec approved for implementation" },
  });
  return { root, input, issued };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(statePathOf(root), "utf8")) as TeamState;
}

/** Named capability shape returned by createCapability (test contract). */
type IssuedCapability = { capability_id: string; dispatch_token: string; advance_token: string; state: NonNullable<TeamState["dispatch_capability"]> };

/** Artifact ids a stage produces (single string or array). */
function producedIds(stage: { produces?: string | string[] }): string[] {
  return Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
}

/**
 * Build a completed source run for any shipped profile: terminal stage done,
 * every stage terminal, capability complete, pause done, produced artifacts
 * + approval artifact present. Reuses the same fail-closed options as the
 * spec-shaped wrapper below.
 */
function setupCompletedSource(options: {
  workflow: string;
  branch?: string;
  classificationType?: TaskType;
  task?: string;
  autonomousReason?: string;
  wrongSourceProfileHash?: boolean;
  incompleteStages?: boolean;
  pauseNotDone?: boolean;
  capabilityNotComplete?: boolean;
  missingProducedArtifact?: boolean;
  missingApprovalArtifact?: boolean;
  stateArtifacts?: Record<string, string>;
  artifactContents?: Record<string, unknown>;
} = {}): { root: string; issued: IssuedCapability; profile: Profile; branch: string; persistedHash: string } {
  const branch = options.branch ?? `feat/handoff-${fixtureCounter++}`;
  const root = mkdtempSync(join(tmpdir(), `handoff-${branch.replace(/\//g, "-")}-`));
  initGit(root, branch);
  const profile = loadProfile(options.workflow as never);
  assert.ok(profile, `profile ${options.workflow} must load`);
  const terminal = profile.stages[profile.stages.length - 1]!;
  const persistedHash = options.wrongSourceProfileHash ? "deadbeef".repeat(8) : profileHash(profile);
  const issued = createCapability({
    run_key: branch,
    branch,
    workflow: profile.name,
    profile_hash: persistedHash,
    stage_cursor: terminal.id,
    kind: "none",
    expected_roster: [],
  });
  const stageStatuses = options.incompleteStages
    ? profile.stages.map((s, index) => ({ id: s.id, status: (index === 0 ? "in_progress" : "pending") as const }))
    : profile.stages.map((s) => ({ id: s.id, status: "done" as const }));
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: {
      type: options.classificationType ?? "SPEC",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow: profile.name,
      autonomous_reason: options.autonomousReason ?? "approved source run",
    },
    task: options.task ?? `${profile.name} handoff fixture`,
    history: [{ task: "original request", at: "2026-08-01T00:00:00.000Z" }],
    autonomous: false,
    workflow_override: false,
    issue: { number: 42, url: "https://example.test/42" },
    stage_cursor: terminal.id,
    stages: stageStatuses,
    artifacts: options.stateArtifacts ?? {},
    pause: { kind: options.pauseNotDone ? ("none" as const) : ("done" as const), reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: options.capabilityNotComplete
      ? issued.state
      : { ...issued.state, status: "complete" as const, dispatches: [] },
    checkpoint_decisions: [
      { stage_id: profile.stages[0]!.id, checkpoint: "orientation", mode: "autonomous", decision: "proceed", actor: "orchestrator", rationale: "fixture", decided_at: "2026-08-01T00:00:00.000Z" },
    ],
    updated_at: new Date().toISOString(),
  }, { featureSlug: "handoff-test" });
  const dir = artifactsDirOf(root);
  mkdirSync(dir, { recursive: true });
  for (const id of producedIds(terminal)) {
    if (options.missingProducedArtifact) break;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(options.artifactContents?.[id] ?? { ready: true }));
  }
  if (!options.missingApprovalArtifact) {
    writeApprovalArtifact(root, "workflow_approval", {}, branch, profile.name, terminal.id);
  }
  return { root, issued, profile, branch, persistedHash };
}

/** Build a handoff input for an issued completed-source capability. */
function handoffInputFor(
  issued: IssuedCapability,
  branch: string,
  persistedHash: string,
  overrides: Partial<HandoffWorkflowInput> = {},
): HandoffWorkflowInput {
  const binding = issued.state.issued_for!;
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: branch,
    branch,
    workflow: binding.workflow,
    profile_hash: persistedHash,
    stage_cursor: binding.stage_cursor,
    cursor_epoch: binding.cursor_epoch,
    target_workflow: "full-feature",
    approval: { kind: "artifact", ref: "workflow_approval", source_stage: binding.stage_cursor, decision: "approved" },
    actor: "orchestrator",
    handoff_context: { artifact_ids: [], decision_refs: [], summary: "" },
    ...overrides,
  };
}

const TARGET_HASH = profileHash(loadProfile("full-feature")!);
const TARGET_HASH_FINGERPRINT = TARGET_HASH.length > 32 ? `${TARGET_HASH.slice(0, 30)}${TARGET_HASH.slice(-2)}` : TARGET_HASH;

/**
 * Snapshot of the catalogue at import time (shipped entries only) so the
 * integrity test is order-independent: tests may register synthetic routes
 * into the live map, but the shipped catalogue contract stays pinned.
 */
const SHIPPED_CATALOGUE = handoffRouteCatalogue();

test("handoff: success preserves source state and arms the target discovery stage with a fresh capability", () => {
  const { root, input } = setupCompletedSpecPreparation();
  try {
    const result = handoffWorkflow(root, input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const state = result.state;
    const targetProfile = loadProfile("full-feature")!;

    // Target bindings.
    assert.equal(state.classification.workflow, "full-feature");
    assert.equal(state.workflow_override, true, "SPEC->full-feature requires the override escape hatch");
    assert.equal(state.profile_hash, TARGET_HASH);
    assert.equal(state.stage_cursor, "discovery");
    assert.equal(state.cursor_epoch, result.handoff.cursor_epoch);
    assert.equal(state.dispatch_capability?.issued_for?.workflow, "full-feature");
    assert.equal(state.dispatch_capability?.issued_for?.profile_hash, TARGET_HASH);
    assert.equal(state.dispatch_capability?.issued_for?.stage_cursor, "discovery");
    assert.equal(state.dispatch_capability?.issued_for?.cursor_epoch, state.cursor_epoch);
    assert.equal(state.dispatch_capability?.issued_for?.run_key, input.run_key, "run_key is preserved");
    assert.equal(state.dispatch_capability?.issued_for?.branch, input.branch);
    assert.equal(state.dispatch_capability?.status, "ready");
    assert.equal(state.dispatch_capability?.kind, "none", "orchestrator discovery arms a none-kind capability");
    assert.equal(state.dispatch_capability?.expected_count, 0);
    assert.deepEqual(state.stages, targetProfile.stages.map((s) => ({ id: s.id, status: s.id === "discovery" ? "in_progress" : "pending" })));
    assert.deepEqual(state.pause, { kind: "none", reason: "" });
    assert.ok(checkMonotonic(state).ok, "target stage list stays monotonic");

    // Preserved source fields (verbatim).
    assert.equal(state.task, "spec handoff fixture");
    assert.equal(state.branch, input.branch);
    assert.equal(state.run_key, input.run_key);
    assert.deepEqual(state.history, [{ task: "original request", at: "2026-08-01T00:00:00.000Z" }]);
    assert.equal(state.autonomous, false, "legacy top-level autonomous preserved");
    assert.deepEqual(state.issue, { number: 42, url: "https://example.test/42" });
    assert.deepEqual(state.artifacts, { spec_handoff: "spec_handoff.json" });
    assert.deepEqual(state.scope, { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" });
    assert.equal(state.classification.type, "SPEC");
    assert.equal(state.classification.complexity, "MEDIUM");
    assert.equal(state.classification.confidence, "HIGH");
    assert.equal(state.classification.autonomous, false);
    assert.equal(state.classification.autonomous_reason, "approved spec");
    assert.equal(state.checkpoint_decisions?.length, 1, "source checkpoint decisions are preserved verbatim");
    assert.equal(state.policy?.strict_orchestrator, true);

    // Cleared source provenance.
    assert.equal("join_summary" in state, false, "source join metadata is not misapplied to target stages");
    assert.equal("loop_state" in state, false);
    assert.equal("slot_artifacts" in state, false);

    // One additive audit record.
    assert.equal(state.handoffs?.length, 1);
    const audit = state.handoffs![0]!;
    assert.equal(audit.route.source_workflow, "spec-preparation");
    assert.equal(audit.route.source_stage, "handoff");
    assert.equal(audit.route.target_workflow, "full-feature");
    assert.equal(audit.route.target_stage, "discovery");
    assert.equal(audit.source.workflow, "spec-preparation");
    assert.equal(audit.source.stage, "handoff");
    assert.equal(audit.source.cursor_epoch, input.cursor_epoch);
    assert.equal(audit.target.workflow, "full-feature");
    assert.equal(audit.target.stage, "discovery");
    assert.equal(audit.target.cursor_epoch, state.cursor_epoch);
    assert.equal(audit.target.capability_id, state.dispatch_capability?.capability_id);
    assert.equal(audit.approval.kind, "artifact");
    assert.equal(audit.approval.ref, "workflow_approval");
    assert.equal(audit.approval.decision, "approved");
    assert.equal(audit.approval.actor, "orchestrator");
    assert.deepEqual(audit.context, { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "spec approved for implementation" });
    assert.ok(audit.id && audit.at);

    // Returned one-time envelope matches the fresh target capability.
    assert.equal(result.handoff.capability_id, state.dispatch_capability?.capability_id);
    assert.equal(result.handoff.workflow, "full-feature");
    assert.equal(result.handoff.profile_hash, `${TARGET_HASH.slice(0, 30)}${TARGET_HASH.slice(-2)}`);
    assert.equal(result.handoff.stage_cursor, "discovery");
    assert.equal(result.handoff.cursor_epoch, state.cursor_epoch);
    assert.equal(result.handoff.kind, "none");
    assert.deepEqual(result.handoff.expected_roster, []);
    assert.deepEqual(result.route, audit.route);

    // The safe result exposes the typed catalogue route: id/kind/status,
    // source and target workflow/stage, prerequisites and description.
    assert.equal(result.route.id, "spec-handoff->full-feature");
    assert.equal(result.route.kind, "feature-intake");
    assert.equal(result.route.disposition, "enabled");
    assert.ok(result.route.description.length > 0, "route carries a human-readable meaning");
    assert.ok(Array.isArray(result.route.prerequisites) && result.route.prerequisites.length > 0, "route declares prerequisites");
    assert.ok(result.route.preparation?.length, "route declares target preparation/materialization");
    assert.equal(audit.route.id, "spec-handoff->full-feature");
    assert.equal(audit.route.disposition, "enabled");

    // Hash-only secret persistence: no plaintext tokens in state.json.
    const persisted = readFileSync(statePathOf(root), "utf8");
    assert.doesNotMatch(persisted, new RegExp(result.handoff.dispatch_token));
    assert.doesNotMatch(persisted, new RegExp(result.handoff.advance_token));
    assert.match(String(state.dispatch_capability?.dispatch_token_hash), /^[0-9a-f]{64}$/);
    assert.match(String(state.dispatch_capability?.advance_token_hash), /^[0-9a-f]{64}$/);

    // Artifacts and typed references stay addressable from the same dir.
    const dir = artifactsDirOf(root);
    assert.deepEqual(readArtifact(dir, "spec_handoff"), { goal: "implement handoff", scope: ["core"], acceptance_criteria: ["handoff works"] });
    assert.deepEqual(readArtifact(dir, "spec-preparation"), { ready: true });

    // The carried specification satisfies the target feature_spec contract
    // once discovery materializes it (DoD tr-dod-04).
    const specSchema = artifactSchemaFor("feature_spec");
    assert.ok(specSchema, "feature_spec artifact contract exists");
    const materialized = { goal: "implement handoff", scope: ["core"], acceptance_criteria: ["handoff works"] };
    assert.equal(validateProducedArtifact("feature_spec", materialized).ok, true);

    // Target continuation: contract resolves discovery with the target hash.
    const contract = resolveWorkflowContract(root);
    assert.equal(contract.workflow, "full-feature");
    assert.equal(contract.stage.id, "discovery");
    assert.equal(contract.profile.hash, TARGET_HASH);
    assert.equal(contract.state.dispatch.allowed, false, "orchestrator discovery is not a dispatch stage");

    // beginCapability reissues plaintext secrets for the active target
    // capability without changing its identity or cursor position.
    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    assert.equal(begun.handoff.capability_id, result.handoff.capability_id);
    assert.equal(begun.handoff.stage_cursor, result.handoff.stage_cursor);
    assert.equal(begun.handoff.cursor_epoch, result.handoff.cursor_epoch);
    assert.notEqual(begun.handoff.dispatch_token, result.handoff.dispatch_token);
    assert.notEqual(begun.handoff.advance_token, result.handoff.advance_token);
    const reissuedPersisted = readFileSync(statePathOf(root), "utf8");
    assert.doesNotMatch(reissuedPersisted, new RegExp(begun.handoff.dispatch_token));
    assert.doesNotMatch(reissuedPersisted, new RegExp(begun.handoff.advance_token));
    assert.match(String(begun.state.dispatch_capability?.dispatch_token_hash), /^[0-9a-f]{64}$/);
    assert.match(String(begun.state.dispatch_capability?.advance_token_hash), /^[0-9a-f]{64}$/);

    // Task-boundary gates accept the target state (P5 + dispatch shape).
    assert.equal(classificationToolGate({ toolName: "task" }, { cwd: root }), undefined, "workflow_override + valid autonomy passes the P5 gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff accepts the observed flat source_workflow/source_stage approval shape", () => {
  const fixture = setupCompletedSpecPreparation();
  try {
    const binding = fixture.issued.state.issued_for!;
    writeObservedApprovalArtifact(fixture.root, binding.run_key, {}, binding.workflow, binding.stage_cursor);
    const result = handoffWorkflow(fixture.root, fixture.input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.audit.route.source_workflow, binding.workflow);
    assert.equal(result.audit.route.source_stage, binding.stage_cursor);
    assert.equal(result.audit.target.workflow, fixture.input.target_workflow);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("handoff accepts flat approval after a normal terminal advance without rotating the completed source epoch", () => {
  const sourceName = `handoff-terminal-src-${fixtureCounter++}`;
  const sourceProfile: Profile = {
    name: sourceName,
    title: "Terminal advance handoff source",
    description: "normal next-stage and terminal advances before handoff",
    match: { type: ["SPEC"] },
    stages: [
      { id: "prepare", title: "Prepare", type: "orchestrator" },
      { id: "handoff", title: "Handoff", type: "orchestrator", produces: "spec_handoff" },
    ],
  };
  registerWorkflowProfiles([sourceProfile]);
  registerWorkflowHandoffRoute({
    id: `terminal-${sourceName}`,
    source_workflow: sourceName,
    source_stage: "handoff",
    target_workflow: "full-feature",
    target_stage: "discovery",
    kind: "feature-intake",
    disposition: "enabled",
    description: "Normal terminal advance regression route.",
  });

  const branch = `feat/terminal-${fixtureCounter++}`;
  const root = mkdtempSync(join(tmpdir(), `handoff-terminal-${branch.replace(/\//g, "-")}-`));
  try {
    initGit(root, branch);
    const sourceHash = profileHash(sourceProfile);
    const issued = createCapability({
      run_key: branch,
      branch,
      workflow: sourceName,
      profile_hash: sourceHash,
      stage_cursor: "prepare",
      kind: "none",
      expected_roster: [],
    });
    const sourceEpoch = issued.state.issued_for!.cursor_epoch;
    writeState(root, {
      schema: 1,
      branch,
      run_key: branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: sourceName },
      task: "terminal advance handoff regression",
      history: [{ task: "fixture", at: "2026-08-01T00:00:00.000Z" }],
      autonomous: false,
      workflow_override: false,
      issue: null,
      stage_cursor: "prepare",
      stages: sourceProfile.stages.map((stage, index) => ({ id: stage.id, status: index === 0 ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: sourceHash,
      scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
      cursor_epoch: sourceEpoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "handoff-test" });

    const nextStage = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch,
      branch,
      workflow: sourceName,
      profile_hash: sourceHash,
      stage_cursor: "prepare",
      cursor_epoch: sourceEpoch,
      evidence: "prepare completed",
    });
    assert.equal(nextStage.ok, true);
    if (!nextStage.ok || !nextStage.handoff) return;
    assert.notEqual(nextStage.state.cursor_epoch, sourceEpoch, "a normal next-stage advance rotates the cursor epoch");
    assert.equal(nextStage.handoff.stage_cursor, "handoff");

    writeFileSync(join(artifactsDirOf(root), "spec_handoff.json"), JSON.stringify({ goal: "terminal advance handoff" }));
    const terminal = advanceCursor(root, {
      token: nextStage.handoff.advance_token,
      capability_id: nextStage.handoff.capability_id,
      run_key: nextStage.handoff.run_key,
      branch: nextStage.handoff.branch,
      workflow: nextStage.handoff.workflow,
      profile_hash: nextStage.handoff.profile_hash,
      stage_cursor: nextStage.handoff.stage_cursor,
      cursor_epoch: nextStage.handoff.cursor_epoch,
      evidence: "handoff completed",
    });
    assert.equal(terminal.ok, true);
    if (!terminal.ok) return;
    assert.equal(terminal.handoff, undefined);
    assert.equal(terminal.state.dispatch_capability?.status, "complete");
    assert.equal(terminal.state.cursor_epoch, nextStage.handoff.cursor_epoch, "terminal completion preserves the source epoch");
    assert.equal(terminal.state.dispatch_capability?.issued_for?.cursor_epoch, nextStage.handoff.cursor_epoch);

    writeObservedApprovalArtifact(root, branch, {}, sourceName, "handoff");
    const handoff = handoffWorkflow(root, {
      token: nextStage.handoff.advance_token,
      capability_id: nextStage.handoff.capability_id,
      run_key: branch,
      branch,
      workflow: sourceName,
      profile_hash: sourceHash,
      stage_cursor: "handoff",
      cursor_epoch: nextStage.handoff.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
      actor: "orchestrator",
      handoff_context: { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "terminal approval" },
    });
    assert.equal(handoff.ok, true, "valid flat workflow approval is accepted after normal terminal advance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff preserves legacy flat approval compatibility", () => {
  const fixture = setupCompletedSpecPreparation();
  try {
    const result = handoffWorkflow(fixture.root, fixture.input);
    assert.equal(result.ok, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("handoff rejects observed flat approval mismatches without mutation", () => {
  const mismatches: Array<{ label: string; overrides: Record<string, unknown> }> = [
    { label: "run_key", overrides: { run_key: "feat/other-run" } },
    { label: "source_workflow", overrides: { source_workflow: "lightweight" } },
    { label: "source_stage", overrides: { source_stage: "intake_repo_map" } },
    { label: "decision", overrides: { decision: "pending" } },
    { label: "actor", overrides: { actor: "" } },
    { label: "decided_at", overrides: { decided_at: "not-a-date" } },
  ];
  for (const { label, overrides } of mismatches) {
    const fixture = setupCompletedSpecPreparation();
    try {
      const binding = fixture.issued.state.issued_for!;
      writeObservedApprovalArtifact(fixture.root, binding.run_key, overrides, binding.workflow, binding.stage_cursor);
      const before = snapshot(fixture.root);
      const result = handoffWorkflow(fixture.root, fixture.input);
      assert.equal(result.ok, false, label);
      if (!result.ok) assert.equal(result.error, "handoff approval evidence is invalid", label);
      assertUnchanged(fixture.root, before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const targetMismatch = setupCompletedSpecPreparation();
  try {
    const binding = targetMismatch.issued.state.issued_for!;
    writeObservedApprovalArtifact(targetMismatch.root, binding.run_key, {}, binding.workflow, binding.stage_cursor);
    const before = snapshot(targetMismatch.root);
    const result = handoffWorkflow(targetMismatch.root, { ...targetMismatch.input, target_workflow: "lightweight" });
    assert.equal(result.ok, false, "requested target");
    if (!result.ok) assert.equal(result.error, "workflow transition is not registered");
    assertUnchanged(targetMismatch.root, before);
  } finally {
    rmSync(targetMismatch.root, { recursive: true, force: true });
  }
});

test("handoff: rejections are fail-closed and byte-identical", () => {
  // No state at all.
  {
    const root = mkdtempSync(join(tmpdir(), `handoff-no-state-${fixtureCounter++}-`));
    try {
      initGit(root, "feat/handoff");
      const result = handoffWorkflow(root, {
        token: "t", capability_id: "c", run_key: "r", branch: "feat/handoff", workflow: "spec-preparation",
        profile_hash: "h", stage_cursor: "handoff", cursor_epoch: "e",
        target_workflow: "full-feature", approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" }, actor: "orchestrator",
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "workflow state not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Stale branch binding.
  {
    const { root, input } = setupCompletedSpecPreparation({ branch: "feat/handoff" });
    try {
      execFileSync("git", ["-C", root, "checkout", "--quiet", "-b", "feat/other"], { stdio: "ignore" });
      const before = snapshot(root);
      const result = handoffWorkflow(root, input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /stale for the active branch/);
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Stale credentials: wrong capability id, token, cursor epoch, branch.
  const cases: Array<{ label: string; mutate: (input: HandoffWorkflowInput) => HandoffWorkflowInput; error: RegExp }> = [
    { label: "wrong capability_id", mutate: (input) => ({ ...input, capability_id: "not-the-capability" }), error: /capability identity mismatch/ },
    { label: "wrong token", mutate: (input) => ({ ...input, token: "not-the-token" }), error: /invalid secret/ },
    { label: "wrong cursor_epoch", mutate: (input) => ({ ...input, cursor_epoch: "not-the-epoch" }), error: /capability binding mismatch/ },
    { label: "wrong branch", mutate: (input) => ({ ...input, branch: "feat/wrong" }), error: /capability binding mismatch/ },
    { label: "wrong workflow", mutate: (input) => ({ ...input, workflow: "lightweight" }), error: /capability binding mismatch/ },
    { label: "wrong profile_hash", mutate: (input) => ({ ...input, profile_hash: "deadbeef".repeat(8) }), error: /capability binding mismatch/ },
  ];
  for (const { label, mutate, error } of cases) {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      const before = snapshot(root);
      const result = handoffWorkflow(root, mutate(input));
      assert.equal(result.ok, false, label);
      if (!result.ok) assert.match(result.error, error, label);
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Source profile hash drift (capability bound to a stale hash).
  {
    const { root, input } = setupCompletedSpecPreparation({ wrongSourceProfileHash: true });
    try {
      const before = snapshot(root);
      const result = handoffWorkflow(root, input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "source workflow profile is missing or stale");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Incomplete source: mid-workflow stages, pause not done, capability not complete.
  {
    const incomplete = setupCompletedSpecPreparation({ incompleteStages: true });
    try {
      const before = snapshot(incomplete.root);
      const result = handoffWorkflow(incomplete.root, incomplete.input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "source workflow is not a completed handoff source");
      assertUnchanged(incomplete.root, before);
    } finally {
      rmSync(incomplete.root, { recursive: true, force: true });
    }
  }
  {
    const paused = setupCompletedSpecPreparation({ pauseNotDone: true });
    try {
      const before = snapshot(paused.root);
      const result = handoffWorkflow(paused.root, paused.input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "source workflow is not a completed handoff source");
      assertUnchanged(paused.root, before);
    } finally {
      rmSync(paused.root, { recursive: true, force: true });
    }
  }
  {
    const notComplete = setupCompletedSpecPreparation({ capabilityNotComplete: true });
    try {
      const before = snapshot(notComplete.root);
      const result = handoffWorkflow(notComplete.root, notComplete.input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "source workflow is not a completed handoff source");
      assertUnchanged(notComplete.root, before);
    } finally {
      rmSync(notComplete.root, { recursive: true, force: true });
    }
  }

  // Missing produced artifact on the source terminal stage.
  {
    const missing = setupCompletedSpecPreparation({ missingProducedArtifact: true });
    try {
      const before = snapshot(missing.root);
      const result = handoffWorkflow(missing.root, missing.input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /source produced artifact '.*' is missing or invalid/);
      assertUnchanged(missing.root, before);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }
  }

  // Approval evidence: missing artifact, free text, mismatched bindings.
  {
    const missing = setupCompletedSpecPreparation({ missingApprovalArtifact: true });
    try {
      const before = snapshot(missing.root);
      const result = handoffWorkflow(missing.root, missing.input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff approval evidence is missing");
      assertUnchanged(missing.root, before);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }
  }
  {
    const freeText = setupCompletedSpecPreparation();
    try {
      const before = snapshot(freeText.root);
      const result = handoffWorkflow(freeText.root, { ...freeText.input, approval: { ...freeText.input.approval, decision: "looks good to me" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff approval evidence is invalid");
      assertUnchanged(freeText.root, before);
    } finally {
      rmSync(freeText.root, { recursive: true, force: true });
    }
  }
  {
    const mismatched = setupCompletedSpecPreparation();
    try {
      writeApprovalArtifact(mismatched.root, "workflow_approval", { workflow: "lightweight" }, mismatched.input.branch);
      const before = snapshot(mismatched.root);
      const result = handoffWorkflow(mismatched.root, mismatched.input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff approval evidence is invalid");
      assertUnchanged(mismatched.root, before);
    } finally {
      rmSync(mismatched.root, { recursive: true, force: true });
    }
  }
  {
    const wrongStage = setupCompletedSpecPreparation();
    try {
      const before = snapshot(wrongStage.root);
      const result = handoffWorkflow(wrongStage.root, { ...wrongStage.input, approval: { ...wrongStage.input.approval, source_stage: "intake_repo_map" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff approval evidence is invalid");
      assertUnchanged(wrongStage.root, before);
    } finally {
      rmSync(wrongStage.root, { recursive: true, force: true });
    }
  }

  // Target validation: unknown workflow, hash precondition mismatch, unregistered route.
  {
    const unknown = setupCompletedSpecPreparation();
    try {
      const before = snapshot(unknown.root);
      const result = handoffWorkflow(unknown.root, { ...unknown.input, target_workflow: "not-a-profile" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "target workflow is unavailable");
      assertUnchanged(unknown.root, before);
    } finally {
      rmSync(unknown.root, { recursive: true, force: true });
    }
  }
  {
    const hashMismatch = setupCompletedSpecPreparation();
    try {
      const before = snapshot(hashMismatch.root);
      const result = handoffWorkflow(hashMismatch.root, { ...hashMismatch.input, target_profile_hash: "deadbeef".repeat(8) });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "target profile hash mismatch");
      assertUnchanged(hashMismatch.root, before);
    } finally {
      rmSync(hashMismatch.root, { recursive: true, force: true });
    }
  }
  {
    const unsupported = setupCompletedSpecPreparation();
    try {
      const before = snapshot(unsupported.root);
      const result = handoffWorkflow(unsupported.root, { ...unsupported.input, target_workflow: "lightweight" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "workflow transition is not registered");
      assertUnchanged(unsupported.root, before);
    } finally {
      rmSync(unsupported.root, { recursive: true, force: true });
    }
  }
});

test("handoff: unsafe or oversized context is rejected", () => {
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      const before = snapshot(root);
      const result = handoffWorkflow(root, { ...input, handoff_context: { artifact_ids: ["missing-artifact"], decision_refs: [], summary: "" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff context is invalid or exceeds limits");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      const before = snapshot(root);
      const tooMany = Array.from({ length: 33 }, () => "spec_handoff");
      const result = handoffWorkflow(root, { ...input, handoff_context: { artifact_ids: tooMany, decision_refs: [], summary: "" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff context is invalid or exceeds limits");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      const before = snapshot(root);
      const result = handoffWorkflow(root, { ...input, handoff_context: { artifact_ids: [], decision_refs: [], summary: "x".repeat(2001) } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff context is invalid or exceeds limits");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      const before = snapshot(root);
      const result = handoffWorkflow(root, { ...input, handoff_context: { artifact_ids: [], decision_refs: ["a".repeat(201)], summary: "" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff context is invalid or exceeds limits");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      const before = snapshot(root);
      const result = handoffWorkflow(root, { ...input, handoff_context: { artifact_ids: ["../escape"], decision_refs: [], summary: "" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff context is invalid or exceeds limits");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("handoff: a full audit trail rejects overflow instead of appending past the cap", () => {
  /** Minimal well-formed record; only the record count is under test here. */
  const record = (index: number): HandoffRecord => ({
    id: `prior-handoff-${index}`,
    route: SHIPPED_CATALOGUE[0]!,
    source: {
      workflow: "spec-preparation",
      profile_hash: "0".repeat(64),
      stage: "handoff",
      cursor_epoch: `source-epoch-${index}`,
      run_key: "prior-run",
      branch: "prior-branch",
    },
    target: {
      workflow: "full-feature",
      profile_hash: "0".repeat(64),
      stage: "discovery",
      cursor_epoch: `target-epoch-${index}`,
      capability_id: `prior-capability-${index}`,
    },
    approval: { kind: "artifact", ref: "workflow_approval", decision: "approved", actor: "orchestrator", decided_at: "2026-08-01T00:00:00.000Z" },
    context: { artifact_ids: [], decision_refs: [], summary: "" },
    at: "2026-08-01T00:00:00.000Z",
  });

  // Exactly at the cap (32): reject rather than truncate or overflow; state byte-identical.
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      writeState(root, { ...readState(root), handoffs: Array.from({ length: 32 }, (_, index) => record(index)) }, { featureSlug: "handoff-test" });
      const before = snapshot(root);
      const result = handoffWorkflow(root, input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "handoff audit trail is full");
      assertUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // One below the cap (31): the handoff succeeds and persists exactly 32 records.
  {
    const { root, input } = setupCompletedSpecPreparation();
    try {
      writeState(root, { ...readState(root), handoffs: Array.from({ length: 31 }, (_, index) => record(index)) }, { featureSlug: "handoff-test" });
      const result = handoffWorkflow(root, input);
      assert.equal(result.ok, true);
      assert.equal(readState(root).handoffs?.length, 32);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("handoff: duplicate and replayed handoffs are deterministic rejections without state mutation", () => {
  const { root, input, issued } = setupCompletedSpecPreparation();
  try {
    const first = handoffWorkflow(root, input);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const afterSuccess = snapshot(root);

    // Replay the original (now stale) source envelope: identity mismatch.
    const replay = handoffWorkflow(root, input);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.error, "capability identity mismatch");
    assertUnchanged(root, afterSuccess);

    // A fresh target envelope cannot hand off again: the target is not a
    // completed handoff source.
    const handoff = first.handoff;
    const fresh: HandoffWorkflowInput = {
      token: handoff.advance_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "discovery", decision: "approved" },
      actor: "orchestrator",
      handoff_context: { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "again" },
    };
    const again = handoffWorkflow(root, fresh);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error, "source workflow is not a completed handoff source");
    assertUnchanged(root, afterSuccess);
    assert.equal(readState(root).handoffs?.length, 1, "exactly one audit record survives the replays");

    // The old source credentials cannot authorize anything anymore.
    const persisted = readState(root);
    assert.notEqual(persisted.dispatch_capability?.capability_id, issued.capability_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: synthetic route transfers into a dispatchable single target stage; gates accept the fresh epoch and reject the old one", () => {
  const sourceName = `handoff-src-${fixtureCounter++}`;
  const targetName = `handoff-tgt-${fixtureCounter++}`;
  const sourceProfile: Profile = {
    name: sourceName,
    title: "Synthetic handoff source",
    description: "single runnable stage then a handoff stage",
    match: { type: ["SPEC"] },
    stages: [
      { id: "spec", title: "Spec", type: "orchestrator" },
      { id: "handoff", title: "Handoff", type: "orchestrator" },
    ],
  };
  const targetProfile: Profile = {
    name: targetName,
    title: "Synthetic handoff target",
    description: "dispatchable first stage",
    match: { type: ["FEATURE"] },
    stages: [
      { id: "implementation", title: "Implementation", type: "single", role: "go" },
      { id: "summary", title: "Summary", type: "orchestrator" },
    ],
  };
  registerWorkflowProfiles([sourceProfile, targetProfile]);
  registerWorkflowHandoffRoute({
    id: `synthetic-${targetName}`,
    source_workflow: sourceName,
    source_stage: "handoff",
    target_workflow: targetName,
    target_stage: "implementation",
    kind: "feature-intake",
    disposition: "enabled",
    description: "Synthetic dispatchable target used by handoff gate tests.",
  });

  const branch = `feat/synthetic-${fixtureCounter++}`;
  const root = mkdtempSync(join(tmpdir(), `handoff-synthetic-${branch.replace(/\//g, "-")}-`));
  try {
    initGit(root, branch);
    const sourceHash = profileHash(sourceProfile);
    const issued = createCapability({
      run_key: branch, branch, workflow: sourceName, profile_hash: sourceHash,
      stage_cursor: "handoff", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1,
      branch,
      run_key: branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: sourceName },
      task: "synthetic handoff",
      workflow_override: false,
      issue: null,
      stage_cursor: "handoff",
      stages: sourceProfile.stages.map((s) => ({ id: s.id, status: "done" as const })),
      artifacts: {},
      pause: { kind: "done" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: sourceHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: { ...issued.state, status: "complete" as const, dispatches: [] },
      updated_at: new Date().toISOString(),
    }, { featureSlug: "handoff-test" });
    const dir = artifactsDirOf(root);
    mkdirSync(dir, { recursive: true });
    writeApprovalArtifact(root, "workflow_approval", {}, branch, sourceName, "handoff");

    const result = handoffWorkflow(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch,
      branch,
      workflow: sourceName,
      profile_hash: sourceHash,
      stage_cursor: "handoff",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      target_workflow: targetName,
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
      actor: "orchestrator",
      handoff_context: { artifact_ids: [], decision_refs: [], summary: "" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const state = result.state;
    assert.equal(state.classification.workflow, targetName);
    assert.equal(state.stage_cursor, "implementation");
    assert.equal(state.dispatch_capability?.kind, "single");
    assert.deepEqual(state.dispatch_capability?.expected_roster, [{ role: "go", agent: "developer-go" }]);
    assert.equal(state.dispatch_capability?.status, "ready");
    assert.ok(checkMonotonic(state).ok);
    assert.equal(classificationToolGate({ toolName: "task" }, { cwd: root }), undefined, "override + valid autonomy passes P5");

    // A marker bound to the fresh target epoch/roster is accepted.
    const implementation = targetProfile.stages[0]!;
    const freshMarker = buildDispatchMarker(result.handoff.run_key, implementation, ["go"], "go", result.handoff.cursor_epoch);
    assert.equal(
      dispatchGate({ toolName: "task", input: { agent: "developer-go", role: "go", task: freshMarker } }, { cwd: root }),
      undefined,
      "fresh target epoch/roster passes the dispatch gate",
    );

    // A marker carrying the OLD source epoch/roster is rejected.
    const staleMarker = buildDispatchMarker(result.handoff.run_key, implementation, ["go"], "go", issued.state.issued_for!.cursor_epoch);
    const blocked = dispatchGate({ toolName: "task", input: { agent: "developer-go", role: "go", task: staleMarker } }, { cwd: root });
    assert.ok(blocked, "old source epoch marker is rejected");
    assert.match(blocked?.reason ?? "", /task marker does not match persisted opaque capability/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: checkpoint-kind approval uses a durable approved decision on the source stage", () => {
  const sourceName = `handoff-ckpt-src-${fixtureCounter++}`;
  const targetName = `handoff-ckpt-tgt-${fixtureCounter++}`;
  const sourceProfile: Profile = {
    name: sourceName,
    title: "Checkpoint handoff source",
    description: "handoff stage declares an approval checkpoint",
    match: { type: ["SPEC"] },
    stages: [
      { id: "spec", title: "Spec", type: "orchestrator" },
      { id: "handoff", title: "Handoff", type: "orchestrator", checkpoint: "approve_spec" },
    ],
  };
  const targetProfile: Profile = {
    name: targetName,
    title: "Checkpoint handoff target",
    description: "orchestrator discovery entry",
    match: { type: ["FEATURE"] },
    stages: [{ id: "discovery", title: "Discovery", type: "orchestrator" }],
  };
  registerWorkflowProfiles([sourceProfile, targetProfile]);
  registerWorkflowHandoffRoute({
    id: `ckpt-${targetName}`,
    source_workflow: sourceName,
    source_stage: "handoff",
    target_workflow: targetName,
    target_stage: "discovery",
    kind: "feature-intake",
    disposition: "enabled",
    description: "Synthetic checkpoint-approval handoff route used by tests.",
  });

  const branch = `feat/ckpt-${fixtureCounter++}`;
  const root = mkdtempSync(join(tmpdir(), `handoff-ckpt-${branch.replace(/\//g, "-")}-`));
  try {
    initGit(root, branch);
    const sourceHash = profileHash(sourceProfile);
    const issued = createCapability({
      run_key: branch, branch, workflow: sourceName, profile_hash: sourceHash,
      stage_cursor: "handoff", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1,
      branch,
      run_key: branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: sourceName },
      task: "checkpoint handoff",
      workflow_override: false,
      issue: null,
      stage_cursor: "handoff",
      stages: sourceProfile.stages.map((s) => ({ id: s.id, status: "done" as const })),
      artifacts: {},
      pause: { kind: "done" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: sourceHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: { ...issued.state, status: "complete" as const, dispatches: [] },
      checkpoint_decisions: [
        { stage_id: "handoff", checkpoint: "approve_spec", mode: "interactive", decision: "approved", actor: "user", rationale: "explicit approval", decided_at: "2026-08-02T00:00:00.000Z" },
      ],
      updated_at: new Date().toISOString(),
    }, { featureSlug: "handoff-test" });
    mkdirSync(artifactsDirOf(root), { recursive: true });

    const input: HandoffWorkflowInput = {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch,
      branch,
      workflow: sourceName,
      profile_hash: sourceHash,
      stage_cursor: "handoff",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      target_workflow: targetName,
      approval: { kind: "checkpoint", ref: "approve_spec", source_stage: "handoff", decision: "approved" },
      actor: "user",
      handoff_context: { artifact_ids: [], decision_refs: [], summary: "" },
    };
    const result = handoffWorkflow(root, input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.state.classification.workflow, targetName);
    assert.equal(result.state.stage_cursor, "discovery");
    assert.equal(result.state.checkpoint_decisions?.length, 1, "source decisions preserved by value");
    assert.equal(result.audit.approval.kind, "checkpoint");
    assert.equal(result.audit.approval.ref, "approve_spec");
    assert.equal(result.audit.approval.actor, "user");

    // A second handoff with the fresh target envelope is not a completed source.
    const before = snapshot(root);
    const rejected = handoffWorkflow(root, { ...input, token: result.handoff.advance_token, capability_id: result.handoff.capability_id, workflow: targetName, profile_hash: result.handoff.profile_hash, stage_cursor: result.handoff.stage_cursor, cursor_epoch: result.handoff.cursor_epoch });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error, "source workflow is not a completed handoff source");
    assertUnchanged(root, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: a persist failure fails closed — old state intact, no tmp debris", () => {
  const { root, input } = setupCompletedSpecPreparation();
  try {
    const before = snapshot(root);
    // Remove write permission from the feature state dir so the atomic
    // write cannot land; the transition must throw (WORKFLOW_HANDOFF_FAILED
    // at the tool layer) and leave the old canonical state untouched.
    execFileSync("chmod", ["555", join(root, ".work-state", "features", "handoff-test")], { stdio: "ignore" });
    assert.throws(() => handoffWorkflow(root, input));
    execFileSync("chmod", ["755", join(root, ".work-state", "features", "handoff-test")], { stdio: "ignore" });
    assertUnchanged(root, before);
    const dir = join(root, ".work-state", "features", "handoff-test");
    const debris = readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(debris, [], "atomicWrite leaves no tmp residue");
    assert.equal(resolveState(root).state?.classification?.workflow, "spec-preparation", "no partial switch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: the shipped route catalogue is typed, complete, and references real profiles/stages", () => {
  const catalogue = SHIPPED_CATALOGUE;
  assert.ok(catalogue.length > 0, "the shipped catalogue is not empty");
  const ids = catalogue.map((route) => route.id);
  assert.equal(new Set(ids).size, ids.length, "route ids are unique");
  const keys = catalogue.map((route) => `${route.source_workflow}:${route.source_stage}->${route.target_workflow}`);
  assert.equal(new Set(keys).size, keys.length, "route keys (source workflow/stage -> target workflow) are unique");

  // Every entry is typed, documented, and points at real shipped stages.
  for (const route of catalogue) {
    assert.ok(["enabled", "conditional", "unsupported"].includes(route.disposition), `${route.id} has a valid disposition`);
    assert.ok(route.description.trim(), `${route.id} carries a human-readable description`);
    const source = loadProfile(route.source_workflow as never);
    assert.ok(source, `source profile ${route.source_workflow} exists`);
    assert.ok(source.stages.some((stage) => stage.id === route.source_stage), `source stage ${route.source_workflow}:${route.source_stage} exists`);
    const target = loadProfile(route.target_workflow as never);
    assert.ok(target, `target profile ${route.target_workflow} exists`);
    assert.ok(target.stages.some((stage) => stage.id === route.target_stage), `target stage ${route.target_workflow}:${route.target_stage} exists`);
    if (route.disposition !== "enabled") {
      assert.ok(route.when?.trim(), `${route.id} documents when it may be selected`);
    }
  }

  // Policy shape: exactly one enabled route today; the conditional families
  // and the documented unsupported pairs are all present.
  const enabled = catalogue.filter((route) => route.disposition === "enabled").map((route) => route.id);
  assert.deepEqual(enabled, ["spec-handoff->full-feature"], "exactly one enabled route: spec -> full-feature");
  const conditional = catalogue.filter((route) => route.disposition === "conditional").map((route) => route.id).sort();
  assert.deepEqual(conditional, [
    "bug-fix-summary->regression",
    "debug-cycle-summary->regression",
    "emergency-summary->regression",
    "full-feature-summary->regression",
    "lightweight-summary->regression",
    "regression-summary->bug-fix",
    "regression-summary->debug-cycle",
    "standard-summary->regression",
  ], "conditional routes match the declared policy families");
  for (const route of catalogue.filter((entry) => entry.disposition === "conditional")) {
    assert.ok(Array.isArray(route.blocked_by) && route.blocked_by.length > 0, `${route.id} declares its missing adapter/evidence gaps`);
    assert.ok(Array.isArray(route.prerequisites) && route.prerequisites.length > 0, `${route.id} declares prerequisites`);
  }
  const unsupported = catalogue.filter((route) => route.disposition === "unsupported");
  const unsupportedPairs = new Set(unsupported.map((route) => `${route.source_workflow}->${route.target_workflow}`));
  assert.ok(unsupportedPairs.has("spec-preparation->bug-fix"), "spec -> bug-fix is documented unsupported");
  assert.ok(unsupportedPairs.has("full-feature->debug-cycle"), "feature -> debug-cycle is documented unsupported");
  assert.ok(unsupportedPairs.has("feature-regression->full-feature"), "regression -> feature is documented unsupported");
  assert.ok(unsupportedPairs.has("review->full-feature"), "review -> implementation is documented unsupported");
  assert.ok(unsupportedPairs.has("research->full-feature"), "analysis -> implementation is documented unsupported");
  assert.ok(unsupported.some((route) => route.source_workflow === route.target_workflow), "same-profile transitions are documented unsupported");
});

test("handoff: conditional catalogue routes reject deterministically with visible route metadata and unchanged state", () => {
  const { root, issued, branch, persistedHash } = setupCompletedSource({ workflow: "full-feature", classificationType: "FEATURE" });
  try {
    const before = snapshot(root);
    const result = handoffWorkflow(root, handoffInputFor(issued, branch, persistedHash, { target_workflow: "feature-regression" }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /conditional and not enabled/);
      assert.match(result.error, /full-feature-summary->regression/);
      assert.match(result.error, /blocking:/);
      assert.equal(result.route?.id, "full-feature-summary->regression");
      assert.equal(result.route?.kind, "regression");
      assert.equal(result.route?.disposition, "conditional");
      assert.equal(result.route?.source_workflow, "full-feature");
      assert.equal(result.route?.source_stage, "summary");
      assert.equal(result.route?.target_workflow, "feature-regression");
      assert.equal(result.route?.target_stage, "discovery_intake");
      assert.ok((result.route?.blocked_by ?? []).length > 0, "conditional rejection exposes the missing adapters");
    }
    assertUnchanged(root, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: explicitly unsupported catalogue pairs are denied with a human-readable reason", () => {
  const { root, input } = setupCompletedSpecPreparation();
  try {
    const before = snapshot(root);
    const result = handoffWorkflow(root, { ...input, target_workflow: "bug-fix" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /unsupported/);
      assert.match(result.error, /spec-handoff->bug-fix/);
      assert.equal(result.route?.id, "spec-handoff->bug-fix");
      assert.equal(result.route?.kind, "unsupported");
      assert.equal(result.route?.disposition, "unsupported");
      assert.equal(result.route?.source_workflow, "spec-preparation");
      assert.equal(result.route?.target_workflow, "bug-fix");
    }
    assertUnchanged(root, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: duplicate route ids and duplicate route keys are rejected deterministically at registration", () => {
  // Id collision with the shipped catalogue (different key) is rejected.
  assert.throws(
    () => registerWorkflowHandoffRoute({
      id: "spec-handoff->full-feature",
      source_workflow: "spec-preparation",
      source_stage: "handoff",
      target_workflow: "research",
      target_stage: "summary",
      kind: "unsupported",
      disposition: "unsupported",
      description: "duplicate id",
    }),
    /handoff route id already registered/,
  );
  // Key collision (same source workflow/stage -> target workflow) is rejected.
  const fresh: HandoffRoute = {
    id: "dup-key-1",
    source_workflow: "research",
    source_stage: "summary",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "duplicate key fixture",
  };
  registerWorkflowHandoffRoute(fresh);
  assert.throws(
    () => registerWorkflowHandoffRoute({ ...fresh, id: "dup-key-2" }),
    /handoff route already registered/,
  );
  // Malformed entries (unknown disposition, missing description) are rejected.
  assert.throws(
    () => registerWorkflowHandoffRoute({ ...fresh, id: "dup-key-3", disposition: "bogus" as never }),
    /invalid handoff route registration/,
  );
  assert.throws(
    () => registerWorkflowHandoffRoute({ ...fresh, id: "dup-key-5", kind: "bogus" as never }),
    /invalid handoff route registration/,
  );
  assert.throws(
    () => registerWorkflowHandoffRoute({ ...fresh, id: "dup-key-4", description: "" }),
    /invalid handoff route registration/,
  );
});

test("handoff: a registered route whose target stage does not exist in the target profile is rejected", () => {
  const sourceName = `handoff-stage-src-${fixtureCounter++}`;
  const targetName = `handoff-stage-tgt-${fixtureCounter++}`;
  const sourceProfile: Profile = {
    name: sourceName,
    title: "Stage-validation source",
    description: "source with a handoff terminal stage",
    match: { type: ["SPEC"] },
    stages: [
      { id: "spec", title: "Spec", type: "orchestrator" },
      { id: "handoff", title: "Handoff", type: "orchestrator" },
    ],
  };
  const targetProfile: Profile = {
    name: targetName,
    title: "Stage-validation target",
    description: "target missing the routed entry stage",
    match: { type: ["FEATURE"] },
    stages: [{ id: "discovery", title: "Discovery", type: "orchestrator" }],
  };
  registerWorkflowProfiles([sourceProfile, targetProfile]);
  registerWorkflowHandoffRoute({
    id: `stage-route-${fixtureCounter}`,
    source_workflow: sourceName,
    source_stage: "handoff",
    target_workflow: targetName,
    target_stage: "does-not-exist",
    kind: "feature-intake",
    disposition: "enabled",
    description: "synthetic route with a missing target stage",
  });

  const branch = `feat/stage-${fixtureCounter++}`;
  const root = mkdtempSync(join(tmpdir(), `handoff-stage-${branch.replace(/\//g, "-")}-`));
  try {
    initGit(root, branch);
    const sourceHash = profileHash(sourceProfile);
    const issued = createCapability({
      run_key: branch, branch, workflow: sourceName, profile_hash: sourceHash,
      stage_cursor: "handoff", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1,
      branch,
      run_key: branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: sourceName },
      task: "stage validation",
      workflow_override: false,
      issue: null,
      stage_cursor: "handoff",
      stages: sourceProfile.stages.map((s) => ({ id: s.id, status: "done" as const })),
      artifacts: {},
      pause: { kind: "done" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: sourceHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: { ...issued.state, status: "complete" as const, dispatches: [] },
      updated_at: new Date().toISOString(),
    }, { featureSlug: "handoff-test" });
    mkdirSync(artifactsDirOf(root), { recursive: true });
    writeApprovalArtifact(root, "workflow_approval", {}, branch, sourceName, "handoff");
    const before = snapshot(root);
    const result = handoffWorkflow(root, handoffInputFor(issued, branch, sourceHash, { target_workflow: targetName }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "target stage is unavailable");
    assertUnchanged(root, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
