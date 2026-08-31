/**
 * wave-004 roster_policy seam contracts (behavioral):
 *   - workflow_instructions (stage contract) is readable BEFORE capability
 *     issuance and exposes the allowed-pool roster policy
 *   - workflow_begin accepts only semantic role/facet/reason selections;
 *     concrete agent ids are rejected
 *   - selections validate allowed roles, multiplicity and the LIVE registered
 *     agent mapping; missing mappings and unmapped roles fail closed
 *   - the validated selection freezes on the issued capability: an identical
 *     re-issue is idempotent, a changed selection for an active capability is
 *     rejected
 *   - without a selection the engine picks a safe deterministic default
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { beginCapability, type RosterBeginSelection } from "../src/engine/durable.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { writeStateBootstrap, resolveState } from "../src/engine/state.js";
import { resolveConfig } from "../src/engine/config.js";
import { buildAgentMapping, validateAgentMappingState, writeAgentMapping, type AgentMappingState } from "../src/engine/agent-mapping.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TeamState } from "../src/engine/types.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

const poolRoles = {
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  architect: "architect",
} as const;

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

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

function writeFreshState(root: string): void {
  const profile = loadProfile("full-feature");
  assert.ok(profile);
  const state: TeamState = {
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "full-feature" },
    task: "roster seam regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "exploration",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "discovery" ? "done" as const : stage.id === "exploration" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    scope: NO_SCOPE,
    updated_at: new Date().toISOString(),
  };
  writeStateBootstrap(root, state, { featureSlug: "seam" });
}

function frozenSelection(root: string): NonNullable<TeamState["roster_selection"]> | undefined {
  const resolved = resolveState(root);
  return resolved.state?.roster_selection;
}

test("workflow_instructions is readable before capability issuance and exposes the allowed pool", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-instructions-"));
  try {
    initGit(root);
    writeFreshState(root);
    const contract = resolveWorkflowContract(root);
    const rosterPolicy = contract.roster_policy;
    assert.ok(rosterPolicy, "roster policy is exposed without any capability");
    assert.deepEqual(rosterPolicy.allowed_roles, ["analyst", "tech-researcher"]);
    assert.equal(rosterPolicy.max_workers, 3);
    assert.equal(contract.roster_selection, null, "no selection is frozen before begin");
    assert.equal(contract.state.dispatch.allowed, false, "dispatch is not permitted before capability issuance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("begin freezes a semantic selection with live-mapped agents; identical re-issue is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-freeze-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);
    const selection: RosterBeginSelection = {
      rationale: "two-probe exploration",
      occurrences: [
        { role: "analyst", reason: "codebase probe" },
        { role: "tech-researcher", reason: "prior art" },
      ],
    };
    const begun = beginCapability(root, selection);
    assert.equal(begun.ok, true, begun.ok ? "begin accepted" : begun.error);
    if (!begun.ok) return;
    assert.deepEqual(begun.handoff?.expected_roster, [
      { role: "analyst", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
    ], "agents come from the live registered mapping");
    const frozen = frozenSelection(root);
    assert.ok(frozen, "selection is frozen in state");
    assert.equal(frozen?.selected.length, 2);
    assert.equal(frozen?.selected[0]?.agent, "analyst");

    const again = beginCapability(root, selection);
    assert.equal(again.ok, true, again.ok ? "identical re-issue is idempotent" : again.error);
    const refrozen = frozenSelection(root);
    assert.equal(refrozen?.snapshot_id, frozen?.snapshot_id, "identical selection keeps the frozen snapshot");
    assert.deepEqual(refrozen?.selected, frozen?.selected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed selection for an active capability is rejected with the frozen snapshot named", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-reject-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);
    const begun = beginCapability(root, { occurrences: [{ role: "analyst" }, { role: "tech-researcher" }] });
    assert.equal(begun.ok, true);
    const frozen = frozenSelection(root);
    assert.ok(frozen);

    // A genuinely different composition is rejected and names the frozen snapshot.
    const reordered = beginCapability(root, { occurrences: [{ role: "tech-researcher" }, { role: "analyst" }] });
    assert.equal(reordered.ok, false, "a reordered selection is a changed selection");
    if (reordered.ok) return;
    assert.match(reordered.error, /frozen/);
    assert.match(reordered.error, new RegExp(frozen.snapshot_id));

    const refaceted = beginCapability(root, { occurrences: [{ role: "analyst", facet: "second-probe" }, { role: "tech-researcher" }] });
    assert.equal(refaceted.ok, false, "a changed facet composition is a changed selection");
    if (refaceted.ok) return;
    assert.match(refaceted.error, /frozen/);

    // Engine-appended slots are engine-owned: a strict prefix of the frozen
    // composition stays idempotent.
    const shrunk = beginCapability(root, { occurrences: [{ role: "analyst" }] });
    assert.equal(shrunk.ok, true, "a prefix of the frozen composition is the identical selection");
    const kept = frozenSelection(root);
    assert.equal(kept?.snapshot_id, frozen.snapshot_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concrete agent ids are never accepted as selection input", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-agent-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);
    const tainted = { occurrences: [{ role: "analyst", agent: "someone-else" }] } as unknown as RosterBeginSelection;
    const rejected = beginCapability(root, tainted);
    assert.equal(rejected.ok, false, "agent ids are not caller authority");
    if (rejected.ok) return;
    assert.match(rejected.error, /semantic/);
    assert.match(rejected.error, /agent id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection validation: unmapped role, role outside the allowed pool, and multiplicity violations fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-invalid-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);

    const unmapped = beginCapability(root, { occurrences: [{ role: "qa" }] });
    assert.equal(unmapped.ok, false);
    if (unmapped.ok) return;
    assert.match(unmapped.error, /no live registered agent mapping: 'qa'/);

    const outside = beginCapability(root, { occurrences: [{ role: "architect" }] });
    assert.equal(outside.ok, false, "architect is registered but outside the exploration pool");
    if (outside.ok) return;
    assert.match(outside.error, /outside allowed_roles/);

    // wave-004 widened exploration multiplicity to three per role, so the
    // fail-closed bound now needs a fourth analyst (it exceeds both the
    // per-role maximum and the overall max_workers bound).
    const tooMany = beginCapability(root, { occurrences: [{ role: "analyst" }, { role: "analyst" }, { role: "analyst" }, { role: "analyst" }] });
    assert.equal(tooMany.ok, false);
    if (tooMany.ok) return;
    assert.match(tooMany.error, /exceeds multiplicity maximum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stage with no trusted live agent mapping fails closed; the no-selection default is deterministic", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-nomapping-"));
  try {
    initGit(root);
    writeFreshState(root);
    const blocked = beginCapability(root, { occurrences: [{ role: "analyst" }] });
    assert.equal(blocked.ok, false, "no begin without a trusted live mapping");
    if (blocked.ok) return;
    assert.match(blocked.error, /live registered agent mapping/);

    publishMapping(root);
    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "default selection works" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    assert.deepEqual(begun.handoff.expected_roster, [
      { role: "analyst", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
    ], "COMPLEX risk trigger extends the minimum analyst slot with the distinct researcher role");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the contract exposes a frozen selection only for the current stage and cursor epoch", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-stale-selection-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);
    const begun = beginCapability(root, { occurrences: [{ role: "analyst" }, { role: "tech-researcher" }] });
    assert.equal(begun.ok, true, begun.ok ? "begin accepted" : begun.error);
    if (!begun.ok) return;
    const frozen = frozenSelection(root);
    assert.ok(frozen, "selection is frozen in state");

    // A selection naming a different stage is stale data: masked. Both the
    // state mirror and the capability mirror carry the stale snapshot so the
    // contract gate — not a mirror conflict — is what masks it.
    const stageResolved = resolveState(root);
    assert.ok(stageResolved.state && stageResolved.statePath);
    const staleStageSelection = { ...frozen!, stage_id: "discovery" };
    writeStateBootstrap(root, {
      ...stageResolved.state,
      roster_selection: staleStageSelection,
      dispatch_capability: { ...stageResolved.state.dispatch_capability!, roster_selection: staleStageSelection },
    }, { target: stageResolved });
    const staleStage = resolveWorkflowContract(root);
    assert.equal(staleStage.stage.roster_selection, null, "a selection naming another stage is masked");
    assert.equal(staleStage.stage.dispatch.selection_id, null);
    assert.equal(staleStage.stage.dispatch.permitted, false, "a masked selection cannot satisfy the dispatch gate");
    assert.ok(staleStage.stage.provenance.control_plane.warnings.some((warning) => /stale roster_selection/.test(warning)), "the masking is reported as a warning");

    // A selection bound to a rotated cursor epoch is equally stale: masked.
    const epochResolved = resolveState(root);
    assert.ok(epochResolved.state && epochResolved.statePath);
    const staleEpochSelection = { ...frozen!, capability_epoch: "rotated-epoch" };
    writeStateBootstrap(root, {
      ...epochResolved.state,
      roster_selection: staleEpochSelection,
      dispatch_capability: { ...epochResolved.state.dispatch_capability!, roster_selection: staleEpochSelection },
    }, { target: epochResolved });
    const staleEpoch = resolveWorkflowContract(root);
    assert.equal(staleEpoch.stage.roster_selection, null, "a selection bound to a rotated epoch is masked");
    assert.equal(staleEpoch.stage.dispatch.permitted, false);

    // The current selection (own stage, live epoch) stays fully exposed.
    const restored = resolveState(root);
    assert.ok(restored.state && restored.statePath);
    writeStateBootstrap(root, {
      ...restored.state,
      roster_selection: frozen,
      dispatch_capability: { ...restored.state.dispatch_capability!, roster_selection: frozen },
    }, { target: restored });
    const current = resolveWorkflowContract(root);
    assert.equal(current.stage.roster_selection?.snapshot_id, frozen.snapshot_id, "the live selection is exposed");
    assert.equal(current.stage.dispatch.selection_id, frozen.snapshot_id);
    assert.equal(current.stage.dispatch.permitted, true, "a current selection satisfies the dispatch gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateAgentMappingState is the one trusted boundary: invariant violations fail with reasons", () => {
  const valid = buildAgentMapping({ roles: { analyst: "analyst" }, availableAgents: ["analyst"], genericFallbackRoles: ["analyst"] });
  assert.equal(validateAgentMappingState(valid).ok, true, "a builder-produced mapping validates");
  const base = {
    schema: 1 as const,
    generated_at: new Date().toISOString(),
    preferences_hash: "fixture-preferences",
  };
  // Ghost agent: resolved outside available_agents — the retired outer gate passed this.
  const ghost = validateAgentMappingState({
    ...base,
    available_agents: ["analyst"],
    resolved_roles: { analyst: "omp-ghost" },
    diagnostics: {},
    unresolved_roles: [],
  });
  assert.equal(ghost.ok, false, "a ghost agent fails the validator");
  if (!ghost.ok) assert.match(ghost.error, /resolved_roles\.analyst names agent 'omp-ghost' outside available_agents/);

  // Disjointness: a role cannot be unresolved and resolved at once.
  const disjoint = validateAgentMappingState({
    ...base,
    available_agents: ["analyst"],
    resolved_roles: { analyst: "analyst" },
    diagnostics: {},
    unresolved_roles: ["analyst"],
  });
  assert.equal(disjoint.ok, false);
  if (!disjoint.ok) assert.match(disjoint.error, /unresolved_roles names 'analyst' which resolved_roles also resolves/);

  // Diagnostics contradiction: an unresolved role cannot claim a live status.
  const contradicted = validateAgentMappingState({
    ...base,
    available_agents: ["analyst"],
    resolved_roles: {},
    diagnostics: { analyst: { requested: "analyst", candidates: ["analyst"], status: "preferred" } },
    unresolved_roles: ["analyst"],
  });
  assert.equal(contradicted.ok, false);
  if (!contradicted.ok) assert.match(contradicted.error, /unresolved role 'analyst' carries a 'preferred' diagnostic/);

  // The live inventory cannot contain duplicates.
  const duplicated = validateAgentMappingState({
    ...base,
    available_agents: ["analyst", "analyst"],
    resolved_roles: { analyst: "analyst" },
    diagnostics: {},
    unresolved_roles: [],
  });
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.match(duplicated.error, /available_agents must not contain duplicates/);

  // End to end: workflow_begin rejects the ghost handoff closed instead of
  // dispatching to an agent host discovery never returned.
  const root = mkdtempSync(join(tmpdir(), "roster-seam-ghost-begin-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);
    const ghostBegin = beginCapability(root, { occurrences: [{ role: "analyst" }] }, {
      trustedMapping: {
        ...base,
        available_agents: ["analyst"],
        resolved_roles: { analyst: "omp-ghost" },
        diagnostics: {},
        unresolved_roles: [],
      } as unknown as AgentMappingState,
    });
    assert.equal(ghostBegin.ok, false, "the ghost handoff fails the begin closed");
    if (!ghostBegin.ok) {
      assert.match(ghostBegin.error, /trusted agent mapping handoff is malformed/);
      assert.match(ghostBegin.error, /outside available_agents/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy state without a top-level cursor epoch masks any selection, whatever epoch it claims", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-seam-legacy-epoch-"));
  try {
    initGit(root);
    writeFreshState(root);
    publishMapping(root);
    const begun = beginCapability(root, { occurrences: [{ role: "analyst" }, { role: "tech-researcher" }] });
    assert.equal(begun.ok, true, begun.ok ? "begin accepted" : begun.error);
    if (!begun.ok || !begun.handoff) return;
    const capEpoch = begun.handoff.cursor_epoch;

    // Legacy shape: normalizePersistedState-era state whose top-level
    // cursor_epoch is absent. The selection keeps the current stage but
    // claims an arbitrary epoch — it must be masked.
    const arbitraryResolved = resolveState(root);
    assert.ok(arbitraryResolved.state && arbitraryResolved.statePath);
    const { cursor_epoch: _droppedEpoch, ...legacyState } = arbitraryResolved.state;
    assert.equal(legacyState.cursor_epoch, undefined, "fixture is the legacy shape without a top-level cursor epoch");
    const arbitrarySelection = { ...legacyState.roster_selection!, capability_epoch: "arbitrary-legacy-epoch" };
    writeStateBootstrap(root, {
      ...legacyState,
      roster_selection: arbitrarySelection,
      dispatch_capability: { ...legacyState.dispatch_capability!, roster_selection: arbitrarySelection },
    }, { target: arbitraryResolved });
    const arbitrary = resolveWorkflowContract(root);
    assert.equal(arbitrary.stage.roster_selection, null, "a current-stage selection without an authoritative epoch binding is masked");
    assert.equal(arbitrary.stage.dispatch.selection_id, null, "no stale selection id is exposed");
    assert.equal(arbitrary.stage.dispatch.permitted, false, "selectionReady stays false for a roster stage without an epoch binding");
    assert.ok(arbitrary.stage.provenance.control_plane.warnings.some((warning) => /stale roster_selection/.test(warning)), "the masking is reported as a warning");

    // Matching the capability-internal issued epoch is NOT authoritative:
    // only the top-level cursor epoch binds, so this stays masked too.
    const capBoundResolved = resolveState(root);
    assert.ok(capBoundResolved.state && capBoundResolved.statePath);
    const { cursor_epoch: _droppedCapEpoch, ...legacyState2 } = capBoundResolved.state;
    const capBoundSelection = { ...legacyState2.roster_selection!, capability_epoch: capEpoch };
    writeStateBootstrap(root, {
      ...legacyState2,
      roster_selection: capBoundSelection,
      dispatch_capability: { ...legacyState2.dispatch_capability!, roster_selection: capBoundSelection },
    }, { target: capBoundResolved });
    const capBound = resolveWorkflowContract(root);
    assert.equal(capBound.stage.roster_selection, null, "a capability-internal epoch never substitutes for the top-level cursor epoch");
    assert.equal(capBound.stage.dispatch.permitted, false);

    // Positive control: the modern shape (top-level epoch present and
    // matching) exposes the selection and satisfies the dispatch gate.
    const modernResolved = resolveState(root);
    assert.ok(modernResolved.state && modernResolved.statePath);
    const modernSelection = { ...modernResolved.state.roster_selection!, capability_epoch: capEpoch };
    writeStateBootstrap(root, {
      ...modernResolved.state,
      cursor_epoch: capEpoch,
      roster_selection: modernSelection,
      dispatch_capability: { ...modernResolved.state.dispatch_capability!, roster_selection: modernSelection },
    }, { target: modernResolved });
    const modern = resolveWorkflowContract(root);
    assert.equal(modern.stage.roster_selection?.capability_epoch, capEpoch, "the authoritative epoch binding exposes the selection");
    assert.equal(modern.stage.dispatch.selection_id, modern.stage.roster_selection?.snapshot_id);
    assert.equal(modern.stage.dispatch.permitted, true, "a live epoch binding satisfies selectionReady");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
