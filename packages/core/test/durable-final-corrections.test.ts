/**
 * Final-correction regressions for the durable control plane (br-zps final
 * review closure):
 *
 *   - optional control-plane mirrors are omitted/deleted, never own
 *     undefined: no-checkpoint begin, checkpoint -> orchestrator advance and
 *     loop re-entry into an orchestrator stage all persist cleanly;
 *   - every durable mutation runs as ONE lock + fresh-read + revision/raw-
 *     hash CAS transaction with authentication inside it, proven across a
 *     real second OS process (lock serialization, fresh-read preservation of
 *     a concurrent field, and a CAS conflict against a real lockless
 *     writer);
 *   - the transaction result carries the exact normalized/stamped state;
 *   - historical product approval survives capability rotation
 *     (product_approval -> product_handoff gate) while current-scope checks
 *     stay strict;
 *   - a stale prior-stage policy mirror can neither conflict a stage rebind
 *     nor dress the contract;
 *   - modern authorizing calls require the loop-iteration binding;
 *   - the workflow contract exposes only the current scoped declaration and
 *     decision; legacy readable-but-nonauthorizing decisions stay readable;
 *   - partial capabilities yield structured rejections through public
 *     durable paths (never TypeError);
 *   - exact decision/rationale text is preserved (trim decides emptiness
 *     only);
 *   - status is coherent after a resolved pause/provider wait.
 *
 * NOTE on real time: the two cross-process tests synchronize with a SECOND
 * OS process on the platform clock; deterministic fake timers cannot drive
 * another process, so bounded spin-waits on observable file state are used
 * (never fixed sleeps without observation).
 */

import { test } from "node:test";
import { createHash } from "node:crypto";

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  advanceCursor as rawAdvanceCursor,
  appendChildJoin as rawAppendChildJoin,
  authorizeDispatch as rawAuthorizeDispatch,
  beginCapability as rawBeginCapability,
  completeDispatch as rawCompleteDispatch,
  createCapability,
  materializeMigratedDispatches,
  persistPendingDispatch,
  reconcileTaskResult as rawReconcileTaskResult,
  recordCheckpointDecision as rawRecordCheckpointDecision,
  validateCheckpointAsk,
  type CapabilityHandoff,
  type DispatchAuth,
  type IssuedCapability,
} from "../src/engine/durable.js";
import {
  checkpointPolicyHash,
  recordTrustedCheckpointAnswer,
  resolveCheckpointDeclaration,
  validateCheckpointForAdvance,
  type TrustedCheckpointAnswerIngest,
} from "../src/engine/checkpoints.js";
import { loadProfile, profileHash, registerWorkflowProfiles } from "../src/engine/profile.js";
import { normalizePersistedState, setStageStatus, setStateTransactionTestHooks, updateStateAtomically, writeStateMd, type StateMutation } from "../src/engine/state.js";
import { readArtifact, writeArtifact } from "../src/engine/artifacts.js";
import { flushRecorder } from "../src/observability/hooks.js";
import { resolveWorkflowContract as rawResolveWorkflowContract } from "../src/engine/workflow-contract.js";
import {
  candidateForState,
  persistCanonicalRun,
  readRunControl,
  readRunState,
  resumeCanonicalRun,
  runTarget,
  terminalControlPublication,
  updateCanonicalRun,
  updateRunControl,
} from "../src/engine/run-store.js";
import { lifecyclePayloadHash, LifecycleError } from "../src/engine/run-lifecycle.js";
import type { CheckpointAnswerProof, CheckpointPolicy, LifecycleRequest, PrepareRequestReceipt, Profile, TeamState, TrustedExecutionContext } from "../src/engine/types.js";
function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

const RUN_ID = "88888888-8888-4888-8888-888888888888";

function runPath(root: string): string {
  return join(root, ".work-state", "runs", RUN_ID);
}
function statePathOf(root: string, _slug: string): string {
  return runTarget(root, RUN_ID).statePath!;
}
function readState(root: string, _slug: string): TeamState {
  const statePath = statePathOf(root, _slug);
  return JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
}
function writeArtifacts(root: string, _slug: string, artifacts: Record<string, unknown>): void {
  const artifactsDir = runTarget(root, RUN_ID).artifactsDir!;
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(artifacts)) {
    writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value));
  }
}
function writeCanonicalState(root: string, state: TeamState): void {
  const target = runTarget(root, RUN_ID);
  const persisted = { ...state, state_revision: state.state_revision ?? 1 };
  mkdirSync(target.stateDir!, { recursive: true });
  writeFileSync(target.statePath!, `${JSON.stringify(persisted, null, 2)}\n`);
  writeStateMd(target.stateDir!, persisted);
}
function canonicalTarget(root: string) {
  return runTarget(root, RUN_ID);
}
function migrationProofFixture(
  root: string,
  stageId: string,
  canonicalSlots: Array<{ dispatch_id: string; role: string; agent: string; slot_id?: string; task_id?: string; artifact_ids: string[] }> | undefined,
) {
  const migrationId = "migration-final-proof";
  const sourceId = "feature:legacy-proof";
  const sourceHash = "legacy-source-hash";
  const completedAt = "2026-09-20T00:00:00.000Z";
  const legacyState = {
    schema: 1,
    run_key: "legacy",
    branch: "main",
    stage_cursor: stageId,
    dispatch_capability: {
      status: "complete",
      dispatches: [
        { id: "legacy-dev", role: "dev", agent: "legacy-dev", status: "succeeded", completed_at: completedAt, completion: { outcome: "succeeded", artifact_ids: [], completed_at: completedAt } },
        { id: "legacy-qa", role: "qa", agent: "legacy-qa", status: "succeeded", completed_at: completedAt, completion: { outcome: "succeeded", artifact_ids: [], completed_at: completedAt } },
      ],
    },
  };
  const legacyBytes = Buffer.from(`${JSON.stringify(legacyState)}\n`);
  const stateSha256 = createHash("sha256").update(legacyBytes).digest("hex");
  const revisionRoot = join(runPath(root), "revisions", migrationId);
  mkdirSync(revisionRoot, { recursive: true });
  writeFileSync(join(revisionRoot, "state.json"), legacyBytes);
  writeFileSync(join(revisionRoot, "succeeded-slots.json"), JSON.stringify({ source_id: sourceId, source_hash: sourceHash, slots: [
    { dispatch_id: "legacy-dev", role: "dev", agent: "legacy-dev", slot_id: "dev", artifact_ids: [] },
    { dispatch_id: "legacy-qa", role: "qa", agent: "legacy-qa", slot_id: "qa", artifact_ids: [] },
  ] }) + "\n");
  writeFileSync(join(revisionRoot, "manifest.json"), JSON.stringify({
    source_id: sourceId,
    source_hash: sourceHash,
    state_sha256: stateSha256,
    files: [],
  }) + "\n");
  writeFileSync(join(runPath(root), "migration-receipt.json"), JSON.stringify({
    migration_id: migrationId,
    source_id: sourceId,
    source_hash: sourceHash,
    state_sha256: stateSha256,
    file_manifest: [],
    run_id: RUN_ID,
    status: "published",
    succeeded_slots: [
      { dispatch_id: "legacy-dev", role: "dev", agent: "legacy-dev", slot_id: "dev", artifact_ids: [] },
      { dispatch_id: "legacy-qa", role: "qa", agent: "legacy-qa", slot_id: "qa", artifact_ids: [] },
    ],
  }) + "\n");
  const capability = createCapability({
    run_key: RUN_ID,
    branch: "main",
    workflow: "lightweight",
    profile_hash: "legacy-proof-profile",
    stage_cursor: stageId,
    kind: "consilium",
    expected_roster: [
      { role: "dev", agent: "fresh-dev" },
      { role: "qa", agent: "fresh-qa" },
    ],
  });
  const state = {
    ...readState(root, "final"),
    migration: {
      id: migrationId,
      from_schema: 1,
      to_schema: 2,
      source_profile_hash: "legacy-proof-profile",
      target_profile_hash: "legacy-proof-profile",
      source_policy_hash: null,
      target_policy_hash: null,
      legacy_inputs: [sourceId],
      warnings: [],
      status: "complete",
      migrated_at: completedAt,
    },
    migration_succeeded_slots: canonicalSlots === undefined ? {} : { [stageId]: canonicalSlots },
  } as TeamState;
  return { state, capability: capability.state, target: canonicalTarget(root) };
}

function advanceCursor(root: string, input: DispatchAuth) {
  return rawAdvanceCursor(root, { run_id: RUN_ID, ...input }, { runId: RUN_ID });
}
function authorizeDispatch(root: string, input: DispatchAuth) {
  return rawAuthorizeDispatch(root, { run_id: RUN_ID, ...input });
}
function completeDispatch(root: string, input: Parameters<typeof rawCompleteDispatch>[1]) {
  if (input.artifact_ids?.length) {
    const statePath = statePathOf(root, "final");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    const artifacts = { ...(state.artifacts ?? {}) };
    for (const id of input.artifact_ids) artifacts[id] = `artifacts/${id}.json`;
    writeCanonicalState(root, { ...state, artifacts });
  }
  return rawCompleteDispatch(root, { run_id: RUN_ID, ...input }, { runId: RUN_ID });
}
function recordCheckpointDecision(root: string, input: Parameters<typeof rawRecordCheckpointDecision>[1]) {
  return rawRecordCheckpointDecision(root, { run_id: RUN_ID, ...input });
}
function beginCapability(root: string, requested?: Parameters<typeof rawBeginCapability>[1], options?: Parameters<typeof rawBeginCapability>[2]) {
  return rawBeginCapability(root, requested, { ...(options ?? {}), runId: RUN_ID });
}
function resolveWorkflowContract(root: string) {
  return rawResolveWorkflowContract(root, { runId: RUN_ID });
}

function scopeFlags() {
  return { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "dev" };
}

function clarificationPolicy(defaultRule: CheckpointPolicy["default"]): CheckpointPolicy {
  return {
    default: defaultRule,
    scope: "decision",
    hard_human: [],
    rules: {
      gate_ok: {
        kind: "clarification",
        default: defaultRule,
        allowed_decisions: ["proceed"],
        phase: "before_advance",
        rationale: "test policy",
      },
    },
    source: "profile",
    policy_version: 1,
    rationale: "test policy",
  };
}

function productPolicy(): CheckpointPolicy {
  return {
    default: "required_human",
    scope: "decision",
    hard_human: ["product_approval"],
    rules: {
      product_approval: {
        kind: "product_approval",
        default: "required_human",
        allowed_decisions: ["proceed", "needs_more_validation", "defer", "reject"],
        phase: "before_advance",
        rationale: "product direction is human-owned",
      },
    },
    source: "profile",
    policy_version: 1,
    rationale: "hard-human product floor",
  };
}

/** checkpoint stage (profile policy) -> no-checkpoint orchestrator stage. */
function mirrorsProfile(): Profile {
  return {
    name: "final-mirrors",
    title: "Final mirrors",
    description: "checkpoint build -> plain ops",
    match: { type: ["OPS"] },
    checkpoint_policy: clarificationPolicy("required_human"),
    stages: [
      { id: "build", title: "Build", type: "single", role: "dev", produces: "implementation", checkpoint: "gate_ok" },
      { id: "ops", title: "Ops", type: "orchestrator", produces: "summary" },
    ],
  };
}

/** Orchestrator loop: prepare -> check (loops back to prepare). */
function loopProfile(): Profile {
  return {
    name: "final-loop",
    title: "Final loop",
    description: "orchestrator bounded loop",
    match: { type: ["OPS"] },
    stages: [
      { id: "prepare", title: "Prepare", type: "orchestrator", produces: "prep" },
      { id: "check", title: "Check", type: "orchestrator", produces: "verdict", loop: { back_to: "prepare", until: "verdict.pass == true", max_iterations: 3, on_exhausted: "escalate_user" } },
    ],
  };
}

/** QA-shared DoD loop: loopback re-enters qa_tests and then checks its output. */
function qaLoopProfile(): Profile {
  return {
    name: "final-qa-loop",
    title: "Final QA loop",
    description: "QA shared DoD bounded loop",
    match: { type: ["OPS"] },
    stages: [
      { id: "prior", title: "Prior", type: "orchestrator", produces: "implementation" },
      { id: "qa_tests", title: "QA", type: "orchestrator", consumes: ["implementation", "dod"], produces: "qa_tests" },
      {
        id: "check",
        title: "Check",
        type: "orchestrator",
        consumes: ["qa_tests", "dod"],
        produces: "verdict",
        loop: { back_to: "qa_tests", until: "verdict.pass == true", max_iterations: 3, on_exhausted: "escalate_user" },
      },
    ],
  };
}

/** product_approval -> product_handoff, both gated on the recorded decision. */
function productProfile(): Profile {
  return {
    name: "final-product",
    title: "Final product",
    description: "approval handoff",
    match: { type: ["PRODUCT_DISCOVERY"] },
    stages: [
      { id: "product_approval", title: "Approval", type: "orchestrator", produces: "product_approval_record", checkpoint: "product_approval", gate: "product_approval_recorded", checkpoint_policy: productPolicy() },
      { id: "product_handoff", title: "Handoff", type: "orchestrator", produces: "product_handoff", gate: "product_approval_recorded" },
    ],
  };
}

/** Same checkpoint id on both stages, DIFFERENT policies. */
function stalePolicyProfile(): Profile {
  return {
    name: "final-stale-policy",
    title: "Final stale policy",
    description: "mirror rebound per stage",
    match: { type: ["OPS"] },
    stages: [
      { id: "build", title: "Build", type: "single", role: "dev", produces: "implementation", checkpoint: "gate_ok", checkpoint_policy: clarificationPolicy("autonomous_allowed") },
      { id: "ship", title: "Ship", type: "single", role: "dev", produces: "release", checkpoint: "gate_ok", checkpoint_policy: clarificationPolicy("required_human") },
    ],
  };
}
/** Two terminal orchestrator stages for final cursor publication regressions. */
function terminalAdvanceProfile(): Profile {
  return {
    name: "final-terminal-advance",
    title: "Final terminal advance",
    description: "terminal summary publication",
    match: { type: ["OPS"] },
    stages: [
      { id: "prior", title: "Prior", type: "orchestrator" },
      { id: "summary", title: "Summary", type: "orchestrator" },
    ],
  };
}


interface SeedOptions {
  profile: Profile;
  stageCursor: string;
  slug: string;
  capability?: TeamState["dispatch_capability"];
  decisions?: TeamState["typed_checkpoint_decisions"];
  checkpointPolicy?: TeamState["checkpoint_policy"];
}

function seedState(root: string, opts: SeedOptions): void {
  mkdirSync(join(runPath(root), "artifacts"), { recursive: true });
  const stages = opts.profile.stages.map((stage) => ({
    id: stage.id,
    status: stage.id === opts.stageCursor ? "in_progress" as const : "pending" as const,
  }));
  const state = {
    schema: 2 as const,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active" as const,
    rework_generation: 0,
    branch: "main",
    title: "final corrections",
    classification: { type: opts.profile.name === "final-product" ? "PRODUCT_DISCOVERY" : "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: opts.profile.name },
    task: "final corrections",
    workflow_override: false,
    issue: null,
    required_inputs: {},
    required_input_receipts: {},
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(opts.profile),
    scope: scopeFlags(),
    stage_cursor: opts.stageCursor,
    stages,
    updated_at: new Date().toISOString(),
    ...(opts.capability ? { dispatch_capability: opts.capability, cursor_epoch: opts.capability.issued_for!.cursor_epoch } : {}),
    ...(opts.decisions ? { typed_checkpoint_decisions: opts.decisions } : {}),
  } as TeamState;

  // A real checkpoint answer is bound to the active stage's declared policy.
  // Project that declaration into the canonical state exactly as the durable
  // transition does, including the policy binding used by the contract.
  if (opts.checkpointPolicy) {
    // Explicit mirrors are retained for stale-policy and legacy-readable
    // fixtures, which intentionally exercise an unbound persisted projection.
    state.checkpoint_policy = opts.checkpointPolicy;
  } else {
    const stage = opts.profile.stages.find((candidate) => candidate.id === opts.stageCursor);
    const declaration = stage
      ? resolveCheckpointDeclaration(stage, opts.profile.checkpoint_policy, state, "rebind")
      : { ok: true as const, declaration: null };
    if (!declaration.ok) throw new Error(`fixture checkpoint declaration failed: ${declaration.error}`);
    if (declaration.declaration) {
      state.checkpoint_policy = declaration.declaration.policy;
      state.checkpoint_policy_binding = {
        stage_id: declaration.declaration.stage_id,
        profile_hash: state.profile_hash!,
        policy_hash: declaration.declaration.policy_hash,
      };
    }
  }

  if (opts.capability && (!("dispatch_token_hash" in opts.capability) || !("advance_token_hash" in opts.capability))) {
    const statePath = statePathOf(root, "final");
    mkdirSync(dirname(statePath), { recursive: true });

    mkdirSync(join(runPath(root), "artifacts"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state) + "\n");
    writeStateMd(runPath(root), state);
  } else {
    writeCanonicalState(root, state);
  }
}

function noneCapability(profile: Profile, stageId: string): IssuedCapability {
  return createCapability({
    run_key: RUN_ID, branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
    stage_cursor: stageId, kind: "none", expected_roster: [],
  });
}
function terminalAdvanceContext(root: string, sessionId = "terminal-advance"): TrustedExecutionContext {
  return {
    session_id: sessionId,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: "main",
    authority: "coordinator",
  };
}

function terminalAdvanceState(profile: Profile, capability: IssuedCapability): TeamState {
  return {
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: "main",
    title: "terminal advance",
    classification: {
      type: "OPS",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow: profile.name,
    },
    task: "terminal advance",
    workflow_override: false,
    issue: null,
    required_inputs: {},
    required_input_receipts: {},

    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    scope: scopeFlags(),
    stage_cursor: "summary",
    stages: [
      { id: "prior", status: "done" },
      { id: "summary", status: "in_progress" },
    ],
    cursor_epoch: capability.state.issued_for!.cursor_epoch,
    dispatch_capability: capability.state,
    updated_at: new Date().toISOString(),
  };
}
function persistTerminalAdvanceFixture(root: string, sessionId = "terminal-advance"): {
  profile: Profile;
  issued: IssuedCapability;
  context: TrustedExecutionContext;
} {
  initGit(root);
  const profile = terminalAdvanceProfile();
  registerWorkflowProfiles([profile]);
  const issued = noneCapability(profile, "summary");
  const context = terminalAdvanceContext(root, sessionId);
  persistCanonicalRun(root, terminalAdvanceState(profile, issued), { context });
  return { profile, issued, context };
}

function singleCapability(profile: Profile, stageId: string, role: string): IssuedCapability {
  return createCapability({
    run_key: RUN_ID, branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
    stage_cursor: stageId, kind: "single", expected_roster: [{ role, agent: role }],
  });
}

function advanceAuthOf(issued: IssuedCapability): DispatchAuth {
  const issuedFor = issued.state.issued_for!;
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow: issuedFor.workflow,
    profile_hash: issuedFor.profile_hash,
    stage_cursor: issuedFor.stage_cursor,
    cursor_epoch: issuedFor.cursor_epoch,
    loop_iteration: issuedFor.loop_iteration,
  };
}

function advanceAuthOfHandoff(handoff: CapabilityHandoff): DispatchAuth {
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
function mintAnswer(root: string, slug: string, stageId: string, checkpointId: string, decision: string, answerId: string): TrustedCheckpointAnswerIngest {
  const state = readState(root, slug);
  const trusted = recordTrustedCheckpointAnswer(state, {
    answer_id: answerId,
    channel: "terminal",
    reference: `terminal-answer/final/${answerId}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision,
  });
  writeCanonicalState(root, trusted.state);
  return trusted;
}

function recordDecision(root: string, auth: DispatchAuth, checkpointId: string, kind: string, decision: string, proof: { ref: string; proof?: CheckpointAnswerProof }, rationale: string, authorization: "human" | "policy_auto" = "human") {
  return recordCheckpointDecision(root, {
    ...auth,
    checkpoint: checkpointId,
    checkpoint_id: checkpointId,
    checkpoint_kind: kind,
    decision,
    authorization,
    actor_provenance: authorization === "human"
      ? { kind: "user", ref: proof.ref, proof: proof.proof }
      : { kind: "system", ref: proof.ref },
    rationale,
  });
}

// ---------------------------------------------------------------------------
// Blocker: optional mirrors omitted/deleted — no-checkpoint stages persist
// ---------------------------------------------------------------------------

test("final: begin on a no-checkpoint stage persists; the policy mirror is omitted, never own undefined", () => {
  const root = mkdtempSync(join(tmpdir(), "final-begin-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });

    // The blocker: this begin used to emit own undefined
    // checkpoint_policy/binding mirrors and normalization rejected the write.
    const begin = beginCapability(root);
    assert.equal(begin.ok, true, begin.ok ? "began" : `begin failed: ${begin.error}`);
    if (!begin.ok) return;
    const afterBegin = readState(root, "final");
    assert.equal("checkpoint_policy" in afterBegin, false, "a no-checkpoint stage projects NO policy mirror key");
    assert.equal("checkpoint_policy_binding" in afterBegin, false, "a no-checkpoint stage projects NO binding key");
    assert.equal(afterBegin.stage_cursor, "discovery");
    assert.ok(begin.handoff);
    assert.equal(begin.handoff.loop_iteration, 1, "the first pass executes iteration 1");
    assert.equal(begin.handoff.checkpoint_policy_hash, null, "no declaration -> null policy hash on the handoff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: advance from a checkpoint stage into a no-checkpoint stage clears every optional mirror by key", () => {
  const root = mkdtempSync(join(tmpdir(), "final-clear-"));
  try {
    initGit(root);
    const profile = mirrorsProfile();
    registerWorkflowProfiles([profile]);
    const issued = singleCapability(profile, "build", "dev");
    seedState(root, { profile, stageCursor: "build", slug: "final", capability: issued.state });
    writeArtifacts(root, "final", { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "e" } });

    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;
    const completed = completeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "done", artifact_ids: ["implementation"] });
    assert.equal(completed.ok, true, completed.ok ? "completed" : completed.error);

    const trusted = mintAnswer(root, "final", "build", "gate_ok", "proceed", "final/clear-answer");
    const recorded = recordDecision(root, advanceAuthOf(issued), "gate_ok", "clarification", "proceed", { ref: trusted.answer.reference, proof: trusted.proof }, "owner answered");
    assert.equal(recorded.ok, true, recorded.ok ? "recorded" : recorded.error);

    // The cursor move into a stage without a checkpoint declaration used to
    // write own undefined mirrors and the persist threw.
    const advanced = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "build done" });
    assert.equal(advanced.ok, true, advanced.ok ? "advanced into the no-checkpoint stage" : advanced.error);
    const after = readState(root, "final");
    assert.equal(after.stage_cursor, "ops");
    assert.equal("checkpoint_policy" in after, false, "the prior stage's policy mirror is deleted, not carried");
    assert.equal("checkpoint_policy_binding" in after, false);
    assert.equal("work_identity" in after, false, "the build stage's identity is deleted on the cursor move");
    assert.equal("pending" in after, false, "the completed stage's pending mirror never leaks into the next stage");
    assert.equal("completion_envelope" in after, false, "the completed stage's envelope mirror never leaks into the next stage");
    assert.equal(after.pause.kind, "none", "the next stage starts with a clean lifecycle, not the prior pause");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: loop re-entry into a no-checkpoint orchestrator stage persists with a coherent iteration", () => {
  const root = mkdtempSync(join(tmpdir(), "final-loop-"));
  try {
    initGit(root);
    const profile = loopProfile();
    registerWorkflowProfiles([profile]);
    const issued = noneCapability(profile, "prepare");
    seedState(root, { profile, stageCursor: "prepare", slug: "final", capability: issued.state });
    writeArtifacts(root, "final", { prep: { ok: true } });

    const toCheck = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "prepared" });
    assert.equal(toCheck.ok, true, toCheck.ok ? "armed check" : toCheck.error);
    if (!toCheck.ok || !toCheck.handoff) return;
    assert.equal(toCheck.handoff.loop_iteration, 1);
    writeArtifacts(root, "final", { verdict: { pass: false } });

    // The blocker: re-entry wrote `work_identity: undefined` (own undefined)
    // and the persist threw before this fix.

    const reentered = advanceCursor(root, { ...advanceAuthOfHandoff(toCheck.handoff), evidence: "FAIL" });
    assert.equal(reentered.ok, true, reentered.ok ? "re-entered prepare" : reentered.error);
    const after = readState(root, "final");
    assert.equal(after.stage_cursor, "prepare");
    assert.equal(after.loop_state?.reentries, 1, "one loop-back performed");
    assert.equal("work_identity" in after, false, "identity is cleared by key deletion");
    assert.equal(after.pause.kind, "none", "the re-entered iteration starts clean");
    assert.equal(after.dispatch_capability?.issued_for?.loop_iteration, 2, "the window executes iteration reentries + 1");
    assert.equal(reentered.ok && reentered.handoff ? reentered.handoff.loop_iteration : -1, 2, "the handoff iteration matches the active window");

    // The re-armed iteration agrees with loopIterationForStage semantics:
    // the next pass of the whole window executes at iteration 2.
    writeArtifacts(root, "final", { prep: { ok: true, pass2: true } });
    if (!reentered.ok || !reentered.handoff) return;
    const toCheck2 = advanceCursor(root, { ...advanceAuthOfHandoff(reentered.handoff), evidence: "prepared 2" });
    assert.equal(toCheck2.ok, true, toCheck2.ok ? "second pass advances" : toCheck2.error);
    if (!toCheck2.ok || !toCheck2.handoff) return;
    assert.equal(toCheck2.handoff.loop_iteration, 2, "check re-arms at iteration 2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("final: QA loopback invalidates declared output and shared DoD evidence, then begin repins current bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "final-qa-loop-evidence-"));
  try {
    initGit(root);
    const profile = qaLoopProfile();
    registerWorkflowProfiles([profile]);
    const issued = createCapability({
      run_key: RUN_ID,
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "check",
      kind: "none",
      expected_roster: [],
      loop_iteration: 1,
    });
    seedState(root, { profile, stageCursor: "check", slug: "final", capability: issued.state });

    const artifactsDir = runTarget(root, RUN_ID).artifactsDir!;
    const implementation = JSON.stringify({ files_touched: ["src/example.ts"], build_status: "pass" });
    const qaTests = JSON.stringify({ tests_added: ["qa-loop"], build_status: "pass" });
    const dod = JSON.stringify({
      items: [{
        id: "criterion-1",
        criterion: "DoD evidence is current",
        verify_method: "QA mutation",
        status: "pending",
        evidence: "",
      }],
    });
    const verdict = JSON.stringify({ pass: false });
    writeFileSync(join(artifactsDir, "implementation.json"), implementation);
    writeFileSync(join(artifactsDir, "qa_tests.json"), qaTests);
    writeFileSync(join(artifactsDir, "dod.json"), dod);
    writeFileSync(join(artifactsDir, "verdict.json"), verdict);
    const implementationInput = {
      artifact_id: "implementation",
      path: "implementation.json",
      sha256: createHash("sha256").update(implementation, "utf8").digest("hex"),
    };
    const qaTestsInput = {
      artifact_id: "qa_tests",
      path: "qa_tests.json",
      sha256: createHash("sha256").update(qaTests, "utf8").digest("hex"),
    };
    const dodInput = {
      artifact_id: "dod",
      path: "dod.json",
      sha256: createHash("sha256").update(dod, "utf8").digest("hex"),
    };
    const receiptBinding = {
      capability_id: issued.capability_id,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      rework_generation: 0,
      read_at: "2026-09-20T00:00:00.000Z",
    };
    updateCanonicalRun(root, RUN_ID, (state) => ({
      ...state,
      stage_cursor: "check",
      stages: [
        { id: "prior", status: "done" },
        { id: "qa_tests", status: "done" },
        { id: "check", status: "in_progress" },
      ],
      artifacts: {
        implementation: "artifacts/implementation.json",
        qa_tests: "artifacts/qa_tests.json",
        dod: "artifacts/dod.json",
        verdict: "artifacts/verdict.json",
      },
      required_inputs: {
        prior: [],
        qa_tests: [implementationInput, dodInput],
        check: [qaTestsInput, dodInput],
      },
      required_input_receipts: {
        prior: { stage_id: "prior", ...receiptBinding, inputs: [] },
        qa_tests: { stage_id: "qa_tests", ...receiptBinding, inputs: [implementationInput, dodInput] },
        check: { stage_id: "check", ...receiptBinding, inputs: [qaTestsInput, dodInput] },
      },
    }));

    const reentered = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "check failed" });
    assert.equal(reentered.ok, true, reentered.ok ? "the check loop re-entered QA" : reentered.error);
    if (!reentered.ok || !reentered.handoff) return;
    const afterLoop = readState(root, "final");
    assert.equal(afterLoop.stage_cursor, "qa_tests");
    assert.equal(afterLoop.required_inputs?.qa_tests?.find((input) => input.artifact_id === "implementation")?.sha256, implementationInput.sha256);
    assert.equal(afterLoop.required_inputs?.qa_tests?.find((input) => input.artifact_id === "dod")?.sha256, undefined);
    assert.equal(afterLoop.required_inputs?.check?.find((input) => input.artifact_id === "qa_tests")?.sha256, undefined);
    assert.equal(afterLoop.required_inputs?.check?.find((input) => input.artifact_id === "dod")?.sha256, undefined);
    assert.ok(afterLoop.required_input_receipts?.prior);
    assert.equal(afterLoop.required_input_receipts?.qa_tests, undefined);
    assert.equal(afterLoop.required_input_receipts?.check, undefined);

    const refreshedQaTests = JSON.stringify({ tests_added: ["qa-loop-v2"], build_status: "pass" });
    const refreshedDod = JSON.stringify({
      items: [{
        id: "criterion-1",
        criterion: "DoD evidence is current",
        verify_method: "QA mutation",
        status: "met",
        evidence: "QA refreshed the criterion",
      }],
    });
    const refreshedQaTestsHash = createHash("sha256").update(refreshedQaTests, "utf8").digest("hex");
    const refreshedDodHash = createHash("sha256").update(refreshedDod, "utf8").digest("hex");
    writeFileSync(join(artifactsDir, "qa_tests.json"), refreshedQaTests);
    writeFileSync(join(artifactsDir, "dod.json"), refreshedDod);

    const toCheck = advanceCursor(root, { ...advanceAuthOfHandoff(reentered.handoff), evidence: "QA refreshed" });
    assert.equal(toCheck.ok, true, toCheck.ok ? "QA advanced to check" : toCheck.error);
    const began = beginCapability(root);
    assert.equal(began.ok, true, began.ok ? "check begin repinned refreshed QA and DoD" : began.error);
    if (!began.ok) return;
    const afterBegin = readState(root, "final");
    const receipt = afterBegin.required_input_receipts?.check;
    assert.equal(receipt?.inputs.find((input) => input.artifact_id === "qa_tests")?.sha256, refreshedQaTestsHash);
    assert.equal(receipt?.inputs.find((input) => input.artifact_id === "dod")?.sha256, refreshedDodHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: ordinary pending QA begin keeps hashes strict without re-entry invalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "final-qa-pending-begin-"));
  try {
    initGit(root);
    const profile = qaLoopProfile();
    registerWorkflowProfiles([profile]);
    seedState(root, { profile, stageCursor: "qa_tests", slug: "final" });
    const artifactsDir = runTarget(root, RUN_ID).artifactsDir!;
    const implementation = JSON.stringify({ source: "implementation-v1" });
    const dod = JSON.stringify({
      items: [{
        id: "criterion-1",
        criterion: "DoD evidence is current",
        verify_method: "QA mutation",
        status: "pending",
        evidence: "",
      }],
    });
    writeFileSync(join(artifactsDir, "implementation.json"), implementation);
    writeFileSync(join(artifactsDir, "dod.json"), dod);
    const implementationInput = {
      artifact_id: "implementation",
      path: "implementation.json",
      sha256: createHash("sha256").update(implementation, "utf8").digest("hex"),
    };
    const dodInput = {
      artifact_id: "dod",
      path: "dod.json",
      sha256: createHash("sha256").update(dod, "utf8").digest("hex"),
    };
    updateCanonicalRun(root, RUN_ID, (state) => ({
      ...state,
      stage_cursor: "qa_tests",
      stages: [
        { id: "prior", status: "done" },
        { id: "qa_tests", status: "pending" },
        { id: "check", status: "pending" },
      ],
      artifacts: {
        implementation: "artifacts/implementation.json",
        dod: "artifacts/dod.json",
      },
      required_inputs: { qa_tests: [implementationInput, dodInput] },
      required_input_receipts: {},
    }));

    const began = beginCapability(root);
    assert.equal(began.ok, true, began.ok ? "ordinary pending begin succeeds" : began.error);
    if (!began.ok) return;
    const afterBegin = readState(root, "final");
    assert.equal(afterBegin.required_inputs?.qa_tests?.find((input) => input.artifact_id === "dod")?.sha256, dodInput.sha256);

    writeFileSync(join(artifactsDir, "dod.json"), JSON.stringify({ items: [{ id: "criterion-1", criterion: "tampered", verify_method: "QA mutation", status: "met", evidence: "wrong" }] }));
    const rejected = beginCapability(root);
    assert.equal(rejected.ok, false, "ordinary pending begin remains strict after a current-input mutation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Blocker: one transaction for every durable mutation — real cross-process
// ---------------------------------------------------------------------------

test("final: a real second process holding the lock serializes a begin; the fresh read keeps the child's concurrent field", async () => {
  const root = mkdtempSync(join(tmpdir(), "final-xproc-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const statePath = statePathOf(root, "final");
    const lockPath = join(root, ".work-state", ".state.lock");

    // Second OS process on the platform clock: fake timers cannot drive it.
    // It takes the workspace lock, edits the state as a legitimate writer,
    // then releases.
    const child = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      // node -e CODE a b numbers extra args from argv[1] (argv[0] is the binary).
      const [statePath, lockPath] = process.argv.slice(1);
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "final-corrections-child", acquired_at: new Date().toISOString() }));
      console.log("locked");
      setTimeout(() => {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        state.task = "child-edit";
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
        fs.unlinkSync(lockPath);
        console.log("released");
      }, 700);
    `, statePath, lockPath], { stdio: ["ignore", "pipe", "pipe"] });

    // Bounded spin until the child's lock is OBSERVABLY present (never a
    // fixed sleep on the parent side).
    const lockDeadline = Date.now() + 5000;
    while (!existsSync(lockPath) && Date.now() < lockDeadline) busySpin(20);
    assert.ok(existsSync(lockPath), "the child lock appeared");

    const begin = beginCapability(root);
    assert.equal(begin.ok, true, begin.ok ? "begin waited for the cross-process lock and committed" : begin.error);
    const after = readState(root, "final");
    assert.equal(after.task, "child-edit", "the transaction re-read the child's committed field instead of clobbering it with a pre-lock snapshot");
    assert.ok(after.dispatch_capability, "the no-checkpoint begin armed its capability");

    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: a real second process performing a lockless write during a transaction is a CAS conflict with no partial commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "final-cas-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const statePath = statePathOf(root, "final");
    const beforeBytes = readFileSync(statePath, "utf8");

    // Second OS process on the platform clock (see file note): a lockless
    // writer racing the parent transaction.
    const child = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      // node -e CODE a numbers extra args from argv[1] (argv[0] is the binary).
      const [statePath] = process.argv.slice(1);
      setTimeout(() => {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        state.task = "child-race";
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
        console.log("child wrote");
      }, 200);
    `, statePath], { stdio: ["ignore", "pipe", "pipe"] });

    const result = updateStateAtomically(root, (snapshot) => {
      assert.ok(snapshot.state);
      // Block the commit until the child's lockless write is observably on
      // disk, then attempt to commit over it: the revision/raw-hash CAS
      // must reject with no partial write.
      const deadline = Date.now() + 5000;
      for (;;) {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as { task?: string };
        if (raw.task === "child-race") break;
        if (Date.now() > deadline) throw new Error("child write never observed");
        busySpin(20);
      }
      const commit: StateMutation<void> = { op: "commit", state: { ...snapshot.state!, task: "parent" } };
      return commit;
    }, { target: canonicalTarget(root), branch: "main" });
    assert.equal(result.ok, false, "the CAS guard rejects the moved file");
    if (!result.ok) assert.equal(result.code, "state_conflict");
    const after = JSON.parse(readFileSync(statePath, "utf8")) as { task?: string };
    assert.equal(after.task, "child-race", "the child's write is untouched by the failed transaction");
    assert.notEqual(readFileSync(statePath, "utf8"), beforeBytes);

    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: the committed result of a transaction is the exact normalized/stamped state on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "final-stamp-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });

    const result = updateStateAtomically(root, (snapshot) => ({ op: "commit", state: { ...snapshot.state!, task: "stamped" }, value: undefined }), { target: canonicalTarget(root), branch: "main" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.committed, true);
    assert.equal(result.revision, 2);
    const onDisk = JSON.parse(readFileSync(statePathOf(root, "final"), "utf8")) as TeamState;
    assert.equal(result.state?.state_revision, onDisk.state_revision, "the result carries the stamped committed revision");
    assert.equal(result.state?.updated_at, onDisk.updated_at, "the result carries the stamped committed timestamp");
    assert.equal(onDisk.state_revision, 2, "the revision advanced to previous + 1");
    assert.equal(onDisk.task, "stamped");

    const begin = beginCapability(root);
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const diskAfterBegin = readState(root, "final");
    assert.equal(begin.state.state_revision, diskAfterBegin.state_revision, "the transition result carries the stamped committed revision");
    assert.equal(begin.state.updated_at, diskAfterBegin.updated_at, "the transition result carries the stamped committed timestamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH: historical product approval survives capability rotation
// ---------------------------------------------------------------------------

test("final: the product_approval decision authorizes the product_handoff gate across the epoch rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "final-product-"));
  try {
    initGit(root);
    const profile = productProfile();
    registerWorkflowProfiles([profile]);
    const issued = noneCapability(profile, "product_approval");
    seedState(root, { profile, stageCursor: "product_approval", slug: "final", capability: issued.state });

    const trusted = mintAnswer(root, "final", "product_approval", "product_approval", "proceed", "final/product-answer");
    const recorded = recordDecision(root, advanceAuthOf(issued), "product_approval", "product_approval", "proceed", { ref: trusted.answer.reference, proof: trusted.proof }, "product owner approved");
    assert.equal(recorded.ok, true, recorded.ok ? "approval recorded" : recorded.error);

    writeArtifacts(root, "final", { product_approval_record: { decision: "proceed", approved_by: "product owner", rationale: "product owner approved", decided_at: new Date().toISOString() } });
    const toHandoff = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "approval done" });
    assert.equal(toHandoff.ok, true, toHandoff.ok ? "cursor moved to product_handoff" : toHandoff.error);
    if (!toHandoff.ok || !toHandoff.handoff) return;
    assert.notEqual(toHandoff.handoff.cursor_epoch, issued.state.issued_for!.cursor_epoch, "the capability epoch rotated with the cursor");

    writeArtifacts(root, "final", { product_handoff: { decision: "proceed", next_workflow: "spec-preparation", product_spec_artifact: "product_spec", instructions: "spec the approved direction" } });
    // The gate re-validates the approval under the DECISION'S OWN immutable
    // scope (capability epoch at mint time) — previously it recomputed the
    // proof hash against the NEW capability and rejected the normal durable
    // flow.
    const advanced = advanceCursor(root, { ...advanceAuthOfHandoff(toHandoff.handoff), evidence: "handoff done" });
    assert.equal(advanced.ok, true, advanced.ok ? "the historical approval authorizes the handoff gate" : advanced.error);
    const after = readState(root, "final");
    assert.equal(after.pause.kind, "done");
    const decisions = after.typed_checkpoint_decisions ?? [];
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.capability_epoch, issued.state.issued_for!.cursor_epoch, "the decision keeps its mint-time binding as audit scope");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: product handoff selects its stamped approval generation after a differing reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "review-product-generation-"));
  try {
    initGit(root);
    const profile = productProfile();
    registerWorkflowProfiles([profile]);
    const firstCapability = noneCapability(profile, "product_approval");
    seedState(root, { profile, stageCursor: "product_approval", slug: "final", capability: firstCapability.state });
    const firstAnswer = mintAnswer(root, "final", "product_approval", "product_approval", "proceed", "review/product-first");
    const firstRecorded = recordDecision(root, advanceAuthOf(firstCapability), "product_approval", "product_approval", "proceed", { ref: firstAnswer.answer.reference, proof: firstAnswer.proof }, "first approval");
    assert.equal(firstRecorded.ok, true, firstRecorded.ok ? "recorded" : firstRecorded.error);
    writeArtifacts(root, "final", {
      product_approval_record: { decision: "proceed", approved_by: "product owner", rationale: "first approval", decided_at: new Date().toISOString() },
    });
    const toHandoff = advanceCursor(root, { ...advanceAuthOf(firstCapability), evidence: "first approval complete" });
    assert.equal(toHandoff.ok, true, toHandoff.ok ? "handoff armed" : toHandoff.error);
    if (!toHandoff.ok || !toHandoff.handoff) return;
    const handoffState = readState(root, "final");
    const boundArtifact = readArtifact<Record<string, unknown>>(join(runPath(root), "artifacts"), "product_approval_record");
    assert.equal(typeof boundArtifact?.checkpoint_decision_key, "string");

    // Reopen product approval under a new epoch and record a DIFFERENT valid
    // decision. Then resume the already-completed handoff generation while
    // retaining both decisions as audit history.
    const reopenedCapability = noneCapability(profile, "product_approval");
    const reopened: TeamState = {
      ...handoffState,
      stage_cursor: "product_approval",
      cursor_epoch: reopenedCapability.state.issued_for!.cursor_epoch,
      stages: handoffState.stages.map((stage) =>
        stage.id === "product_approval"
          ? { ...stage, status: "in_progress" as const }
          : stage.id === "product_handoff"
            ? { ...stage, status: "pending" as const }
            : stage),
      dispatch_capability: reopenedCapability.state,
      checkpoint_policy: productPolicy(),
      pause: { kind: "none", reason: "" },
    };
    delete reopened.work_identity;
    delete reopened.pending;
    delete reopened.completion_envelope;
    delete reopened.checkpoint_policy_binding;
    writeCanonicalState(root, reopened);
    const secondAnswer = mintAnswer(root, "final", "product_approval", "product_approval", "reject", "review/product-second");
    const secondRecorded = recordDecision(root, advanceAuthOf(reopenedCapability), "product_approval", "product_approval", "reject", { ref: secondAnswer.answer.reference, proof: secondAnswer.proof }, "reopened rejection");
    assert.equal(secondRecorded.ok, true, secondRecorded.ok ? "second generation recorded" : secondRecorded.error);
    const twoGenerationState = readState(root, "final");
    assert.equal(twoGenerationState.typed_checkpoint_decisions?.length, 2);

    const resumed: TeamState = {
      ...handoffState,
      typed_checkpoint_decisions: twoGenerationState.typed_checkpoint_decisions,
      checkpoint_decisions: twoGenerationState.checkpoint_decisions,
      trusted_checkpoint_answers: twoGenerationState.trusted_checkpoint_answers,
    };
    delete resumed.checkpoint_policy;
    delete resumed.checkpoint_policy_binding;
    delete resumed.work_identity;
    delete resumed.pending;
    delete resumed.completion_envelope;
    writeCanonicalState(root, resumed);
    writeArtifacts(root, "final", {
      product_handoff: { decision: "proceed", next_workflow: "spec-preparation", product_spec_artifact: "product_spec", instructions: "handoff the first approved direction" },
    });

    const advanced = advanceCursor(root, { ...advanceAuthOfHandoff(toHandoff.handoff), evidence: "exact generation handoff" });
    assert.equal(advanced.ok, true, advanced.ok ? "stamped generation selected" : advanced.error);
    assert.equal(readState(root, "final").pause.kind, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH: stale policy mirror
// ---------------------------------------------------------------------------

test("final: a stale prior-stage policy mirror neither conflicts the stage rebind nor dresses the contract", () => {
  const root = mkdtempSync(join(tmpdir(), "final-stale-policy-"));
  try {
    initGit(root);
    const profile = stalePolicyProfile();
    registerWorkflowProfiles([profile]);
    const shipStage = profile.stages.find((stage) => stage.id === "ship")!;
    const staleMirror = clarificationPolicy("autonomous_allowed");
    const issued = singleCapability(profile, "ship", "dev");

    // A state at `ship` still carrying the PRIOR stage's policy mirror. Its
    // binding (if any) names a different stage, so the mirror is a stale
    // projection.
    seedState(root, { profile, stageCursor: "ship", slug: "final", capability: issued.state, checkpointPolicy: staleMirror });

    const state = readState(root, "final");
    // The stale mirror is NOT a policy_conflict anymore: the declared
    // stage/profile policy simply wins, and the next transition re-projects.
    const resolved = resolveCheckpointDeclaration(shipStage, null, state, "authorize");
    assert.equal(resolved.ok, true, resolved.ok ? "declared policy wins" : `${resolved.code}: ${resolved.error}`);
    if (!resolved.ok) return;
    assert.equal(resolved.declaration?.policy.default, "required_human", "the ship declaration is authoritative");
    assert.equal(resolved.declaration?.policy_hash, checkpointPolicyHash(shipStage.checkpoint_policy!));

    // Advance treats the checkpoint as ITS OWN unresolved question (the
    // ship scope), never as a policy conflict of the stale mirror.
    const blocked = validateCheckpointForAdvance(shipStage, state);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, "checkpoint_unresolved", "the stale mirror neither authorizes nor corrupts the question");
      assert.equal(blocked.pauseKind, "user_checkpoint");
    }

    // The contract exposes the CURRENT declared policy, not the stale mirror.
    const contract = resolveWorkflowContract(root);
    assert.equal(contract.stage.checkpoint_policy?.default, "required_human", "the contract never reports the prior stage's policy as current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MEDIUM: modern authorizing calls require the loop iteration
// ---------------------------------------------------------------------------

test("final: modern capabilities reject iteration-less or mismatched authorizing calls", () => {
  const root = mkdtempSync(join(tmpdir(), "final-iter-"));
  try {
    initGit(root);
    const profile = mirrorsProfile();
    registerWorkflowProfiles([profile]);
    const issued = noneCapability(profile, "ops");
    seedState(root, { profile, stageCursor: "ops", slug: "final", capability: issued.state });

    const { loop_iteration: _omitted, ...withoutIteration } = advanceAuthOf(issued);
    const noIteration = authorizeDispatch(root, { ...withoutIteration, token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(noIteration.ok, false, "an iteration-less call cannot authorize a modern capability");
    if (!noIteration.ok) assert.match(noIteration.error, /capability binding mismatch/);

    const wrongIteration = authorizeDispatch(root, { ...advanceAuthOf(issued), loop_iteration: 99, token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(wrongIteration.ok, false);
    if (!wrongIteration.ok) assert.match(wrongIteration.error, /capability binding mismatch/);

    const ask = validateCheckpointAsk(root, { run_id: RUN_ID, ...withoutIteration, token: issued.advance_token, checkpoint: "none_declared", checkpoint_id: "none_declared", checkpoint_kind: "clarification" });
    assert.equal(ask.ok, false, "the ask binds the iteration before any dialog");
    if (!ask.ok) assert.match(ask.error, /capability binding mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH/MEDIUM: contract exposure and legacy readability
// ---------------------------------------------------------------------------

test("final: a legacy readable-but-nonauthorizing decision stays readable and exposes no current decision", () => {
  const root = mkdtempSync(join(tmpdir(), "final-legacy-"));
  try {
    initGit(root);
    const profile = mirrorsProfile();
    registerWorkflowProfiles([profile]);
    const issued = singleCapability(profile, "build", "dev");
    const policy = clarificationPolicy("required_human");
    // Pre-loop-scope record: everything scoped EXCEPT the additive
    // loop_iteration — audit-readable, never authorizing.
    seedState(root, {
      profile,
      stageCursor: "build",
      slug: "final",
      capability: issued.state,
      checkpointPolicy: policy,
      decisions: [{
        run_id: "main",
        stage_id: "build",
        checkpoint_id: "gate_ok",
        checkpoint_kind: "clarification",
        decision: "proceed",
        authorization: "human",
        actor: { kind: "user", ref: "user:legacy" },
        capability_id: issued.capability_id,
        capability_epoch: issued.state.issued_for!.cursor_epoch,
        policy_hash: checkpointPolicyHash(policy),
        rationale: "pre-loop ledger record",
        decided_at: new Date().toISOString(),
      }],
    });

    // Previously the contract rejected this readable state with
    // POLICY_INVALID; the migration allowance is explicit and consistent.
    const contract = resolveWorkflowContract(root);
    assert.equal(contract.stage.checkpoint, "gate_ok");
    assert.equal(contract.stage.checkpoint_decision, null, "a legacy unscoped decision is never exposed as the current decision");
    assert.equal(contract.stage.checkpoint_policy?.default, "required_human");

    const blocked = validateCheckpointForAdvance(profile.stages[0]!, readState(root, "final"));
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "checkpoint_unresolved", "readable does not mean authorizing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH: partial capabilities reject with structured errors on public paths
// ---------------------------------------------------------------------------

test("final: partial capabilities yield structured rejections through public durable paths, never TypeError", () => {
  const root = mkdtempSync(join(tmpdir(), "final-partial-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const partial = {
      capability_id: "cap-partial",
      issued_for: {
        run_key: "main", branch: "main", workflow: "lightweight" as const,
        profile_hash: profileHash(profile), stage_cursor: "discovery",
        cursor_epoch: "epoch-partial",
      },
      kind: "none" as const,
      status: "ready" as const,
    };
    seedState(root, { profile, stageCursor: "discovery", slug: "final", capability: partial as TeamState["dispatch_capability"] });

    const authorized = authorizeDispatch(root, { token: "whatever", capability_id: "cap-partial", run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile), stage_cursor: "discovery", cursor_epoch: "epoch-partial", loop_iteration: 1, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, false, "a capability without secrets/roster/dispatches is not active");
    if (!authorized.ok) assert.equal(typeof authorized.error, "string");

    const advanced = advanceCursor(root, { token: "whatever", capability_id: "cap-partial", run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile), stage_cursor: "discovery", cursor_epoch: "epoch-partial", loop_iteration: 1, evidence: "e" });
    assert.equal(advanced.ok, false);
    if (!advanced.ok) assert.equal(typeof advanced.error, "string");

    const completed = completeDispatch(root, { token: "whatever", capability_id: "cap-partial", dispatch_id: "d1", run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile), stage_cursor: "discovery", cursor_epoch: "epoch-partial", loop_iteration: 1, outcome: "succeeded", evidence: "e" });
    assert.equal(completed.ok, false);
    if (!completed.ok) assert.equal(typeof completed.error, "string");

    // A shape-valid pre-loop-scope capability stays REPLACEABLE via begin.
    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "workflow_begin re-issued a complete capability" : begun.error);
    if (!begun.ok) return;
    const after = readState(root, "final");
    assert.equal(after.dispatch_capability?.capability_id, begun.handoff!.capability_id);
    assert.ok(after.dispatch_capability?.dispatches, "the re-issued capability is complete");

    // A primitive capability cannot even be persisted: normalization rejects
    // the state instead of storing a broken control plane.
    const malformedIssues: string[] = [];
    assert.equal(normalizePersistedState({ ...readState(root, "final"), dispatch_capability: null }, malformedIssues), null);
    assert.ok(malformedIssues.length > 0, "normalization reports the malformed capability");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH: live dispatches reject migration-only completion provenance
// ---------------------------------------------------------------------------

test("final: exact migration proof sets reject omitted, partial and empty evidence while allowing an empty non-migrated stage", () => {
  const root = mkdtempSync(join(tmpdir(), "final-migration-proof-set-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "implementation", slug: "final" });
    const expectedSlots = [
      { dispatch_id: "legacy-dev", role: "dev", agent: "legacy-dev", slot_id: "dev", artifact_ids: [] },
      { dispatch_id: "legacy-qa", role: "qa", agent: "legacy-qa", slot_id: "qa", artifact_ids: [] },
    ];
    const fixture = migrationProofFixture(root, "implementation", expectedSlots);
    const materialized = materializeMigratedDispatches(fixture.state, fixture.capability, "lightweight", "implementation", fixture.target);
    assert.equal(materialized.ok, true, materialized.ok ? "the exact immutable proof set materializes" : materialized.error);
    if (!materialized.ok) return;
    assert.deepEqual(materialized.records.map((record) => record.id), ["legacy-dev", "legacy-qa"]);
    assert.deepEqual(materialized.records.map((record) => record.agent), ["fresh-dev", "fresh-qa"], "a legitimate current-roster agent remap remains allowed");

    const malformed = [
      { label: "omitted stage", state: { ...fixture.state, migration_succeeded_slots: {} } },
      { label: "partial set", state: { ...fixture.state, migration_succeeded_slots: { implementation: [expectedSlots[0]!] } } },
      { label: "empty set", state: { ...fixture.state, migration_succeeded_slots: { implementation: [] } } },
    ];
    for (const candidate of malformed) {
      const result = materializeMigratedDispatches(candidate.state, fixture.capability, "lightweight", "implementation", fixture.target);
      assert.equal(result.ok, false, `${candidate.label} migration proof must fail closed`);
      if (!result.ok) assert.match(result.error, /canonical migration evidence for stage 'implementation' is missing or inconsistent/);
    }

    const emptyNonMigratedStage = materializeMigratedDispatches(
      { ...fixture.state, migration_succeeded_slots: {} },
      fixture.capability,
      "lightweight",
      "other-stage",
      fixture.target,
    );
    assert.equal(emptyNonMigratedStage.ok, true, "an actually empty non-migrated stage is not rejected by a blanket empty-set rule");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: pending and reconcile reject migration provenance hidden in captured and authority arrays without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "final-authority-arrays-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = singleCapability(profile, "implementation", "dev");
    seedState(root, { profile, stageCursor: "implementation", slug: "final", capability: issued.state });
    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;

    const beforePending = readFileSync(statePathOf(root, "final"), "utf8");
    const pending = persistPendingDispatch(root, {
      ...advanceAuthOf(issued),
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      pending_reason: "provider_running",
      provider_ref: "provider-1",
      captured: [{ work_identity: { source: "migration" } }],
      authority: [{ completion_envelope: { completed_by: "migration" } }],
    } as never, { runId: RUN_ID });
    assert.equal(pending.ok, false, "pending persistence rejects captured/authority migration provenance");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), beforePending, "pending rejection occurs before live-authority mutation");

    const beforeReconcile = readFileSync(statePathOf(root, "final"), "utf8");
    const reconciled = rawReconcileTaskResult(root, {
      ...advanceAuthOf(issued),
      run_id: RUN_ID,
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      dispatch_id: authorized.record!.id,
      output: "provider result",
      captured: { authority: [{ identity: { source: "migration" } }] },
      authority: [{ work_identity: { source: "migration" } }],
    } as never);
    assert.equal(reconciled.ok, false, "reconcile rejects captured/authority migration provenance");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), beforeReconcile, "reconcile rejection occurs before live-authority mutation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: migration-looking output, error and artifact payloads remain opaque to pending and reconcile gates", () => {
  const root = mkdtempSync(join(tmpdir(), "final-opaque-payloads-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = singleCapability(profile, "implementation", "dev");
    seedState(root, { profile, stageCursor: "implementation", slug: "final", capability: issued.state });
    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;
    const payload = { source: "migration", completed_by: "migration", terminal_signal: "migration_verified" };

    const pending = persistPendingDispatch(root, {
      ...advanceAuthOf(issued),
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      pending_reason: "provider_running",
      provider_ref: "provider-1",
      output: JSON.stringify(payload),
      stdout: JSON.stringify(payload),
      stderr: JSON.stringify(payload),
      error: JSON.stringify(payload),
      artifact: JSON.stringify(payload),
      artifacts: [payload],
      artifact_ids: ["migration"],
    } as never, { runId: RUN_ID });
    assert.equal(pending.ok, true, pending.ok ? "opaque payloads do not block pending persistence" : pending.error);
    if (!pending.ok) return;
    assert.equal(readState(root, "final").dispatch_capability?.dispatches[0]?.status, "pending");

    const reconciled = rawReconcileTaskResult(root, {
      ...advanceAuthOf(issued),
      run_id: RUN_ID,
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      dispatch_id: authorized.record!.id,
      output: JSON.stringify(payload),
      isError: false,
      details: { async: { state: "completed" } },
      stdout: JSON.stringify(payload),
      stderr: JSON.stringify(payload),
      error: { payload },
      artifact: payload,
    } as never);
    assert.equal(reconciled.ok, true, reconciled.ok ? "opaque payloads do not block reconcile" : reconciled.error);
    assert.equal(readState(root, "final").dispatch_capability?.dispatches[0]?.status, "succeeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("final: pending completion rejects migration provenance without mutating the live dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "final-pending-provenance-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = singleCapability(profile, "implementation", "dev");
    seedState(root, { profile, stageCursor: "implementation", slug: "final", capability: issued.state });
    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;

    const before = readFileSync(statePathOf(root, "final"), "utf8");
    const pending = completeDispatch(root, {
      ...advanceAuthOf(issued),
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      pending: true,
      pending_reason: "provider_running",
      provider_ref: "provider-1",
      completed_by: "migration" as never,
      terminal_signal: "migration_verified" as never,
    });
    assert.equal(pending.ok, false, "migration provenance cannot enter a live pending dispatch");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), before, "rejected provenance leaves the live dispatch byte-unchanged");
    const projectionBefore = readFileSync(statePathOf(root, "final"), "utf8");
    const projectionOnly = {
      ...advanceAuthOf(issued),
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      pending: true,
      pending_reason: "provider_running",
      provider_ref: "provider-1",
      work_identity: { ...authorized.record!.work_identity!, source: "migration" },
    } as never;
    const projectedPending = completeDispatch(root, projectionOnly);
    assert.equal(projectedPending.ok, false, "a migration-only work identity cannot enter a live pending dispatch");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), projectionBefore, "projection-only provenance leaves the pending dispatch byte-unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: same-outcome replay rejects migration provenance without rewriting a completed live dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "final-replay-provenance-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = singleCapability(profile, "implementation", "dev");
    seedState(root, { profile, stageCursor: "implementation", slug: "final", capability: issued.state });
    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;

    writeArtifacts(root, "final", { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "e" } });
    const completed = completeDispatch(root, {
      ...advanceAuthOf(issued),
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      outcome: "succeeded",
      evidence: "done",
      artifact_ids: ["implementation"],
    });
    assert.equal(completed.ok, true, completed.ok ? "completed" : completed.error);
    if (!completed.ok) return;

    const before = readFileSync(statePathOf(root, "final"), "utf8");
    const projectionBefore = readFileSync(statePathOf(root, "final"), "utf8");
    const projectedReplay = rawCompleteDispatch(root, {
      ...advanceAuthOf(issued),
      run_id: RUN_ID,
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      outcome: "succeeded",
      evidence: "projection replay",
      artifact_ids: ["implementation"],
      work_identity: { ...authorized.record!.work_identity!, source: "migration" },
    } as never, { runId: RUN_ID });
    assert.equal(projectedReplay.ok, false, "a migration-only work identity cannot masquerade as a live replay");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), projectionBefore, "projection-only replay leaves the completed dispatch byte-unchanged");
    const replay = rawCompleteDispatch(root, {
      ...advanceAuthOf(issued),
      run_id: RUN_ID,
      token: issued.dispatch_token,
      dispatch_id: authorized.record!.id,
      outcome: "succeeded",
      evidence: "migration replay",
      artifact_ids: ["implementation"],
      completed_by: "migration" as never,
      terminal_signal: "migration_verified" as never,
    }, { runId: RUN_ID });
    assert.equal(replay.ok, false, "migration provenance cannot masquerade as a live same-outcome replay");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), before, "rejected replay leaves the completed dispatch byte-unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: child join rejects migration provenance for an otherwise valid live child identity", () => {
  const root = mkdtempSync(join(tmpdir(), "final-child-provenance-"));
  try {
    initGit(root);
    const profile = mirrorsProfile();
    registerWorkflowProfiles([profile]);
    const issued = singleCapability(profile, "build", "dev");
    seedState(root, { profile, stageCursor: "build", slug: "final", capability: issued.state });
    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;

    const state = readState(root, "final");
    const parent = state.dispatch_capability!.dispatches[0]!.work_identity!;
    const child = {
      ...parent,
      task_id: `${parent.task_id}-child`,
      dispatch_id: `${parent.dispatch_id}-child`,
      slot_id: `${parent.slot_id}-child`,
      worker_id: `${parent.worker_id}-child`,
    };
    const before = readFileSync(statePathOf(root, "final"), "utf8");
    const joined = rawAppendChildJoin(root, {
      parent,
      child,
      state: "succeeded",
      expected_artifact_ids: [],
      completion_envelope_ref: "child-envelope",
      attempt: 1,
      completion_envelope: {
        schema_version: 1,
        identity: child,
        outcome: "succeeded",
        terminal_signal: "migration_verified",
        artifact_refs: [],
        evidence_ref: "evidence/child",
        conflict_ref: null,
        completed_by: "migration",
        emitted_at: new Date().toISOString(),
      } as never,
    });
    assert.equal(joined.ok, false, "migration provenance cannot be appended as a live child join");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), before, "rejected child provenance leaves the parent ledger byte-unchanged");

    const projectionBefore = readFileSync(statePathOf(root, "final"), "utf8");
    const projectedChild = { ...child, source: "migration" };
    const projectedJoin = rawAppendChildJoin(root, {
      parent,
      child: projectedChild,
      state: "succeeded",
      expected_artifact_ids: [],
      completion_envelope_ref: "child-projection-envelope",
      attempt: 1,
      completion_envelope: {
        schema_version: 1,
        identity: projectedChild,
        outcome: "succeeded",
        terminal_signal: "provider_terminal",
        artifact_refs: [],
        evidence_ref: "evidence/child-projection",
        conflict_ref: null,
        completed_by: "engine_task_caller",
        emitted_at: new Date().toISOString(),
      } as never,
    });
    assert.equal(projectedJoin.ok, false, "a migration-only child identity cannot masquerade as a live child join");
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), projectionBefore, "projection-only child provenance leaves the parent ledger byte-unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// LOW: the trusted ingest primitive itself enforces live-answer uniqueness
// ---------------------------------------------------------------------------

test("final: minting a direct trusted answer supersedes every live sibling for the same question", () => {
  const root = mkdtempSync(join(tmpdir(), "final-unique-"));
  try {
    initGit(root);
    const profile = mirrorsProfile();
    registerWorkflowProfiles([profile]);
    const issued = singleCapability(profile, "build", "dev");
    seedState(root, { profile, stageCursor: "build", slug: "final", capability: issued.state });

    const first = mintAnswer(root, "final", "build", "gate_ok", "proceed", "final/unique-1");
    assert.equal((first.state.trusted_checkpoint_answers ?? []).filter((answer) => answer.consumed_at === undefined).length, 1);

    // A SECOND direct mint for the same (run, stage, checkpoint) — a
    // different channel, even — can never leave two live answers behind.
    const second = recordTrustedCheckpointAnswer(readState(root, "final"), {
      answer_id: "final/unique-2",
      channel: "escalation",
      reference: "escalation-answer/final/unique-2",
      stage_id: "build",
      checkpoint_id: "gate_ok",
      decision: "proceed",
    });
    const live = (second.state.trusted_checkpoint_answers ?? []).filter((answer) => answer.consumed_at === undefined && answer.consumed_reason === undefined);
    assert.equal(live.length, 1, "at most ONE live answer per question across channels");
    assert.equal(live[0]!.answer_id, "final/unique-2");
    const superseded = (second.state.trusted_checkpoint_answers ?? []).find((answer) => answer.answer_id === "final/unique-1");
    assert.equal(superseded?.consumed_reason, "superseded", "the sibling live answer is superseded, never left authorizable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MEDIUM: exact decision/rationale text
// ---------------------------------------------------------------------------

test("final: trim decides emptiness only — decision labels and rationale are preserved verbatim", () => {
  const root = mkdtempSync(join(tmpdir(), "final-verbatim-"));
  try {
    initGit(root);
    const profile = mirrorsProfile();
    registerWorkflowProfiles([profile]);
    const issued = singleCapability(profile, "build", "dev");
    seedState(root, { profile, stageCursor: "build", slug: "final", capability: issued.state });

    const padded = recordCheckpointDecision(root, {
      ...advanceAuthOf(issued),
      checkpoint: "gate_ok",
      checkpoint_id: "gate_ok",
      checkpoint_kind: "clarification",
      decision: " proceed ",
      authorization: "human",
      actor_provenance: { kind: "user", ref: "user:x" },
      rationale: "padded",
    });
    assert.equal(padded.ok, false, "a padded label is never normalized into an allowed decision");
    if (!padded.ok) assert.match(padded.error, /policy_invalid/);

    const blank = recordCheckpointDecision(root, {
      ...advanceAuthOf(issued),
      checkpoint: "gate_ok",
      checkpoint_id: "gate_ok",
      checkpoint_kind: "clarification",
      decision: "   ",
      authorization: "policy_auto",
      actor_provenance: { kind: "system", ref: "policy" },
      rationale: "blank",
    });
    assert.equal(blank.ok, false, "a whitespace-only decision is empty");

    const trusted = mintAnswer(root, "final", "build", "gate_ok", "proceed", "final/verbatim-answer");
    const recorded = recordDecision(root, advanceAuthOf(issued), "gate_ok", "clarification", "proceed", { ref: trusted.answer.reference, proof: trusted.proof }, "  padded rationale  ");
    assert.equal(recorded.ok, true, recorded.ok ? "recorded" : recorded.error);
    const stored = (readState(root, "final").typed_checkpoint_decisions ?? [])[0]!;
    assert.equal(stored.decision, "proceed");
    assert.equal(stored.rationale, "  padded rationale  ", "rationale is preserved verbatim, not trimmed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MEDIUM: status coherent after resolved pause / provider wait
// ---------------------------------------------------------------------------

test("final: after a provider wait and a resolved checkpoint the next stage reports a clean ready status", () => {
  const root = mkdtempSync(join(tmpdir(), "final-status-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = singleCapability(profile, "implementation", "dev");
    seedState(root, { profile, stageCursor: "implementation", slug: "final", capability: issued.state });
    // Lightweight implementation consumes the prior discovery artifact; keep
    // the upstream fixture schema valid before exercising provider wait.
    writeArtifacts(root, "final", { discovery: { task: "loop test", branch: "main" } });

    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;
    const pending = persistPendingDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, dispatch_id: authorized.record!.id, pending_reason: "provider_running", provider_ref: "provider-1" }, { runId: RUN_ID });
    assert.equal(pending.ok, true, pending.ok ? "pending persisted" : pending.error);

    const pausedContract = resolveWorkflowContract(root);
    assert.equal(pausedContract.status.lifecycle, "pending", "the provider wait reports pending for the CURRENT stage");
    assert.equal(pausedContract.status.pause, "background_wait");

    writeArtifacts(root, "final", { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "e" } });
    const completed = completeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "done", artifact_ids: ["implementation"] });
    assert.equal(completed.ok, true, completed.ok ? "completed" : completed.error);
    assert.equal(readState(root, "final").pause.kind, "none", "the last completion clears the background wait");

    // Checkpoint unresolved -> resumable pause; then the human answer
    // resolves it and the cursor moves with a CLEAN lifecycle.
    const blocked = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "fix done" });
    assert.equal(blocked.ok, false, "the checkpoint blocks until resolved");
    assert.equal(readState(root, "final").pause.kind, "user_checkpoint");

    const trusted = mintAnswer(root, "final", "implementation", "approve_implementation", "proceed", "final/status-answer");
    const recorded = recordDecision(root, advanceAuthOf(issued), "approve_implementation", "implementation_approval", "proceed", { ref: trusted.answer.reference, proof: trusted.proof }, "owner approved");
    assert.equal(recorded.ok, true, recorded.ok ? "recorded" : recorded.error);

    const advanced = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "fix done" });
    assert.equal(advanced.ok, true, advanced.ok ? "advanced to code_review" : advanced.error);
    const after = readState(root, "final");
    assert.equal(after.stage_cursor, "code_review");
    assert.equal(after.pause.kind, "none", "the resolved pause never reports the NEXT stage as paused");
    assert.equal("pending" in after, false);
    assert.equal("completion_envelope" in after, false);

    const contract = resolveWorkflowContract(root);
    assert.equal(contract.state.stageCursor, "code_review");
    assert.equal(contract.status.lifecycle, "ready", "the next stage's lifecycle is derived from the NEW stage, not the carried mirrors");
    assert.equal(contract.status.pause, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH: final advance publishes canonical completion and terminal controls
// ---------------------------------------------------------------------------

test("final: summary advance commits lifecycle completion before terminal control publication", () => {
  const root = mkdtempSync(join(tmpdir(), "final-terminal-advance-"));
  try {
    const { issued, context } = persistTerminalAdvanceFixture(root);
    const advanced = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "summary complete" });
    assert.equal(advanced.ok, true, advanced.ok ? "summary advanced" : advanced.error);
    if (!advanced.ok) return;

    const persisted = readRunState(root, RUN_ID, "main");
    assert.ok(persisted);
    assert.equal(persisted.lifecycle_status, "complete");
    assert.deepEqual(persisted.pause, { kind: "done", reason: "" });
    assert.deepEqual(persisted.stages.map((stage) => stage.status), ["done", "done"]);
    assert.equal(persisted.dispatch_capability?.status, "complete");

    const control = readRunControl(root);
    assert.deepEqual(control.runs[RUN_ID], candidateForState(persisted));
    assert.equal(control.runs[RUN_ID]?.status, "complete");
    assert.equal(control.execution_claim, null);
    assert.equal(control.selections[context.session_id]?.active, false);

    const resumeContext = terminalAdvanceContext(root, "terminal-resumer");
    const request: LifecycleRequest = {
      mode: "resume",
      request_id: "terminal-resume-after-advance",
      execution: resumeContext,
      run_id: RUN_ID,
      branch: "main",
    };
    const receipt: PrepareRequestReceipt = {
      request_id: request.request_id,
      payload_hash: lifecyclePayloadHash(request),
      operation: "resume",
      previous_run_id: RUN_ID,
      previous_title: "terminal advance",
      previous_status: "complete",
      selected_run_id: RUN_ID,
      selected_title: "terminal advance",
      selected_status: "complete",
      committed_at: new Date().toISOString(),
      continuation: { stage: "summary", status: "complete" },
    };
    assert.throws(
      () => resumeCanonicalRun(root, RUN_ID, resumeContext, { request, receipt }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_terminal",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final: rejected summary advance leaves canonical state and terminal controls unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "final-terminal-reject-"));
  try {
    const { issued } = persistTerminalAdvanceFixture(root);
    const beforeState = readRunState(root, RUN_ID, "main");
    const beforeControl = readRunControl(root);
    const rejected = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "   " });
    assert.equal(rejected.ok, false);
    assert.deepEqual(readRunState(root, RUN_ID, "main"), beforeState);
    assert.deepEqual(readRunControl(root), beforeControl);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("final: last-cursor advance rejects when an earlier stage remains nonterminal", () => {
  const root = mkdtempSync(join(tmpdir(), "final-terminal-nonterminal-"));
  try {
    const { issued } = persistTerminalAdvanceFixture(root);
    const changed = updateStateAtomically(root, (snapshot) => ({
      op: "commit",
      state: {
        ...snapshot.state!,
        stages: snapshot.state!.stages.map((stage) => stage.id === "prior" ? { ...stage, status: "pending" as const } : stage),
      },
    }), { target: runTarget(root, RUN_ID), branch: "main" });
    assert.equal(changed.ok, true);
    const beforeState = readRunState(root, RUN_ID, "main");
    const beforeControl = readRunControl(root);
    const rejected = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "summary complete" });
    assert.equal(rejected.ok, false);
    assert.deepEqual(readRunState(root, RUN_ID, "main"), beforeState);
    assert.deepEqual(readRunControl(root), beforeControl);
    assert.equal(beforeState?.lifecycle_status, "active");
    assert.equal(beforeState?.pause.kind, "none");
    assert.equal(beforeControl.selections["terminal-advance"]?.active, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("final: an outstanding worker blocks terminal completion, claim release, and selection demotion", () => {
  const root = mkdtempSync(join(tmpdir(), "final-terminal-worker-"));
  try {
    const { issued, context } = persistTerminalAdvanceFixture(root);
    updateRunControl(root, (control) => {
      const claim = control.execution_claim;
      if (!claim) throw new Error("terminal fixture claim missing");
      return {
        commit: true,
        value: undefined,
        control: { ...control, execution_claim: { ...claim, worker_ids: ["worker-pending"] } },
      };
    });
    const beforeState = readRunState(root, RUN_ID, "main");
    const beforeControl = readRunControl(root);
    const rejected = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "summary complete" });
    assert.equal(rejected.ok, false);
    assert.deepEqual(readRunState(root, RUN_ID, "main"), beforeState);
    const afterControl = readRunControl(root);
    assert.deepEqual(afterControl, beforeControl);
    assert.equal(afterControl.runs[RUN_ID]?.status, "active");
    assert.deepEqual(afterControl.execution_claim?.worker_ids, ["worker-pending"]);
    assert.equal(afterControl.selections[context.session_id]?.active, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("final: outstanding dispatches deny terminal publication with an owned or null control claim", () => {
  const root = mkdtempSync(join(tmpdir(), "final-terminal-dispatch-"));
  try {
    initGit(root);
    const profile = terminalAdvanceProfile();
    registerWorkflowProfiles([profile]);
    const issued = createCapability({
      run_key: RUN_ID,
      branch: "main",
      workflow: profile.name,
      profile_hash: profileHash(profile),
      stage_cursor: "summary",
      kind: "single",
      expected_roster: [{ role: "dev", agent: "dev" }],
    });
    const context = terminalAdvanceContext(root);
    persistCanonicalRun(root, terminalAdvanceState(profile, issued), { context });
    const authorized = authorizeDispatch(root, {
      ...advanceAuthOf(issued),
      token: issued.dispatch_token,
      role: "dev",
      agent: "dev",
    });
    assert.equal(authorized.ok, true, authorized.ok ? "dispatch authorized" : authorized.error);
    if (!authorized.ok) return;

    const beforeState = readRunState(root, RUN_ID, "main");
    assert.ok(beforeState);
    if (!beforeState) return;
    const terminalState: TeamState = {
      ...beforeState,
      lifecycle_status: "complete",
      pause: { kind: "done", reason: "" },
      stages: beforeState.stages.map((stage) => ({ ...stage, status: "done" as const })),
      ...(beforeState.dispatch_capability
        ? { dispatch_capability: { ...beforeState.dispatch_capability, status: "complete" as const, dispatches: [] } }
        : {}),
    };
    const beforeOwnedControl = readRunControl(root);
    assert.throws(
      () => terminalControlPublication(root, beforeState, terminalState),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readRunState(root, RUN_ID, "main"), beforeState);
    assert.deepEqual(readRunControl(root), beforeOwnedControl);
    assert.equal(beforeOwnedControl.selections[context.session_id]?.active, true);

    updateRunControl(root, (control) => ({
      commit: true,
      value: undefined,
      control: { ...control, execution_claim: null },
    }));
    const beforeNullClaimControl = readRunControl(root);
    assert.equal(beforeNullClaimControl.execution_claim, null);
    assert.throws(
      () => terminalControlPublication(root, beforeState, terminalState),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_busy",
    );
    assert.deepEqual(readRunState(root, RUN_ID, "main"), beforeState);
    assert.deepEqual(readRunControl(root), beforeNullClaimControl);
    assert.equal(beforeNullClaimControl.selections[context.session_id]?.active, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// PR review: raw snapshot, commit point, journal generation and observability
// ---------------------------------------------------------------------------

test("review: atomic update derives state/revision/hash from the one post-resolution raw read", () => {
  const root = mkdtempSync(join(tmpdir(), "review-raw-snapshot-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    setStateTransactionTestHooks({
      afterTargetResolution: ({ statePath }) => {
        const moved = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
        writeFileSync(statePath, JSON.stringify({ ...moved, task: "writer-between-resolution-and-read" }, null, 2) + "\n");
      },
    });
    const updated = updateStateAtomically(root, (snapshot) => {
      assert.equal(snapshot.state?.task, "writer-between-resolution-and-read");
      return { op: "commit", state: { ...snapshot.state!, task: "committed-from-fresh-raw" } };
    }, { target: canonicalTarget(root), branch: "main" });
    assert.equal(updated.ok, true);
    assert.equal(readState(root, "final").task, "committed-from-fresh-raw");
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: stale opts.target state is ignored in favor of its current raw bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "review-stale-target-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const stale = { ...canonicalTarget(root), state: readState(root, "final") };
    const moved = stale.state;
    writeFileSync(statePathOf(root, "final"), JSON.stringify({ ...moved, task: "newer-than-target" }, null, 2) + "\n");
    const updated = updateStateAtomically(root, (snapshot) => {
      assert.equal(snapshot.state?.task, "newer-than-target");
      return { op: "discard", value: snapshot.state?.task };
    }, { target: stale, branch: "main" });
    assert.equal(updated.ok, true);
    if (updated.ok) assert.equal(updated.value, "newer-than-target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: concurrent creation at an absent final destination is a CAS conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "review-absent-create-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const seedBytes = readFileSync(statePathOf(root, "final"), "utf8");
    const destinationPath = statePathOf(root, "final");
    rmSync(destinationPath);
    setStateTransactionTestHooks({
      beforeCas: ({ destinationPath }) => {
        writeFileSync(destinationPath, seedBytes);
      },
    });
    const updated = updateStateAtomically(root, () => ({
      op: "commit",
      state: JSON.parse(seedBytes) as TeamState,
    }), { target: canonicalTarget(root), branch: "main" });
    assert.equal(updated.ok, false);
    if (!updated.ok) {
      assert.equal(updated.code, "state_conflict");
      assert.match(updated.error, /created during the transaction/);
    }
    assert.equal(readFileSync(destinationPath, "utf8"), seedBytes);
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: state.md fault rolls artifact writes back before releasing the state lock", () => {
  const root = mkdtempSync(join(tmpdir(), "review-state-md-fault-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const statePath = statePathOf(root, "final");
    const before = readFileSync(statePath, "utf8");
    const mirrorPath = join(runPath(root), "team-state.md");
    rmSync(mirrorPath);
    mkdirSync(mirrorPath);
    setStateTransactionTestHooks({
      afterJournalFinalize: ({ committed, lockPath }) => {
        assert.equal(committed, false);
        assert.ok(existsSync(lockPath), "rollback finalized while the state lock was still held");
        assert.equal(readArtifact(join(runPath(root), "artifacts"), "journal-fault"), null);
      },
    });
    const updated = updateStateAtomically(root, (snapshot) => {
      writeArtifact(snapshot.target.artifactsDir!, "journal-fault", { partial: true });
      return { op: "commit", state: { ...snapshot.state!, task: "must-not-commit" } };
    }, { target: canonicalTarget(root), branch: "main" });
    assert.equal(updated.ok, false);
    if (!updated.ok) assert.match(updated.error, /sidecar is not a regular file/);
    assert.equal(readFileSync(statePath, "utf8"), before);
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});


test("review: rollback is generation-safe and does not overwrite a lockless artifact replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "review-generation-safe-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const artifactPath = join(runPath(root), "artifacts", "generation.json");
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        writeFileSync(artifactPath, JSON.stringify({ owner: "lockless-writer" }) + "\n");
        const moved = JSON.parse(readFileSync(sourcePath, "utf8")) as TeamState;
        writeFileSync(sourcePath, JSON.stringify({ ...moved, task: "force-conflict" }, null, 2) + "\n");
      },
      afterJournalFinalize: ({ committed, lockPath }) => {
        assert.equal(committed, false);
        assert.ok(existsSync(lockPath));
        assert.deepEqual(JSON.parse(readFileSync(artifactPath, "utf8")), { owner: "lockless-writer" });
      },
    });
    const updated = updateStateAtomically(root, (snapshot) => {
      writeArtifact(snapshot.target.artifactsDir!, "generation", { owner: "transaction" });
      return { op: "commit", state: { ...snapshot.state!, task: "parent" } };
    }, { target: canonicalTarget(root), branch: "main" });
    assert.equal(updated.ok, false);
    if (!updated.ok) assert.equal(updated.code, "state_conflict");
    assert.deepEqual(JSON.parse(readFileSync(artifactPath, "utf8")), { owner: "lockless-writer" });
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: CAS rejection publishes neither artifact_written nor stage_transition", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-no-phantom-events-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        const moved = JSON.parse(readFileSync(sourcePath, "utf8")) as TeamState;
        writeFileSync(sourcePath, JSON.stringify({ ...moved, task: "lockless-conflict" }, null, 2) + "\n");
      },
    });
    const updated = updateStateAtomically(root, (snapshot) => {
      writeArtifact(snapshot.target.artifactsDir!, "phantom", { should_not_exist: true });
      const next = setStageStatus(snapshot.state!, "discovery", "done", root);
      return { op: "commit", state: next };
    }, { target: canonicalTarget(root), branch: "main" });
    assert.equal(updated.ok, false);
    await flushRecorder(root);
    assert.equal(readArtifact(join(runPath(root), "artifacts"), "phantom"), null);
    assert.equal(existsSync(join(runPath(root), "observability", "events.jsonl")), false);
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Bounded spin used ONLY to observe cross-process file state (see file note). */
function busySpin(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // bounded spin until the observed deadline
  }
}

