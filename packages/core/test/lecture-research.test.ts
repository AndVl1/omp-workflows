/**
 * Regression tests for the LECTURE_RESEARCH / lecture-research workflow.
 *
 * Locked contracts:
 *   - resolveWorkflow: LECTURE_RESEARCH -> "lecture-research" at EVERY
 *     complexity x autonomy; generic INVESTIGATION -> "research" unchanged.
 *   - selectProfile over the shipped profiles: the dedicated LECTURE_RESEARCH
 *     intent selects lecture-research with the exact five-stage sequence
 *     intake -> lecture_mapping -> synthesis -> repo_fit -> approval, and a
 *     model-provided workflow cannot hijack the dedicated intent.
 *   - The profile's artifacts are covered by the shipped schema registry:
 *     grounded intake/mapping/candidate/repo-fit/decision shapes pass;
 *     missing provenance/evidence and invalid verdicts block.
 *   - Approval gate: the profile's gate expression completes ONLY on an
 *     approved or rejected decision; anything else fails closed.
 *   - Prompts: /do-work (classification contract) and the fresh + amend /cto
 *     prompts expose LECTURE_RESEARCH, lecture-research and the
 *     no-implementation-before-approval policy.
 *   - Keyword fallback stays conservative: lecture/playlist wording maps to
 *     LECTURE_RESEARCH, generic investigate/research wording stays
 *     INVESTIGATION.
 *   - DoD backstop leaves lecture-research exempt from the done-claim DoD
 *     block (research-only workflow). dodBackstop is exercised through its
 *     module export (../src/gates/dod-backstop.js) — the package index wires
 *     it only as a session-stop hook, so no public surface reaches it
 *     directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveWorkflow,
  loadAllProfiles,
  selectProfile,
  resolveClassification,
  keywordClassify,
  buildClassificationPhaseZero,
  buildWorkflowMatrix,
  validateProducedArtifact,
  requiredFieldsOf,
  loadArtifactSchemas,
  evaluatePredicate,
  buildDoWorkPrompt,
  buildCtoPrompt,
  buildAmendPrompt,
  runCto,
  type Classification,
  type Complexity,
  type TeamDef,
  type TeamState,
} from "@andvl1/omp-workflows-core";
import { dodBackstop } from "../src/gates/dod-backstop.js";
import type { ScopeFlags } from "../src/engine/scope.js";

const COMPLEXITIES: Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];
const FLAGS: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };

function lectureClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    type: "LECTURE_RESEARCH",
    complexity: "MEDIUM",
    confidence: "HIGH",
    workflow: "lecture-research",
    autonomous: false,
    ...overrides,
  };
}

function minimalState(): TeamState {
  return {
    schema: 1,
    branch: "feat/lecture-research",
    classification: lectureClassification(),
    task: "research the lecture playlist",
    workflow_override: false,
    issue: null,
    stage_cursor: "approval",
    stages: [{ id: "approval", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "user_checkpoint", reason: "awaiting approval" },
    updated_at: new Date().toISOString(),
  };
}

function lectureProfile() {
  const profile = loadAllProfiles().find((p) => p.name === "lecture-research");
  assert.ok(profile, "the lecture-research profile must ship with the package");
  return profile;
}

test("lecture-research: resolveWorkflow maps LECTURE_RESEARCH at every complexity and autonomy", () => {
  for (const complexity of COMPLEXITIES) {
    for (const autonomous of [false, true]) {
      assert.equal(
        resolveWorkflow("LECTURE_RESEARCH", complexity, autonomous),
        "lecture-research",
        `LECTURE_RESEARCH/${complexity}/autonomous=${autonomous} must resolve to lecture-research`,
      );
    }
  }
});

test("lecture-research: generic INVESTIGATION routing is unchanged (research)", () => {
  for (const complexity of COMPLEXITIES) {
    for (const autonomous of [false, true]) {
      assert.equal(resolveWorkflow("INVESTIGATION", complexity, autonomous), "research");
    }
  }
});

test("lecture-research: selectProfile returns the shipped profile with the exact stage sequence", () => {
  const profile = selectProfile(loadAllProfiles(), lectureClassification());
  assert.ok(profile, "shipped profiles must select a profile for LECTURE_RESEARCH");
  assert.equal(profile.name, "lecture-research");
  assert.deepEqual(
    profile.stages.map((stage) => stage.id),
    ["intake", "lecture_mapping", "synthesis", "repo_fit", "approval"],
    "exact lecture-research stage sequence",
  );
  const approval = profile.stages.find((stage) => stage.id === "approval");
  assert.ok(approval, "approval stage exists");
  assert.ok(approval.gate, "approval stage declares a gate");
  assert.equal(approval.produces, "lecture_decision");
});

test("lecture-research: dedicated intent cannot be hijacked by a model-provided workflow", () => {
  const profiles = loadAllProfiles();
  const hijack = selectProfile(profiles, lectureClassification({ workflow: "standard" }));
  assert.equal(
    hijack?.name,
    "lecture-research",
    "a model-provided 'standard' workflow must not steal the dedicated LECTURE_RESEARCH intent",
  );
  const generic = selectProfile(profiles, {
    type: "INVESTIGATION",
    complexity: "MEDIUM",
    confidence: "HIGH",
    workflow: "research",
    autonomous: false,
  });
  assert.equal(generic?.name, "research", "generic INVESTIGATION still selects the research profile");
});

test("lecture-research: resolveClassification fails closed on a wrong model-provided workflow", () => {
  const complete = {
    type: "LECTURE_RESEARCH" as const,
    complexity: "MEDIUM" as const,
    confidence: "HIGH" as const,
    autonomous: false,
  };
  assert.throws(
    () =>
      resolveClassification({
        task: "research the lecture playlist",
        autonomous: false,
        classification: { ...complete, workflow: "standard" },
      }),
    /classification gate: LECTURE_RESEARCH must resolve to 'lecture-research', got 'standard'/,
    "an explicit non-lecture-research workflow must fail closed at the authoritative classification path",
  );

  const accepted = resolveClassification({
    task: "research the lecture playlist",
    autonomous: false,
    classification: { ...complete, workflow: "lecture-research" },
  });
  assert.equal(accepted.workflow, "lecture-research", "the matching explicit workflow is accepted");

  const omitted = resolveClassification({
    task: "research the lecture playlist",
    autonomous: false,
    classification: complete,
  });
  assert.equal(omitted.workflow, "lecture-research", "an omitted workflow still resolves from the matrix");

  // The early guard is dedicated-intent-only: a wrong explicit workflow on a
  // generic type must not be rejected here (generic INVESTIGATION behavior is
  // unchanged; later P5/workflow_override checks own that path).
  const generic = resolveClassification({
    task: "investigate why users cannot log in",
    autonomous: false,
    classification: {
      type: "INVESTIGATION",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow: "standard",
    },
  });
  assert.equal(generic.workflow, "standard", "generic INVESTIGATION keeps its explicit workflow");
});

test("lecture-research: every artifact the profile produces or consumes has a shipped schema", () => {
  const profile = lectureProfile();
  const ids = new Set<string>();
  for (const stage of profile.stages) {
    if (stage.produces) {
      for (const id of Array.isArray(stage.produces) ? stage.produces : [stage.produces]) ids.add(id);
    }
    for (const id of stage.consumes ?? []) ids.add(id);
  }
  assert.deepEqual([...ids].sort(), [
    "lecture_candidates",
    "lecture_decision",
    "lecture_intake",
    "lecture_mapping",
    "lecture_repo_fit",
  ]);
  const schemas = loadArtifactSchemas();
  for (const id of ids) assert.ok(schemas[id], `schema for '${id}' must exist`);
  assert.deepEqual(requiredFieldsOf("lecture_intake"), ["task", "sources"]);
  assert.deepEqual(requiredFieldsOf("lecture_mapping"), ["lectures", "coverage"]);
  assert.deepEqual(requiredFieldsOf("lecture_decision"), ["verdict"]);
});

test("lecture-research: artifact contract accepts grounded artifacts, rejects missing provenance/evidence", () => {
  // intake: grounded provenance passes; missing provenance and empty sources block.
  assert.deepEqual(
    validateProducedArtifact("lecture_intake", {
      task: "What architecture does the course teach?",
      sources: [
        { id: "lecture-01", kind: "transcript", location: "sources/lecture-01.vtt", provenance: "provided file; timecodes embedded" },
      ],
    }),
    { ok: true },
  );
  const noProvenance = validateProducedArtifact("lecture_intake", {
    task: "t",
    sources: [{ id: "lecture-01", kind: "transcript", location: "sources/lecture-01.vtt" }],
  });
  assert.equal(noProvenance.ok, false, "intake source without provenance blocks");
  if (!noProvenance.ok) {
    assert.ok(
      noProvenance.issues.some((issue) => issue.field === "$.sources[0].provenance"),
      "diagnostic carries the provenance JSON path",
    );
  }
  assert.equal(validateProducedArtifact("lecture_intake", { task: "t", sources: [] }).ok, false, "empty intake sources block");

  // mapping: every lecture entry must carry quoted evidence.
  assert.deepEqual(
    validateProducedArtifact("lecture_mapping", {
      coverage: "lecture-01 mapped; lecture-02 unmapped (no transcript)",
      lectures: [
        { id: "lecture-01-unit-1", title: "Event sourcing intro", source_id: "lecture-01", evidence: '[04:12] "events are the source of truth"' },
      ],
    }),
    { ok: true },
  );
  const noEvidence = validateProducedArtifact("lecture_mapping", {
    coverage: "mapped",
    lectures: [{ id: "u1", title: "T", source_id: "lecture-01" }],
  });
  assert.equal(noEvidence.ok, false, "mapping entry without evidence blocks");
  if (!noEvidence.ok) {
    assert.ok(
      noEvidence.issues.some((issue) => issue.field === "$.lectures[0].evidence"),
      "diagnostic carries the evidence JSON path",
    );
  }

  // candidates: evidence_sources must be non-empty.
  assert.deepEqual(
    validateProducedArtifact("lecture_candidates", {
      candidates: [
        {
          id: "candidate-1",
          topic: "Course teaches event sourcing",
          evidence_sources: [{ source_id: "lecture-01", evidence: "[04:12] events are the source of truth" }],
          conflicts: [],
        },
      ],
    }),
    { ok: true },
  );
  assert.equal(
    validateProducedArtifact("lecture_candidates", {
      candidates: [{ id: "candidate-1", topic: "T", evidence_sources: [], conflicts: [] }],
    }).ok,
    false,
    "candidates without evidence sources block",
  );

  // repo_fit: category enum.
  assert.deepEqual(
    validateProducedArtifact("lecture_repo_fit", {
      findings: [{ title: "Claim matches repo", category: "repo_fit", evidence: "src/events.ts:12 declares events" }],
    }),
    { ok: true },
  );
  assert.equal(
    validateProducedArtifact("lecture_repo_fit", {
      findings: [{ title: "F", category: "speculative", evidence: "e" }],
    }).ok,
    false,
    "unknown repo-fit category blocks",
  );
});

test("lecture-research: decision artifact accepts approved and rejected verdicts only", () => {
  for (const verdict of ["approved", "rejected"] as const) {
    assert.deepEqual(
      validateProducedArtifact("lecture_decision", { verdict, rationale: "explicit human decision" }),
      { ok: true },
      `verdict '${verdict}' is a valid terminal decision`,
    );
  }
  assert.equal(
    validateProducedArtifact("lecture_decision", { verdict: "needs_rework", rationale: "r" }).ok,
    false,
    "non-terminal verdict is rejected",
  );
  assert.equal(
    validateProducedArtifact("lecture_decision", { rationale: "no verdict recorded" }).ok,
    false,
    "missing verdict is rejected",
  );
});

test("lecture-research: approval gate completes only on approved or rejected decisions", () => {
  const approval = lectureProfile().stages.find((stage) => stage.id === "approval");
  assert.ok(approval, "approval stage exists");
  const gate = approval.gate ?? "";
  assert.ok(gate, "approval stage declares a gate");

  const root = mkdtempSync(join(tmpdir(), "lecture-gate-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    for (const verdict of ["approved", "rejected"] as const) {
      writeFileSync(join(artifactsDir, "lecture_decision.json"), JSON.stringify({ verdict, rationale: "explicit human decision" }));
      assert.deepEqual(
        evaluatePredicate(gate, { flags: FLAGS, artifactsDir, state: minimalState(), stage: approval }),
        { ok: true, value: true },
        `gate must accept an explicit '${verdict}' decision`,
      );
    }

    writeFileSync(join(artifactsDir, "lecture_decision.json"), JSON.stringify({ verdict: "needs_rework" }));
    assert.deepEqual(
      evaluatePredicate(gate, { flags: FLAGS, artifactsDir, state: minimalState(), stage: approval }),
      { ok: true, value: false },
      "gate must not complete on a non-terminal verdict",
    );

    rmSync(join(artifactsDir, "lecture_decision.json"));
    const missing = evaluatePredicate(gate, { flags: FLAGS, artifactsDir, state: minimalState(), stage: approval });
    assert.equal(missing.ok, false, "missing decision artifact fails closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lecture-research: keyword fallback stays lecture-conservative", () => {
  assert.equal(
    keywordClassify("research the lecture playlist for the architecture course").type,
    "LECTURE_RESEARCH",
    "lecture/playlist wording wins the keyword fallback",
  );
  assert.equal(
    keywordClassify("investigate why users cannot log in").type,
    "INVESTIGATION",
    "generic investigation wording must not become LECTURE_RESEARCH",
  );
  assert.equal(
    keywordClassify("research the migration options for the payments module").type,
    "INVESTIGATION",
    "the bare word 'research' must not become LECTURE_RESEARCH",
  );
});

test("lecture-research: do-work prompt and classification contract expose the dedicated intent", () => {
  const phaseZero = buildClassificationPhaseZero();
  assert.ok(phaseZero.includes("LECTURE_RESEARCH"), "PHASE-0 type enumeration includes LECTURE_RESEARCH");

  const matrix = buildWorkflowMatrix();
  assert.ok(matrix.includes("| LECTURE_RESEARCH | lecture-research | lecture-research | lecture-research | lecture-research |"));
  assert.ok(matrix.includes("| INVESTIGATION | research | research | research | research |"), "generic INVESTIGATION row is unchanged");
  assert.ok(matrix.includes("never routed to an implementation workflow"), "the matrix states the research-only policy");

  const root = mkdtempSync(join(tmpdir(), "lecture-dowork-"));
  try {
    const prompt = buildDoWorkPrompt(
      { task: "research the lecture playlist", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );
    assert.ok(prompt.includes("LECTURE_RESEARCH"), "do-work prompt exposes the LECTURE_RESEARCH type");
    assert.ok(prompt.includes("lecture-research"), "do-work prompt exposes the lecture-research profile");
    assert.ok(prompt.includes("never routed to an implementation workflow"), "do-work prompt carries the research-only policy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lecture-research: fresh and amend CTO prompts keep the research-only human-gated policy", () => {
  const root = mkdtempSync(join(tmpdir(), "lecture-cto-"));
  try {
    const fresh = buildCtoPrompt(
      { task: "Research the lecture playlist into verified findings", autonomyHint: false, issue: null, branch: null },
      root,
    );
    assert.ok(fresh.includes("LECTURE_RESEARCH"), "fresh CTO prompt exposes the LECTURE_RESEARCH type");
    assert.ok(fresh.includes("lecture-research"), "fresh CTO prompt exposes the lecture-research profile");
    assert.match(fresh, /no implementation (?:starts )?before approval/i, "fresh CTO prompt carries the no-implementation-before-approval policy");

    const res = runCto({
      task: "Feature A",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "backend", slice: "s1" }],
      defs: {
        backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] } satisfies TeamDef,
      },
    });
    assert.equal(res.ok, true, "amend fixture: runCto starts a run in the temp root");
    if (!res.ok) return;
    const amend = buildAmendPrompt(
      { task: "Fold in lecture research", autonomyHint: false, issue: null, branch: "main" },
      root,
      { runId: res.plan.id, state: res.state },
    );
    assert.ok(amend.includes("LECTURE_RESEARCH"), "amend CTO prompt exposes the LECTURE_RESEARCH type");
    assert.ok(amend.includes("lecture-research"), "amend CTO prompt exposes the lecture-research profile");
    assert.match(amend, /no implementation (?:starts )?before approval/i, "amend CTO prompt carries the no-implementation-before-approval policy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lecture-research: DoD backstop exempts lecture-research done-claims", () => {
  const root = mkdtempSync(join(tmpdir(), "lecture-dod-"));
  try {
    const workState = join(root, ".work-state");
    mkdirSync(workState, { recursive: true });
    const claimingDone = { pause: { kind: "done" }, stage_cursor: "summary" };

    writeFileSync(join(workState, "team-state.json"), JSON.stringify({ ...claimingDone, classification: { workflow: "lecture-research" } }));
    assert.equal(
      dodBackstop({}, { cwd: root }),
      undefined,
      "lecture-research is exempt from the done-claim DoD block (research-only workflow)",
    );

    writeFileSync(join(workState, "team-state.json"), JSON.stringify({ ...claimingDone, classification: { workflow: "standard" } }));
    const blocked = dodBackstop({}, { cwd: root });
    assert.ok(blocked, "control: a non-exempt workflow claiming done is blocked");
    if (!blocked || !("reason" in blocked)) assert.fail("blocked result carries a reason");
    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason, /dod\.json is missing/, "the block is the missing-DoD block, proving the exemption is what allowed the stop above");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
