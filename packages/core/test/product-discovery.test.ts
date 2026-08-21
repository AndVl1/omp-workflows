/**
 * Product discovery workflow tests.
 *
 * Verifies the PRODUCT_DISCOVERY intent end-to-end at the contract level:
 *   1. the shipped product-discovery profile (stage order, roles, consumes/
 *      produces, checkpoint/gate wiring, prompt discipline);
 *   2. the typed artifact contracts (valid and invalid cases);
 *   3. the workflow matrix (every complexity/autonomy resolves to
 *      product-discovery, dedicated selection);
 *   4. the fail-closed autonomy contract (autonomous PRODUCT_DISCOVERY is
 *      rejected in both the model and the legacy classification paths);
 *   5. the product_approval_recorded runtime gate (advance fails closed
 *      until an interactive product decision is recorded durably, and an
 *      autonomous decision is rejected even when recorded).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllProfiles,
  resolveWorkflow,
  selectProfile,
  resolveClassification,
  validateProducedArtifact,
} from "@andvl1/omp-workflows-core";
import { loadProfile, registerWorkflowProfiles, profileHash } from "../src/engine/profile.js";
import { createCapability, advanceCursor, recordCheckpointDecision } from "../src/engine/durable.js";
import { writeState } from "../src/engine/state.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";

const COMPLEXITIES = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"] as const;

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

/** Single orchestrator stage exercising the product_approval_recorded gate. */
const APPROVAL_PROFILE: Profile = {
  name: "product-approval-regression",
  title: "Product approval regression",
  description: "product_approval orchestrator stage wired to the product_approval_recorded gate",
  match: { type: ["PRODUCT_DISCOVERY"] },
  stages: [
    {
      id: "product_approval",
      title: "Product approval",
      type: "orchestrator",
      checkpoint: "product_approval",
      gate: "product_approval_recorded",
      produces: "product_approval_record",
    },
  ],
};

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function classification(workflow: string, autonomous: boolean): TeamState["classification"] {
  return { type: "PRODUCT_DISCOVERY", complexity: "MEDIUM", confidence: "HIGH", autonomous, workflow: workflow as TeamState["classification"]["workflow"] };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "product-approval", "state.json"), "utf8")) as TeamState;
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

function setupApprovalStage(root: string, branch: string, profile: Profile): { issued: ReturnType<typeof createCapability>; artifactsDir: string } {
  const persistedHash = profileHash(profile);
  const issued = createCapability({
    run_key: branch,
    branch,
    workflow: profile.name,
    profile_hash: persistedHash,
    stage_cursor: "product_approval",
    kind: "none", // orchestrator stages are non-dispatch: empty roster
    expected_roster: [],
  });
  const { artifactsDir } = writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: classification(profile.name, false),
    task: "product approval gate regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "product_approval",
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === "product_approval" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "product-approval" });
  return { issued, artifactsDir };
}

test("product-discovery: profile ships with the exact stage order and role wiring", async () => {
  const profiles = await loadAllProfiles();
  const profile = profiles.find((p) => p.name === "product-discovery");
  assert.ok(profile, "product-discovery profile is shipped");
  assert.equal(profile.title, "Product discovery");
  assert.ok(profile.match.type.includes("PRODUCT_DISCOVERY"), "match selects PRODUCT_DISCOVERY");

  assert.deepEqual(
    profile.stages.map((s) => s.id),
    [
      "product_intake",
      "problem_framing",
      "evidence_and_alternatives",
      "product_critique",
      "product_synthesis",
      "product_prd_document",
      "product_approval",
      "product_handoff",
    ],
  );

  const [intake, framing, evidence, critique, synthesis, prdDocument, approval, handoff] = profile.stages;

  // product_intake: parallel consilium of the two evidence-gathering roles.
  assert.equal(intake?.type, "consilium");
  assert.deepEqual(intake?.roles, ["product-analyst", "product-researcher"]);
  assert.equal(intake?.parallel, true);
  assert.equal(intake?.produces, "product_intake");

  // problem_framing: analyst consumes intake.
  assert.equal(framing?.type, "single");
  assert.equal(framing?.role, "product-analyst");
  assert.deepEqual(framing?.consumes, ["product_intake"]);
  assert.equal(framing?.produces, "product_framing");

  // evidence_and_alternatives: researcher consumes framing.
  assert.equal(evidence?.type, "single");
  assert.equal(evidence?.role, "product-researcher");
  assert.deepEqual(evidence?.consumes, ["product_framing"]);
  assert.equal(evidence?.produces, "product_evidence");

  // product_critique: critic reviews framing + evidence.
  assert.equal(critique?.type, "single");
  assert.equal(critique?.role, "product-critic");
  assert.deepEqual(critique?.consumes, ["product_framing", "product_evidence"]);
  assert.equal(critique?.produces, "product_critique");

  // product_synthesis: strategist consumes framing + evidence + critique.
  assert.equal(synthesis?.type, "single");
  assert.equal(synthesis?.role, "product-strategist");
  assert.deepEqual(synthesis?.consumes, ["product_framing", "product_evidence", "product_critique"]);
  assert.equal(synthesis?.produces, "product_spec");

  // product_prd_document: executable document stage — deterministic engine render BEFORE the owner approves.
  assert.equal(prdDocument?.type, "document");
  assert.deepEqual(
    prdDocument?.document,
    { format: "markdown", renderer: "product-prd", path: "documents/product-prd.md" },
    "the stage declares the exact shipped document contract",
  );
  assert.deepEqual(prdDocument?.consumes, ["product_intake", "product_framing", "product_evidence", "product_critique", "product_spec"]);
  assert.equal(prdDocument?.produces, "product_prd");

  // product_approval: interactive human gate.
  assert.equal(approval?.type, "orchestrator");
  assert.deepEqual(approval?.consumes, ["product_prd", "product_spec"]);
  assert.equal(approval?.checkpoint, "product_approval");
  assert.equal(approval?.gate, "product_approval_recorded");
  assert.equal(approval?.produces, "product_approval_record");
  assert.match(approval?.autonomous ?? "", /never auto-approve/i);
  assert.match(approval?.prompt ?? "", /mode=interactive/i);
  assert.match(approval?.prompt ?? "", /proceed \| needs_more_validation \| defer \| reject/);
  assert.match(approval?.prompt ?? "", /no inferred consent|never self-approve/i);

  // product_handoff: same approval gate, consumes the PRD, spec + approval record.
  assert.equal(handoff?.type, "orchestrator");
  assert.deepEqual(handoff?.consumes, ["product_prd", "product_spec", "product_approval_record"]);
  assert.equal(handoff?.gate, "product_approval_recorded");
  assert.equal(handoff?.produces, "product_handoff");
  assert.match(handoff?.prompt ?? "", /spec-preparation.*proceed/i);
  assert.match(handoff?.prompt ?? "", /no application or repository files were changed/i);
});

test("product-discovery: every stage prompt enforces evidence-first, no-code discipline", async () => {
  const profiles = await loadAllProfiles();
  const profile = profiles.find((p) => p.name === "product-discovery");
  assert.ok(profile);
  for (const stage of profile.stages) {
    const prompt = stage.prompt ?? "";
    assert.match(prompt, /DO NOT edit|do not edit|no application code|read-only/i, `${stage.id} prohibits code edits`);
    assert.match(prompt, /fabricat/i, `${stage.id} prohibits fabricated data`);
    assert.match(prompt, /verified\|assumption\|unknown|verified|assumption/, `${stage.id} preserves evidence status`);
    assert.match(prompt, /EXACT .* schema|exactly/i, `${stage.id} demands exact schema output`);
  }
});

test("product-discovery: artifact contracts accept valid documents and reject invalid ones", () => {
  // product_intake — valid (mergeable arrays: intake is a parallel consilium,
  // strict fan-in concatenates arrays and would block divergent scalars).
  assert.deepEqual(
    validateProducedArtifact("product_intake", {
      problem_statements: ["Teams cannot see why experiments fail"],
      contexts: ["unknown"],
      stakeholders: ["platform team"],
      constraints: [],
      open_questions: ["who owns the data?"],
      evidence: [{ claim: "experiments fail silently", status: "verified", source: "docs/experiments.md" }],
    }),
    { ok: true },
  );
  // product_intake — missing required problem_statements.
  assert.equal(
    validateProducedArtifact("product_intake", { evidence: [{ claim: "x", status: "unknown", source: "n/a" }] }).ok,
    false,
  );
  // product_intake — evidence status outside the enum.
  assert.equal(
    validateProducedArtifact("product_intake", {
      problem_statements: ["p"],
      evidence: [{ claim: "x", status: "guessed", source: "n/a" }],
    }).ok,
    false,
  );

  // product_framing — valid; assumptions is required.
  assert.deepEqual(
    validateProducedArtifact("product_framing", {
      problem_restatement: "Teams cannot see why experiments fail",
      target_users: ["platform team"],
      success_criteria: ["experiment failures surface in one dashboard"],
      non_goals: ["fixing the failing experiments"],
      assumptions: ["experiment failures are silent by design"],
    }),
    { ok: true },
  );
  // product_framing — missing required assumptions.
  assert.equal(
    validateProducedArtifact("product_framing", {
      problem_restatement: "p",
      target_users: [],
      success_criteria: [],
      non_goals: [],
    }).ok,
    false,
  );

  // product_evidence — valid.
  assert.deepEqual(
    validateProducedArtifact("product_evidence", {
      evidence: [{ claim: "users churn after day 7", status: "verified", source: "analytics dashboard" }],
      alternatives: [{ id: "alt-a", summary: "improve onboarding", pros: ["cheap"], cons: ["unproven"] }],
      gaps: ["no churn cohort data"],
    }),
    { ok: true },
  );
  // product_evidence — missing alternatives.
  assert.equal(
    validateProducedArtifact("product_evidence", {
      evidence: [{ claim: "x", status: "assumption", source: "n/a" }],
    }).ok,
    false,
  );
  // product_evidence — missing required gaps.
  assert.equal(
    validateProducedArtifact("product_evidence", {
      evidence: [{ claim: "x", status: "assumption", source: "n/a" }],
      alternatives: [{ id: "alt-a", summary: "s" }],
    }).ok,
    false,
  );

  // product_critique — valid.
  assert.deepEqual(
    validateProducedArtifact("product_critique", {
      verdict: "needs_more_validation",
      findings: ["churn claim is from a single cohort"],
      blocking_gaps: ["cohort data over 3 months"],
    }),
    { ok: true },
  );
  // product_critique — verdict outside the enum.
  assert.equal(
    validateProducedArtifact("product_critique", { verdict: "approved", findings: [] }).ok,
    false,
  );
  // product_critique — missing required blocking_gaps.
  assert.equal(
    validateProducedArtifact("product_critique", { verdict: "proceed", findings: [] }).ok,
    false,
  );

  // product_spec — valid (every product-level concept required, explicit
  // unknown/TBD entries instead of omitted fields).
  assert.deepEqual(
    validateProducedArtifact("product_spec", {
      recommendation: "proceed",
      value_proposition: "reduce churn by fixing onboarding",
      opportunity: "unknown",
      target_users: ["new users"],
      solution_direction: "improve the first-run experience",
      success_metrics: ["reduce onboarding drop-off"],
      guardrail_metrics: ["no regression in activation"],
      scope: ["first-run experience"],
      anti_scope: ["pricing changes"],
      risks: ["onboarding change may not move the metric"],
      validation_plan: [],
      evidence_trace: ["churn claim -> verified evidence item"],
      open_decisions: [],
    }),
    { ok: true },
  );
  // product_spec — a spec with ONLY recommendation/value/risk cannot pass:
  // every product-level concept is required.
  assert.equal(
    validateProducedArtifact("product_spec", {
      recommendation: "proceed",
      value_proposition: "reduce churn",
      risks: ["onboarding change may not move the metric"],
    }).ok,
    false,
  );
  // product_spec — missing required value_proposition.
  assert.equal(validateProducedArtifact("product_spec", { recommendation: "defer", risks: [] }).ok, false);

  // product_approval_record — valid (interactive decision).
  assert.deepEqual(
    validateProducedArtifact("product_approval_record", {
      decision: "proceed",
      approved_by: "Product Owner",
      rationale: "evidence supports it",
      decided_at: "2026-08-17T00:00:00Z",
    }),
    { ok: true },
  );
  // product_approval_record — decision outside the four allowed values.
  assert.equal(
    validateProducedArtifact("product_approval_record", {
      decision: "approved",
      approved_by: "Product Owner",
      rationale: "x",
    }).ok,
    false,
  );
  // product_approval_record — missing required decided_at.
  assert.equal(
    validateProducedArtifact("product_approval_record", {
      decision: "proceed",
      approved_by: "Product Owner",
      rationale: "evidence supports it",
    }).ok,
    false,
  );

  // product_handoff — valid proceed handoff.
  assert.deepEqual(
    validateProducedArtifact("product_handoff", {
      decision: "proceed",
      next_workflow: "spec-preparation",
      product_spec_artifact: "product_spec",
      instructions: "Spec the improved onboarding flow; preserve churn evidence.",
    }),
    { ok: true },
  );
  // product_handoff — valid non-proceed handoff.
  assert.deepEqual(
    validateProducedArtifact("product_handoff", {
      decision: "defer",
      next_workflow: "none",
      product_spec_artifact: "product_spec",
      instructions: "Revisit next quarter.",
      blocked_reason: "Not the right time; budget cycle ends this month.",
    }),
    { ok: true },
  );
  // product_handoff — next_workflow outside the enum.
  assert.equal(
    validateProducedArtifact("product_handoff", {
      decision: "proceed",
      next_workflow: "full-feature",
      product_spec_artifact: "product_spec",
      instructions: "x",
    }).ok,
    false,
  );
  // product_handoff — missing required instructions.
  assert.equal(
    validateProducedArtifact("product_handoff", {
      decision: "proceed",
      next_workflow: "spec-preparation",
      product_spec_artifact: "product_spec",
    }).ok,
    false,
  );
});

test("product-discovery: product_approval_recorded gate requires an interactive human decision to advance", () => {
  const root = mkdtempSync(join(tmpdir(), "pd-approval-"));
  try {
    initGit(root, "feat/product-approval");
    registerWorkflowProfiles([APPROVAL_PROFILE]);
    const profile = loadProfile("product-approval-regression");
    assert.ok(profile);
    const { issued, artifactsDir } = setupApprovalStage(root, "feat/product-approval", profile);
    writeFileSync(
      join(artifactsDir, "product_approval_record.json"),
      JSON.stringify({ decision: "proceed", approved_by: "Product Owner", rationale: "evidence supports it", decided_at: "2026-08-17T00:00:00Z" }),
    );

    // 1. Advance with no durable decision fails closed: the gate fires its
    //    no-decision diagnostic (gate 'product_approval_recorded' is not
    //    satisfied) before the unresolved-checkpoint check, so no later
    //    stage can run while the product owner has not answered.
    assert.equal((readState(root).checkpoint_decisions ?? []).length, 0, "no decision recorded yet");
    const noDecision = advanceCursor(root, { ...advanceAuth(issued), evidence: "approval presented to product owner" });
    assert.equal(noDecision.ok, false, "advance without a product decision must block");
    if (!noDecision.ok) assert.match(noDecision.error, /gate 'product_approval_recorded' is not satisfied/);

    // 2. An autonomous decision is recorded durably but the gate still
    //    rejects it: product approval requires an interactive human decision.
    const autonomous = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "product_approval", mode: "autonomous", decision: "proceed", actor: "orchestrator", rationale: "auto-approve" });
    assert.equal(autonomous.ok, true);
    if (!autonomous.ok) return;
    const autonomousRecord = readState(root).checkpoint_decisions?.[0];
    assert.equal(autonomousRecord?.mode, "autonomous", "autonomous decision is persisted durably");
    assert.equal(autonomousRecord?.decision, "proceed");
    const rejected = advanceCursor(root, { ...advanceAuth(issued), evidence: "approval presented to product owner" });
    assert.equal(rejected.ok, false, "an autonomous product approval decision must still block advance");
    if (!rejected.ok) assert.match(rejected.error, /gate 'product_approval_recorded' is not satisfied/);

    // 3. An interactive allowed decision (proceed) replaces the record and
    //    satisfies the gate, unblocking advance; with no next stage the
    //    single-stage run completes.
    const interactive = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "product_approval", mode: "interactive", decision: "proceed", actor: "Product Owner", rationale: "evidence supports it" });
    assert.equal(interactive.ok, true);
    if (!interactive.ok) return;
    const interactiveRecord = readState(root).checkpoint_decisions?.[0];
    assert.equal(interactiveRecord?.mode, "interactive", "interactive decision replaces the autonomous record");
    assert.equal(interactiveRecord?.decision, "proceed");
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "approval presented to product owner" });
    assert.equal(advanced.ok, true, "an interactive proceed decision allows advance");
    if (!advanced.ok) return;
    assert.equal(advanced.state.stages.find((s) => s.id === "product_approval")?.status, "done");
    assert.equal(advanced.state.dispatch_capability?.status, "complete", "no next stage: the capability completes after the gate passes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("product-discovery: matrix resolves to product-discovery for every complexity/autonomy combination", () => {
  for (const complexity of COMPLEXITIES) {
    for (const autonomous of [false, true]) {
      assert.equal(
        resolveWorkflow("PRODUCT_DISCOVERY", complexity, autonomous),
        "product-discovery",
        `PRODUCT_DISCOVERY/${complexity}/autonomous=${autonomous} must keep its dedicated workflow`,
      );
    }
  }
});

test("product-discovery: selectProfile picks product-discovery for every complexity, never hijacked by 'standard'", async () => {
  const profiles = await loadAllProfiles();
  for (const complexity of COMPLEXITIES) {
    const selected = selectProfile(profiles, {
      type: "PRODUCT_DISCOVERY",
      complexity,
      confidence: "HIGH",
      workflow: "standard", // hostile explicit workflow must not hijack the intent
      autonomous: false,
    });
    assert.equal(selected?.name, "product-discovery", `PRODUCT_DISCOVERY/${complexity} must select product-discovery`);
    const explicit = selectProfile(profiles, {
      type: "PRODUCT_DISCOVERY",
      complexity,
      confidence: "HIGH",
      workflow: "product-discovery",
      autonomous: false,
    });
    assert.equal(explicit?.name, "product-discovery");
  }
});

test("product-discovery: autonomous classification fails closed in the model path", () => {
  assert.throws(
    () =>
      resolveClassification({
        task: "decide what to build",
        autonomous: false,
        classification: {
          type: "PRODUCT_DISCOVERY",
          complexity: "COMPLEX",
          confidence: "HIGH",
          autonomous: true,
        },
      }),
    /PRODUCT_DISCOVERY.*autonomous.*fails closed/i,
  );
  // Interactive model classification is accepted and keeps the dedicated workflow.
  const accepted = resolveClassification({
    task: "decide what to build",
    autonomous: true, // ignored: the model decision is authoritative
    classification: {
      type: "PRODUCT_DISCOVERY",
      complexity: "COMPLEX",
      confidence: "HIGH",
      autonomous: false,
      autonomous_reason: "requires human product approval",
    },
  });
  assert.equal(accepted.type, "PRODUCT_DISCOVERY");
  assert.equal(accepted.autonomous, false);
  assert.equal(accepted.workflow, "product-discovery");
  // An explicit hostile workflow on a model classification is rejected.
  assert.throws(
    () =>
      resolveClassification({
        task: "decide what to build",
        autonomous: false,
        classification: {
          type: "PRODUCT_DISCOVERY",
          complexity: "QUICK",
          confidence: "HIGH",
          autonomous: false,
          workflow: "standard",
        },
      }),
    /must resolve to 'product-discovery'/,
  );
});

test("product-discovery: autonomous classification fails closed in the legacy path", () => {
  const task = "product discovery: explore whether we should build a usage analytics surface";
  assert.throws(
    () => resolveClassification({ task, autonomous: true }),
    /PRODUCT_DISCOVERY.*autonomous.*fails closed/i,
  );
  const accepted = resolveClassification({ task, autonomous: false });
  assert.equal(accepted.type, "PRODUCT_DISCOVERY");
  assert.equal(accepted.workflow, "product-discovery");
});
