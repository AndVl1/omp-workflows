/**
 * Durable checkpoint decisions and bounded loop re-entry (scopes 4-5):
 *   - interactive and routing-autonomy checkpoint attempts persist no
 *     authorization while unresolved checkpoints block advance;
 *   - only explicit typed, policy-bound decisions can unblock a checkpoint;
 *   - loops actually re-enter `back_to` with a fresh epoch/capability,
 *     append durable iteration history, respect `max_iterations`, and map
 *     exhaustion to needs_human/failed;
 *   - old loop epochs cannot authorize a re-entered iteration (stale token).
 */

import { test } from "node:test";
import { TEST_ON, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, unlinkSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { z as zod } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRetainedTestRegistrations, openTestRegistry, registerTestProfiles, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability, authorizeDispatch, completeDispatch, advanceCursor, recordCheckpointDecision } from "../src/engine/durable.js";
import { registerWorkflowTools } from "../src/index.js";
import { appendCheckpointDecision, checkpointAnswerBinding, nativeCheckpointPolicy, validateCheckpointDecision } from "../src/engine/checkpoints.js";
import { writeState } from "../src/engine/state.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function classification(workflow: string, autonomous: boolean): TeamState["classification"] {
  return { type: "BUG_FIX", complexity: "MEDIUM", confidence: "HIGH", autonomous, workflow: workflow as TeamState["classification"]["workflow"] };
}

function setupStage(
  root: string,
  branch: string,
  profile: Profile,
  stageId: string,
  kind: "single" | "consilium",
  roster: Array<{ role: string; agent: string }>,
): { issued: ReturnType<typeof createCapability>; artifactsDir: string } {
  const persistedHash = profileHash(profile);
  const issued = createCapability({
    run_key: branch, branch, workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: stageId, kind, expected_roster: roster,
  });
  // Preserve durable loop/checkpoint/fan-in state across stage transitions
  // (advanceCursor carries it forward; the test helper must not wipe it).
  const existingPath = join(root, ".work-state", "features", "loop", "state.json");
  let carried: Partial<Pick<TeamState, "loop_state" | "checkpoint_decisions" | "slot_artifacts" | "join_summary">> = {};
  try {
    const existing = JSON.parse(readFileSync(existingPath, "utf8")) as TeamState;
    carried = {
      ...(existing.loop_state ? { loop_state: existing.loop_state } : {}),
      ...(existing.checkpoint_decisions ? { checkpoint_decisions: existing.checkpoint_decisions } : {}),
      ...(existing.slot_artifacts ? { slot_artifacts: existing.slot_artifacts } : {}),
      ...(existing.join_summary ? { join_summary: existing.join_summary } : {}),
    };
  } catch {
    // first stage setup: nothing to carry
  }
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: classification(profile.name, false),
    task: "loop test",
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    ...carried,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "loop" });
  const artifactsDir = join(root, ".work-state", "features", "loop", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  return { issued, artifactsDir };
}

function authOf(issued: ReturnType<typeof createCapability>, role: string, agent: string) {
  return {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    role,
    agent,
  };
}

function advanceAuth(issued: ReturnType<typeof createCapability>) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
  };
}
function mountedAdvanceAuth(issued: ReturnType<typeof createCapability>) {
  const { token: _token, ...auth } = advanceAuth(issued);
  return { ...auth, advance_token: issued.advance_token };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "loop", "state.json"), "utf8")) as TeamState;
}

const CHECKPOINT_REGISTRATION_OWNER = "core-test-profile";

function checkpointFeatureId(root: string, state: TeamState): string {
  if (state.specification?.feature_id) return state.specification.feature_id;
  const featuresDir = join(root, ".work-state", "features");
  const candidates = readdirSync(featuresDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(candidates.length, 1, "checkpoint fixture must have exactly one prepared feature state");
  const feature = candidates[0]?.name;
  assert.ok(feature, "checkpoint fixture prepared feature state must have a directory name");
  if (!feature) throw new Error("checkpoint fixture prepared feature state is unavailable");
  return feature;
}

function closeCheckpointFixtures(root: string): void {
  mountedCheckpointAsks.delete(root);
  closeRetainedTestRegistrations(root);
}

type MountedCheckpointAsk = {
  execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }>;
};

const mountedCheckpointAsks = new Map<string, MountedCheckpointAsk>();

function mountedCheckpointAsk(root: string): MountedCheckpointAsk {
  const existing = mountedCheckpointAsks.get(root);
  if (existing) return existing;
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_tools"], CHECKPOINT_REGISTRATION_OWNER);
  const tools = new Map<string, MountedCheckpointAsk>();
  try {
    registerWorkflowTools({
      zod: { z: zod },
      on: TEST_ON,
      registerTool(tool: unknown) {
        const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
        tools.set(mounted.name, { execute: mounted.execute.bind(mounted) });
      },
    } as never, {
      owner: () => registration.owner,
      cwd: root,
      registrationToken: registration.token,
      resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd,
    });
    const ask = tools.get("workflow_checkpoint_ask_selected");
    assert.ok(ask, "mounted workflow checkpoint Ask must be available");
    if (!ask) throw new Error("mounted workflow checkpoint Ask is unavailable");
    registration.retain(true);
    mountedCheckpointAsks.set(root, ask);
    return ask;
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original mounted Ask failure */ }
    throw error;
  }
}

async function typedCheckpoint(root: string, stageId: string, checkpointId: string, advanceToken: string, decision = "proceed") {
  const state = readState(root);
  const policy = state.checkpoint_policy;
  const capability = state.dispatch_capability;
  assert.ok(policy, "checkpoint test state must carry a typed policy");
  assert.ok(capability?.capability_id && capability.issued_for, "checkpoint test state must carry capability binding");
  if (!capability?.capability_id || !capability.issued_for) throw new Error("checkpoint test capability binding is unavailable");
  const issuedFor = capability.issued_for;
  const featureId = checkpointFeatureId(root, state);
  assert.equal(stageId, issuedFor.stage_cursor, "checkpoint fixture stage must match the current capability");
  const rule = policy.rules[checkpointId];
  assert.ok(rule, `checkpoint test policy must define ${checkpointId}`);
  const feedback = decision === "request_changes" ? "Add the missing failure-path evidence." : undefined;
  const ask = mountedCheckpointAsk(root);
  TEST_SESSION_MANAGER.cwd = root;
  const askInput = {
    feature_id: featureId,
    advance_token: advanceToken,
    capability_id: capability.capability_id,
    run_key: issuedFor.run_key,
    branch: issuedFor.branch,
    workflow: issuedFor.workflow,
    profile_hash: issuedFor.profile_hash,
    stage_cursor: issuedFor.stage_cursor,
    cursor_epoch: issuedFor.cursor_epoch,
    checkpoint: checkpointId,
    checkpoint_id: checkpointId,
    checkpoint_kind: rule.kind,
    question: "Authorize the workflow scope fixture checkpoint",
  };
  const result = await ask.execute("scope-test", askInput, undefined, undefined, {
    cwd: root,
    sessionManager: TEST_SESSION_MANAGER,
    hasUI: true,
    ui: {
      askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
        const question = questions[0];
        if (!question) return undefined;
        return {
          kind: "submit" as const,
          results: [{
            id: question.id,
            question: question.question,
            header: question.header,
            options: question.options.map((option) => option.label),
            multi: false,
            selectedOptions: [decision],
            ...(feedback !== undefined ? { note: feedback } : {}),
          }],
        };
      },
    },
  });
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  const proof = (result.details.actor_provenance as { proof?: { answer_id?: string } } | undefined)?.proof;
  assert.ok(proof?.answer_id, "mounted checkpoint Ask must return trusted answer provenance");
  const after = readState(root);
  const answer = after.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === proof?.answer_id);
  assert.ok(answer, "mounted checkpoint Ask must persist the trusted answer");
  assert.equal(answer?.decision, decision);
  if (feedback !== undefined) assert.equal(answer?.feedback, feedback);
  const persisted = after.typed_checkpoint_decisions?.find((candidate) => candidate.actor.proof?.answer_id === proof?.answer_id);
  assert.ok(persisted, "mounted checkpoint Ask must persist the typed decision");
  if (!persisted) throw new Error("mounted checkpoint Ask did not persist a typed decision");
  return persisted;
}

async function persistTypedCheckpoint(root: string, stageId: string, checkpointId: string, advanceToken: string, decision = "proceed"): Promise<void> {
  await typedCheckpoint(root, stageId, checkpointId, advanceToken, decision);
}

const LOOP_PROFILE: Profile = {
  name: "loop-regression",
  title: "Loop regression",
  description: "debug-cycle shaped loop for durable re-entry tests",
  match: { type: ["OPS"] },
  stages: [
    { id: "diagnose", title: "Diagnose", type: "single", role: "diagnostics", produces: "diagnosis" },
    { id: "implementation", title: "Fix", type: "single", role: "dev", produces: "implementation" },
    {
      id: "verify",
      title: "Verify",
      type: "single",
      role: "manual-qa",
      consumes: ["diagnosis", "implementation"],
      produces: "debug",
      loop: { back_to: "diagnose", until: "verdict == PASS", max_iterations: 2, on_exhausted: "escalate_user" },
    },
    { id: "summary", title: "Summary", type: "orchestrator" },
  ],
};

function runSingleStage(
  root: string,
  profile: Profile,
  stageId: string,
  artifactIds: string[],
  writeArtifacts: (artifactsDir: string) => void,
): ReturnType<typeof createCapability> {
  const role = stageId === "diagnose" ? "diagnostics" : stageId === "implementation" ? "dev" : "manual-qa";
  const roster = [{ role, agent: role }];
  const { issued, artifactsDir } = setupStage(root, "feat/loop", profile, stageId, "single", roster);
  writeArtifacts(artifactsDir);
  const auth = authOf(issued, role, role);
  const authorized = authorizeDispatch(root, auth);
  assert.equal(authorized.ok, true, `authorize ${stageId}`);
  if (!authorized.ok || !authorized.record) throw new Error("authorize failed");
  const completed = completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: `${stageId} done`, artifact_ids: artifactIds });
  assert.equal(completed.ok, true, `complete ${stageId}`);
  if (!completed.ok) throw new Error(`complete failed: ${completed.error}`);
  return issued;
}

test("completion admission requires the exact stage.produces set before mutation", () => {
  const cases: Array<{ label: string; artifact_ids: string[] }> = [
    { label: "omission", artifact_ids: [] },
    { label: "extra", artifact_ids: ["diagnosis", "unexpected"] },
    { label: "duplicate", artifact_ids: ["diagnosis", "diagnosis"] },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `completion-contract-${item.label}-`));
    try {
      initGit(root, "feat/loop");
      writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
      const { issued, artifactsDir } = setupStage(root, "feat/loop", LOOP_PROFILE, "diagnose", "single", [{ role: "diagnostics", agent: "diagnostics" }]);
      writeFileSync(join(artifactsDir, "diagnosis.json"), JSON.stringify({ diagnosis: "valid" }));
      const auth = authOf(issued, "diagnostics", "diagnostics");
      const authorized = authorizeDispatch(root, auth);
      assert.equal(authorized.ok, true, `${item.label}: authorize`);
      if (!authorized.ok || !authorized.record) continue;
      const before = readState(root);
      const rejected = completeDispatch(root, {
        ...auth,
        dispatch_id: authorized.record.id,
        outcome: "succeeded",
        evidence: `${item.label} rejected`,
        artifact_ids: item.artifact_ids,
      });
      assert.equal(rejected.ok, false, `${item.label}: exact set must be rejected`);
      if (!rejected.ok) assert.match(rejected.error, /exactly match|duplicates/u);
      assert.deepEqual(readState(root), before, `${item.label}: rejected completion must not mutate durable state`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("completion replay revalidates exact persisted artifact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "completion-integrity-"));
  try {
    initGit(root, "feat/loop");
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
    const { issued, artifactsDir } = setupStage(root, "feat/loop", LOOP_PROFILE, "diagnose", "single", [{ role: "diagnostics", agent: "diagnostics" }]);
    const artifactPath = join(artifactsDir, "diagnosis.json");
    writeFileSync(artifactPath, JSON.stringify({ diagnosis: "valid" }));
    const auth = authOf(issued, "diagnostics", "diagnostics");
    const authorized = authorizeDispatch(root, auth);
    assert.ok(authorized.ok && authorized.record);
    if (!authorized.ok || !authorized.record) return;
    const completion = { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded" as const, evidence: "diagnosis complete", artifact_ids: ["diagnosis"] };
    const first = completeDispatch(root, completion);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    const replay = completeDispatch(root, completion);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    const beforeTamper = readState(root);
    writeFileSync(artifactPath, JSON.stringify({ diagnosis: "tampered" }));
    const rejected = completeDispatch(root, completion);
    assert.equal(rejected.ok, false, "changed completion bytes must fail closed");
    if (!rejected.ok) assert.match(rejected.error, /changed since completion|artifact reference/u);
    assert.deepEqual(readState(root), beforeTamper, "integrity rejection must not mutate durable state");
    writeFileSync(artifactPath, JSON.stringify({ diagnosis: "valid" }));
    unlinkSync(artifactPath);
    const deleted = completeDispatch(root, completion);
    assert.equal(deleted.ok, false, "deleted completion bytes must fail closed");
    writeFileSync(artifactPath, JSON.stringify({ diagnosis: "valid" }));
    const outsidePath = join(root, "outside.json");
    writeFileSync(outsidePath, JSON.stringify({ diagnosis: "outside" }));
    unlinkSync(artifactPath);
    symlinkSync(outsidePath, artifactPath);
    const symlinked = completeDispatch(root, completion);
    assert.equal(symlinked.ok, false, "symlinked completion bytes must fail closed");
    assert.deepEqual(readState(root), beforeTamper, "all integrity rejections must preserve durable state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: unresolved declared checkpoint blocks advance; an explicit typed decision unblocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-block-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued, artifactsDir } = setupStage(root, "feat/ck", profile, "implementation", "single", roster);
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
    const auth = authOf(issued, "${scope.dev_agent}", "developer-kotlin");
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done", artifact_ids: ["implementation"] }).ok, true);

    const blocked = advanceCursor(root, { ...advanceAuth(issued), evidence: "done" });
    assert.equal(blocked.ok, false, "unresolved checkpoint must block advance");
    if (!blocked.ok) {
      assert.match(blocked.error, /checkpoint 'approve_implementation' for stage 'implementation' is unresolved/);
      assert.equal(blocked.state.pause.kind, "user_checkpoint", "missing consent is resumable");
    }
    assert.equal((readState(root).typed_checkpoint_decisions ?? []).length, 0, "classification never creates consent");

    await persistTypedCheckpoint(root, "implementation", "approve_implementation", issued.advance_token);
    const recorded = readState(root);
    assert.equal(recorded.typed_checkpoint_decisions?.length, 1);
    assert.equal(recorded.checkpoint_decisions?.length, 1, "legacy record is only a typed mirror");
    assert.equal(recorded.checkpoint_decisions?.[0]?.mode, "interactive");
    assert.match(recorded.checkpoint_decisions?.[0]?.actor ?? "", /^user:terminal:workflow_checkpoint_ask_selected:checkpoint-answer-/u);
    assert.equal(recorded.checkpoint_decisions?.[0]?.decision, "proceed");
    assert.ok(recorded.checkpoint_decisions?.[0]?.decided_at);

    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "done" });
    assert.equal(advanced.ok, true, "typed decision unblocks advance");
  } finally {
    closeCheckpointFixtures(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("checkpoint: approve_stop records durably but advance completes the current stage without dispatching or handing off", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-stop-"));
  try {
    initGit(root, "feat/loop");
    const nativePolicy = nativeCheckpointPolicy("specification_phase_approval");
    const nativeRule = nativePolicy.rules.specification_phase_approval;
    const stopPolicy = {
      ...nativePolicy,
      hard_human: ["product_approval" as const],
      rules: {
        approve_diagnosis: {
          ...nativeRule,
          kind: "product_approval" as const,
        },
      },
    };
    const stopProfile: Profile = {
      ...LOOP_PROFILE,
      name: "approve-stop-regression",
      stages: LOOP_PROFILE.stages.map((stage) => stage.id === "diagnose"
        ? {
          ...stage,
          checkpoint: "approve_diagnosis",
          checkpoint_policy: stopPolicy,
        }
        : stage),
    };
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [stopProfile]);
    const profile = loadProfile("approve-stop-regression");
    assert.ok(profile);
    if (!profile) return;
    const issued = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "cause", explanation: "why" }));
    });

    await typedCheckpoint(root, "diagnose", "approve_diagnosis", issued.advance_token, "approve_stop");
    const recordedState = readState(root);
    assert.equal(recordedState.typed_checkpoint_decisions?.length, 1);
    assert.equal(recordedState.typed_checkpoint_decisions?.[0]?.decision, "approve_stop");

    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "stop approval" });
    assert.equal(advanced.ok, true, advanced.ok ? "approve_stop must finish the current workflow without advancing" : advanced.error);
    const stopped = readState(root);
    assert.equal(stopped.pause.kind, "done");
    assert.match(stopped.pause.reason, /stopped after checkpoint/u);
    assert.equal(stopped.stages.find((stage) => stage.id === "diagnose")?.status, "done");
    assert.equal(stopped.stages.find((stage) => stage.id === "implementation")?.status, "pending");
    assert.equal(stopped.dispatch_capability?.status, "complete");
    assert.deepEqual(stopped.dispatch_capability?.dispatches ?? [], []);
  } finally {
    closeCheckpointFixtures(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted checkpoint request_changes re-arms the current stage, then revised approval advances", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-revise-mounted-"));
  let registration: ReturnType<typeof openTestRegistry> | undefined;
  try {
    initGit(root, "feat/loop");
    const nativePolicy = nativeCheckpointPolicy("specification_phase_approval");
    const nativeRule = nativePolicy.rules.specification_phase_approval;
    const revisionPolicy = {
      ...nativePolicy,
      hard_human: ["product_approval" as const],
      rules: {
        approve_diagnosis: {
          ...nativeRule,
          kind: "product_approval" as const,
        },
      },
    };
    const profile: Profile = {
      ...LOOP_PROFILE,
      name: "mounted-revise-regression",
      stages: [
        {
          id: "diagnose",
          title: "Diagnose",
          type: "orchestrator",
          checkpoint: "approve_diagnosis",
          checkpoint_policy: revisionPolicy,
        },
        { id: "implementation", title: "Implementation", type: "orchestrator" },
      ],
    };
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [profile]);
    const loaded = loadProfile("mounted-revise-regression");
    assert.ok(loaded);
    if (!loaded) return;
    const { issued } = setupStage(root, "feat/loop", loaded, "diagnose", "none", []);
    writeTestRegistryMarker(root);
    registration = openTestRegistry(root, ["workflow_tools"], CHECKPOINT_REGISTRATION_OWNER);
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
    registerWorkflowTools({
      zod: { z: zod },
      on: TEST_ON,
      registerTool(tool: unknown) {
        const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
        tools.set(mounted.name, mounted);
      },
    } as never, {
      owner: () => registration!.owner,
      cwd: root,
      registrationToken: registration!.token,
      resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd,
    });
    registration!.retain(true);
    const checkpointAskTool = tools.get("workflow_checkpoint_ask_selected");
    const advanceTool = tools.get("workflow_advance");
    assert.ok(checkpointAskTool);
    assert.ok(advanceTool);
    if (!checkpointAskTool || !advanceTool) return;
    mountedCheckpointAsks.set(root, { execute: checkpointAskTool.execute.bind(checkpointAskTool) });

    await typedCheckpoint(root, "diagnose", "approve_diagnosis", issued.advance_token, "request_changes");

    const firstAdvance = await advanceTool.execute("test", { ...mountedAdvanceAuth(issued), evidence: "revision requested" }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(firstAdvance.details.ok, true, JSON.stringify(firstAdvance.details));
    assert.equal(firstAdvance.details.transition, "revision_required");
    assert.equal(firstAdvance.details.stage_cursor, "diagnose");
    assert.ok(firstAdvance.details.handoff);
    const revisedHandoff = firstAdvance.details.handoff as {
      capability_id: string;
      advance_token: string;
      run_key: string;
      branch: string;
      workflow: string;
      profile_hash: string;
      stage_cursor: string;
      cursor_epoch: string;
    };
    const revisedState = readState(root);
    assert.equal(revisedState.stages.find((stage) => stage.id === "diagnose")?.status, "in_progress");
    assert.equal(revisedState.stages.find((stage) => stage.id === "implementation")?.status, "pending");
    assert.equal(revisedState.dispatch_capability?.status, "ready");
    assert.equal(revisedState.typed_checkpoint_decisions?.at(-1)?.decision, "request_changes");

    await typedCheckpoint(root, "diagnose", "approve_diagnosis", revisedHandoff.advance_token, "approve_continue");
    const secondAdvance = await advanceTool.execute("test", {
      advance_token: revisedHandoff.advance_token,
      capability_id: revisedHandoff.capability_id,
      run_key: revisedHandoff.run_key,
      branch: revisedHandoff.branch,
      workflow: revisedHandoff.workflow,
      profile_hash: revisedHandoff.profile_hash,
      stage_cursor: revisedHandoff.stage_cursor,
      cursor_epoch: revisedHandoff.cursor_epoch,
      evidence: "revised approval",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(secondAdvance.details.ok, true, JSON.stringify(secondAdvance.details));
    assert.equal(secondAdvance.details.transition, "advance");
    assert.equal(secondAdvance.details.stage_cursor, "implementation");
    assert.equal(readState(root).stages.find((stage) => stage.id === "implementation")?.status, "in_progress");
  } finally {
    closeCheckpointFixtures(root);
    try { registration?.finish(false); } catch { /* preserve original mounted test failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});
test("checkpoint: hard-human authorization requires a durable answer proof, not a forgeable prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-provenance-"));
  try {
    initGit(root, "feat/ck-provenance");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued } = setupStage(root, "feat/ck-provenance", profile, "implementation", "single", roster);

    const valid = await typedCheckpoint(root, "implementation", "approve_implementation", issued.advance_token);
    const state = readState(root);
    const stage = { id: "implementation", checkpoint: "approve_implementation" };
    const accepted = validateCheckpointDecision(state, valid, { stage });
    assert.equal(accepted.ok, true, "the trusted ingest path creates a valid proof");

    for (const ref of ["user:fabricated", "terminal:also-forgeable", "escalation:also-forgeable"]) {
      const spoofed = { ...valid, actor: { kind: "user" as const, ref } };
      const rejected = validateCheckpointDecision(state, spoofed, { stage });
      assert.equal(rejected.ok, false, `bare ${ref} must not authorize`);
      if (!rejected.ok) assert.equal(rejected.code, "checkpoint_unverified");
    }
    const trustedRecord = state.trusted_checkpoint_answers?.[0];
    assert.ok(trustedRecord, "trusted ingest must persist an answer record before proof submission");
    const forgedRecord = {
      ...trustedRecord,
      answer_id: "caller-minted-answer",
      nonce: "caller-chosen-nonce",
      reference: "terminal-answer/caller-minted-answer",
      binding: "",
    };
    const forgedBinding = checkpointAnswerBinding(forgedRecord);
    const selfConsistentForgery = {
      ...valid,
      actor: {
        kind: "user" as const,
        ref: forgedRecord.reference,
        proof: {
          answer_id: forgedRecord.answer_id,
          nonce: forgedRecord.nonce,
          channel: forgedRecord.channel,
          reference: forgedRecord.reference,
          binding: forgedBinding,
        },
      },
    };
    const forged = validateCheckpointDecision(state, selfConsistentForgery, { stage });
    assert.equal(forged.ok, false, "a caller-computed binding without a durable answer record must not authorize");
    if (!forged.ok) assert.equal(forged.code, "checkpoint_unverified");


    const proof = valid.actor.proof!;
    const mismatches = [
      { ...valid, run_id: "stale-run" },
      { ...valid, capability_epoch: "stale-epoch" },
      { ...valid, policy_hash: "stale-policy" },
      { ...valid, decision: "reject" },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, nonce: "replayed-nonce" } } },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, binding: "forged-binding" } } },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, channel: "escalation" as const } } },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, reference: "terminal:wrong-reference" } } },
    ];
    for (const candidate of mismatches) {
      const rejected = validateCheckpointDecision(state, candidate, { stage });
      assert.equal(rejected.ok, false, "mismatched durable answer context must fail closed");
      if (!rejected.ok) assert.equal(rejected.code, "checkpoint_unverified");
    }

    const persisted = appendCheckpointDecision(state, valid);
    assert.equal(persisted.typed_checkpoint_decisions?.length, 1);
    assert.equal(persisted.trusted_checkpoint_answers?.[0]?.consumed_at !== undefined, true, "answer consumption is durable");
    assert.deepEqual(persisted.artifacts, state.artifacts, "checkpoint authorization does not overwrite artifacts");
    assert.equal(validateCheckpointDecision(persisted, valid, { stage }).ok, true, "exact replay is idempotent");
    assert.throws(
      () => appendCheckpointDecision(persisted, { ...valid, decision: "reject" }),
      /checkpoint_unverified|migration_conflict/,
      "a replayed answer cannot authorize a different decision",
    );
  } finally {
    closeCheckpointFixtures(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test("checkpoint: routing autonomy stays orthogonal to profile consent; migration conflicts fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-policy-orthogonal-"));
  try {
    initGit(root, "feat/ck-policy");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued, artifactsDir } = setupStage(root, "feat/ck-policy", profile, "implementation", "single", roster);
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
    const auth = authOf(issued, "${scope.dev_agent}", "developer-kotlin");
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done", artifact_ids: ["implementation"] }).ok, true);

    const profileState = readState(root);
    assert.equal(profileState.checkpoint_policy?.source, "profile");
    writeState(root, { ...profileState, classification: { ...profileState.classification, autonomous: true } }, { featureSlug: checkpointFeatureId(root, profileState) });
    await persistTypedCheckpoint(root, "implementation", "approve_implementation", issued.advance_token);
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "typed human consent" });
    assert.equal(advanced.ok, true, "routing autonomous=true must not conflict with a profile-source human policy");

    const migrationRoot = mkdtempSync(join(tmpdir(), "ck-policy-migration-conflict-"));
    try {
      initGit(migrationRoot, "feat/ck-policy-migration");
      const migrationSetup = setupStage(migrationRoot, "feat/ck-policy-migration", profile, "implementation", "single", roster);
      const typed = await typedCheckpoint(migrationRoot, "implementation", "approve_implementation", migrationSetup.issued.advance_token);
      const approvedState = readState(migrationRoot);
      const basePolicy = approvedState.checkpoint_policy!;
      const migrationPolicy = {
        ...basePolicy,
        default: "autonomous_allowed" as const,
        source: "migration" as const,
        rules: {
          ...basePolicy.rules,
          approve_implementation: { ...basePolicy.rules.approve_implementation!, default: "autonomous_allowed" as const },
        },
      };
      const conflictingState = {
        ...approvedState,
        classification: { ...approvedState.classification, autonomous: false },
        checkpoint_policy: migrationPolicy,
      };
      writeState(migrationRoot, conflictingState, { featureSlug: checkpointFeatureId(migrationRoot, approvedState) });
      const conflict = validateCheckpointDecision(readState(migrationRoot), typed, {
        stage: { id: "implementation", checkpoint: "approve_implementation", checkpoint_policy: migrationPolicy },
        policy: migrationPolicy,
      });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.code, "migration_conflict");
    } finally {
      closeCheckpointFixtures(migrationRoot);
      rmSync(migrationRoot, { recursive: true, force: true });
    }
  } finally {
    closeCheckpointFixtures(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: typed recording is idempotent; conflicting decisions fail and wrong names fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-replace-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued } = setupStage(root, "feat/ck", profile, "implementation", "single", roster);
    const typed = await typedCheckpoint(root, "implementation", "approve_implementation", issued.advance_token);
    writeState(root, appendCheckpointDecision(readState(root), typed), { featureSlug: checkpointFeatureId(root, readState(root)) });
    writeState(root, appendCheckpointDecision(readState(root), typed), { featureSlug: checkpointFeatureId(root, readState(root)) });
    const decisions = readState(root);
    assert.equal(decisions.typed_checkpoint_decisions?.length, 1, "identical typed decision is idempotent");
    assert.equal(decisions.checkpoint_decisions?.length, 1, "typed mirror remains singular");
    assert.throws(
      () => appendCheckpointDecision(readState(root), { ...typed, rationale: "conflicting answer" }),
      /migration_conflict/,
      "a second answer cannot replace an existing checkpoint decision",
    );
    const wrongName = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "bogus", mode: "interactive", decision: "x", actor: "user", rationale: "r" });
    assert.equal(wrongName.ok, false);
    if (!wrongName.ok) assert.match(wrongName.error, /typed checkpoint authorization and actor provenance/);
  } finally {
    closeCheckpointFixtures(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test("loop: FAIL until re-enters back_to with a fresh capability and durable history; stale epoch cannot authorize", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-reenter-"));
  try {
    initGit(root, "feat/loop");
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    const verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "cause", explanation: "why" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });

    const advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "verify FAIL" });
    assert.equal(advanced.ok, true, "FAIL until re-enters the loop");
    if (!advanced.ok) return;
    const state = advanced.state;
    assert.equal(state.stage_cursor, "diagnose", "cursor re-enters back_to");
    assert.equal(state.stages.find((s) => s.id === "verify")?.status, "done");
    assert.equal(state.stages.find((s) => s.id === "diagnose")?.status, "in_progress");
    assert.equal(state.dispatch_capability?.status, "ready", "re-entry arms a fresh ready capability");
    assert.equal(state.dispatch_capability?.kind, "single");
    assert.deepEqual(state.dispatch_capability?.expected_roster, [{ role: "diagnostics", agent: "diagnostics" }]);
    assert.equal(state.loop_state?.reentries, 1);
    assert.equal(state.loop_state?.status, "running");
    assert.equal(state.loop_state?.history.length, 1);
    assert.equal(state.loop_state?.history[0]!.iteration, 1);
    assert.equal(state.loop_state?.history[0]!.from_epoch, verify.state.issued_for!.cursor_epoch);
    assert.equal(state.loop_state?.history[0]!.to_epoch, state.cursor_epoch);
    assert.notEqual(state.cursor_epoch, verify.state.issued_for!.cursor_epoch, "fresh cursor epoch per iteration");

    // The old verify-epoch token must not authorize anything after re-entry.
    const stale = advanceCursor(root, { ...advanceAuth(verify), evidence: "stale" });
    assert.equal(stale.ok, false, "old loop epoch cannot authorize a re-entered iteration");
    if (!stale.ok) assert.match(stale.error, /capability identity mismatch|capability binding mismatch|invalid secret|stale cursor binding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: full debug cycle re-enters twice, then exhausts to needs_human", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-exhaust-"));
  try {
    initGit(root, "feat/loop");
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    // Iteration 1: verify FAIL -> re-enter diagnose (reentries 1).
    let verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c1", explanation: "e1" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 1" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;

    // Iteration 2: diagnose -> implementation -> verify FAIL -> re-enter (reentries 2).
    const diagnose = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c2", explanation: "e2" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c2", explanation: "e2" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 2" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.reentries, 2, "second re-entry recorded");

    // Iteration 3: diagnose -> implementation -> verify FAIL -> exhausted (max_iterations=2).
    const diagnose3 = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c3", explanation: "e3" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose3), evidence: "diagnose 3" }).ok, true);
    const implementation3 = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation3), evidence: "fix 3" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c3", explanation: "e3" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 3 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 3" });
    assert.equal(advanced.ok, true, "exhaustion is a durable transition");
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.status, "exhausted");
    assert.equal(advanced.state.loop_state?.outcome, "needs_human", "escalate_user maps to needs_human");
    assert.equal(advanced.state.pause.kind, "needs_human");
    assert.equal(advanced.state.dispatch_capability?.status, "complete", "no ready capability after exhaustion");
    assert.equal(advanced.state.stage_cursor, "verify");
    assert.equal(advanced.handoff, undefined, "no handoff after exhaustion");
    assert.equal(advanced.state.loop_state?.history.length, 2, "durable iteration history preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: until PASS exits the loop and advances normally; on_exhausted failed maps to failed pause", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-pass-"));
  try {
    initGit(root, "feat/loop");
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    // First FAIL -> re-enter.
    let verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "diagnose");

    // Second verify with PASS -> loop complete, advance to summary.
    const diagnose = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "PASS", iterations: 2 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "PASS" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.status, "complete", "PASS marks the loop complete");
    assert.equal(advanced.state.stage_cursor, "summary", "loop exits to the next stage");
    assert.equal(advanced.state.dispatch_capability?.status, "ready");

    // on_exhausted: "failed" maps to a failed pause after max_iterations=1.
    const failProfile: Profile = {
      ...LOOP_PROFILE,
      name: "loop-fail-regression",
      stages: LOOP_PROFILE.stages.map((s) => s.id === "verify" ? { ...s, loop: { ...s.loop!, on_exhausted: "failed", max_iterations: 1 } } : s),
    };
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [failProfile]);
    const failP = loadProfile("loop-fail-regression");
    assert.ok(failP);
    const verifyF = runSingleStage(root, failP, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    const firstFail = advanceCursor(root, { ...advanceAuth(verifyF), evidence: "FAIL" });
    assert.equal(firstFail.ok, true);
    if (!firstFail.ok) return;
    assert.equal(firstFail.state.loop_state?.reentries, 1, "max_iterations=1 allows one re-entry");
    const diagnoseF = runSingleStage(root, failP, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnoseF), evidence: "d" }).ok, true);
    const implF = runSingleStage(root, failP, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implF), evidence: "i" }).ok, true);
    const verifyF2 = runSingleStage(root, failP, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"] }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
    });
    const exhausted = advanceCursor(root, { ...advanceAuth(verifyF2), evidence: "FAIL 2" });
    assert.equal(exhausted.ok, true);
    if (!exhausted.ok) return;
    assert.equal(exhausted.state.pause.kind, "failed", "on_exhausted=failed maps to a failed pause");
    assert.equal(exhausted.state.loop_state?.outcome, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advance: durable boundary rejects oversized or line-active authorization input without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "advance-bounds-"));
  try {
    initGit(root, "feat/loop");
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);
    if (!profile) return;
    const { issued } = setupStage(root, "feat/loop", profile, "diagnose", "single", [{ role: "diagnostics", agent: "diagnostics" }]);
    const base = { ...advanceAuth(issued), feature_id: "loop", evidence: "bounded evidence" };
    const attempts = [
      { label: "UTF-8 oversized evidence", input: { ...base, evidence: "é".repeat(4097) } },
      { label: "line-active evidence", input: { ...base, evidence: "line one\nline two" } },
      { label: "oversized advance token", input: { ...base, token: "x".repeat(4097) } },
      { label: "oversized capability selector", input: { ...base, capability_id: "x".repeat(4097) } },
    ];
    for (const attempt of attempts) {
      const before = readState(root);
      const rejected = advanceCursor(root, attempt.input);
      assert.equal(rejected.ok, false, `${attempt.label} must fail closed`);
      if (!rejected.ok) assert.match(rejected.error, /bounded|line-inert|evidence|authorization/i, attempt.label);
      assert.deepEqual(readState(root), before, `${attempt.label} must not mutate durable state`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: interpreter never auto-records from routing autonomy; unresolved consent pauses", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-interp-"));
  const branch = "feat/interp";
  try {
    initGit(root, branch);
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);
    const checkpointProfile: Profile = {
      ...LOOP_PROFILE,
      name: "interp-checkpoint",
      stages: LOOP_PROFILE.stages.map((s) => s.id === "diagnose" ? { ...s, checkpoint: "approve_diagnosis" } : s),
    };
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [checkpointProfile]);

    const interactive: TaskCaller = {
      async call(args) {
        const stageId = args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
        return { id: stageId, output: "ok", artifacts: stageId === "diagnose" ? { diagnosis: { root_cause: "c", explanation: "e" } } : {}, exitCode: 0 };
      },
      async batch() { return []; },
    };
    const interactiveResult = await run({
      task: "interactive checkpoint",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "interp-checkpoint" },
      taskTool: interactive,
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed" && /checkpoint 'approve_diagnosis'/.test(o.note)),
      "interactive unresolved checkpoint blocks advance",
    );
    const interactiveState = JSON.parse(readFileSync(interactiveResult.statePath!, "utf8")) as TeamState;
    assert.equal(interactiveState.pause.kind, "user_checkpoint");
    assert.equal(interactiveState.typed_checkpoint_decisions?.length ?? 0, 0);
    assert.equal(interactiveState.checkpoint_decisions?.length ?? 0, 0);

    // Routing autonomy is not authorization: no auto decision is recorded and
    // no later stage runs until a trusted typed decision is supplied.
    const root2 = mkdtempSync(join(tmpdir(), "ck-interp-auto-"));
    try {
      initGit(root2, branch);
      let verifyRuns = 0;
      const autonomous: TaskCaller = {
        async call(args) {
          const stageId = args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
          if (stageId === "diagnose") return { id: "d", output: "ok", artifacts: { diagnosis: { root_cause: "c", explanation: "e" } }, exitCode: 0 };
          if (stageId === "implementation") return { id: "i", output: "ok", artifacts: { implementation: { files_touched: ["x"] } }, exitCode: 0 };
          if (stageId === "verify") {
            verifyRuns += 1;
            return { id: "v", output: "ok", artifacts: { debug: { verdict: verifyRuns === 1 ? "FAIL" : "PASS", iterations: verifyRuns } }, exitCode: 0 };
          }
          return { id: stageId, output: "ok", artifacts: {}, exitCode: 0 };
        },
        async batch() { return []; },
      };
      const autoResult = await run({
        task: "autonomous checkpoint",
        cwd: root2,
        branch,
        autonomous: true,
        classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "interp-checkpoint" },
        taskTool: autonomous,
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), true, "routing autonomy cannot auto-proceed");
      const state = JSON.parse(readFileSync(autoResult.statePath!, "utf8")) as TeamState;
      assert.equal(state.pause.kind, "user_checkpoint");
      assert.equal(state.typed_checkpoint_decisions?.length ?? 0, 0);
      assert.equal(state.checkpoint_decisions?.length ?? 0, 0);
      assert.equal(state.stages.find((s) => s.id === "implementation")?.status, "pending");
      assert.equal(verifyRuns, 0);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: interpreter enforces declared checkpoints on orchestrator/bash/none stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-interp-alltypes-"));
  const branch = "feat/interp-all";
  try {
    initGit(root, branch);
    const allTypesProfile: Profile = {
      name: "interp-checkpoint-all-types",
      title: "All stage types with an orchestrator checkpoint",
      description: "orchestrator (checkpoint) -> bash -> none",
      match: { type: ["FEATURE"] },
      stages: [
        {
          id: "discovery",
          title: "Discovery",
          type: "orchestrator",
          checkpoint: "confirm_understanding",
          autonomous: "log confirmed understanding, continue",
        },
        { id: "hooks", title: "Hooks", type: "bash", command: "true" },
        { id: "noop", title: "Noop", type: "none" },
      ],
    };
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [allTypesProfile]);
    const taskTool: TaskCaller = {
      async call() { return { id: "x", output: "ok", artifacts: {}, exitCode: 0 }; },
      async batch() { return []; },
    };
    const baseClassification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const };

    // Interactive: the orchestrator's declared checkpoint blocks advance and
    // no later stage can run while it is unresolved.
    const interactiveResult = await run({
      task: "interactive all-types",
      cwd: root,
      branch,
      autonomous: false,
      classification: { ...baseClassification, autonomous: false, workflow: "interp-checkpoint-all-types" },
      taskTool,
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed" && /checkpoint 'confirm_understanding' for stage 'discovery' is unresolved/.test(o.note)),
      "interactive orchestrator checkpoint blocks advance",
    );
    const interactiveState = JSON.parse(readFileSync(interactiveResult.statePath!, "utf8")) as TeamState;
    assert.equal(interactiveState.pause.kind, "user_checkpoint");
    assert.equal(interactiveState.stages.find((s) => s.id === "discovery")?.status, "in_progress");
    assert.equal(interactiveState.stages.find((s) => s.id === "hooks")?.status, "pending", "later stages never run while the checkpoint is unresolved");
    assert.equal(interactiveState.stages.find((s) => s.id === "noop")?.status, "pending");

    // Routing autonomy still cannot authorize the orchestrator checkpoint:
    // every later stage remains pending until a trusted typed decision arrives.
    const root2 = mkdtempSync(join(tmpdir(), "ck-interp-alltypes-auto-"));
    try {
      initGit(root2, branch);
      const autoResult = await run({
        task: "autonomous all-types",
        cwd: root2,
        branch,
        autonomous: true,
        classification: { ...baseClassification, autonomous: true, workflow: "interp-checkpoint-all-types" },
        taskTool,
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), true, "autonomous routing cannot auto-proceed");
      const autoState = JSON.parse(readFileSync(autoResult.statePath!, "utf8")) as TeamState;
      assert.equal(autoState.pause.kind, "user_checkpoint");
      assert.equal(autoState.typed_checkpoint_decisions?.length ?? 0, 0);
      assert.equal(autoState.checkpoint_decisions?.length ?? 0, 0);
      assert.equal(autoState.stages.find((s) => s.id === "discovery")?.status, "in_progress");
      assert.equal(autoState.stages.find((s) => s.id === "hooks")?.status, "pending");
      assert.equal(autoState.stages.find((s) => s.id === "noop")?.status, "pending");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
