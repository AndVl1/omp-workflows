/**
 * RC2+ regression tests: the static parser is a MECHANICAL `autonomyHint`,
 * never an authority. The main LLM classifies `type`/`complexity`/
 * `confidence`/`autonomous` together at PHASE-0 (in any language); the P5
 * gate reads `classification.autonomous` (the model decision), fails closed
 * on missing/non-boolean values, and never lets a static hint force a
 * workflow. Legacy top-level `TeamState.autonomous` is read-compat only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability, beginCapability, authorizeDispatch, authorizeDispatchTrusted, completeDispatch, reconcileTrustedTaskResult, advanceCursor } from "../src/engine/durable.js";
import { resolveConfig } from "../src/engine/config.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { appendCheckpointDecision, checkpointPolicyHash, issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, registerTrustedCheckpointHostBridge } from "../src/engine/checkpoints.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { buildDispatchMarker, parseDispatchMarker, trustedDispatchRequests } from "../src/gates/dispatch.js";
import { dodBackstop, validateTypedDoD } from "../src/gates/dod-backstop.js";
import { registerTestTeamWorkflow } from "./fixtures/registry-activation.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { createFeatureWorkspace } from "../src/specification/workspace.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { prepareWorkflowState as prepareWorkflowStateSource, resolveClassification as resolveClassificationSource } from "../src/engine/run.js";

import {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  keywordClassify,
  resolveWorkflow,
  resolveClassification,
  prepareWorkflowState,
  classificationGate,
  buildCtoPrompt,
} from "@andvl1/omp-workflows-core";

function writeWorkflowState(root: string, state: Record<string, unknown>): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(state));
}

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

const trustedIntakeRoles = { "specification-analyst": "specification-worker", "tech-researcher": "tech-researcher" } as const;
const TEST_CHECKPOINT_BRIDGE = Object.freeze({});
registerTrustedCheckpointHostBridge(TEST_CHECKPOINT_BRIDGE);
/** Publish a trusted live agent mapping covering the spec-preparation intake pool. */
function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: trustedIntakeRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(trustedIntakeRoles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(trustedIntakeRoles),
    source: "do-work-autonomy-test",
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
  });
  writeAgentMapping(root, mapping);
}
function recordTypedCheckpoint(root: string, stageId: string, checkpointId: string): void {
  const resolved = resolveState(root);
  assert.ok(resolved.state, "checkpoint fixture state must resolve");
  const state = resolved.state!;
  const policy = state.checkpoint_policy;
  const capability = state.dispatch_capability;
  assert.ok(policy, "checkpoint fixture must have a typed policy");
  assert.ok(capability?.capability_id && capability.issued_for?.cursor_epoch, "checkpoint fixture must have a capability binding");
  const rule = policy.rules[checkpointId];
  assert.ok(rule, `checkpoint fixture must define ${checkpointId}`);
  const runId = state.work_identity?.run_id ?? state.run_key ?? state.branch;
  const answerId = `do-work/${stageId}/${checkpointId}`;
  const reference = `terminal-answer/do-work/${stageId}/${checkpointId}`;
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot, "checkpoint fixture root must pin");
  if (!pinnedRoot) return;
  if (!state.profile_hash) {
    pinnedRoot.close();
    return;
  }
  try {
    const rootIdentity = { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
    const capabilityAnswer = issueTrustedCheckpointAnswerCapability(TEST_CHECKPOINT_BRIDGE, {
      root: rootIdentity,
      state,
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: stageId,
      checkpoint_id: checkpointId,
      decision: "proceed",
      question: "Authorize the fixture checkpoint",
      options: ["proceed"],
      session_id: "do-work-autonomy-test-session",
      actor_ref: reference,
      profile_hash: state.profile_hash,
    });
    const trusted = recordTrustedCheckpointAnswer(state, {
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: stageId,
      checkpoint_id: checkpointId,
      decision: "proceed",
    }, { capability: capabilityAnswer, root: rootIdentity });
  const typed = {
    run_id: runId,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    checkpoint_kind: rule.kind,
    decision: "proceed",
    authorization: "human" as const,
    actor: { kind: "user" as const, ref: trusted.answer.reference, proof: trusted.proof },
    capability_id: capability.capability_id,
    capability_epoch: capability.issued_for!.cursor_epoch,
    policy_hash: checkpointPolicyHash(policy),
    rationale: "explicit typed fixture answer",
    decided_at: new Date().toISOString(),
  };
    writeState(root, appendCheckpointDecision(trusted.state, typed), { target: resolved });
  } finally {
    pinnedRoot.close();
  }
}
test("do-work: matching-branch state prompt is resumable", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-resume-match-"));
  try {
    writeWorkflowState(root, { branch: "feat/current", task: "previous fix" });
    const prompt = buildDoWorkPrompt({ task: "feedback", autonomyHint: false, issue: null, branch: "feat/current" }, root);
    assert.match(prompt, /resumable continuation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: stale active-feature state starts a new workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-resume-stale-"));
  try {
    mkdirSync(join(root, ".work-state", "features", "old"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "old\n");
    writeFileSync(join(root, ".work-state", "features", "old", "state.json"), JSON.stringify({ branch: "feat/old", task: "previous fix" }));
    const prompt = buildDoWorkPrompt({ task: "feedback", autonomyHint: false, issue: null, branch: "feat/current" }, root);
    assert.match(prompt, /No existing do-work state was found/);
    assert.doesNotMatch(prompt, /resumable continuation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_prepare: stale active-feature state is replaced for the current branch", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-stale-feature-"));
  try {
    initGit(root, "main");
    mkdirSync(join(root, ".work-state", "features", "old"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "old\n");
    writeFileSync(join(root, ".work-state", "features", "old", "state.json"), JSON.stringify({
      schema: 1,
      branch: "feat/old",
      task: "previous fix",
      classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" },
      stage_cursor: "discovery",
      stages: [{ id: "discovery", status: "pending" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
    }));
    const prepared = prepareWorkflowState({
      task: "current branch fix",
      cwd: root,
      branch: "main",
      autonomous: false,
      classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false },
      files: [],
      issue: null,
    });
    assert.equal(prepared.statePath, realpathSync(join(root, ".work-state", "features", "main", "state.json")));
    assert.equal(resolveState(root, "main").state?.branch, "main");
    assert.equal(readFileSync(join(root, ".work-state", ".active-feature"), "utf8"), "main\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("workflow_prepare adaptive QUICK uses root legacy state without feature workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-adaptive-quick-"));
  try {
    initGit(root, "feat/adaptive");
    const prepared = prepareWorkflowStateSource({
      task: "Correct the deploy script usage banner that prints the wrong flag name",
      cwd: root,
      branch: "feat/adaptive",
      autonomous: false,
      classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false },
      files: [],
      issue: null,
      adaptiveQuick: true,
    });
    assert.equal(prepared.statePath, realpathSync(join(root, ".work-state", "team-state.json")));
    assert.equal(existsSync(join(root, ".work-state", "features")), false);
    const resolved = resolveState(root, "feat/adaptive");
    assert.equal(resolved.isLegacy, true);
    assert.equal(resolved.state?.classification?.complexity, "QUICK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("workflow_prepare: stale retarget preserves a newer destination created before CAS", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-stale-destination-race-"));
  try {
    initGit(root, "main");
    mkdirSync(join(root, ".work-state", "features", "old"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "old\n");
    writeFileSync(join(root, ".work-state", "features", "old", "state.json"), JSON.stringify({
      schema: 1,
      branch: "feat/old",
      task: "previous fix",
      classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" },
      stage_cursor: "discovery",
      stages: [{ id: "discovery", status: "pending" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
    }));
    const destinationPath = join(realpathSync(root), ".work-state", "features", "main", "state.json");
    const newerBytes = JSON.stringify({
      schema: 1,
      state_revision: 8,
      branch: "main",
      task: "newer current-branch workflow",
      classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "standard" },
      stage_cursor: "discovery",
      stages: [{ id: "discovery", status: "in_progress" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
    }, null, 2) + "\n";
    let injected = false;
    setStateTransactionTestHooks({
      beforeCas: ({ destinationPath: resolvedDestination }) => {
        if (injected) return;
        injected = true;
        assert.equal(resolvedDestination, destinationPath);
        writeFileSync(resolvedDestination, newerBytes);
      },
    }, root);
    try {
      assert.throws(
        () => prepareWorkflowStateSource({
          task: "current branch fix",
          cwd: root,
          branch: "main",
          autonomous: false,
          classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false },
          files: [],
          issue: null,
        }),
        /state_conflict: workflow state was created during the transaction/,
      );
    } finally {
      setStateTransactionTestHooks(null, root);
    }
    assert.equal(injected, true, "the deterministic race hook must run");
    assert.equal(readFileSync(destinationPath, "utf8"), newerBytes, "a newer destination must never be overwritten");
    assert.equal(readFileSync(join(root, ".work-state", ".active-feature"), "utf8"), "old\n", "failed prepare must not publish a new pointer");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveState: incomplete active feature blocks legacy root without migration", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-active-feature-legacy-fallback-"));
  try {
    initGit(root, "main");
    mkdirSync(join(root, ".work-state", "features", "stale"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "stale\n");
    writeFileSync(join(root, ".work-state", "features", "stale", "state.json"), JSON.stringify({
      schema: 1,
      branch: "main",
      task: "incomplete feature state",
    }));
    writeWorkflowState(root, {
      schema: 1,
      branch: "main",
      classification: {
        type: "SPEC",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: true,
        workflow: "spec-preparation",
      },
      task: "current task",
      stage_cursor: "specify",
      stages: [{ id: "specify", status: "in_progress" }],
      artifacts: {},
      workflow_override: false,
      issue: null,
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
      policy: { strict_orchestrator: true },
    }, root);

    const resolved = resolveState(root, "main");
    assert.equal(resolved.isLegacy, false);
    assert.equal(resolved.statePath, realpathSync(join(root, ".work-state", "features", "stale", "state.json")));
    assert.equal(resolved.state?.classification, undefined, "incomplete active feature has no executable classification");
    const legacyPath = join(root, ".work-state", "team-state.json");
    const legacyBefore = readFileSync(legacyPath, "utf8");
    const activeFeaturePath = join(root, ".work-state", "features", "stale", "state.json");
    const activeFeatureBefore = readFileSync(activeFeaturePath, "utf8");
    publishMapping(root);
    const begun = beginCapability(root);
    assert.equal(begun.ok, false, "legacy state requires explicit migration before capability issuance");
    assert.equal(begun.state?.dispatch_capability, undefined, "migration-required legacy admission cannot issue a capability");
    assert.equal(readFileSync(legacyPath, "utf8"), legacyBefore, "fail-closed legacy handling must not rewrite the source state");
    assert.equal(readFileSync(activeFeaturePath, "utf8"), activeFeatureBefore, "migration-required legacy admission must not mutate the active feature state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("beginCapability: migrates pre-durable top-level workflow state", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-legacy-state-migration-"));
  try {
    initGit(root, "main");
    writeWorkflowState(root, {
      task: "legacy spec task",
      branch: "main",
      classification: {
        type: "SPEC",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: true,
      },
      workflow: "spec-preparation",
      status: "in_progress",
      pending_stages: ["research", "architecture", "specification", "review"],
      history: [],
    });

    const resolved = resolveState(root, "main");
    assert.equal(resolved.state?.classification.workflow, "spec-preparation");
    assert.deepEqual(resolved.state?.stages, []);
    publishMapping(root);
    const begun = beginCapability(root);
    assert.equal(begun.ok, true, begun.ok ? "" : begun.error);
    assert.equal(begun.state?.stage_cursor, "specify");
    assert.ok(begun.state?.stages.some((stage) => stage.id === "specify"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("beginCapability: remains fail-closed for incomplete state shapes", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-incomplete-state-shape-"));
  try {
    initGit(root, "main");
    writeWorkflowState(root, {
      task: "incomplete state",
      branch: "main",
      classification: {
        type: "SPEC",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: true,
        workflow: "spec-preparation",
      },
    });

    const begun = beginCapability(root);
    assert.equal(begun.ok, false);
    assert.equal(begun.error, "workflow stages are missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("resolveState: rejects feature artifacts that escape through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "state-artifact-symlink-"));
  try {
    const featureDir = join(root, ".work-state", "features", "current");
    const outside = join(root, "outside-artifacts");
    mkdirSync(featureDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "current\n");
    writeFileSync(join(featureDir, "state.json"), JSON.stringify({ branch: "feat/current" }));
    symlinkSync(outside, join(featureDir, "artifacts"), "dir");
    const resolved = resolveState(root, "feat/current");
    assert.equal(resolved.invalid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: natural-language directive sets the hint and strips from task", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-ru-"));
  try {
    const envelope = parseWorkEnvelope("действуй автономно: исправь 500 на /api/users issue=#42", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "исправь 500 на /api/users");
    assert.equal(envelope.issue, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: [AUTONOMOUSLY] lookalike stays literal and hint is false", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-look-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root);
    assert.equal(envelope.autonomyHint, false);
    assert.equal(envelope.task, "[AUTONOMOUSLY] Fix bug", "lookalike must survive verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) /cto and /do-work share the four-field classification contract ──────

test("do-work: prompt renders the hint as NON-authoritative metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-prompt-"));
  try {
    const on = buildDoWorkPrompt(parseWorkEnvelope("действуй автономно: Fix bug", root), root);
    assert.ok(on.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording rendered");
    assert.ok(on.includes("Never copy the hint into persisted"), "hint must not be copied as the decision");
    assert.ok(!on.includes("state.autonomous: true"), "prompt must NOT instruct persisting the parsed flag");
    assert.ok(!on.includes("state.autonomous: false"), "prompt must NOT instruct persisting the parsed flag");

    const off = buildDoWorkPrompt(parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root), root);
    assert.ok(off.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording rendered");
    assert.ok(off.includes("[AUTONOMOUSLY] Fix bug"), "task text carries the lookalike verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification contract: /do-work and /cto request the SAME four model fields", () => {
  const root = mkdtempSync(join(tmpdir(), "class-contract-"));
  try {
    const work = buildDoWorkPrompt(parseWorkEnvelope("Fix login bug", root), root);
    const cto = buildCtoPrompt(parseWorkEnvelope("Fix login bug", root), root);
    for (const prompt of [work, cto]) {
      assert.ok(prompt.includes("CLASSIFICATION:"), "visible classification block");
      assert.ok(prompt.includes("- Type: FEATURE | REFACTOR | OPS | BUG_FIX | SPEC | REGRESS | INVESTIGATION | REVIEW | HOTFIX"), "Type field");
      assert.ok(prompt.includes("- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL"), "Complexity field");
      assert.ok(prompt.includes("- Confidence: HIGH | MEDIUM | LOW"), "Confidence field");
      assert.ok(prompt.includes("- Autonomous: true | false"), "Autonomous field");
      assert.ok(prompt.includes("Autonomy is YOUR decision"), "model decides autonomy");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (a) hint false + natural-language autonomy → model true → debug-cycle ───

test("P5 gate: natural-language autonomous task (hint false) is accepted as debug-cycle when the MODEL decides true", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-model-auto-"));
  try {
    const envelope = parseWorkEnvelope("Do this without waiting for approval — fix the login bug", root);
    assert.equal(envelope.autonomyHint, false, "parser does NOT recognize natural-language autonomy");

    // The prompt hands the FULL task to the model and lets it decide true.
    const prompt = buildDoWorkPrompt(envelope, root);
    assert.ok(prompt.includes("Do this without waiting for approval"), "full task visible to PHASE-0");
    assert.ok(prompt.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording is explicit");

    // Model output: autonomous=true -> debug-cycle passes the gate.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: true, autonomous_reason: "task explicitly waives approval" },
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "model autonomous=true accepted as debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) hint true + contradictory task → model false → interactive ─────────

test("P5 gate: [AUTONOMOUS] marker can be OVERRIDDEN by the model to interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Walk me through each step before touching code", root);
    assert.equal(envelope.autonomyHint, true, "static hint is ON");

    const prompt = buildDoWorkPrompt(envelope, root);
    assert.ok(prompt.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording rendered");
    assert.ok(prompt.includes("does not authorize a checkpoint"), "prompt separates routing from checkpoint permission");

    // Model decides autonomous=false -> interactive bug-fix passes; debug-cycle blocks.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false, autonomous_reason: "user wants step-by-step review" },
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "model false stays interactive");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "interactive QUICK BUG_FIX with debug-cycle is blocked");
    assert.ok(blocked?.reason?.includes("expected 'bug-fix'"), "block names the interactive resolution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) absent / non-boolean classification.autonomous blocks ───────────────

test("P5 gate: missing classification.autonomous blocks — no silent default", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "missing autonomous blocks");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: non-boolean classification.autonomous blocks — fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-nonbool-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "string autonomous blocks");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) workflow_override can never bypass the fail-closed autonomy gate ────

test("P5 gate: workflow_override:true cannot bypass MISSING classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-missing-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      workflow_override: true,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "an explicit override must not bypass a missing model autonomy field");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true cannot bypass NON-BOOLEAN classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-nonbool-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
      workflow_override: true,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "an explicit override must not bypass a non-boolean model autonomy field");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true still allows a VALID model autonomy decision", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-valid-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
      workflow_override: true,
    });
    assert.equal(
      classificationGate({ agent: "developer" }, { cwd: root }),
      undefined,
      "override with a valid boolean decision passes — the override skips the mismatch check, not the autonomy gate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (e) legacy top-level state reads safely; new field wins over legacy ─────

test("P5 gate: legacy top-level autonomous reads compatibly when the model field is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-legacy-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      autonomous: true,
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "legacy autonomous=true + debug-cycle passes");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      autonomous: false,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "legacy autonomous=false must NOT silently run debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: a present model field wins over the legacy top-level field", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-priority-"));
  try {
    // Legacy says true, model says false — the model decision is the authority.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
      autonomous: true,
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "model false keeps it interactive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── static hint can never force autonomous ──────────────────────────────────

test("P5 gate: a static hint cannot force autonomous — hint true + model false stays interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-static-hint-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Fix bug", root);
    assert.equal(envelope.autonomyHint, true);

    // Even with the marker present, the persisted model decision rules.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "hint true must not force debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── engine classification is demoted and cannot pick autonomy ───────────────

test("do-work: keywordClassify guesses type/complexity only — it cannot decide autonomy", () => {
  const base = keywordClassify("fix the login bug");
  assert.equal(base.type, "BUG_FIX", "keyword guess still detects the type");
  assert.ok(!("autonomous" in base), "keyword guess has no autonomous field");
  assert.equal(resolveWorkflow(base.type, base.complexity, true), "debug-cycle", "autonomous BUG_FIX resolves to debug-cycle even at QUICK");
  assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix", "interactive QUICK BUG_FIX stays bug-fix");
});

test("do-work: type/complexity/autonomous resolve together from the model classification", () => {
  const auto = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true, workflow: "debug-cycle" };
  const interactive = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" };
  assert.equal(resolveWorkflow(auto.type, auto.complexity, auto.autonomous), auto.workflow, "model auto classification maps to debug-cycle");
  assert.equal(resolveWorkflow(interactive.type, interactive.complexity, interactive.autonomous), interactive.workflow, "model interactive classification maps to bug-fix");
});

test("engine: resolveClassification treats the MODEL classification as authoritative", () => {
  const resolved = resolveClassification({
    task: "fix the login bug",
    autonomous: true, // legacy hint — must be IGNORED when the model speaks
    classification: {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "MEDIUM",
      autonomous: false,
      autonomous_reason: "user wants review",
    },
  });
  assert.deepEqual(resolved, {
    type: "BUG_FIX",
    complexity: "QUICK",
    confidence: "MEDIUM",
    autonomous: false,
    autonomous_reason: "user wants review",
    workflow: "bug-fix", // resolved from the MODEL's autonomous, not the hint
  });
});

test("engine: resolveClassification FAILS CLOSED on incomplete model output (no keyword fallback)", () => {
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH" } }),
    /classification gate: model classification incomplete/,
    "missing autonomous blocks — no silent default",
  );
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: "true" } }),
    /classification gate: model classification incomplete/,
    "non-boolean autonomous blocks — fail closed",
  );
});

test("engine: seeded SPEC classification honors the registered workspace profile", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-prepare-spec-seed-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("spec-import");
    assert.ok(profile, "the shipped spec-import profile must be available");
    if (!profile) return;
    const created = createFeatureWorkspace(root, {
      feature_id: "import-seed",
      display_name: "Imported seed",
      run_key: "run-import-seed",
      profile_name: profile.name,
      profile_hash: profileHash(profile),
      source_kind: "external",
      import_ref: "snapshot-import-seed",
    });
    assert.equal(created.ok, true, created.ok ? "import workspace created" : created.error);
    if (!created.ok) return;
    const prepared = prepareWorkflowStateSource({
      task: "Read-only external specification compatibility validation",
      cwd: root,
      branch: "main",
      autonomous: false,
      classification: {
        type: "SPEC",
        complexity: "MEDIUM",
        confidence: "HIGH",
        autonomous: false,
        workflow: "spec-import",
      },
      files: [],
      issue: null,
      feature_id: "import-seed",
      run_key: "run-import-seed",
    });
    assert.equal(prepared.profile.name, "spec-import");
    assert.equal(prepared.classification.workflow, "spec-import");
    assert.equal(prepared.state.specification?.profile_name, "spec-import");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("engine: seeded SPEC workflow rejects arbitrary and unbound overrides", () => {
  const base = {
    task: "Read-only external specification compatibility validation",
    autonomous: false,
    classification: {
      type: "SPEC" as const,
      complexity: "MEDIUM" as const,
      confidence: "HIGH" as const,
      autonomous: false,
      workflow: "spec-import" as const,
    },
  };
  const bound = resolveClassificationSource(base, "spec-import");
  assert.equal(bound.workflow, "spec-import");
  assert.throws(
    () => resolveClassificationSource({ ...base, classification: { ...base.classification, workflow: "full-feature" } }, "spec-import"),
    /seeded SPEC workspace requires workflow spec-import/,
  );
  assert.throws(
    () => resolveClassificationSource(base),
    /SPEC must resolve to 'spec-preparation'/,
  );
});

test("engine: legacy path (no model classification) uses the caller flag verbatim — never defaulted", () => {
  const resolved = resolveClassification({ task: "fix the login bug", autonomous: true });
  assert.equal(resolved.type, "BUG_FIX", "keyword guess still detects the type on the legacy path");
  assert.equal(resolved.autonomous, true, "caller-supplied flag used verbatim");
  assert.equal(resolved.workflow, "debug-cycle", "workflow resolved from the caller flag");
});

test("P5 gate: missing classification blocks; absent state allows (legacy flow)", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-"));
  try {
    writeWorkflowState(root, { classification: { complexity: "QUICK" } });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "missing classification blocks subagent launch");

    rmSync(join(root, ".work-state"), { recursive: true, force: true });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "no state -> legacy allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy blocks source and canonical-state writes and denies generic shell execution for every actor", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-policy-"));
  try {
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const source = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: "src/app.ts" } }, { cwd: root, hasUI: true });
    assert.equal(source?.block, true);
    const state = orchestratorWriteGate({ toolName: "edit", input: { actor: "worker", path: ".work-state/team-state.json" } }, { cwd: root, hasUI: true });
    assert.equal(state?.block, true);
    const artifact = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: ".work-state/artifacts/report.json" } }, { cwd: root, hasUI: true });
    assert.equal(artifact, undefined);

    const mountedWorkflowTool = orchestratorWriteGate(
      { toolName: "write", input: { path: "xd://workflow_instructions", content: "{}" } },
      { cwd: root, hasUI: true },
    );
    assert.equal(mountedWorkflowTool, undefined, "mounted xd tools are not project writes");
    const mountedDiagnosticTool = orchestratorWriteGate(
      { toolName: "write", input: { path: "xd://report_issue", content: "tool routing failed" } },
      { cwd: root, hasUI: true },
    );
    assert.equal(mountedDiagnosticTool, undefined, "mounted diagnostics are not project writes");

    for (const toolName of ["read", "glob", "grep"]) {
      assert.equal(
        orchestratorWriteGate({ toolName, input: { path: "src/app.ts" } }, { cwd: root, hasUI: true }),
        undefined,
        `${toolName} remains an explicit non-shell read-only tool`,
      );
    }

    const worker = orchestratorWriteGate({ toolName: "write", input: { actor: "orchestrator", path: "src/app.ts" } }, { cwd: root, hasUI: false });
    assert.equal(worker, undefined);
    const orchestratorRead = orchestratorWriteGate({ toolName: "bash", input: { command: "git diff -- src/app.ts" } }, { cwd: root, hasUI: true });
    assert.equal(orchestratorRead?.block, true, "even read-only Bash is denied to the orchestrator");
    assert.match(orchestratorRead?.reason ?? "", /shell-capable Bash execution/);
    const spoofedWorker = orchestratorWriteGate(
      { toolName: "bash", input: { actor: "worker", command: "git diff -- src/app.ts" } },
      { cwd: root, hasUI: true },
    );
    assert.equal(spoofedWorker?.block, true, "event input cannot grant worker authority");

    for (const command of ["echo hacked > src/app.ts", "rm src/app.ts", "git diff -- src/app.ts"]) {
      const blockedWorker = orchestratorWriteGate({ toolName: "bash", input: { command } }, { cwd: root, hasUI: false });
      assert.equal(blockedWorker?.block, true, `strict worker Bash must be denied: ${command}`);
      assert.match(blockedWorker?.reason ?? "", /generic shell execution|shell-capable Bash execution/);
    }
    const workerCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: "cat > .work-state/team-state.json" } }, { cwd: root, hasUI: false });
    assert.equal(workerCanonicalBash?.block, true);
    const workerCanonicalInPlace = orchestratorWriteGate({ toolName: "bash", input: { command: "awk -i inplace '{print}' .work-state/team-state.json" } }, { cwd: root, hasUI: false });
    assert.equal(workerCanonicalInPlace?.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator Bash gate blocks the bypass matrix before command parsing", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-bash-bypass-matrix-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const commands = [
      "perl -pi -e 's/old/new/' src/app.ts",
      "php -r 'file_put_contents(\"src/app.ts\", \"hacked\");'",
      "awk '{print}' > src/app.ts",
      "python3 -c 'from pathlib import Path; Path(\"src/app.ts\").write_text(\"hacked\")'",
      "node -e 'require(\"node:fs\").writeFileSync(\"src/app.ts\", \"hacked\")'",
      "ruby -e 'File.write(\"src/app.ts\", \"hacked\")'",
      "echo \"$(cat src/app.ts)\" > src/app.ts",
      "env -i PATH=\"$PATH\" sh -c 'echo hacked > src/app.ts'",
      "ln -s ../src/app.ts src/app-link.ts",
      "git reset --hard HEAD",
      "python3 -c 'import base64; __import__(\"pathlib\").Path(\"src/app.ts\").write_bytes(base64.b64decode(\"aGFja2Vk\"))'",
      "node -e 'require(\"node:fs\").writeFileSync(Buffer.from(\"c3JjL2FwcC50cw==\", \"base64\").toString(), Buffer.from(\"aGFja2Vk\", \"base64\"))'",
      "target=src/app.ts; printf hacked > \"$target\"",
      "npm run mutate",
      "cat ../../secret.txt",
      "cat /tmp/secret.txt",
      "find .. -type f",
      "PATH=/tmp/shadow:$PATH npm run check",
      "unknown-command --write src/app.ts",
    ];
    for (const command of commands) {
      const blocked = orchestratorWriteGate(
        { toolName: "bash", input: { command } },
        { cwd: root, hasUI: true },
      );
      assert.equal(blocked?.block, true, `strict orchestrator Bash must be denied: ${command}`);
      assert.match(blocked?.reason ?? "", /shell-capable Bash execution/);
      const worker = orchestratorWriteGate(
        { toolName: "bash", input: { command } },
        { cwd: root, hasUI: false },
      );
      assert.equal(worker?.block, true, `strict worker Bash must be denied: ${command}`);
      assert.match(worker?.reason ?? "", /generic shell execution|shell-capable Bash execution/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("strict workers deny every generic shell execution tool before parsing", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-shell-tool-aliases-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    for (const toolName of ["bash", "sh", "zsh", "shell", "exec", "execute", "run", "run_command", "command", "terminal", "node", "python", "python3", "perl", "ruby", "php"]) {
      const blocked = orchestratorWriteGate({ toolName, input: { command: "cat ../../secret.txt" } }, { cwd: root, hasUI: false });
      assert.equal(blocked?.block, true, `strict worker must deny ${toolName}`);
      assert.match(blocked?.reason ?? "", /generic shell execution|shell-capable Bash execution/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict worker Bash blocks cooperative workflow-state mutation forms", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-state-mutation-matrix-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const blockedCommands = [
      `python3 -c 'from pathlib import Path; Path(os.path.join(".work-state","team-state.json")).write_text("x")'`,
      `node -e 'fs.writeFileSync(path.join(".work-state","team-state.json"), "x")'`,
      `ruby -e 'File.write(File.join(".work-state","team-state.json"), "x")'`,
      `perl -e 'open(F, ">.work-state/team-state.json")'`,
      `env -i sh -c 'cd .work-state && touch team-state.json'`,
      "python3 -c open(.work-state/team-state.json,w)",
      "echo x > .omp/activation.json",
      "rm .omp/escalation.json",
      "python3 -c open(.omp/commands/do.json,w)",
      `cd ".work-state" && echo x > team-state.json`,
      "rm -rf .work-state",
      `rm -rf ".work-state"`,
      "mv .work-state backup-work-state",
      "cp -R source .work-state",
      "truncate -s 0 .work-state/team-state.json",
      "touch .work-state/team-state.json",
    ];
    for (const command of blockedCommands) {
      const result = orchestratorWriteGate({ toolName: "bash", input: { command } }, { cwd: root, hasUI: false });
      assert.equal(result?.block, true, `worker Bash must block workflow-state mutation: ${command}`);
    }
    const readOnlyCommands = [
      "cat .work-state/team-state.json",
      "python3 -c 'import json; json.load(open(os.path.join(\".work-state\",\"team-state.json\")))'",
      "node -e 'fs.readFileSync(path.join(\".work-state\",\"team-state.json\"))'",
      "ruby -e 'File.read(File.join(\".work-state\",\"team-state.json\"))'",
      "perl -e 'open(F, \"<.work-state/team-state.json\")'",
      "npm test",
      "node --test test/example.test.ts",
      "cat ../../secret.txt",
      "cat /tmp/secret.txt",
      "find .. -type f",
      "grep -R secret ..",
      "PATH=/tmp/shadow:$PATH npm run check",
    ];
    for (const command of readOnlyCommands) {
      const result = orchestratorWriteGate({ toolName: "bash", input: { command } }, { cwd: root, hasUI: false });
      assert.equal(result?.block, true, `strict worker must block read-only-looking shell: ${command}`);
      assert.match(result?.reason ?? "", /generic shell execution|shell-capable Bash execution/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy parses edit patches while denying every Bash command", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-patch-policy-"));
  try {
    mkdirSync(join(root, ".work-state", "features", "visualize", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const sourcePatch = ["[packages/e2e/src/server.ts#064B]", "PUT 1.=1:", "+export const server = true;"].join("\n");
    assert.equal(orchestratorWriteGate({ toolName: "edit", input: { input: sourcePatch } }, { cwd: root, hasUI: false }), undefined, "a worker edit patch with a file header is a verifiable source path");
    assert.equal(orchestratorWriteGate({ toolName: "edit", input: sourcePatch }, { cwd: root, hasUI: false }), undefined, "a worker edit patch passed as the raw tool input is a verifiable source path");
    const authorityPatch = ["[.work-state/features/visualize/state.json#064B]", "PUT 1.=1:", "+{}"].join("\n");
    const blockedAuthorityPatch = orchestratorWriteGate({ toolName: "edit", input: { input: authorityPatch } }, { cwd: root, hasUI: false });
    assert.equal(blockedAuthorityPatch?.block, true);
    const blockedHeaderlessPatch = orchestratorWriteGate({ toolName: "edit", input: { input: "PUT 1.=1:\n+not a file patch" } }, { cwd: root, hasUI: false });
    assert.equal(blockedHeaderlessPatch?.block, true);
    assert.match(blockedHeaderlessPatch?.reason ?? "", /no verifiable path/);
    const readOnlyCommands = [
      "/usr/bin/python3 -m json.tool .work-state/features/visualize/artifacts/spec.json > /dev/null",
      "python3 -c 'import glob,json; [json.load(open(path)) for path in glob.glob(\".work-state/features/visualize/artifacts/*.json\")]'",
      "node -e 'const fs=require(\"node:fs\"); JSON.parse(fs.readFileSync(\".work-state/features/visualize/artifacts/spec.json\", \"utf8\"));'",
      "node -e 'const fs=require(\"node:fs\"); fs.globSync(\".work-state/features/visualize/artifacts/*.json\");'",
    ];
    for (const command of readOnlyCommands) {
      const blocked = orchestratorWriteGate({ toolName: "bash", input: { command } }, { cwd: root, hasUI: true });
      assert.equal(blocked?.block, true, "read-only shell validation is still shell execution: " + command);
      assert.match(blocked?.reason ?? "", /shell-capable Bash execution/);
      assert.equal(orchestratorWriteGate({ toolName: "bash", input: { command } }, { cwd: root, hasUI: false })?.block, true, "authority references are blocked for workers: " + command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict worker writes cannot mutate any workflow authority subtree or symlink alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-authority-tree-"));
  try {
    const workState = join(root, ".work-state");
    const controlPlane = join(root, ".omp");
    mkdirSync(join(controlPlane, "commands"), { recursive: true });
    writeFileSync(join(controlPlane, "activation.json"), "{}");
    writeFileSync(join(controlPlane, "escalation.json"), "{}");
    for (const directory of ["outbox", "inbox", "answers", "claims", "artifacts"]) mkdirSync(join(workState, directory), { recursive: true });
    writeFileSync(join(workState, "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    symlinkSync(workState, join(root, "work-state-alias"), "dir");
    symlinkSync(controlPlane, join(root, "omp-alias"), "dir");
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const authorityPaths = [
      ".work-state/outbox/message.json",
      ".work-state/inbox/request.json",
      ".work-state/answers/answer.json",
      ".work-state/claims/claim.json",
      ".work-state/artifacts/result.json",
      "work-state-alias/outbox/message.json",
      realpathSync(workState) + "/inbox/real-path.json",
      ".omp/activation.json",
      ".omp/escalation.json",
      ".omp/commands/do.json",
      "omp-alias/commands/alias.json",
    ];
    for (const path of authorityPaths) {
      const result = orchestratorWriteGate({ toolName: "write", input: { path } }, { cwd: root, hasUI: false });
      assert.equal(result?.block, true);
    }
    assert.equal(orchestratorWriteGate({ toolName: "edit", input: { path: "src/application.ts" } }, { cwd: root, hasUI: false }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict durable transitions fail closed when no active git branch exists", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-no-git-"));
  try {
    writeWorkflowState(root, {
      branch: "feature/no-git",
      classification: { workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
    });
    const begun = beginCapability(root);
    assert.equal(begun.ok, false);
    assert.match(begun.error, /stale for the active branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt makes orchestrator non-coding policy explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-policy-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), root);
    assert.match(prompt, /STRICT ORCHESTRATOR POLICY/);
    assert.match(prompt, /write\/edit application source or project files \| DENY/);
    assert.match(prompt, /direct git, shell, interpreter, and process execution \| DENY/);
    assert.match(prompt, /direct branch switching or any shell-capable execution \| DENY/);
    assert.match(prompt, /bash stage runs only through a trusted worker execution context/);
    assert.match(prompt, /After every delegated call or parallel batch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: prompt is tool-only for workflow content and never instructs filesystem profile reads", () => {
  // Arbitrary consumer project: a fresh temp dir, no packages/core anywhere.
  const root = mkdtempSync(join(tmpdir(), "do-work-consumer-"));
  try {
    assert.ok(!existsSync(join(root, "packages", "core")), "temp consumer cwd has no packages/core");
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("Fix login bug", root), root);

    assert.ok(
      prompt.includes("workflow_prepare"),
      "prompt must require workflow_prepare before state transitions",
    );
    assert.ok(
      prompt.indexOf("workflow_prepare") < prompt.indexOf("workflow_begin"),
      "workflow_prepare must precede workflow_begin in the tool sequence",
    );
    assert.match(prompt, /If it includes `required_next_tool`, execute that exact descriptor now/);
    assert.ok(prompt.indexOf("required_next_tool") < prompt.indexOf("workflow_begin"), "required_next_tool branch must be established before generic workflow_begin");
    assert.match(prompt, /If no `required_next_tool` is returned, and only then, call `workflow_instructions` BEFORE `workflow_begin`/);
    assert.match(prompt, /native specification.*composite start supersedes `workflow_begin`, `workflow_instructions`, and low-level phase dispatch/i);
    assert.match(prompt, /ONLY supported state initialization\/update path/);
    assert.doesNotMatch(prompt, /Then write `.work-state\/team-state\.json`/);
    assert.ok(
      prompt.includes("stage.instructions"),
      "prompt must name the returned stage contract field stage.instructions",
    );
    assert.match(prompt, /only workflow instruction source/i);
    assert.match(prompt, /state\.artifactsDir/);
    assert.doesNotMatch(prompt, /writing declared typed artifacts under `\.work-state\/artifacts\/`/);
    // After every workflow_advance the model must re-fetch workflow_instructions.
    assert.match(prompt, /workflow_advance`, call `workflow_instructions`/);
    assert.match(prompt, /handoff\.dispatch_markers/);
    assert.match(prompt, /tasks\[\]\.task/);
    assert.match(prompt, /artifact_schemas/);
    assert.match(prompt, /slot_artifacts/);
    assert.match(prompt, /artifact_ids/);
    assert.match(prompt, /native task result.*artifact completion/i);
    assert.match(prompt, /dod.*items.*MUST be objects/i);
    assert.match(prompt, /Before `workflow_advance`.*workflow_checkpoint/);
    assert.match(prompt, /typed `workflow_checkpoint` envelope/);
    assert.match(prompt, /actor_provenance/);
    assert.match(prompt, /compact first-30\/last-2 binding fingerprint/);
    assert.match(prompt, /workflow_\*.*main-session-only.*canonical `\.work-state`.*bash.*write/i);

    // No filesystem/package-path/plugin-root workflow content sourcing.
    assert.ok(!prompt.includes("findProfileDir"), "prompt must not reference the profile directory helper");
    assert.ok(!prompt.includes("<workflow>.json"), "prompt must not instruct reading workflow JSON from disk");
    assert.ok(!prompt.includes("CLAUDE_PLUGIN_ROOT"), "prompt must not mention CLAUDE_PLUGIN_ROOT");
    assert.ok(!prompt.includes("omp://"), "prompt must not mention omp:// for workflow content");
    assert.match(prompt, /Do NOT glob for workflow files/, "prompt must forbid globbing workflow files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("do-work: resume guidance is exactly eight ordered steps with no-micromanagement and typed marker discipline", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-resume-contract-"));
  try {
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("Continue the previous fix", root), root);
    const resumeStart = prompt.indexOf("### Eight-step resume-from-disk contract");
    const workerPolicyStart = prompt.indexOf("### NO-MICROMANAGEMENT WORKER POLICY");
    assert.ok(resumeStart >= 0);
    assert.ok(workerPolicyStart > resumeStart);
    const resumeSection = prompt.slice(resumeStart, workerPolicyStart);
    assert.deepEqual(resumeSection.match(/^\d+\. /gm), ["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. "]);
    for (const label of [
      "**Prepare**",
      "**Honor preparation continuation or read instructions",
      "**Resolve and validate begin**",
      "**Freeze snapshot/capability**",
      "**Authorize identity**",
      "**Reconcile pending/terminal**",
      "**Join/fan-in**",
      "**Checkpoint/gate/advance**",
    ]) {
      assert.match(resumeSection, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(prompt, /NO-MICROMANAGEMENT WORKER POLICY/);
    assert.match(prompt, /Do not prescribe code shape, file edits, command sequences/);
    assert.match(prompt, /Pending\/active workers.*Still Running.*neutral/);
    assert.match(prompt, /typed marker.*missing or malformed/);
    assert.match(prompt, /legacy alias.*autonomous\/completion claim/);
    assert.match(prompt, /completion intent, free text, prompt wording/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DoD gate: malformed and legacy artifacts fail closed while typed evidence passes", () => {
  const valid = validateTypedDoD({
    items: [{ criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
  });
  assert.equal(valid.ok, true);
  assert.equal(validateTypedDoD({ items: ["criterion"] }).ok, false);
  assert.equal(validateTypedDoD({ criteria: ["legacy"] }).ok, false);
  assert.equal(validateTypedDoD({ items: [{ criterion: "criterion", status: "met" }] }).ok, false);

  const root = mkdtempSync(join(tmpdir(), "dod-typed-backstop-"));
  try {
    const workState = join(root, ".work-state");
    const artifacts = join(workState, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(workState, "team-state.json"), JSON.stringify({
      stage_cursor: "summary",
      pause: { kind: "done" },
      classification: { workflow: "lightweight" },
    }));
    const dodPath = join(artifacts, "dod.json");
    writeFileSync(join(workState, ".active-feature"), "../escape");
    assert.equal(dodBackstop({}, { cwd: root }), undefined, "unsafe active-feature slug must fail closed before reading state");
    rmSync(join(workState, ".active-feature"));

    writeFileSync(dodPath, JSON.stringify({
      items: [{ id: "manual-1", source: "manual", criterion: "criterion", status: "met", evidence: "observed pass" }],
      type_requirements_met: true,
      updated_at: new Date().toISOString(),
    }));
    const malformed = dodBackstop({}, { cwd: root });
    assert.equal(malformed?.decision, "block");
    assert.match(malformed?.reason ?? "", /malformed typed artifact/);

    writeFileSync(dodPath, JSON.stringify({
      items: [{ id: "manual-1", source: "manual", criterion: "criterion", verify_method: "run the focused check", status: "pending", evidence: "" }],
      type_requirements_met: true,
      updated_at: new Date().toISOString(),
    }));
    const pending = dodBackstop({}, { cwd: root });
    assert.equal(pending?.decision, "block");
    assert.match(pending?.reason ?? "", /unmet or evidence-less/);

    writeFileSync(dodPath, JSON.stringify({
      items: [{ id: "manual-1", source: "manual", criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
      type_requirements_met: true,
      updated_at: new Date().toISOString(),
    }));
    assert.deepEqual(dodBackstop({}, { cwd: root }), { continue: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DoD gate: terminal spec-import handoff stops without implementation DoD", () => {
  const root = mkdtempSync(join(tmpdir(), "dod-spec-import-handoff-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("spec-import");
    assert.ok(profile, "spec-import profile must be available");
    if (!profile) return;
    const created = createFeatureWorkspace(root, {
      feature_id: "imported-payment-retry",
      display_name: "Imported payment retry",
      run_key: "run-imported-payment-retry",
      profile_name: profile.name,
      profile_hash: profileHash(profile),
      source_kind: "external",
      import_ref: "snapshot-imported-payment-retry",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const prepared = prepareWorkflowStateSource({
      task: "Read-only external specification compatibility validation",
      cwd: root,
      branch: "main",
      autonomous: false,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-import" },
      files: [],
      issue: null,
      feature_id: "imported-payment-retry",
      run_key: "run-imported-payment-retry",
    });
    const state = {
      ...prepared.state,
      stage_cursor: "handoff",
      pause: { kind: "done", reason: "" },
      specification: {
        ...prepared.state.specification,
        status: "implementation_ready",
        handoff_ref: "imported-payment-retry.handoff.v1",
      },
    };
    const featureDir = join(root, ".work-state", "features", "imported-payment-retry");
    writeFileSync(join(featureDir, "state.json"), JSON.stringify(state));
    writeFileSync(join(root, ".work-state", ".active-feature"), "imported-payment-retry\n");
    assert.deepEqual(
      dodBackstop({}, { cwd: root }),
      { continue: true },
      "a pre-implementation imported handoff is a terminal stop without a DoD artifact",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DoD gate: active, pending, waiting, polling, and temporary artifact states are neutral", () => {
  const root = mkdtempSync(join(tmpdir(), "dod-neutral-runtime-"));
  try {
    const statePath = join(root, ".work-state", "team-state.json");
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const transientStates: Record<string, unknown>[] = [
      { worker: { status: "active" } },
      { worker_status: "pending" },
      { pause: { kind: "Still Running" } },
      { wait: { kind: "nested wait" } },
      { polling: { status: "polling" } },
      { artifact_status: "temporary artifact absence" },
    ];
    for (const transient of transientStates) {
      writeFileSync(statePath, JSON.stringify({
        stage_cursor: "summary",
        pause: { kind: "done" },
        classification: { workflow: "lightweight" },
        ...transient,
      }));
      assert.equal(dodBackstop({}, { cwd: root }), undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("team and do-work use the same strict orchestration contract", () => {
  const root = mkdtempSync(join(tmpdir(), "team-alias-policy-"));
  try {
    const work = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), root);
    const team = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), root);
    assert.equal(team, work, "/team alias must resolve to the identical canonical prompt");
    assert.match(team, /STRICT ORCHESTRATOR POLICY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch gate requires the exact active cursor stage and roster", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cursor-"));
  try {
    initGit(root, "feat/test");
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const profile = loadProfile("lightweight");
    assert.ok(profile, "lightweight profile must be available for strict dispatch fixture");
    const persistedProfileHash = profileHash(profile);
    const capability = createCapability({
      run_key: "feat/test", branch: "feat/test", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "${scope.dev_agent}" }],
    });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
      branch: "feat/test", run_key: "feat/test", policy: { strict_orchestrator: true }, stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
      cursor_epoch: capability.state.issued_for?.cursor_epoch, profile_hash: persistedProfileHash,
      dispatch_capability: capability.state,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    }));
    const { dispatchGate } = await import("../src/gates/dispatch.ts");
    const missing = dispatchGate({ toolName: "task", input: { agent: "backend-kotlin", task: "Implement the stage without a marker" } }, { cwd: root });
    assert.equal(missing?.block, true, "missing structured marker must fail closed");
    const malformed = dispatchGate({ toolName: "task", input: { agent: "backend-kotlin", task: "<!-- omp-dispatch run=feat/test stage=implementation -->" } }, { cwd: root });
    assert.equal(malformed?.block, true, "malformed structured marker must fail closed");
    const wrong = dispatchGate({ toolName: "task", input: { agent: "backend-kotlin", task: "<!-- omp-dispatch run=feat/test stage=discovery kind=single cursor=discovery roles=analyst -->" } }, { cwd: root });
    assert.equal(wrong?.block, true);
    const right = dispatchGate({ toolName: "task", input: { agent: "${scope.dev_agent}", role: "${scope.dev_agent}", task: `<!-- omp-dispatch run=feat/test stage=implementation kind=single cursor=${capability.state.issued_for?.cursor_epoch} roles=\${scope.dev_agent} -->` } }, { cwd: root });
    assert.equal(right, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("dispatch markers bind to the persisted cursor epoch", () => {
  const stage = { id: "implementation", title: "Implementation", type: "single" as const, role: "go" };
  const marker = buildDispatchMarker("run-1", stage, ["go"], "go", "epoch-1");
  assert.equal(parseDispatchMarker(marker)?.cursor, "epoch-1");
});
test("strict runtime issues opaque capabilities and reconciles native task results", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-runtime-"));
  try {
    initGit(root, "feature/capability");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/capability",
      task: "capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const handoff = begun.handoff;
    const fullProfileHash = profileHash(profile);
    const expectedFingerprint = `${fullProfileHash.slice(0, 30)}${fullProfileHash.slice(-2)}`;
    assert.notEqual(expectedFingerprint, fullProfileHash);
    assert.equal(handoff.profile_hash, expectedFingerprint);
    const wrongProfileHash = `${handoff.profile_hash.slice(0, -1)}${handoff.profile_hash.endsWith("0") ? "1" : "0"}`;
    const wrongBinding = authorizeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: wrongProfileHash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    });
    assert.equal(wrongBinding.ok, false);
    if (wrongBinding.ok) return;
    assert.equal(wrongBinding.error, "capability binding mismatch");
    const persisted = readFileSync(join(root, ".work-state", "team-state.json"), "utf8");
    assert.doesNotMatch(persisted, new RegExp(handoff.dispatch_token));
    assert.doesNotMatch(persisted, new RegExp(handoff.advance_token));

    const stage = profile.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(handoff.run_key, stage, ["developer-kotlin"], "developer-kotlin", handoff.cursor_epoch);
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-1",
      input: { agent: "developer-kotlin", role: "developer-kotlin", task: marker },
    }, { cwd: root });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(request.requests.length, 1);
    const preauthorized = authorizeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    });
    assert.equal(preauthorized.ok, true);
    const authorized = authorizeDispatchTrusted(root, request.requests[0]!);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const duplicateAuthorization = authorizeDispatchTrusted(root, request.requests[0]!);
    assert.equal(duplicateAuthorization.ok, true);
    if (!duplicateAuthorization.ok || !duplicateAuthorization.record) return;
    assert.equal(duplicateAuthorization.record.id, authorized.record.id);

    const reconciled = reconcileTrustedTaskResult(root, {
      tool_call_id: "tool-1",
      outcome: "succeeded",
      evidence: "native task result",
    });
    assert.equal(reconciled.ok, true);
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "result.json"), "{}");
    writeFileSync(join(root, ".work-state", "artifacts", "discovery.json"), JSON.stringify({ task: "capability test", branch: "feature/capability" }));
    writeFileSync(join(root, ".work-state", "artifacts", "implementation.json"), JSON.stringify({
      files_touched: ["src/main.ts"],
    }));
    const replay = completeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: "developer-kotlin",
      agent: "developer-kotlin",
      tool_call_id: "tool-1",
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "explicit workflow evidence",
      artifact_ids: ["implementation"],
    });
    assert.equal(replay.ok, true);

    // Checkpoint permission is a separate typed transition. Legacy
    // mode/autonomous prose is migration input and cannot authorize advance.
    recordTypedCheckpoint(root, "implementation", "approve_implementation");
    assert.equal(resolveState(root).state?.typed_checkpoint_decisions?.length, 1);

    const advanced = advanceCursor(root, {
      token: handoff.advance_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      evidence: "implementation completed",
    });
    assert.equal(advanced.ok, true, advanced.ok ? undefined : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.equal(advanced.handoff?.expected_roster[0]?.role, "code-reviewer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("beginCapability reissues secrets for an active dispatch without losing its record", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-resume-"));
  try {
    initGit(root, "feature/resume-capability");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/resume-capability",
      task: "resume capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });

    const first = beginCapability(root);
    assert.equal(first.ok, true);
    if (!first.ok || !first.handoff) return;
    const auth = {
      token: first.handoff.dispatch_token,
      capability_id: first.handoff.capability_id,
      run_key: first.handoff.run_key,
      branch: first.handoff.branch,
      workflow: first.handoff.workflow,
      profile_hash: first.handoff.profile_hash,
      stage_cursor: first.handoff.stage_cursor,
      cursor_epoch: first.handoff.cursor_epoch,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;

    const resumed = beginCapability(root);
    assert.equal(resumed.ok, true);
    if (!resumed.ok || !resumed.handoff) return;
    assert.equal(resumed.handoff.capability_id, first.handoff.capability_id);
    assert.notEqual(resumed.handoff.dispatch_token, first.handoff.dispatch_token);
    assert.equal(resumed.state.dispatch_capability?.dispatches[0]?.id, authorized.record.id);

    const stale = completeDispatch(root, {
      ...auth,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "stale handoff must be rejected",
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "invalid secret");

    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "implementation.json"), JSON.stringify({ files_touched: ["src/main.ts"] }));
    const recovered = completeDispatch(root, {
      ...auth,
      token: resumed.handoff.dispatch_token,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "resumed handoff completed the dispatch",
      artifact_ids: ["implementation"],
    });
    assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("native task hook leaves spawned and scheduled results pending", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-async-"));
  try {
    initGit(root, "feature/async-capability");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/async-capability",
      task: "async capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });
    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const stage = profile.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["developer-kotlin"], "developer-kotlin", begun.handoff.cursor_epoch);
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-async",
      input: { agent: "developer-kotlin", role: "developer-kotlin", task: marker },
    }, { cwd: root });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(authorizeDispatchTrusted(root, request.requests[0]!).ok, true);

    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerTestTeamWorkflow(root, {
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
    } as never, { observability: false });
    const onToolResult = handlers.get("tool_result");
    assert.ok(onToolResult);
    for (const state of ["spawned", "scheduled"]) {
      onToolResult!({
        toolName: "task",
        toolCallId: "tool-async",
        content: [],
        isError: false,
        details: { async: { state } },
      }, { cwd: root });
    }
    const persisted = resolveState(root, "feature/async-capability").state;
    assert.equal(persisted?.dispatch_capability?.dispatches[0]?.status, "authorized");
    assert.equal(persisted?.dispatch_capability?.dispatches[0]?.completion, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("trusted reconciliation preserves every dispatch in a consilium batch", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-batch-"));
  try {
    initGit(root, "feature/batch-capability");
    const profile = loadProfile("review");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/batch-capability",
      task: "batch capability test",
      classification: { type: "REVIEW", complexity: "COMPLEX", confidence: "HIGH", autonomous: true, workflow: "review" },
      stage_cursor: "review",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "review" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const markerFor = (role: string) => begun.handoff!.dispatch_markers.find((entry) => entry.role === role)?.marker ?? "";
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-batch",
      input: {
        tasks: [
          { role: "code-reviewer", agent: "code-reviewer", task: markerFor("code-reviewer") },
          { role: "qa", agent: "qa", task: markerFor("qa") },
        ],
      },
    }, { cwd: root });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(request.requests.length, 2);
    for (const authorization of request.requests) {
      assert.equal(authorizeDispatchTrusted(root, authorization).ok, true);
    }

    mkdirSync(join(root, ".work-state", "features", "feature-batch-capability", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "features", "feature-batch-capability", "artifacts", "review.json"), JSON.stringify({ findings: [] }) + "\n");
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "review.json"), JSON.stringify({ findings: [] }) + "\n");
    for (const authorization of request.requests) {
      const reconciled = reconcileTrustedTaskResult(root, {
        tool_call_id: authorization.tool_call_id,
        slot_id: authorization.slot_id,
        task_id: authorization.task_id,
        outcome: "succeeded",
        evidence: `batch completed for ${authorization.slot_id}`,
        artifact_ids: ["review"],
      });
      assert.equal(reconciled.ok, true);
    }
    const reconciledState = resolveState(root).state;
    assert.deepEqual(
      reconciledState?.dispatch_capability?.dispatches.map((dispatch) => dispatch.status),
      ["succeeded", "succeeded"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("advance handoff resolves the next stage roster", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-handoff-"));
  try {
    initGit(root, "feat/handoff");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/handoff",
      branch: "feat/handoff",
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      kind: "single",
      expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    const state = {
      schema: 1,
      branch: "feat/handoff",
      run_key: "feat/handoff",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "handoff",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      cursor_epoch: issued.state.issued_for?.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    };
    writeState(root, state, { featureSlug: "handoff" });
    mkdirSync(join(root, ".work-state", "features", "handoff", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "features", "handoff", "artifacts", "implementation.json"), JSON.stringify({
      files_touched: ["src/main.ts"],
    }));
    const authInput = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "feat/handoff",
      branch: "feat/handoff",
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "${scope.dev_agent}",
      agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, authInput);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const completed = completeDispatch(root, {
      ...authInput,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "task completed",
      artifact_ids: ["implementation"],
    });
    assert.equal(completed.ok, true);
    recordTypedCheckpoint(root, "implementation", "approve_implementation");
    assert.equal(resolveState(root).state?.typed_checkpoint_decisions?.length, 1);
    const advanced = advanceCursor(root, {
      ...authInput,
      token: issued.advance_token,
      evidence: "stage completed",
    });
    assert.equal(advanced.ok, true, advanced.ok ? undefined : advanced.error);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.deepEqual(advanced.state.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }]);
    assert.equal(advanced.state.dispatch_capability?.kind, "single");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow contract supports an explicit stateless profile lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-stateless-"));
  try {
    const contract = resolveWorkflowContract(root, { requireState: false, workflow: "lightweight", branch: "main" });
    assert.equal(contract.state.path, null);
    assert.equal(contract.state.artifactsDir, null);
    assert.equal(contract.provenance.statePath, null);
    assert.equal(contract.stage.id, "discovery");
    assert.equal(contract.stage.artifact_schemas.discovery?.type, "object");
    assert.deepEqual(contract.stage.artifact_schemas.discovery?.required, ["task", "branch"]);
    assert.equal(contract.stage.artifact_schemas.dod?.properties?.items?.items?.type, "object");
    assert.deepEqual(contract.stage.artifact_schemas.dod?.properties?.items?.items?.required, ["criterion", "verify_method", "status"]);
    assert.equal(contract.state.dispatch.allowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow contract exposes the active feature artifact directory", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-feature-artifacts-"));
  try {
    const branch = "fix/artifact-path";
    initGit(root, branch);
    const prepared = prepareWorkflowState({
      task: "fix artifact path",
      cwd: root,
      branch,
      autonomous: true,
      classification: {
        type: "BUG_FIX",
        complexity: "COMPLEX",
        confidence: "HIGH",
        autonomous: true,
        workflow: "debug-cycle",
      },
      files: [],
      issue: null,
    });
    const contract = resolveWorkflowContract(root, { branch });
    const expectedArtifactsDir = realpathSync(join(root, ".work-state", "features", "fix-artifact-path", "artifacts"));
    assert.equal(contract.state.artifactsDir, expectedArtifactsDir);
    assert.equal(contract.state.path, prepared.statePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator paths reject a symlinked work-state root and allow nested physical targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-work-state-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "orchestrator-work-state-outside-"));
  const outsideControlPlane = mkdtempSync(join(tmpdir(), "orchestrator-control-plane-outside-"));
  const relocated = `${root}.work-state-real`;
  const sentinel = join(outside, "sentinel.txt");
  try {
    const workState = join(root, ".work-state");
    mkdirSync(workState, { recursive: true });
    writeFileSync(join(workState, "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));

    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const nestedTarget = ".work-state/artifacts/not-yet-created/deep/result.json";
    for (const actor of ["orchestrator", "lead"] as const) {
      for (const toolName of ["write", "edit"] as const) {
        assert.equal(
          orchestratorWriteGate({ toolName, input: { path: nestedTarget } }, { cwd: root, actor, hasUI: true }),
          undefined,
          `${actor} may target nested paths below a physical .work-state root`,
        );
      }
    }

    writeFileSync(join(outside, "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    writeFileSync(sentinel, "sentinel\n");
    renameSync(workState, relocated);
    symlinkSync(outside, workState, "dir");
    symlinkSync(outsideControlPlane, join(root, ".omp"), "dir");

    for (const actor of ["orchestrator", "lead"] as const) {
      for (const toolName of ["write", "edit"] as const) {
        const result = orchestratorWriteGate(
          { toolName, input: { path: nestedTarget } },
          { cwd: root, actor, hasUI: true },
        );
        assert.equal(result?.block, true, `${actor} ${toolName} must reject a symlinked .work-state root`);
        assert.match(result?.reason ?? "", /may write only under \.work-state/);
      }
    }

    for (const path of [".work-state/artifacts/worker.json", ".omp/commands/worker.json"]) {
      const result = orchestratorWriteGate(
        { toolName: "write", input: { path } },
        { cwd: root, actor: "worker", hasUI: false },
      );
      assert.equal(result?.block, true, `worker must retain lexical authority-tree blocking for ${path}`);
      assert.match(result?.reason ?? "", /engine-owned workflow authority tree/);
    }
    assert.equal(readFileSync(sentinel, "utf8"), "sentinel\n", "symlinked authority roots never authorize outside writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(relocated, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(outsideControlPlane, { recursive: true, force: true });
  }
});
