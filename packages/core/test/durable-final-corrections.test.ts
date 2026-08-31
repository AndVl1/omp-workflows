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
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceCursor,
  authorizeDispatch,
  beginCapability,
  completeDispatch,
  createCapability,
  persistPendingDispatch,
  recordCheckpointDecision,
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
import { resolveState, setStageStatus, setStateTransactionTestHooks, updateStateAtomically, writeStateBootstrap, type StateMutation } from "../src/engine/state.js";
import { readArtifact, writeArtifact } from "../src/engine/artifacts.js";
import { flushRecorder } from "../src/observability/hooks.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import type { CheckpointAnswerProof, CheckpointPolicy, Profile, TeamState } from "../src/engine/types.js";

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

function statePathOf(root: string, slug: string): string {
  return join(root, ".work-state", "features", slug, "state.json");
}

function readState(root: string, slug: string): TeamState {
  return JSON.parse(readFileSync(statePathOf(root, slug), "utf8")) as TeamState;
}

function writeArtifacts(root: string, slug: string, artifacts: Record<string, unknown>): void {
  const dir = join(root, ".work-state", "features", slug, "artifacts");
  mkdirSync(dir, { recursive: true });
  for (const [id, value] of Object.entries(artifacts)) writeFileSync(join(dir, `${id}.json`), JSON.stringify(value));
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

interface SeedOptions {
  profile: Profile;
  stageCursor: string;
  slug: string;
  capability?: TeamState["dispatch_capability"];
  decisions?: TeamState["typed_checkpoint_decisions"];
  checkpointPolicy?: TeamState["checkpoint_policy"];
}

function seedState(root: string, opts: SeedOptions): void {
  const state = {
    schema: 1 as const,
    branch: "main",
    run_key: "main",
    classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: opts.profile.name },
    task: "final corrections",
    workflow_override: false,
    issue: null,
    stage_cursor: opts.stageCursor,
    stages: opts.profile.stages.map((stage) => ({ id: stage.id, status: stage.id === opts.stageCursor ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(opts.profile),
    scope: scopeFlags(),
    updated_at: new Date().toISOString(),
    ...(opts.capability ? { dispatch_capability: opts.capability, cursor_epoch: opts.capability.issued_for!.cursor_epoch } : {}),
    ...(opts.decisions ? { typed_checkpoint_decisions: opts.decisions } : {}),
    ...(opts.checkpointPolicy ? { checkpoint_policy: opts.checkpointPolicy } : {}),
  } as TeamState;
  writeStateBootstrap(root, state, { featureSlug: opts.slug });
}

function noneCapability(profile: Profile, stageId: string): IssuedCapability {
  return createCapability({
    run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
    stage_cursor: stageId, kind: "none", expected_roster: [],
  });
}

function singleCapability(profile: Profile, stageId: string, role: string): IssuedCapability {
  return createCapability({
    run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
    stage_cursor: stageId, kind: "single", expected_roster: [{ role, agent: role }],
  });
}

function advanceAuthOf(issued: IssuedCapability): DispatchAuth {
  const issuedFor = issued.state.issued_for!;
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: "main",
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

/**
 * Mint a trusted terminal answer for the CURRENT scope and persist it —
 * mirroring the ask tool's durable commit that precedes every record call.
 */
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
  writeStateBootstrap(root, trusted.state, { featureSlug: slug });
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
      const commit: StateMutation<void> = { op: "commit", state: { ...snapshot.state, task: "parent" } };
      return commit;
    });
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

    const result = updateStateAtomically(root, (snapshot) => ({ op: "commit", state: { ...snapshot.state!, task: "stamped" }, value: undefined }));
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
    const boundArtifact = readArtifact<Record<string, unknown>>(join(root, ".work-state", "features", "final", "artifacts"), "product_approval_record");
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
    writeStateBootstrap(root, reopened, { featureSlug: "final" });
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
    writeStateBootstrap(root, resumed, { featureSlug: "final" });
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

    const ask = validateCheckpointAsk(root, { ...withoutIteration, token: issued.advance_token, checkpoint: "none_declared", checkpoint_id: "none_declared", checkpoint_kind: "clarification" });
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
    if (!authorized.ok) assert.match(authorized.error, /dispatch capability unavailable/);

    const advanced = advanceCursor(root, { token: "whatever", capability_id: "cap-partial", run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile), stage_cursor: "discovery", cursor_epoch: "epoch-partial", loop_iteration: 1, evidence: "e" });
    assert.equal(advanced.ok, false);
    if (!advanced.ok) assert.match(advanced.error, /dispatch capability unavailable/);

    const completed = completeDispatch(root, { token: "whatever", capability_id: "cap-partial", dispatch_id: "d1", run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile), stage_cursor: "discovery", cursor_epoch: "epoch-partial", loop_iteration: 1, outcome: "succeeded", evidence: "e" });
    assert.equal(completed.ok, false);
    if (!completed.ok) assert.match(completed.error, /dispatch capability unavailable/);

    // A shape-valid pre-loop-scope capability stays REPLACEABLE via begin.
    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "workflow_begin re-issued a complete capability" : begun.error);
    if (!begun.ok) return;
    const after = readState(root, "final");
    assert.equal(after.dispatch_capability?.capability_id, begun.handoff!.capability_id);
    assert.ok(after.dispatch_capability?.dispatches, "the re-issued capability is complete");

    // A primitive capability cannot even be persisted: normalization rejects
    // the state instead of storing a broken control plane.
    assert.throws(() => writeStateBootstrap(root, { ...readState(root, "final"), dispatch_capability: null as unknown as TeamState["dispatch_capability"] }, { featureSlug: "final" }), /malformed or conflicting typed control-plane fields/);
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
    if (!blank.ok) assert.match(blank.error, /decision_invalid|checkpoint name and decision are required/);

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

    const authorized = authorizeDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, role: "dev", agent: "dev" });
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    if (!authorized.ok) return;
    const pending = persistPendingDispatch(root, { ...advanceAuthOf(issued), token: issued.dispatch_token, dispatch_id: authorized.record!.id, pending_reason: "provider_running", provider_ref: "provider-1" });
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
    });
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
    const stale = resolveState(root, "main");
    const moved = readState(root, "final");
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
    rmSync(statePathOf(root, "final"));
    setStateTransactionTestHooks({
      beforeCas: ({ destinationPath }) => {
        writeFileSync(destinationPath, seedBytes);
      },
    });
    const updated = updateStateAtomically(root, () => ({
      op: "commit",
      state: JSON.parse(seedBytes) as TeamState,
    }));
    assert.equal(updated.ok, false);
    if (!updated.ok) {
      assert.equal(updated.code, "state_conflict");
      assert.match(updated.error, /created during the transaction/);
    }
    assert.equal(readFileSync(statePathOf(root, "final"), "utf8"), seedBytes);
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: creation at a stale target's future branch destination is never overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "review-future-create-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "old" });
    const oldPath = statePathOf(root, "old");
    const old = JSON.parse(readFileSync(oldPath, "utf8")) as TeamState;
    writeFileSync(oldPath, JSON.stringify({ ...old, branch: "foreign" }, null, 2) + "\n");
    let createdBytes = "";
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath, destinationPath }) => {
        assert.notEqual(destinationPath, sourcePath);
        mkdirSync(join(root, ".work-state", "features", "main", "artifacts"), { recursive: true });
        const future = { ...old, branch: "main", task: "concurrent-future-run" };
        createdBytes = JSON.stringify(future, null, 2) + "\n";
        writeFileSync(destinationPath, createdBytes);
      },
    });
    const updated = updateStateAtomically(root, (snapshot) => ({
      op: "commit",
      state: { ...snapshot.state!, branch: "main", task: "would-clobber" },
    }), { branch: "main" });
    assert.equal(updated.ok, false);
    if (!updated.ok) assert.match(updated.error, /future destination/);
    assert.equal(readFileSync(statePathOf(root, "main"), "utf8"), createdBytes);
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
    const mirrorPath = join(root, ".work-state", "features", "final", "team-state.md");
    rmSync(mirrorPath);
    mkdirSync(mirrorPath);
    setStateTransactionTestHooks({
      afterJournalFinalize: ({ committed, lockPath }) => {
        assert.equal(committed, false);
        assert.ok(existsSync(lockPath), "rollback finalized while the state lock was still held");
        assert.equal(readArtifact(join(root, ".work-state", "features", "final", "artifacts"), "journal-fault"), null);
      },
    });
    const updated = updateStateAtomically(root, (snapshot) => {
      writeArtifact(snapshot.target.artifactsDir!, "journal-fault", { partial: true });
      return { op: "commit", state: { ...snapshot.state!, task: "must-not-commit" } };
    });
    assert.equal(updated.ok, false);
    if (!updated.ok) assert.match(updated.error, /sidecar is not a regular file/);
    assert.equal(readFileSync(statePath, "utf8"), before);
  } finally {
    setStateTransactionTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: active-feature fault leaves state and journaled artifacts uncommitted", () => {
  const root = mkdtempSync(join(tmpdir(), "review-active-fault-"));
  try {
    initGit(root);
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    seedState(root, { profile, stageCursor: "discovery", slug: "final" });
    const target = resolveState(root, "main");
    const statePath = statePathOf(root, "final");
    const before = readFileSync(statePath, "utf8");
    const activePath = join(root, ".work-state", ".active-feature");
    rmSync(activePath);
    mkdirSync(activePath);
    const updated = updateStateAtomically(root, (snapshot) => {
      writeArtifact(snapshot.target.artifactsDir!, "active-fault", { partial: true });
      return { op: "commit", state: { ...snapshot.state!, task: "must-not-commit" } };
    }, { target, branch: "main" });
    assert.equal(updated.ok, false);
    if (!updated.ok) assert.match(updated.error, /sidecar is not a regular file/);
    assert.equal(readFileSync(statePath, "utf8"), before);
    assert.equal(readArtifact(target.artifactsDir!, "active-fault"), null);
  } finally {
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
    const artifactPath = join(root, ".work-state", "features", "final", "artifacts", "generation.json");
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
    });
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
    });
    assert.equal(updated.ok, false);
    await flushRecorder(root);
    assert.equal(readArtifact(join(root, ".work-state", "features", "final", "artifacts"), "phantom"), null);
    assert.equal(existsSync(join(root, ".work-state", "features", "final", "observability", "events.jsonl")), false);
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
