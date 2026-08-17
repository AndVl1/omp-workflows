/**
 * br-eu6 regression tests: repeated semantic stage roles resolve to stable
 * unique dispatch slot identities, and `advanceCursor` atomically arms the
 * next stage's ready capability together with its `in_progress` cursor.
 *
 * Coverage:
 *   - full-feature `exploration` ([analyst, tech-researcher, analyst]) issues
 *     a valid consilium capability without "invalid capability roster" errors
 *   - both analyst occurrences are independently dispatchable, joinable and
 *     marker validation cannot collapse them
 *   - orchestrator -> consilium and single -> single transitions land on an
 *     executable `in_progress` stage with a `ready` capability (no ready
 *     capability is persisted while its stage cursor is pending)
 *   - unique-role rosters keep bare slot identities (unchanged behavior)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { resolveStageDispatchSlots, resolveStageDispatchRoles } from "../src/engine/stage.js";
import { createCapability, beginCapability, authorizeDispatch, completeDispatch, advanceCursor, recordCheckpointDecision } from "../src/engine/durable.js";
import { buildDispatchMarker, parseDispatchMarker, dispatchGate } from "../src/gates/dispatch.js";
import { writeState } from "../src/engine/state.js";
import type { ScopeFlags } from "../src/engine/scope.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

test("br-eu6: repeated analyst roles normalize to unique dispatch slots that both map to the analyst agent", () => {
  const profile = loadProfile("full-feature");
  assert.ok(profile, "full-feature profile must be available");
  const exploration = profile.stages.find((stage) => stage.id === "exploration");
  assert.ok(exploration, "full-feature exploration stage must exist");
  const ctx = { cwd: process.cwd(), flags: NO_SCOPE, resolveDevAgent: () => null as string | null };
  const slots = resolveStageDispatchSlots(exploration, ctx);
  assert.deepEqual(slots.map((slot) => slot.slot), ["analyst#1", "tech-researcher", "analyst#2"], "repeated roles get unique numbered slots");
  assert.deepEqual(slots.map((slot) => slot.role), ["analyst", "tech-researcher", "analyst"], "semantic roles are preserved");
  assert.equal(new Set(slots.map((slot) => slot.slot)).size, 3, "slot identities must not be deduplicated");
  // Unique-role profiles keep bare role names as slot identities.
  const architecture = profile.stages.find((stage) => stage.id === "architecture");
  assert.ok(architecture);
  const unique = resolveStageDispatchSlots(architecture, ctx);
  assert.deepEqual(unique.map((slot) => slot.slot), ["architect_minimal", "architect_clean", "architect_pragmatic"]);
  // The semantic roster view keeps the profile's declared duplicates.
  assert.deepEqual(resolveStageDispatchRoles(exploration, ctx), ["analyst", "tech-researcher", "analyst"]);
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

    const begun = beginCapability(root);
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

test("br-eu6: both analyst slots authorize and complete independently; orchestrator-to-consilium advance arms an executable in_progress stage", () => {
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
    const artifactsDir = join(root, ".work-state", "features", "repeat", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // Schema-valid discovery artifacts (task/branch required; feature_spec
    // requires goal/scope/acceptance_criteria).
    writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "repeat", branch: "feat/repeat", constraints: [] }));
    writeFileSync(join(artifactsDir, "feature_spec.json"), JSON.stringify({ goal: "goal", scope: [], acceptance_criteria: ["criterion"] }));

    // full-feature discovery declares a checkpoint; the durable advance
    // refuses to leave an unresolved checkpoint.
    const checkpoint = recordCheckpointDecision(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/repeat", branch: "feat/repeat", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "discovery", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "confirm_understanding", mode: "interactive", decision: "confirmed", actor: "user", rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, "checkpoint decision must record before advance");

    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/repeat", branch: "feat/repeat", workflow: "full-feature", profile_hash: persistedProfileHash,
      stage_cursor: "discovery", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      evidence: "discovery completed",
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.handoff) return;
    assert.equal(advanced.state.stage_cursor, "exploration");
    assert.equal(advanced.state.dispatch_capability?.status, "ready", "next capability is armed");
    assert.equal(advanced.state.stages.find((s) => s.id === "exploration")?.status, "in_progress", "ready capability must not be persisted while its stage cursor is pending");
    assert.deepEqual(advanced.handoff.expected_roster, [
      { role: "analyst#1", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
      { role: "analyst#2", agent: "analyst" },
    ]);

    const auth = {
      token: advanced.handoff.dispatch_token,
      capability_id: advanced.handoff.capability_id,
      run_key: advanced.handoff.run_key,
      branch: advanced.handoff.branch,
      workflow: advanced.handoff.workflow,
      profile_hash: advanced.handoff.profile_hash,
      stage_cursor: advanced.handoff.stage_cursor,
      cursor_epoch: advanced.handoff.cursor_epoch,
    };
    const a1 = authorizeDispatch(root, { ...auth, role: "analyst#1", agent: "analyst" });
    const a2 = authorizeDispatch(root, { ...auth, role: "analyst#2", agent: "analyst" });
    const tr = authorizeDispatch(root, { ...auth, role: "tech-researcher", agent: "tech-researcher" });
    assert.equal(a1.ok, true);
    assert.equal(a2.ok, true);
    assert.equal(tr.ok, true);
    if (!a1.ok || !a2.ok || !tr.ok || !a1.record || !a2.record || !tr.record) return;
    assert.notEqual(a1.record.id, a2.record.id, "each analyst occurrence gets its own dispatch record");
    assert.notEqual(a1.record.role, a2.record.role);
    assert.equal(a1.record.agent, "analyst");
    assert.equal(a2.record.agent, "analyst");

    const complete = (record: { id: string }, role: string, agent: string, artifactIds: string[] = []) =>
      completeDispatch(root, { ...auth, role, agent, dispatch_id: record.id, outcome: "succeeded", evidence: `${role} completed`, artifact_ids: artifactIds });
    // Multi-slot consilium fan-in: every slot writes slot-scoped artifacts
    // (<produce>-<slot>.json); the shared ids are synthesized deterministically
    // at advance. analyst#1 also contributes the dod.
    writeFileSync(join(artifactsDir, "exploration-analyst-1.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "analyst one" }));
    writeFileSync(join(artifactsDir, "exploration-tech-researcher.json"), JSON.stringify({ files_to_read: [{ path: "b.ts", why: "y" }], summary: "researcher" }));
    writeFileSync(join(artifactsDir, "exploration-analyst-2.json"), JSON.stringify({ files_to_read: [{ path: "c.ts", why: "z" }], summary: "analyst two" }));
    writeFileSync(join(artifactsDir, "dod-analyst-1.json"), JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] }));
    assert.equal(complete(a1.record, "analyst#1", "analyst", ["exploration-analyst-1", "dod-analyst-1"]).ok, true);
    assert.equal(complete(a2.record, "analyst#2", "analyst", ["exploration-analyst-2"]).ok, true);
    assert.equal(complete(tr.record, "tech-researcher", "tech-researcher", ["exploration-tech-researcher"]).ok, true);

    const advanced2 = advanceCursor(root, { ...auth, token: advanced.handoff.advance_token, evidence: "exploration completed" });
    assert.equal(advanced2.ok, true, "consilium with two analyst slots joins, synthesizes and advances");
    if (!advanced2.ok) return;
    assert.equal(advanced2.state.stage_cursor, "clarify");
    // Deterministic synthesis wrote the shared artifacts for downstream consumers.
    const sharedExploration = JSON.parse(readFileSync(join(artifactsDir, "exploration.json"), "utf8")) as { files_to_read: unknown[]; summary: string };
    assert.equal(sharedExploration.files_to_read.length, 3, "synthesis concatenates per-slot arrays in roster order");
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
    const checkpoint = recordCheckpointDecision(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "feat/single", branch: "feat/single", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: "approve_implementation", mode: "autonomous", decision: "proceed", actor: "orchestrator", rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true, "checkpoint decision must record before advance");

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
