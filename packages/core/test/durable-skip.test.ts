/**
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 * WF-3: native skip_if blocker (durable advance).
 *
 * A native durable advance evaluates the next stage's `skip_if` with the
 * same fail-closed predicate evaluator the interpreter uses BEFORE arming a
 * capability. A stage whose skip_if holds is marked terminal `skipped` and
 * is never armed or counted as an expected dispatch; the first runnable
 * stage is armed atomically under the same advance token (or the workflow
 * completes when none remains). Malformed/unsupported expressions fail
 * closed.
 *
 * Coverage:
 *   - true next-stage skip_if: stage marked skipped, cursor jumps to the
 *     first runnable stage, capability/handoff bound to that stage, the
 *     skipped stage is not dispatchable and not counted as an expected
 *     dispatch;
 *   - consecutive skipped stages are all marked terminal `skipped` in one
 *     atomic advance (review_fixes + manual_qa shape), then the native walk
 *     runs the remaining stages to completion;
 *   - when every remaining stage is skipped the advance completes the
 *     workflow (no handoff, pause done, capability complete) — end-of-workflow
 *     behavior preserved;
 *   - false skip_if predicates arm the next stage exactly as before (scope
 *     flag and artifact-compare forms);
 *   - malformed (parse error) and unsupported (named predicate) skip
 *     expressions fail closed: advance errors and nothing is skipped, armed
 *     or marked done;
 *   - interpreter parity: run() skips the stage without dispatching a
 *     worker and completes the remaining stages through the same durable
 *     advance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowV2Fixture, qualifiedRoster, workIdentityScopeFixture, type WorkflowV2CapabilityContext, type WorkflowV2TestFixture } from "./workflow-v2-fixtures.js";
import type { IssuedCapability } from "../src/engine/durable.js";
import { createCapability, authorizeDispatch, completeDispatch, advanceCursor, type CapabilityHandoff } from "../src/engine/durable.js";
import { writeState, checkMonotonic } from "../src/engine/state.js";
import { buildDispatchMarker, dispatchGate } from "../src/gates/dispatch.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";

const NO_RUNTIME: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };
const WITH_RUNTIME: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function setup(
  branch: string,
  profile: Profile,
  currentStageId: string,
  kind: "none" | "single" | "consilium",
  roster: Array<{ role: string; agent: string }>,
  flags: ScopeFlags,
  preArtifacts: Record<string, unknown> = {},
  featureSlug = "skip",
): { issued: IssuedCapability; root: string; context: WorkflowV2CapabilityContext; fixture: WorkflowV2TestFixture } {
  const root = mkdtempSync(join(tmpdir(), `w3-skip-${branch}-`));
  initGit(root, branch);
  const fixture = workflowV2Fixture(profile);
  const persistedHash = fixture.profile_identity.fingerprint;
  const qualified = qualifiedRoster(fixture, roster);
  const work_identity_scope = workIdentityScopeFixture(fixture, {
    workflow: profile.name,
    stage_id: currentStageId,
    slot_id: roster[0]?.role ?? currentStageId,
  });
  const issued = createCapability({
    run_key: branch, branch, workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: currentStageId, kind, expected_roster: qualified,
    work_identity_scope,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
  });
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: profile.name },
    workflow: profile.name,
    task: "skip regression",
    workflow_override: false,
    issue: null,
    stage_cursor: currentStageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === currentStageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    profile_hash: fixture.profile_identity.fingerprint,
    work_identity: issued.work_identity,
    scope: flags,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug });
  const artifactsDir = join(root, ".work-state", "features", featureSlug, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(preArtifacts)) {
    writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value));
  }
  return {
    issued,
    root,
    fixture,
    context: {
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      catalog: fixture.catalog,
      effective_policy: fixture.effective_policy,
      agent_inventory: fixture.agent_inventory,
    },
  };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "skip", "state.json"), "utf8")) as TeamState;
}
function advanceAuth(issued: IssuedCapability) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    project_identity: issued.state.issued_for!.project_identity,
    run_identity: issued.state.issued_for!.run_identity,
  };
}

function dispatchAuth(handoff: CapabilityHandoff) {
  return {
    token: handoff.dispatch_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    project_identity: handoff.project_identity,
    run_identity: handoff.run_identity,
  };
}

const SKIP_PROFILE: Profile = {
  name: "skip-regression",
  title: "Skip regression",
  description: "discovery -> skipable manual_qa -> qa_tests -> summary",
  match: { type: ["FEATURE"] },
  stages: [
    { id: "discovery", title: "Discovery", type: "orchestrator" },
    { id: "manual_qa", title: "Manual QA", type: "single", role: "manual-qa", skip_if: "!scope.has_runtime" },
    { id: "qa_tests", title: "QA Tests", type: "single", role: "qa" },
    { id: "summary", title: "Summary", type: "orchestrator" },
  ],
};

const FULL_SKIP_PROFILE: Profile = {
  name: "skip-full-walk",
  title: "Skip full walk",
  description: "review_fixes + manual_qa consecutive skips before the runnable qa_tests",
  match: { type: ["FEATURE"] },
  stages: [
    { id: "discovery", title: "Discovery", type: "orchestrator" },
    { id: "review_fixes", title: "Review Fixes", type: "single", role: "dev", consumes: ["review"], skip_if: "review.findings == []" },
    { id: "manual_qa", title: "Manual QA", type: "single", role: "manual-qa", skip_if: "!scope.has_runtime" },
    { id: "qa_tests", title: "QA Tests", type: "single", role: "qa" },
    { id: "summary", title: "Summary", type: "orchestrator" },
  ],
};

const ALL_SKIP_PROFILE: Profile = {
  name: "skip-all-remaining",
  title: "Skip all remaining",
  description: "every remaining stage is skipped -> advance completes the workflow",
  match: { type: ["FEATURE"] },
  stages: [
    { id: "discovery", title: "Discovery", type: "orchestrator" },
    { id: "skip_a", title: "Skip A", type: "single", role: "dev", skip_if: "!scope.has_runtime" },
    { id: "skip_b", title: "Skip B", type: "single", role: "qa", skip_if: "!scope.has_runtime" },
  ],
};

test("WF-3: advance with a true next-stage skip_if skips it and atomically arms the next runnable stage", () => {
  const { issued, root, context } = setup("single", SKIP_PROFILE, "discovery", "none", [], NO_RUNTIME);
  try {
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "discovery completed" }, context);
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.handoff) return;
    const state = advanced.state;
    assert.equal(state.stage_cursor, "qa_tests", "cursor jumps over the skipped stage to the first runnable stage");
    assert.equal(state.stages.find((s) => s.id === "discovery")?.status, "done");
    assert.equal(state.stages.find((s) => s.id === "manual_qa")?.status, "skipped", "skip_if stage is terminal skipped");
    assert.equal(state.stages.find((s) => s.id === "qa_tests")?.status, "in_progress", "first runnable stage is armed in the same atomic update");
    assert.equal(state.stages.find((s) => s.id === "summary")?.status, "pending");
    assert.equal(advanced.handoff.stage_cursor, "qa_tests", "handoff is bound to the runnable stage, never the skipped one");
    assert.equal(state.dispatch_capability?.issued_for?.stage_cursor, "qa_tests");
    assert.equal(state.dispatch_capability?.status, "ready");
    assert.equal(state.dispatch_capability?.expected_count, 1, "the skipped stage is not counted as an expected dispatch");
    assert.deepEqual(state.dispatch_capability?.expected_roster?.map(({ role, agent }) => ({ role, agent })), [{ role: "qa", agent: "qa" }]);
    assert.ok(checkMonotonic(state).ok, "skipped statuses keep stage progress monotonic");
    assert.equal(state.join_summary?.stage_id, "discovery", "join history still records the advancing stage");

    // The skipped stage is not dispatchable through the armed capability.
    const manualQa = SKIP_PROFILE.stages[1]!;
    const marker = buildDispatchMarker(advanced.handoff.run_key, manualQa, undefined, "manual-qa", advanced.handoff.cursor_epoch);
    const blocked = dispatchGate({ toolName: "task", input: { tasks: [{ agent: "manual-qa", task: marker }] } }, { cwd: root, ...context });
    assert.ok(blocked, "a dispatch marker bound to the skipped stage is rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WF-3: consecutive skipped stages are all marked skipped; the native walk then runs the remaining stages to completion", () => {
  const { issued, root, context } = setup(
    "walk",
    FULL_SKIP_PROFILE,
    "discovery",
    "none",
    [],
    NO_RUNTIME,
    { review: { verdict: "approve", findings: [] } },
  );
  try {
    // review_fixes (review.findings == []) and manual_qa (!scope.has_runtime)
    // are both skipped in one atomic advance; qa_tests is armed.
    const advanced1 = advanceCursor(root, { ...advanceAuth(issued), evidence: "discovery completed" }, context);
    assert.equal(advanced1.ok, true);
    if (!advanced1.ok || !advanced1.handoff) return;
    assert.equal(advanced1.state.stage_cursor, "qa_tests");
    assert.equal(advanced1.state.stages.find((s) => s.id === "review_fixes")?.status, "skipped", "artifact-compare skip_if holds");
    assert.equal(advanced1.state.stages.find((s) => s.id === "manual_qa")?.status, "skipped", "scope-flag skip_if holds");
    assert.equal(advanced1.state.stages.find((s) => s.id === "qa_tests")?.status, "in_progress");

    // Dispatch and complete qa_tests, then advance to summary.
    const qaAuth = {
      ...dispatchAuth(advanced1.handoff),
      role: "qa",
      agent: "qa",
      agent_ref: context.effective_policy.roles.qa!,
    };
    const authorized = authorizeDispatch(root, qaAuth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const completed = completeDispatch(root, { ...qaAuth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "qa passed", artifact_ids: [] });
    assert.equal(completed.ok, true);
    const advanced2 = advanceCursor(root, { ...qaAuth, token: advanced1.handoff.advance_token, evidence: "qa completed" }, context);
    assert.equal(advanced2.ok, true);
    if (!advanced2.ok || !advanced2.handoff) return;
    assert.equal(advanced2.state.stage_cursor, "summary");
    assert.equal(advanced2.state.stages.find((s) => s.id === "qa_tests")?.status, "done");

    // Summary (orchestrator) advances to end-of-workflow.
    const advanced3 = advanceCursor(root, { ...dispatchAuth(advanced2.handoff), token: advanced2.handoff.advance_token, evidence: "summary completed" }, context);
    assert.equal(advanced3.ok, true);
    if (!advanced3.ok) return;
    assert.equal(advanced3.handoff, undefined, "no handoff when the workflow completes");
    const final = readState(root);
    assert.deepEqual(
      final.stages.map((s) => ({ id: s.id, status: s.status })),
      [
        { id: "discovery", status: "done" },
        { id: "review_fixes", status: "skipped" },
        { id: "manual_qa", status: "skipped" },
        { id: "qa_tests", status: "done" },
        { id: "summary", status: "done" },
      ],
    );
    assert.equal(final.pause.kind, "done", "end-of-workflow pause is preserved");
    assert.equal(final.dispatch_capability?.status, "complete");
    assert.ok(checkMonotonic(final).ok);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WF-3: advance completes the workflow when every remaining stage is skipped", () => {
  const { issued, root, context } = setup("allskip", ALL_SKIP_PROFILE, "discovery", "none", [], NO_RUNTIME);
  try {
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "discovery completed" }, context);
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.handoff, undefined, "nothing remains runnable: no capability is handed off");
    const state = advanced.state;
    assert.equal(state.stages.find((s) => s.id === "discovery")?.status, "done");
    assert.equal(state.stages.find((s) => s.id === "skip_a")?.status, "skipped");
    assert.equal(state.stages.find((s) => s.id === "skip_b")?.status, "skipped");
    assert.equal(state.pause.kind, "done", "end-of-workflow pause");
    assert.equal(state.dispatch_capability?.status, "complete");
    assert.equal(state.dispatch_capability?.expected_count, 0, "no skipped stage is counted as an expected dispatch");
    assert.ok(checkMonotonic(state).ok);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WF-3: a false skip_if predicate arms the next stage normally (scope-flag and artifact-compare forms)", () => {
  // Scope-flag form: has_runtime is true, so manual_qa is NOT skipped.
  const { issued, root, context } = setup("falseflag", SKIP_PROFILE, "discovery", "none", [], WITH_RUNTIME);
  try {
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "discovery completed" }, context);
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.handoff) return;
    assert.equal(advanced.handoff.stage_cursor, "manual_qa");
    assert.equal(advanced.state.stages.find((s) => s.id === "manual_qa")?.status, "in_progress", "false skip_if arms normally");
    assert.equal(advanced.state.stages.find((s) => s.id === "qa_tests")?.status, "pending");
    assert.equal(advanced.state.dispatch_capability?.issued_for?.stage_cursor, "manual_qa");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Artifact-compare form: non-empty findings, so review_fixes is NOT skipped.
  const { issued: issued2, root: root2, context: context2 } = setup(
    "falsefindings",
    FULL_SKIP_PROFILE,
    "discovery",
    "none",
    [],
    WITH_RUNTIME,
    { review: { verdict: "needs_changes", findings: [{ title: "x", severity: "HIGH", confidence: 90, zone: "backend-kotlin" }] } },
  );
  try {
    const advanced = advanceCursor(root2, { ...advanceAuth(issued2), evidence: "discovery completed" }, context2);
    assert.equal(advanced.ok, true);
    if (!advanced.ok || !advanced.handoff) return;
    assert.equal(advanced.handoff.stage_cursor, "review_fixes", "non-empty findings must not skip review_fixes");
    assert.equal(advanced.state.stages.find((s) => s.id === "review_fixes")?.status, "in_progress");
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

test("WF-3: skip_if evaluation failures fail closed — nothing is skipped, armed or marked done", () => {
  // The shipped `review.findings == []` expression fails closed when the
  // referenced artifact is missing at advance time (evaluation error), even
  // though the expression itself parses and registers.
  const { issued, root, context } = setup("evalfail", FULL_SKIP_PROFILE, "discovery", "none", [], WITH_RUNTIME);
  try {
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "discovery completed" }, context);
    assert.equal(advanced.ok, false, "an unevaluable skip_if blocks advance");
    if (advanced.ok) return;
    assert.match(advanced.error, /next stage 'review_fixes' skip_if evaluation failed: artifact 'review' referenced by expression is missing/);
    const persisted = readState(root);
    assert.equal(persisted.stages.find((s) => s.id === "discovery")?.status, "in_progress", "current stage is not marked done on failure");
    assert.equal(persisted.stages.find((s) => s.id === "review_fixes")?.status, "pending", "the unevaluable stage is neither skipped nor armed");
    assert.equal(persisted.dispatch_capability?.capability_id, issued.state.capability_id, "capability binding is untouched");
    assert.equal(persisted.stage_cursor, "discovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Unsupported named predicate: parses (so the profile registers) but the
  // skip evaluator has no named-gate resolver (same as the interpreter
  // path), so it fails closed at advance instead of silently running or
  // silently skipping.
  const unsupportedProfile: Profile = {
    name: "skip-unsupported",
    title: "Skip unsupported",
    description: "next stage has a named skip_if with no resolver",
    match: { type: ["FEATURE"] },
    stages: [
      { id: "discovery", title: "Discovery", type: "orchestrator" },
      { id: "named", title: "Named", type: "single", role: "dev", skip_if: "autonomous" },
    ],
  };
  const { issued: issued2, root: root2, context: context2 } = setup("unsupported", unsupportedProfile, "discovery", "none", [], WITH_RUNTIME);
  try {
    const advanced = advanceCursor(root2, { ...advanceAuth(issued2), evidence: "discovery completed" }, context2);
    assert.equal(advanced.ok, false, "unsupported skip_if blocks advance instead of silently running or skipping");
    if (advanced.ok) return;
    assert.match(advanced.error, /unsupported predicate 'autonomous'/);
    const persisted = readState(root2);
    assert.equal(persisted.stages.find((s) => s.id === "discovery")?.status, "in_progress");
    assert.equal(persisted.stages.find((s) => s.id === "named")?.status, "pending");
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});
test("WF-3: interpreter parity — run() skips the skip_if stage without dispatching it and completes through the durable advance", async () => {
  const branch = "interp-skip";
  const interpProfile: Profile = {
    name: "skip-interp",
    title: "Skip interp",
    description: "orchestrator -> skipped review_fixes -> qa_tests -> orchestrator summary",
    match: { type: ["FEATURE"] },
    stages: [
      { id: "discovery", title: "Discovery", type: "orchestrator" },
      { id: "review_fixes", title: "Review Fixes", type: "single", role: "dev", consumes: ["review"], skip_if: "review.findings == []" },
      { id: "qa_tests", title: "QA Tests", type: "single", role: "qa", produces: "qa_tests" },
      { id: "summary", title: "Summary", type: "orchestrator" },
    ],
  };
  const { root, fixture } = setup(branch, interpProfile, "discovery", "none", [], NO_RUNTIME, {}, branch);
  try {
    // The artifact the skip_if reads must exist when the walk evaluates it.
    const artifactsDir = join(root, ".work-state", "features", branch, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "review.json"), JSON.stringify({ verdict: "approve", findings: [] }));

    const dispatchedAgents: string[] = [];
    const taskTool: TaskCaller = {
      async call({ agent }) {
        dispatchedAgents.push(agent);
        return {
          id: "x",
          output: "ok",
          artifacts: agent === "qa" ? { qa_tests: { tests_added: [], build_status: "pass" } } : {},
          exitCode: 0,
        };
      },
      async batch() { return []; },
    };
    const result = await run({
      task: "interpreter skip",
      cwd: root,
      branch,
      autonomous: true,
      classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "skip-interp" },
      continuation: { feedback: "interpreter skip", stageId: "discovery" },
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      catalog: fixture.catalog,
      effective_policy: fixture.effective_policy,
      agent_inventory: fixture.agent_inventory,
      work_identity_scope: workIdentityScopeFixture(fixture, {
        workflow: "skip-interp",
        stage_id: "discovery",
        slot_id: "discovery",
      }),
      taskTool,
    });
    assert.equal(result.outcomes.some((o) => o.status === "failed"), false, "the run completes without failures");
    assert.deepEqual(
      result.outcomes.map((o) => ({ stageId: o.stageId, status: o.status })),
      [
        { stageId: "discovery", status: "done" },
        { stageId: "qa_tests", status: "done" },
        { stageId: "summary", status: "done" },
      ],
      "the interpreter only records stages it executed; the skipped stage is recorded durably in state",
    );
    assert.deepEqual(dispatchedAgents, ["qa"], "the skipped review_fixes stage is never dispatched");
    const final = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
    assert.equal(final.pause.kind, "done");
    assert.equal(final.stages.find((s) => s.id === "review_fixes")?.status, "skipped", "the durable state marks the skip_if stage skipped");
    assert.ok(checkMonotonic(final).ok);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
