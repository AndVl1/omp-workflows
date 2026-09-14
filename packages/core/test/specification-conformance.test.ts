/**
 * Failing contract for the shared implementation-conformance gate (T047).
 *
 * Canonical API under contract (contracts/command-contract.md "Shared
 * Completion Conformance Contract", data-model.md "RequirementClosureEntry" +
 * "ImplementationConformanceResult" + "ExecutionClaim", quickstart.md
 * Scenario 3A, stable error codes `SPEC_IMPLEMENTATION_CONFORMANCE_FAILED` /
 * `SPEC_IMPLEMENTATION_INTENT_CHANGED`):
 *
 *   `packages/core/src/specification/conformance.ts` (T052)
 *     - evaluateImplementationConformance(input)
 *         → ImplementationConformanceResult
 *           input: {
 *             handoff: ImplementationHandoff;   // the exact approved contract
 *             claim: ExecutionClaim;            // the active exclusive claim
 *             profile_hash: string;             // quality-gate/review policy
 *             evidence: ConformanceEvidence[];  // typed submitted references
 *             quality_gates: QualityGateResult[];
 *             evaluated_at: string;             // audit metadata only
 *           }
 *
 *     - ConformanceEvidence — the only channel executors get. One typed
 *       artifact reference per submission:
 *           { evidence_id, kind: "implementation" | "review" |
 *             "executed_test" | "intent_conflict",
 *             subject_id,                       // exact approved subject id
 *             requirement_id,                   // owner; self for requirements
 *             handoff_digest, execution_claim_id,
 *             artifact: CompletionArtifactRef,
 *             review_verdict?: "pass" | "fail", // kind="review"
 *             test?: ExecutedTestEvidence,      // kind="executed_test"
 *             intent_message?: string }         // kind="intent_conflict"
 *
 * Behavioral contracts pinned here (T047):
 *   - complete closure: the gate derives exactly one row per approved
 *     requirement and acceptance scenario; every complete row passes and a
 *     fully passing matrix yields overall `pass` with `complete_feature` and
 *     no blocking findings, bound to the exact handoff and active claim;
 *   - observable-behavior obligations are copied from the frozen handoff: an
 *     observable row additionally requires current passing executed tests, a
 *     non-observable row does not;
 *   - missing implementation evidence, a missing or failing review verdict,
 *     and a failed or absent required executed test each block exactly the
 *     affected row with a `SPEC_IMPLEMENTATION_CONFORMANCE_FAILED` finding
 *     naming the exact remediation, leave unaffected rows passing, and keep
 *     the overall result `blocked` (never `pass`);
 *   - stale or foreign evidence is rejected: evidence bound to another
 *     handoff digest or another claim is non-current and blocks; evidence for
 *     a subject outside the handoff can never add, remove, or reinterpret a
 *     row and blocks the evaluation;
 *   - contradictory evidence (passing and failing executed tests for the same
 *     subject) blocks instead of silently picking the passing half;
 *   - declared intent conflict yields `changed_intent` with
 *     `SPEC_IMPLEMENTATION_INTENT_CHANGED` and routes to specification
 *     revision instead of accepting a silent spec change;
 *   - replay is idempotent: identical inputs reproduce the identical
 *     established matrix, and the content-addressed digest is stable across
 *     audit-time differences;
 *   - no override: green constitution/profile gates cannot substitute for a
 *     missing specification row, a failed gate blocks with gate remediation,
 *     and neither a separate feature DoD row nor a human acknowledgement can
 *     change a blocking verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_NOW,
  sha256,
  validImplementationHandoff,
  validExecutionClaim,
  type ValidHandoffOptions,
} from "./fixtures/specification-fixtures.js";
import {
  evaluateImplementationConformance,
  type ConformanceEvidence,
} from "../src/specification/conformance.js";
import { validateConformanceAgainstHandoff } from "../src/specification/validation.js";
import type {
  ExecutionClaim,
  ImplementationConformanceResult,
  ImplementationHandoff,
  QualityGateResult,
  RequirementClosureEntry,
} from "../src/specification/types.js";
import type { CompletionArtifactRef } from "../src/engine/types.js";

// ── Local evidence builders (fixture file is T001-owned; not edited here) ────

/**
 * The canonical handoff as the engine types it: the T001 fixture builder
 * returns a loosely typed Record (`schema_version: number`), so the bridge
 * pins the frozen engine shape without editing the shared fixture file.
 */
function canonicalHandoff(options: ValidHandoffOptions = {}): ImplementationHandoff {
  return structuredClone(validImplementationHandoff(options)) as unknown as ImplementationHandoff;
}

function artifactRef(name: string): CompletionArtifactRef {
  return {
    artifact_id: `${name}.v1`,
    path: `artifacts/${name}.v1.json`,
    sha256: sha256(name),
    schema_status: "met",
    quality_gate_status: "met",
  };
}

function evidenceBase(
  kind: ConformanceEvidence["kind"],
  subjectId: string,
  requirementId: string,
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): ConformanceEvidence {
  return {
    evidence_id: `ev-${kind}-${subjectId}`,
    kind,
    subject_id: subjectId,
    requirement_id: requirementId,
    handoff_digest: handoff.handoff_digest,
    execution_claim_id: claim.claim_id,
    artifact: artifactRef(`${kind}.${subjectId.toLowerCase()}`),
  };
}

function implEvidence(
  subjectId: string,
  requirementId: string,
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): ConformanceEvidence {
  return evidenceBase("implementation", subjectId, requirementId, handoff, claim);
}

function reviewEvidence(
  subjectId: string,
  requirementId: string,
  verdict: "pass" | "fail",
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): ConformanceEvidence {
  return {
    ...evidenceBase("review", subjectId, requirementId, handoff, claim),
    review_verdict: verdict,
  };
}

function executedTestEvidence(
  subjectId: string,
  requirementId: string,
  status: "pass" | "fail",
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): ConformanceEvidence {
  return {
    ...evidenceBase("executed_test", subjectId, requirementId, handoff, claim),
    test: {
      evidence_ref: artifactRef(`runtime.${subjectId.toLowerCase()}`),
      test_kind: "runtime",
      status,
      executed_at: FIXED_NOW,
    },
  };
}

function intentConflictEvidence(
  subjectId: string,
  requirementId: string,
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
  message: string,
): ConformanceEvidence {
  return {
    ...evidenceBase("intent_conflict", subjectId, requirementId, handoff, claim),
    intent_message: message,
  };
}

/** Implementation + passing review + passing executed tests for one subject. */
function completeEvidence(
  subjectId: string,
  requirementId: string,
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): ConformanceEvidence[] {
  return [
    implEvidence(subjectId, requirementId, handoff, claim),
    reviewEvidence(subjectId, requirementId, "pass", handoff, claim),
    executedTestEvidence(subjectId, requirementId, "pass", handoff, claim),
  ];
}

/** Complete closure for every approved subject of the canonical handoff. */
function completeClosure(handoff: ImplementationHandoff, claim: ExecutionClaim): ConformanceEvidence[] {
  return handoff.requirements.flatMap((requirement) => [
    ...completeEvidence(requirement.requirement_id, requirement.requirement_id, handoff, claim),
    ...(requirement.acceptance_ids.flatMap((acceptanceId) =>
      completeEvidence(acceptanceId, requirement.requirement_id, handoff, claim),
    )),
  ]);
}

function constitutionGate(status: "pass" | "fail" = "pass"): QualityGateResult {
  return {
    gate_id: "project_constitution",
    source: "project_constitution",
    status,
    evidence_refs: [artifactRef("constitution.gate")],
    findings: [],
  };
}

function evaluate(
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
  evidence: ConformanceEvidence[],
  qualityGates: QualityGateResult[] = [constitutionGate()],
  evaluatedAt: string = FIXED_NOW,
): ImplementationConformanceResult {
  return evaluateImplementationConformance({
    handoff,
    claim,
    profile_hash: sha256("execution-profile"),
    evidence,
    quality_gates: qualityGates,
    evaluated_at: evaluatedAt,
  });
}

function entryOf(
  result: ImplementationConformanceResult,
  subjectId: string,
): RequirementClosureEntry {
  const entry = result.entries.find((candidate) => candidate.subject_id === subjectId);
  assert.ok(entry, `the matrix derives exactly one ${subjectId} closure row`);
  return entry!;
}

/** Sorted [kind, subject] pairs — presence without pinning row order. */
function subjectSet(result: ImplementationConformanceResult): Array<[string, string]> {
  return result.entries.map((entry) => [entry.subject_kind, entry.subject_id] as [string, string]).sort();
}

function conformanceFailedFinding(result: ImplementationConformanceResult, subjectId: string) {
  return result.blocking_findings.find(
    (finding) => finding.code === "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED" && finding.subject_id === subjectId,
  );
}

// ── Complete closure ─────────────────────────────────────────────────────────

test("complete closure passes every derived row and completes the feature", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const result = evaluate(handoff, claim, completeClosure(handoff, claim));

  // The subject set is derived from the handoff — exactly one row per
  // approved requirement and acceptance scenario, no extras.
  assert.equal(result.entries.length, 2, "one row for FR-1 and one for AC-1");
  assert.deepEqual(subjectSet(result), [["acceptance_scenario", "AC-1"], ["requirement", "FR-1"]]);

  for (const entry of result.entries) {
    assert.equal(entry.status, "pass", `${entry.subject_id} closes`);
    assert.equal(entry.review_verdict, "pass");
    assert.ok(entry.implementation_evidence_refs.length > 0, "implementation evidence is cited");
    assert.ok(entry.review_evidence_refs.length > 0, "review evidence is cited");
    assert.equal(entry.observable_behavior, true, "the obligation is copied from the frozen handoff");
    assert.ok(entry.test_evidence.length > 0, "an observable row cites executed-test evidence");
    assert.deepEqual(entry.findings, []);
  }
  const requirement = entryOf(result, "FR-1");
  assert.equal(requirement.requirement_id, "FR-1", "a requirement row owns itself");
  const acceptance = entryOf(result, "AC-1");
  assert.equal(acceptance.requirement_id, "FR-1", "an acceptance row names its owning requirement");

  assert.equal(result.overall_status, "pass");
  assert.equal(result.next_action, "complete_feature");
  assert.deepEqual(result.blocking_findings, []);

  // The immutable result binds the exact approved contract and active claim.
  assert.equal(result.schema_version, "1.0");
  assert.equal(result.feature_id, handoff.feature_id);
  assert.equal(result.handoff_id, handoff.handoff_id);
  assert.equal(result.handoff_digest, handoff.handoff_digest);
  assert.equal(result.execution_claim_id, claim.claim_id);
  assert.equal(result.execution_owner, claim.owner_kind);
  assert.equal(result.execution_run_id, claim.owner_run_id);
  assert.equal(result.profile_hash, sha256("execution-profile"));
  assert.match(result.matrix_digest, /^[0-9a-f]{64}$/, "the matrix is content-addressed");
});

test("persisted conformance rejects an acceptance row bound to the wrong requirement", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const result = evaluate(handoff, claim, completeClosure(handoff, claim));
  const persisted = structuredClone(result);
  const acceptance = persisted.entries.find((entry) => entry.subject_kind === "acceptance_scenario");
  assert.ok(acceptance);
  acceptance!.requirement_id = "FR-foreign";

  const validation = validateConformanceAgainstHandoff(persisted, handoff, claim);
  assert.equal(validation.ok, false);
  assert.ok(
    !validation.ok && validation.issues.some((issue) => issue.includes("requirement_id must be 'FR-1'")),
    validation.ok ? "validator unexpectedly accepted foreign ownership" : validation.issues.join("\n"),
  );
});

test("a non-observable row needs no executed tests to pass", () => {
  const handoff = canonicalHandoff({ observableBehavior: false });
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).filter((item) => item.kind !== "executed_test");

  const result = evaluate(handoff, claim, evidence);

  assert.equal(result.overall_status, "pass", "the executed-test obligation follows the frozen handoff");
  assert.deepEqual(
    result.entries.flatMap((entry) => entry.test_evidence),
    [],
  );
});

// ── Missing, failed, and absent evidence blocks exactly the affected row ─────

test("missing implementation evidence blocks its row and keeps unrelated rows passing", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).filter(
    (item) => !(item.kind === "implementation" && item.subject_id === "FR-1"),
  );

  const result = evaluate(handoff, claim, evidence);

  const requirement = entryOf(result, "FR-1");
  assert.equal(requirement.status, "blocked");
  assert.ok(
    conformanceFailedFinding(result, "FR-1"),
    "the blocking finding carries the stable conformance-failure code",
  );
  assert.ok(
    (conformanceFailedFinding(result, "FR-1")?.message ?? "").includes("implementation"),
    "the finding names the exact remediation: implementation evidence for FR-1",
  );

  const acceptance = entryOf(result, "AC-1");
  assert.equal(acceptance.status, "pass", "only the affected row blocks");

  assert.equal(result.overall_status, "blocked");
  assert.equal(result.next_action, "repair_implementation");
  assert.equal(result.execution_claim_id, claim.claim_id, "the blocked matrix stays bound to the active owner");
});

test("a missing review verdict blocks with review remediation", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).filter(
    (item) => !(item.kind === "review" && item.subject_id === "FR-1"),
  );

  const result = evaluate(handoff, claim, evidence);

  const requirement = entryOf(result, "FR-1");
  assert.equal(requirement.status, "blocked");
  assert.equal(requirement.review_verdict, "missing", "an unreviewed row records the missing verdict");
  assert.ok(conformanceFailedFinding(result, "FR-1"));
  assert.equal(result.overall_status, "blocked");
  assert.equal(result.next_action, "repeat_review");
});

test("a rejected review blocks its acceptance row with repeat-review remediation", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).map((item) =>
    item.kind === "review" && item.subject_id === "AC-1"
      ? reviewEvidence("AC-1", "FR-1", "fail", handoff, claim)
      : item,
  );

  const result = evaluate(handoff, claim, evidence);

  const acceptance = entryOf(result, "AC-1");
  assert.equal(acceptance.status, "blocked");
  assert.equal(acceptance.review_verdict, "fail", "the failed verdict is recorded, never upgraded");
  assert.ok(conformanceFailedFinding(result, "AC-1"));
  assert.equal(entryOf(result, "FR-1").status, "pass", "the requirement row is unaffected");

  assert.equal(result.overall_status, "blocked");
  assert.equal(result.next_action, "repeat_review");
});

test("a failing executed test blocks an observable row even with green quality gates", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).map((item) =>
    item.kind === "executed_test" && item.subject_id === "FR-1"
      ? executedTestEvidence("FR-1", "FR-1", "fail", handoff, claim)
      : item,
  );

  const result = evaluate(handoff, claim, evidence);

  assert.equal(entryOf(result, "FR-1").status, "blocked");
  assert.ok(conformanceFailedFinding(result, "FR-1"));
  assert.equal(result.overall_status, "blocked", "green gates do not upgrade a failing observable row");
  assert.equal(result.next_action, "repeat_tests");
  assert.ok(
    result.quality_gate_results.every((gate) => gate.status === "pass"),
    "the gates are present and green — they are simply not sufficient",
  );
});

test("an absent required executed test blocks an observable row", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).filter(
    (item) => !(item.kind === "executed_test" && item.subject_id === "AC-1"),
  );

  const result = evaluate(handoff, claim, evidence);

  const acceptance = entryOf(result, "AC-1");
  assert.equal(acceptance.status, "blocked");
  assert.deepEqual(acceptance.test_evidence, [], "the missing evidence is represented explicitly");
  assert.ok(conformanceFailedFinding(result, "AC-1"));
  assert.equal(result.overall_status, "blocked");
  assert.equal(result.next_action, "repeat_tests");
});

// ── Stale and foreign evidence is rejected ───────────────────────────────────

test("evidence bound to an older handoff digest is non-current and blocks", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const olderDigest = canonicalHandoff({ featureId: "feature-one-older" }).handoff_digest;
  const evidence = completeClosure(handoff, claim).map((item) =>
    item.kind === "implementation" && item.subject_id === "FR-1"
      ? { ...item, handoff_digest: olderDigest }
      : item,
  );

  const result = evaluate(handoff, claim, evidence);

  const requirement = entryOf(result, "FR-1");
  assert.equal(requirement.status, "blocked", "stale evidence never passes a row");
  const finding = conformanceFailedFinding(result, "FR-1");
  assert.ok(finding, "the stale evidence yields the stable conformance-failure code");
  assert.ok(
    (finding?.message ?? "").includes(olderDigest) || (finding?.evidence_refs ?? []).length === 0,
    "the finding identifies the stale binding",
  );
  assert.equal(result.handoff_digest, handoff.handoff_digest, "the matrix binds the current handoff");
  assert.equal(result.overall_status, "blocked");
});

test("evidence produced under another claim is non-current and blocks", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).map((item) =>
    item.kind === "review" && item.subject_id === "FR-1"
      ? { ...item, execution_claim_id: "claim-someone-else" }
      : item,
  );

  const result = evaluate(handoff, claim, evidence);

  assert.equal(entryOf(result, "FR-1").status, "blocked", "foreign-claim evidence is not attributable");
  assert.ok(conformanceFailedFinding(result, "FR-1"));
  assert.equal(result.execution_claim_id, claim.claim_id, "the matrix keeps the active owner binding");
  assert.equal(result.overall_status, "blocked");
});

test("evidence for a subject outside the handoff cannot add or waive rows", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = [
    ...completeClosure(handoff, claim),
    implEvidence("FR-404", "FR-404", handoff, claim),
  ];

  const result = evaluate(handoff, claim, evidence);

  assert.equal(result.entries.length, 2, "the executor cannot add a row the handoff does not approve");
  assert.deepEqual(subjectSet(result), [["acceptance_scenario", "AC-1"], ["requirement", "FR-1"]]);
  assert.ok(
    result.blocking_findings.some((finding) => finding.subject_id === "FR-404"),
    "the foreign submission is rejected with a named finding",
  );
  assert.equal(result.overall_status, "blocked", "an attempted row addition fails closed");
});

// ── Contradictory evidence ───────────────────────────────────────────────────

test("conflicting executed tests for one subject block instead of picking the pass", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).concat(
    executedTestEvidence("FR-1", "FR-1", "fail", handoff, claim),
  );

  const result = evaluate(handoff, claim, evidence);

  const requirement = entryOf(result, "FR-1");
  assert.equal(requirement.status, "blocked");
  assert.equal(requirement.test_evidence.length, 2, "both contradicting records are preserved");
  const finding = conformanceFailedFinding(result, "FR-1");
  assert.ok(finding);
  assert.ok(
    /contradict|conflict/i.test(finding?.message ?? ""),
    "the finding names the contradiction",
  );
  assert.equal(result.overall_status, "blocked");
  assert.equal(result.next_action, "repeat_tests");
});

// ── Changed intent ───────────────────────────────────────────────────────────

test("declared intent conflict marks changed_intent and routes to specification revision", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = [
    ...completeClosure(handoff, claim),
    intentConflictEvidence(
      "FR-1",
      "FR-1",
      handoff,
      claim,
      "the implementation intentionally ships a narrower outcome than approved scope",
    ),
  ];

  const result = evaluate(handoff, claim, evidence);

  const requirement = entryOf(result, "FR-1");
  assert.equal(requirement.status, "changed_intent", "the row is marked, never silently passed");
  assert.ok(
    requirement.findings.some((finding) => finding.code === "SPEC_IMPLEMENTATION_INTENT_CHANGED"),
    "the stable intent-change code identifies the conflict",
  );
  assert.equal(result.overall_status, "changed_intent");
  assert.equal(result.next_action, "revise_specification");
  assert.ok(
    result.blocking_findings.some((finding) => finding.code === "SPEC_IMPLEMENTATION_INTENT_CHANGED"),
  );
  assert.equal(result.execution_claim_id, claim.claim_id, "the claim binding is retained for revision routing");
});

// ── Idempotent replay ────────────────────────────────────────────────────────

test("replaying identical inputs returns the established matrix", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim);

  const first = evaluate(handoff, claim, evidence);
  const replayed = evaluate(handoff, claim, evidence);

  assert.deepEqual(replayed, first, "identical inputs produce the identical immutable result");
  assert.equal(replayed.matrix_digest, first.matrix_digest);
  assert.equal(replayed.conformance_id, first.conformance_id);
});

test("the content-addressed digest is stable across audit-time differences", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim);

  const first = evaluate(handoff, claim, evidence);
  const later = evaluate(handoff, claim, evidence, [constitutionGate()], "2026-09-01T00:00:00.000Z");

  assert.equal(later.matrix_digest, first.matrix_digest, "evaluated_at is audit metadata, not matrix content");
  assert.equal(later.conformance_id, first.conformance_id);
  assert.deepEqual(later.entries, first.entries);
  assert.notEqual(later.evaluated_at, first.evaluated_at);
});

// ── No override ──────────────────────────────────────────────────────────────

test("green constitution and profile gates cannot substitute for a missing specification row", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).filter(
    (item) => !(item.kind === "implementation" && item.subject_id === "AC-1"),
  );

  const result = evaluate(handoff, claim, evidence, [
    constitutionGate(),
    {
      gate_id: "profile.tests",
      source: "execution_profile",
      status: "pass",
      evidence_refs: [artifactRef("profile.gate")],
      findings: [],
    },
  ]);

  assert.equal(entryOf(result, "AC-1").status, "blocked");
  assert.equal(result.overall_status, "blocked", "gate rows are additional, never a substitute");
  assert.equal(result.next_action, "repair_implementation");
});

test("a failed mandated gate blocks with gate remediation", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });

  const result = evaluate(handoff, claim, completeClosure(handoff, claim), [
    constitutionGate("fail"),
  ]);

  assert.equal(result.overall_status, "blocked", "every closure row passes yet the gate row blocks");
  assert.equal(result.next_action, "repair_quality_gate");
  assert.ok(
    result.blocking_findings.some((finding) => finding.subject_id === "project_constitution"),
    "the finding names the failed gate",
  );
});

test("no separate feature DoD or human acknowledgement can change a blocking verdict", () => {
  const handoff = canonicalHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const evidence = completeClosure(handoff, claim).filter(
    (item) => !(item.kind === "implementation" && item.subject_id === "FR-1"),
  );
  const baseline = evaluate(handoff, claim, evidence);

  // A "separate feature DoD" submitted as a passing gate row...
  const overridden = evaluate(handoff, claim, evidence, [
    constitutionGate(),
    {
      gate_id: "feature_dod",
      source: "execution_profile",
      status: "pass",
      evidence_refs: [artifactRef("feature.dod")],
      findings: [],
    },
  ]);
  assert.equal(overridden.overall_status, baseline.overall_status, "the DoD row cannot close the missing row");
  assert.equal(overridden.next_action, baseline.next_action);
  assert.deepEqual(overridden.entries, baseline.entries, "no row is reinterpreted or waived");

  // ...and an explicit human completion acknowledgement is not an input channel:
  // the gate input has no override field, so an injected field fails closed.
  const acknowledged = evaluateImplementationConformance({
    handoff,
    claim,
    profile_hash: sha256("execution-profile"),
    evidence,
    quality_gates: [constitutionGate()],
    evaluated_at: FIXED_NOW,
    human_acknowledgement: "approve completion",
  } as Parameters<typeof evaluateImplementationConformance>[0]);
  assert.equal(acknowledged.overall_status, "blocked", "a human answer cannot override a non-passing result");
  assert.equal(acknowledged.next_action, "repair_implementation");
  assert.deepEqual(acknowledged.entries, [], "unknown acknowledgement fields are rejected before matrix evaluation");
});
