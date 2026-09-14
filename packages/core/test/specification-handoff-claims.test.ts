import { writeTestArtifact } from "./fixtures/artifacts.js";
/**
 * Failing contract for handoff readiness, exact-version binding, ambiguity,
 * and exclusive execution claims (T046).
 *
 * Canonical API under contract (data-model.md "ImplementationHandoff" /
 * "ExecutionClaim", command-contract.md "Global Invariants" + stable error
 * codes, plan.md §"Shared handoff, claim, and completion conformance"):
 *
 *   `packages/core/src/specification/handoff.ts` (T050)
 *     - freezeImplementationHandoff(input: HandoffFreezeInput):
 *         ImplementationHandoff
 *       Builds the frozen executor-neutral handoff from approved
 *       traceability. The `handoff_digest` is content-addressed over the
 *       complete approved requirement → acceptance → decision → task →
 *       verification traceability AND the exact bound artifact versions.
 *     - evaluateHandoffReadiness(handoff: ImplementationHandoff,
 *         context?: HandoffReadinessContext): HandoffReadinessResult
 *       THE one current readiness predicate. It derives readiness from the
 *       frozen content and the current constitution binding; it never
 *       trusts the declared `status` alone, never returns a partial or
 *       ambiguous verdict, and reports every gap, not only the first.
 *
 *   `packages/core/src/specification/claims.ts` (T051)
 *     - acquireExecutionClaim(request: ExecutionClaimRequest):
 *         ExecutionClaimAcquisitionResult (with immutable disposition)
 *     - releaseExecutionClaim(input: ClaimTransitionInput):
 *         ExecutionClaimResult<ExecutionClaim>
 *     - blockExecutionClaim(input: ClaimTransitionInput):
 *         ExecutionClaimResult<ExecutionClaim>
 *     - completeExecutionClaim(input: ClaimCompletionInput):
 *         ExecutionClaimResult<ExecutionClaim>
 *
 * Result shape follows `WorkspaceResult`: `{ ok: true; value }` or
 * `{ ok: false; code; error }` with stable error codes from
 * command-contract.md (`SPEC_HANDOFF_NOT_READY`, `SPEC_EXECUTION_CLAIMED`,
 * `SPEC_STALE`, `SPEC_SELECTION_AMBIGUOUS`, `SPEC_STATE_INVALID`,
 * `SPEC_CONSTITUTION_CHANGED`, `SPEC_CONSTITUTION_IMPACT_PENDING`,
 * `SPEC_IMPLEMENTATION_CONFORMANCE_FAILED`,
 * `SPEC_IMPLEMENTATION_INTENT_CHANGED`).
 *
 * Behavioral contracts pinned here:
 *   - readiness: ready only with complete traceability, current approvals,
 *     no open blocking decision, and a current constitution binding (or
 *     recorded no-impact evidence); `candidate` and `stale` are never ready;
 *   - exact-version binding: the handoff digest freezes every traceability
 *     family and the exact artifact versions; completion binds the exact
 *     claim, owner, run, and handoff digest — nothing looser;
 *   - ambiguity: evaluation is deterministic and repeatable, contradictory
 *     status/content resolves fail-closed, all gaps are reported, duplicate
 *     artifact-version kinds and contested digests never resolve by choice;
 *   - exclusive claims: one active claim per handoff digest, no takeover,
 *     no silent transfer, release/block require explicit reasons, blocked
 *     claims keep the owner, and completion is pass-only through a current
 *     conformance result bound to the exact digest and active owner.
 *
 * These tests fail until T050 (`handoff.ts`) and T051 (`claims.ts`) land;
 * shared types already exist in `types.ts` and fixtures in
 * `fixtures/specification-fixtures.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { specificationTerminalGuardError } from "../src/engine/durable.js";
import {
  FIXED_NOW,
  conflictingActiveClaim,
  digestOf,
  sha256,
  validExecutionClaim,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import {
  freezeImplementationHandoff,
  canonicalHandoffDigest,
  evaluateHandoffReadiness,
} from "../src/specification/handoff.js";
import {
  acquireExecutionClaim,
  blockExecutionClaim,
  completeExecutionClaim,
  recoverExecutionClaimCompletion,
  releaseExecutionClaim,
  readCurrentExecutionClaim,
  readExecutionClaimStore,
  verifyExecutionClaimAdmissionBindingPinned,
} from "../src/specification/claims.js";
import type { ExecutionClaimAcquisitionResult } from "../src/specification/claims.js";
import type {
  ConstitutionBinding,
  ExecutionClaim,
  ExecutionClaimAdmissionBinding,
  ImplementationHandoff,
} from "../src/specification/types.js";
import type { HandoffFreezeInput } from "../src/specification/handoff.js";
import { createFeatureWorkspace, featureArtifactsDir, persistFeatureWorkspace, resolveFeatureWorkspace, workspacePathBindingDigest } from "../src/specification/workspace.js";
import { digestOf as workspaceDigestOf, implementationConformanceMatrixDigest, nextActionForWorkspace } from "../src/specification/validation.js";
import { MAX_CANONICAL_HANDOFF_BYTES, serializeCanonicalHandoff } from "../src/specification/canonical-reader.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Canonical approved-traceability input for `freezeImplementationHandoff`. */
function freezeInput(overrides: Partial<HandoffFreezeInput> = {}): HandoffFreezeInput {
  const handoff = validImplementationHandoff();
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _v, status: _s, ...content } =
    handoff as unknown as Record<string, unknown>;
  return { ...(content as unknown as HandoffFreezeInput), ...overrides };
}

function changedBinding(): ConstitutionBinding {
  const binding = validImplementationHandoff().constitution_binding;
  return { ...binding, content_sha256: sha256("constitution:changed"), bound_at: FIXED_NOW };
}

function mutated(name: string, mutate: (handoff: ImplementationHandoff) => void): ImplementationHandoff {
  const handoff = structuredClone(validImplementationHandoff()) as unknown as ImplementationHandoff;
  mutate(handoff);
  return handoff;
}

test("canonical handoff serialization stays readable near the exact UTF-8 reader cap", () => {
  const handoff = structuredClone(validImplementationHandoff()) as unknown as ImplementationHandoff;
  handoff.risks = ["\\".repeat(4_192_000)];

  const serialized = serializeCanonicalHandoff(handoff);
  assert.equal(serialized.ok, true, serialized.ok ? "" : serialized.error);
  if (!serialized.ok) return;
  assert.ok(serialized.bytes.byteLength <= MAX_CANONICAL_HANDOFF_BYTES);
  assert.ok(serialized.bytes.byteLength > MAX_CANONICAL_HANDOFF_BYTES - 4_096);
  assert.deepEqual(JSON.parse(serialized.bytes.toString("utf8")), handoff);
});

test("canonical handoff serialization rejects a hostile backslash payload over the reader cap", () => {
  const handoff = structuredClone(validImplementationHandoff()) as unknown as ImplementationHandoff;
  handoff.risks = ["\\".repeat(4_193_000)];

  const serialized = serializeCanonicalHandoff(handoff);
  assert.equal(serialized.ok, false);
  if (!serialized.ok) assert.match(serialized.error, /exceeds the 8388608-byte limit/u);
});

// ── Exact-version binding: the digest freezes approved traceability ─────────

test("freezing approved traceability is deterministic and content-addressed", () => {
  const first = freezeImplementationHandoff(freezeInput());
  const second = freezeImplementationHandoff(freezeInput());
  assert.equal(first.handoff_digest, second.handoff_digest, "identical inputs freeze identically");
  assert.deepEqual(first, second);
  assert.match(first.handoff_digest, /^[0-9a-f]{64}$/, "digest is a SHA-256");
  assert.equal(first.status, "ready" as const, "complete approved traceability freezes ready");
});

test("the handoff digest freezes every traceability family and the exact artifact versions", () => {
  const baseline = freezeImplementationHandoff(freezeInput());
  const cases: Readonly<Record<string, (handoff: ImplementationHandoff) => void>> = {
    requirement_statement: (h) => { h.requirements[0]!.statement = "Revised statement"; },
    acceptance_linkage: (h) => {
      h.requirements[0]!.acceptance_ids = ["AC-1", "AC-2"];
      h.verification[0]!.acceptance_ids = ["AC-1", "AC-2"];
    },
    decision_content: (h) => { h.decisions[0]!.rationale = "Revised rationale"; },
    task_dependency: (h) => {
      h.tasks.push({
        task_id: "T-2",
        title: "Second task",
        requirement_ids: ["FR-1"],
        depends_on: ["T-1"],
        expected_outcome: "Done after T-1.",
        affected_scope: ["src/other.ts"],
        completion_evidence: ["test"],
        parallel_safe: true,
      });
    },
    verification_obligation: (h) => { h.verification[0]!.observable_behavior = false; },
    approval_state: (h) => { h.approval_refs = [...h.approval_refs, "checkpoint.tasks.v2"]; },
    exact_artifact_version: (h) => {
      h.artifact_versions = h.artifact_versions.map((artifact) =>
        artifact.kind === "tasks"
          ? { artifact_id: "tasks.v2", kind: "tasks" as const, version: 2, sha256: sha256("tasks.v2") }
          : artifact,
      );
    },
  };
  for (const [name, mutateCase] of Object.entries(cases)) {
    const frozen = freezeImplementationHandoff(freezeInput(mutatedFrozenContent(mutateCase)));
    assert.notEqual(
      frozen.handoff_digest,
      baseline.handoff_digest,
      `${name} must change the content-addressed handoff digest`,
    );
  }
});

/** Lifts a handoff mutation into a freeze-input override. */
function mutatedFrozenContent(mutateCase: (handoff: ImplementationHandoff) => void): Partial<HandoffFreezeInput> {
  const handoff = mutated("freeze", mutateCase);
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _v, status: _s, ...content } =
    handoff as unknown as Record<string, unknown>;
  return content as Partial<HandoffFreezeInput>;
}

// ── Handoff readiness: the one current readiness predicate ──────────────────

test("a complete approved handoff evaluates ready", () => {
  const result = evaluateHandoffReadiness(validImplementationHandoff());
  assert.ok(result.ok, result.ok ? "ready" : `rejected: ${result.error}`);
});

test("candidate and stale statuses are never ready", () => {
  const candidate = evaluateHandoffReadiness(validImplementationHandoff({ status: "candidate" }));
  assert.equal(candidate.ok, false, "a candidate is not executable");
  if (!candidate.ok) assert.equal(candidate.code, "SPEC_HANDOFF_NOT_READY");

  const stale = evaluateHandoffReadiness(validImplementationHandoff({ status: "stale" }));
  assert.equal(stale.ok, false, "a stale handoff is not executable");
  if (!stale.ok) assert.equal(stale.code, "SPEC_STALE");
});

test("open blocking decisions block readiness even when status claims ready", () => {
  const handoff = mutated("open-decision", (h) => { h.open_decisions = ["D-9 unresolved"]; });
  const result = evaluateHandoffReadiness(handoff);
  assert.equal(result.ok, false, "declared ready status must not bypass the blocking decision");
  if (!result.ok) {
    assert.equal(result.code, "SPEC_HANDOFF_NOT_READY");
    assert.ok(
      result.findings.some((finding) => finding.message.includes("D-9")),
      "the finding must name the blocking decision",
    );
  }
});

test("missing approvals and broken traceability fail the predicate closed", () => {
  const unapproved = evaluateHandoffReadiness(
    mutated("no-approvals", (h) => { h.approval_refs = []; }),
  );
  assert.equal(unapproved.ok, false, "approval traceability is mandatory");
  if (!unapproved.ok) assert.equal(unapproved.code, "SPEC_HANDOFF_NOT_READY");

  const broken = evaluateHandoffReadiness(
    mutated("broken-traceability", (h) => { h.requirements[0]!.acceptance_ids = []; }),
  );
  assert.equal(broken.ok, false, "requirements without acceptance scenarios are not ready");
  if (!broken.ok) assert.equal(broken.code, "SPEC_HANDOFF_NOT_READY");
});

test("a changed constitution binding blocks readiness until impact evidence exists", () => {
  const handoff = validImplementationHandoff();
  const changed = changedBinding();

  const noEvidence = evaluateHandoffReadiness(handoff, { current_constitution_binding: changed });
  assert.equal(noEvidence.ok, false, "a changed fingerprint without impact evidence blocks");
  if (!noEvidence.ok) assert.equal(noEvidence.code, "SPEC_CONSTITUTION_CHANGED");

  const noImpact = evaluateHandoffReadiness(handoff, {
    current_constitution_binding: changed,
    constitution_impact_verdict: "no_impact",
  });
  assert.ok(
    !(handoff.constitution_impact_ref === null && noImpact.ok),
    "no-impact context without recorded impact evidence must not flip readiness",
  );
  const recorded = mutated(
    "impact-recorded",
    (h) => { h.constitution_impact_ref = "constitution-impact.v2"; },
  );
  const withEvidence = evaluateHandoffReadiness(recorded, {
    current_constitution_binding: changed,
    constitution_impact_verdict: "no_impact",
  });
  assert.ok(withEvidence.ok, withEvidence.ok ? "ready" : `rejected: ${withEvidence.error}`);

  const affected = evaluateHandoffReadiness(recorded, {
    current_constitution_binding: changed,
    constitution_impact_verdict: "affected",
  });
  assert.equal(affected.ok, false, "an affected change keeps execution blocked");
  if (!affected.ok) assert.equal(affected.code, "SPEC_CONSTITUTION_IMPACT_PENDING");

  const pending = evaluateHandoffReadiness(recorded, { current_constitution_binding: changed });
  assert.equal(pending.ok, false, "missing impact verdict stays pending");
  if (!pending.ok) assert.equal(pending.code, "SPEC_CONSTITUTION_IMPACT_PENDING");

  const unchanged = evaluateHandoffReadiness(handoff, {
    current_constitution_binding: handoff.constitution_binding,
  });
  assert.ok(unchanged.ok, "an unchanged binding needs no impact evidence");
});

// ── Ambiguity: deterministic, complete, fail-closed verdicts ────────────────

test("readiness evaluation is deterministic and repeatable", () => {
  const handoff = validImplementationHandoff();
  assert.deepEqual(evaluateHandoffReadiness(handoff), evaluateHandoffReadiness(handoff));
  const rejected = mutated("open-decision", (h) => { h.open_decisions = ["D-9 unresolved"]; });
  assert.deepEqual(
    evaluateHandoffReadiness(rejected),
    evaluateHandoffReadiness(structuredClone(rejected)),
    "no ambient state may flip a verdict between evaluations",
  );
});

test("all readiness gaps are reported, not only the first", () => {
  const handoff = mutated("multi-gap", (h) => {
    h.open_decisions = ["D-9 unresolved"];
    h.approval_refs = [];
  });
  const result = evaluateHandoffReadiness(handoff);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.findings.length >= 2, `expected both gaps, got ${JSON.stringify(result.findings)}`);
    assert.ok(
      result.findings.some((finding) => finding.message.includes("D-9")),
      "open decision is reported",
    );
    assert.ok(
      result.findings.some((finding) => /approval/i.test(finding.message)),
      "missing approvals are reported",
    );
  }
});

test("ambiguous exact-version bindings fail closed instead of picking one", () => {
  const handoff = mutated("ambiguous-versions", (h) => {
    h.artifact_versions = [
      ...h.artifact_versions,
      { artifact_id: "tasks.v2", kind: "tasks" as const, version: 2, sha256: sha256("tasks.v2") },
    ];
  });
  const result = evaluateHandoffReadiness(handoff);
  assert.equal(result.ok, false, "two current versions of one artifact kind are ambiguous");
  if (!result.ok) {
    assert.equal(result.code, "SPEC_HANDOFF_NOT_READY");
    assert.ok(
      result.findings.some((finding) => /tasks/i.test(finding.message)),
      "the ambiguity names the contested artifact kind",
    );
  }
});

// ── Durable exclusive claims ─────────────────────────────────────────────────

function claimProject(handoff: ImplementationHandoff = validImplementationHandoff()): { root: string; runKey: string } {
  const root = mkdtempSync(join(tmpdir(), "spec-claim-"));
  const runKey = "run-" + handoff.feature_id + "-1";
  const constitutionDocument = "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n";
  writeFileSync(join(root, "CONSTITUTION.md"), constitutionDocument, "utf8");
  handoff.constitution_binding = { ...handoff.constitution_binding, version: "0.0.0", content_sha256: sha256(constitutionDocument), semantic_hash: sha256(constitutionDocument.replace(/\s+/gu, " ").trim()) };
  const gateId = "constitution-gate-claims";
  mkdirSync(join(root, ".work-state", "specification", "constitution"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), JSON.stringify({ schema_version: 1, gate_id: gateId, project_root: root, feature_id: null, origin: { origin_kind: "do_work_nested", origin_run_key: runKey, origin_stage: "do_work" }, gate: { gate_id: gateId, origin_kind: "do_work_nested", origin_run_key: runKey, origin_stage: "do_work", status: "usable", usability_result: "usable", provider: { provider_id: "native", path: "CONSTITUTION.md", source: "native_default" }, constitution_workflow_ref: null, checkpoint_ref: null, binding: handoff.constitution_binding, resume_marker: null }, drafts: [], decisions: [] }, null, 2) + "\n", "utf8");
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const created = createFeatureWorkspace(root, {
    feature_id: handoff.feature_id,
    display_name: handoff.feature_id,
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: sha256("profile"),
  });
  assert.ok(created.ok, created.ok ? "created" : created.error);
  const workspace = created.value;
  const expectedWorkspaceDigest = workspaceDigestOf(workspace);
  workspace.constitution_binding = handoff.constitution_binding;
  workspace.phases = (["specify", "plan", "tasks"] as const).map((phase) => ({
    phase,
    status: "approved" as const,
    current_version: 1,
    approved_version: 1,
    validation_ref: `validation.${phase}.v1`,
    checkpoint_ref: `checkpoint.${phase}.v1`,
    upstream_versions: phase === "specify" ? [] : phase === "plan"
      ? [{ phase: "specify" as const, version: 1, hash: sha256("specify.v1") }]
      : [
          { phase: "specify" as const, version: 1, hash: sha256("specify.v1") },
          { phase: "plan" as const, version: 1, hash: sha256("plan.v1") },
        ],
    stale_reason: null,
    last_feedback: null,
  }));
  workspace.status = "implementation_ready";
  workspace.handoff_ref = handoff.handoff_id;
  workspace.next_action = nextActionForWorkspace(workspace.phases, {
    status: workspace.status,
    hasConstitutionBinding: true,
    sourceKind: workspace.source_kind,
  });
  const persisted = persistFeatureWorkspace(root, workspace, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
  assert.ok(persisted.ok, persisted.ok ? "persisted" : persisted.error);
  const handoffDir = join(featureArtifactsDir(root, handoff.feature_id), "implementation_handoff");
  mkdirSync(handoffDir, { recursive: true, mode: 0o700 });
  writeTestArtifact(root, handoffDir, handoff.handoff_id, handoff);
  return { root, runKey };
}
function inflateFeatureStateForLargeRead(root: string, featureId: string): void {
  const statePath = join(root, ".work-state", "features", featureId, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  const workspace = state.specification as Record<string, unknown>;
  const phases = workspace.phases as Array<Record<string, unknown>>;
  const payload = "x".repeat(220_000);
  workspace.display_name = payload;
  workspace.profile_name = payload;
  for (const phase of phases) phase.last_feedback = payload;
  const body = `${JSON.stringify(state)}\n`;
  assert.ok(Buffer.byteLength(body, "utf8") > 1024 * 1024, "the feature state fixture must exceed the claim-local 1 MiB cap");
  assert.ok(Buffer.byteLength(body, "utf8") <= 8 * 1024 * 1024, "the feature state fixture must remain under the shared persisted-state cap");
  writeFileSync(statePath, body, "utf8");
}
function acquireAt(root: string, runKey: string, handoff: ImplementationHandoff, owner_kind: "do_work" | "cto", owner_run_id: string) {
  return acquireExecutionClaim(root, handoff.feature_id, { handoff, run_key: runKey, owner_kind, owner_run_id, acquired_at: FIXED_NOW });
}
function ctoAdmissionBinding(ownerRunId: string, mappingId: string, mappingRecordPath: string): ExecutionClaimAdmissionBinding {
  return {
    mapping_record_path: mappingRecordPath,
    mapping_record_digest: sha256("mapping-record"),
    mapping_id: mappingId,
    mapping_hash: sha256("mapping"),
    mapping_version: 1,
    confirmation_state_revision: 0,
    feature_state_revision: 0,
    confirmation_state_digest: sha256("confirmation-state"),
    confirmation_authorization_digest: sha256("confirmation-authorization"),
    confirmation_ledger_digest: sha256("confirmation-ledger"),
    checkpoint_ref: "checkpoint.cto",
    trusted_answer_ref: "answer.cto",
    stage_id: "execution",
    policy_hash: sha256("policy"),
    wave_id: "wave-1",
    capability_id: "capability-1",
    capability_epoch: "epoch-1",
  };
}

function mappingContext(binding: ExecutionClaimAdmissionBinding, featureId = "feature-one", runKey = "run-feature-one-1") {
  return {
    selected_feature_id: featureId,
    selected_run_key: runKey,
    mapping_record_path: binding.mapping_record_path,
    mapping_record_digest: binding.mapping_record_digest,
    mapping_id: binding.mapping_id,
    mapping_hash: binding.mapping_hash,
    mapping_version: binding.mapping_version,
    checkpoint_ref: binding.checkpoint_ref,
    trusted_answer_ref: binding.trusted_answer_ref,
    wave_id: binding.wave_id,
    capability_id: binding.capability_id,
    capability_epoch: binding.capability_epoch,
  };
}

function identity(claim: ReturnType<typeof validExecutionClaim>) {
  return { claim_id: claim.claim_id, handoff_digest: claim.handoff_digest, owner_kind: claim.owner_kind, owner_run_id: claim.owner_run_id };
}
test("CTO admission rejects copied mapping paths during acquisition and terminal verification", () => {
  const handoff = freezeImplementationHandoff({
    ...freezeInput(),
    execution_choices: ["do-work", "cto"],
  });
  const { root, runKey } = claimProject(handoff);
  const ownerRunId = "cto-run-1";
  const mappingId = "cto-mapping-1";
  const copiedPath = `.work-state/cto/${ownerRunId}/specification-mappings/copied.json`;
  const admission = ctoAdmissionBinding(ownerRunId, mappingId, copiedPath);
  try {
    const acquired = acquireExecutionClaim(root, handoff.feature_id, {
      handoff,
      run_key: runKey,
      owner_kind: "cto",
      owner_run_id: ownerRunId,
      acquired_at: FIXED_NOW,
      admission_binding: admission,
    });
    assert.equal(acquired.ok, false);
    if (!acquired.ok) assert.match(acquired.error, /canonical owner mapping path/u);
    const journal = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(journal.ok, journal.ok ? "claim journal readable" : journal.error);
    if (journal.ok) assert.equal(journal.value.length, 0, "path rejection must not create claim authority");

    const workspaceResult = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspaceResult.ok, workspaceResult.ok ? "workspace loaded" : workspaceResult.error);
    const pinnedRoot = PinnedProjectRoot.open(root);
    assert.ok(pinnedRoot, "project root must be pinnable");
    if (!workspaceResult.ok || !pinnedRoot) return;
    const workspace = {
      ...workspaceResult.value,
      status: "claimed" as const,
      execution_claim_ref: "claim-cto-path",
      handoff_ref: handoff.handoff_id,
    };
    const claim = {
      ...validExecutionClaim({ ownerKind: "cto", handoffDigest: handoff.handoff_digest }),
      claim_id: "claim-cto-path",
      owner_run_id: ownerRunId,
      admission_binding: admission,
    } as unknown as ExecutionClaim;
    const terminal = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
      feature_id: handoff.feature_id,
      run_key: runKey,
      owner_run_id: ownerRunId,
      workspace,
      claim,
      handoff,
      mapping: mappingContext(admission),
      verification_mode: "terminal",
    });
    assert.equal(terminal.ok, false);
    if (!terminal.ok) assert.match(terminal.error, /canonical.*owner run/u);
    const canonicalPath = `.work-state/cto/${ownerRunId}/specification-mappings/${mappingId}.json`;
    const canonicalAdmission = ctoAdmissionBinding(ownerRunId, mappingId, canonicalPath);
    const canonicalClaim = {
      ...claim,
      admission_binding: canonicalAdmission,
    } as unknown as ExecutionClaim;
    const wrongRun = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
      feature_id: handoff.feature_id,
      run_key: runKey,
      owner_run_id: ownerRunId,
      workspace,
      claim: canonicalClaim,
      handoff,
      mapping: mappingContext(canonicalAdmission, handoff.feature_id, `${runKey}-wrong`),
      verification_mode: "terminal",
    });
    assert.equal(wrongRun.ok, false);
    if (!wrongRun.ok) assert.match(wrongRun.error, /selector does not match/u);
    const exactPair = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
      feature_id: handoff.feature_id,
      run_key: runKey,
      owner_run_id: ownerRunId,
      workspace,
      claim: canonicalClaim,
      handoff,
      mapping: mappingContext(canonicalAdmission, handoff.feature_id, runKey),
      verification_mode: "terminal",
    });
    assert.equal(exactPair.ok, false, "an exact selector without its canonical mapping must still fail closed");
    if (!exactPair.ok) assert.match(exactPair.error, /canonical mapping record is unreadable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim admission rejects missing, invalid, and raced constitutions without claim mutation", () => {
  const cases = [
    { label: "missing", mutate: (root: string) => unlinkSync(join(root, "CONSTITUTION.md")) },
    { label: "invalid", mutate: (root: string) => writeFileSync(join(root, "CONSTITUTION.md"), "# invalid\n", "utf8") },
    { label: "raced", mutate: (root: string) => {
      let injected = false;
      setStateTransactionTestHooks({ beforeCas: () => {
        if (injected) return;
        injected = true;
        writeFileSync(join(root, "CONSTITUTION.md"), "# raced\n", "utf8");
      } }, root);
    } },
  ] as const;
  for (const scenario of cases) {
    const handoff = validImplementationHandoff();
    const { root, runKey } = claimProject(handoff);
    const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
    const stateBefore = readFileSync(statePath);
    try {
      scenario.mutate(root);
      const rejected = acquireAt(root, runKey, handoff, "do_work", "run-constitution-" + scenario.label);
      assert.equal(rejected.ok, false, scenario.label + " constitution must block claim admission");
      if (!rejected.ok) assert.equal(rejected.code, "SPEC_STALE", scenario.label + " drift is stale");
      const claims = readExecutionClaimStore(root, handoff.feature_id);
      assert.ok(claims.ok, claims.ok ? "claim journal" : claims.error);
      if (claims.ok) assert.equal(claims.value.length, 0, scenario.label + " must not create a claim WAL/journal");
      assert.deepEqual(readFileSync(statePath), stateBefore, scenario.label + " must not mutate feature state");
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("durable acquisition persists one active claim and workspace authority", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const result = acquireAt(root, runKey, handoff, "do_work", "run-dw-1");
    assert.ok(result.ok, result.ok ? "acquired" : result.error);
    if (!result.ok) return;
    assert.equal(result.disposition, "created");
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok, store.ok ? "read" : store.error);
    if (store.ok) assert.deepEqual(store.value, [result.value]);
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "claimed");
      assert.equal(workspace.value.execution_claim_ref, result.value.claim_id);
    }

  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("claim authority and admission read feature state above the claim-local 1 MiB cap", () => {
  const handoff = validImplementationHandoff();
  const authorityProject = claimProject(handoff);
  try {
    const acquired = acquireAt(authorityProject.root, authorityProject.runKey, handoff, "do_work", "run-large-authority");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    inflateFeatureStateForLargeRead(authorityProject.root, handoff.feature_id);
    const authority = readCurrentExecutionClaim(authorityProject.root, handoff.feature_id);
    assert.ok(authority.ok, authority.ok ? "large feature state remains readable for authority" : authority.error);
    if (authority.ok) assert.equal(authority.value?.claim_id, acquired.value.claim_id);
  } finally {
    rmSync(authorityProject.root, { recursive: true, force: true });
  }

  const admissionProject = claimProject(handoff);
  try {
    inflateFeatureStateForLargeRead(admissionProject.root, handoff.feature_id);
    const acquired = acquireAt(admissionProject.root, admissionProject.runKey, handoff, "do_work", "run-large-admission");
    assert.ok(acquired.ok, acquired.ok ? "large feature state admitted" : acquired.error);
  } finally {
    rmSync(admissionProject.root, { recursive: true, force: true });
  }
});


test("forged ready handoff is rejected before claim WAL and canonical handoff remains claimable", () => {
  const canonical = validImplementationHandoff();
  const { root, runKey } = claimProject(canonical);
  try {
    const forged = freezeImplementationHandoff({
      ...freezeInput(),
      requirements: [{ ...canonical.requirements[0]!, statement: "forged task-plan identity" }],
    });
    const rejected = acquireAt(root, runKey, forged, "do_work", "run-forged");
    assert.equal(rejected.ok, false, "a structurally ready but non-canonical handoff must fail closed");
    const journal = readExecutionClaimStore(root, canonical.feature_id);
    assert.ok(journal.ok, journal.ok ? "empty claim journal" : journal.error);
    if (journal.ok) assert.equal(journal.value.length, 0, "canonical mismatch must not create claim journal authority");
    const retry = acquireAt(root, runKey, canonical, "do_work", "run-canonical");
    assert.ok(retry.ok, retry.ok ? "canonical handoff remains claimable" : retry.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-WAL canonical handoff drift compensates only the owned transaction", () => {
  const canonical = validImplementationHandoff();
  const { root, runKey } = claimProject(canonical);
  let injected = false;
  try {
    const forged = freezeImplementationHandoff({
      ...freezeInput(),
      requirements: [{ ...canonical.requirements[0]!, statement: "post-WAL canonical drift" }],
    });
    const handoffDir = join(featureArtifactsDir(root, canonical.feature_id), "implementation_handoff");
    let casCalls = 0;
    setStateTransactionTestHooks({
      beforeCas: () => {
        casCalls += 1;
        if (casCalls < 3 || injected) return;
        injected = true;
        writeFileSync(join(handoffDir, `${canonical.handoff_id}.json`), `${JSON.stringify(forged, null, 2)}\n`, "utf8");
      },
    }, root);
    const result = acquireAt(root, runKey, canonical, "do_work", "run-post-wal-drift");
    assert.equal(result.ok, false, "canonical drift at activation must fail closed");
    const claims = readExecutionClaimStore(root, canonical.feature_id);
    assert.ok(claims.ok, claims.ok ? "claim journal" : claims.error);
    if (claims.ok) assert.deepEqual(claims.value.map((claim) => claim.status), ["active", "released"], result.ok ? "unexpected success" : result.error);
    const workspace = resolveFeatureWorkspace(root, { feature_id: canonical.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.execution_claim_ref, null);
      assert.equal(workspace.value.execution_claim_prepare_ref, null);
    }
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact active claim replay reports replayed disposition without appending", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const first = acquireAt(root, runKey, handoff, "do_work", "run-dw-replay");
    assert.ok(first.ok, first.ok ? "acquired" : first.error);
    if (!first.ok) return;
    const replay = acquireAt(root, runKey, handoff, "do_work", "run-dw-replay");
    assert.ok(replay.ok, replay.ok ? "replayed" : replay.error);
    if (!replay.ok) return;
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.value.claim_id, first.value.claim_id);
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok, store.ok ? "read" : store.error);
    if (store.ok) assert.equal(store.value.length, 1, "exact replay must not append a journal entry");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("replayed constitution-bound claims reject live drift and recover after exact restoration", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const constitutionPath = join(root, "CONSTITUTION.md");
  const originalConstitution = readFileSync(constitutionPath, "utf8");
  try {
    const first = acquireAt(root, runKey, handoff, "do_work", "run-dw-replay-drift");
    assert.ok(first.ok, first.ok ? "acquired" : first.error);
    if (!first.ok) return;
    const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
    const journalPath = join(root, ".work-state", "features", handoff.feature_id, "artifacts", "execution_claim", "root.json");
    const beforeState = readFileSync(statePath);
    const beforeJournal = readFileSync(journalPath);
    writeFileSync(constitutionPath, originalConstitution + "\n## II. Security\n\nChanged during claim replay.\n", "utf8");
    const staleReplay = acquireAt(root, runKey, handoff, "do_work", "run-dw-replay-drift");
    assert.equal(staleReplay.ok, false, "replayed claim must recheck live constitution before returning authority");
    if (!staleReplay.ok) assert.equal(staleReplay.code, "SPEC_STALE");
    assert.deepEqual(readFileSync(statePath), beforeState, "constitution drift does not mutate workspace state");
    assert.deepEqual(readFileSync(journalPath), beforeJournal, "constitution drift does not append claim authority");
    writeFileSync(constitutionPath, originalConstitution, "utf8");
    const restoredReplay = acquireAt(root, runKey, handoff, "do_work", "run-dw-replay-drift");
    assert.ok(restoredReplay.ok, restoredReplay.ok ? "restored replay" : restoredReplay.error);
    if (restoredReplay.ok) {
      assert.equal(restoredReplay.disposition, "replayed");
      assert.equal(restoredReplay.value.claim_id, first.value.claim_id);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("completion evidence rejects a root swap before terminal admission", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const acquired = acquireAt(root, runKey, handoff, "do_work", "run-evidence-swap");
  assert.ok(acquired.ok, acquired.ok ? "acquired" : acquired.error);
  if (!acquired.ok) { rmSync(root, { recursive: true, force: true }); return; }
  const conformance = validImplementationConformance({ handoffDigest: handoff.handoff_digest });
  conformance.execution_claim_id = acquired.value.claim_id;
  conformance.execution_owner = acquired.value.owner_kind;
  conformance.execution_run_id = acquired.value.owner_run_id;
  conformance.profile_hash = sha256("profile");
  const artifacts = featureArtifactsDir(root, handoff.feature_id);
  writeTestArtifact(root, join(artifacts, "execution_claim"), acquired.value.claim_id, acquired.value);
  writeTestArtifact(root, join(artifacts, "implementation_conformance"), conformance.conformance_id, conformance);
  const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
  assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
  if (!workspace.ok) { rmSync(root, { recursive: true, force: true }); return; }
  workspace.value.status = "executing";
  workspace.value.implementation_conformance_ref = conformance.conformance_id;
  const outside = mkdtempSync(join(tmpdir(), "spec-claim-evidence-outside-"));
  const moved = root + ".opened";
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    PinnedProjectRoot.open = (projectRoot, hooks) => {
      const pinned = originalOpen(projectRoot, hooks);
      if (pinned && !swapped) {
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      }
      return pinned;
    };
    const state = { specification: workspace.value } as never;
    const result = specificationTerminalGuardError(state, artifacts);
    assert.ok(result, "root swap must reject completion evidence");
    assert.match(result ?? "", /project root changed|changed before it could be read|cannot be pinned/i);
    assert.deepEqual(readdirSync(outside), [], "replacement root must remain untouched");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("claim journal append rejects a root swap before exclusive commit", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const outside = mkdtempSync(join(tmpdir(), "spec-claim-journal-outside-"));
  const moved = root + ".opened";
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    PinnedProjectRoot.open = (projectRoot, hooks) => originalOpen(projectRoot, {
      ...(hooks ?? {}),
      beforeTempOpen: (relativePath) => {
        hooks?.beforeTempOpen?.(relativePath);
        if (swapped) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      },
    }, root);
    const result = acquireAt(root, runKey, handoff, "do_work", "run-journal-swap");
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.code === "SPEC_PATH_UNAUTHORIZED" || result.code === "SPEC_CLAIM_PERSIST_FAILED");
    assert.deepEqual(readdirSync(outside), [], "replacement root must remain untouched");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("claim inspection remains bound to its pin after a root swap", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const acquired = acquireAt(root, runKey, handoff, "do_work", "run-inspection-swap");
  assert.ok(acquired.ok, acquired.ok ? "acquired" : acquired.error);
  if (!acquired.ok) { rmSync(root, { recursive: true, force: true }); return; }
  const outside = mkdtempSync(join(tmpdir(), "spec-claim-inspection-outside-"));
  const moved = root + ".opened";
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    PinnedProjectRoot.open = (projectRoot, hooks) => {
      const pinned = originalOpen(projectRoot, hooks);
      if (pinned && !swapped) {
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      }
      return pinned;
    };
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.equal(store.ok, true, store.ok ? "read" : store.error);
    if (store.ok) assert.equal(store.value.at(-1)?.claim_id, acquired.value.claim_id);
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.equal(current.ok, false);
    if (!current.ok) assert.equal(current.code, "SPEC_PATH_UNAUTHORIZED");
    assert.deepEqual(readdirSync(outside), [], "replacement root must remain untouched by claim inspection");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("claim release rejects a root swap between journal read and append", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const acquired = acquireAt(root, runKey, handoff, "do_work", "run-transition-swap");
  assert.ok(acquired.ok, acquired.ok ? "acquired" : acquired.error);
  if (!acquired.ok) { rmSync(root, { recursive: true, force: true }); return; }
  const outside = mkdtempSync(join(tmpdir(), "spec-claim-release-outside-"));
  const moved = root + ".opened";
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    PinnedProjectRoot.open = (projectRoot, hooks) => originalOpen(projectRoot, {
      ...hooks,
      beforeTempOpen: (relativePath) => {
        hooks.beforeTempOpen?.(relativePath);
        if (swapped) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      },
    });
    const result = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "release after swap" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.code === "SPEC_PATH_UNAUTHORIZED" || result.code === "SPEC_CLAIM_PERSIST_FAILED");
    assert.deepEqual(readdirSync(outside), [], "replacement root must not receive a release journal");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("claim completion rejects a root swap between journal read and append", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const acquired = acquireAt(root, runKey, handoff, "do_work", "run-completion-swap");
  assert.ok(acquired.ok, acquired.ok ? "acquired" : acquired.error);
  if (!acquired.ok) { rmSync(root, { recursive: true, force: true }); return; }
  const conformance = validImplementationConformance({ handoffDigest: handoff.handoff_digest });
  conformance.execution_claim_id = acquired.value.claim_id;
  conformance.execution_owner = acquired.value.owner_kind;
  conformance.execution_run_id = acquired.value.owner_run_id;
  conformance.matrix_digest = implementationConformanceMatrixDigest(conformance)!;
  conformance.conformance_id = `implementation-conformance.${conformance.matrix_digest}`;
  const outside = mkdtempSync(join(tmpdir(), "spec-claim-completion-outside-"));
  const moved = root + ".opened";
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    PinnedProjectRoot.open = (projectRoot, hooks) => originalOpen(projectRoot, {
      ...hooks,
      beforeTempOpen: (relativePath) => {
        hooks.beforeTempOpen?.(relativePath);
        if (swapped) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      },
    });
    const result = completeExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), conformance });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.code === "SPEC_PATH_UNAUTHORIZED" || result.code === "SPEC_CLAIM_PERSIST_FAILED");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("claim state bind rejects a root swap without replacement claims", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const outside = mkdtempSync(join(tmpdir(), "spec-claim-state-outside-"));
  const moved = root + ".opened";
  let swapped = false;
  try {
    setStateTransactionTestHooks({
      afterTargetResolution: () => {
        if (swapped) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      },
    }, root);
    const result = acquireAt(root, runKey, handoff, "do_work", "run-state-swap");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED");
    assert.deepEqual(readdirSync(outside), [], "replacement root must remain untouched");
  } finally {
    setStateTransactionTestHooks(null, root);
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
      const restored = readCurrentExecutionClaim(root, handoff.feature_id);
      assert.equal(restored.ok, true, restored.ok ? "restored root" : restored.error);
      if (restored.ok) assert.equal(restored.value, null, "restoring the old directory must not create claim authority");
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a second owner observes the canonical bound claim without compensation", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const first = acquireAt(root, runKey, handoff, "do_work", "run-first-owner");
  assert.ok(first.ok, first.ok ? "first claim" : first.error);
  try {
    let injected = false;
    setStateTransactionTestHooks({
      beforeCas: () => { injected = true; },
    }, root);
    const result = acquireAt(root, runKey, handoff, "do_work", "run-second-owner");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SPEC_EXECUTION_CLAIMED");
      assert.match(result.error, /run-first-owner/);
    }
    assert.equal(injected, false, "a conflicting owner must be rejected before a workspace CAS");
    const claims = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(claims.ok);
    if (claims.ok) assert.deepEqual(claims.value.map((claim) => claim.status), ["active"]);
    const currentClaim = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.ok(currentClaim.ok, currentClaim.ok ? "current claim" : currentClaim.error);
    if (currentClaim.ok) {
      assert.equal(currentClaim.value?.owner_run_id, "run-first-owner");
      assert.equal(currentClaim.value?.status, "active");
    }
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock-loser claim replay rejects live drift and replays after exact restoration", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const constitutionPath = join(root, "CONSTITUTION.md");
  const originalConstitution = readFileSync(constitutionPath, "utf8");
  const lockPath = join(root, ".work-state", "features", handoff.feature_id, "artifacts", "execution_claim", "claim.lock");
  const originalTryAcquire = PinnedProjectRoot.prototype.tryAcquireExclusiveLock;
  let injected = false;
  try {
    const first = acquireAt(root, runKey, handoff, "do_work", "run-lock-loser-first");
    assert.ok(first.ok, first.ok ? "first claim" : first.error);
    if (!first.ok) return;
    writeFileSync(lockPath, JSON.stringify({ schema: 2, token: "foreign-live-lock", pid: process.pid }) + "\n", "utf8");
    PinnedProjectRoot.prototype.tryAcquireExclusiveLock = function (
      this: PinnedProjectRoot,
      relativeCandidate: string,
      relativeTarget: string,
      ownerContent: string,
      options?: Parameters<PinnedProjectRoot["tryAcquireExclusiveLock"]>[3],
    ): boolean {
      if (!injected) {
        injected = true;
        writeFileSync(constitutionPath, originalConstitution + "\n## II. Security\n\nChanged during lock-loser replay.\n", "utf8");
      }
      return originalTryAcquire.call(this, relativeCandidate, relativeTarget, ownerContent, options);
    };
    const stale = acquireAt(root, runKey, handoff, "do_work", "run-lock-loser-first");
    assert.equal(stale.ok, false, "lock-loser replay must reject a constitution drift");
    if (!stale.ok) assert.equal(stale.code, "SPEC_STALE");
    assert.equal(injected, true);
    writeFileSync(constitutionPath, originalConstitution, "utf8");
    unlinkSync(lockPath);
    const restored = acquireAt(root, runKey, handoff, "do_work", "run-lock-loser-first");
    assert.ok(restored.ok, restored.ok ? "restored replay" : restored.error);
    if (restored.ok) assert.equal(restored.disposition, "replayed");
  } finally {
    PinnedProjectRoot.prototype.tryAcquireExclusiveLock = originalTryAcquire;
    try { unlinkSync(lockPath); } catch { /* lock was already removed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("claims module loads in a cold child process", async () => {
  const moduleUrl = new URL("../src/specification/claims.ts", import.meta.url).href;
  const script = "await import(" + JSON.stringify(moduleUrl) + "); process.stdout.write(\"ready\");";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 && stdout === "ready" ? resolve() : reject(new Error(stderr || "cold claims import exited with " + code)));
  });
});

test("simultaneous cross-process contenders cannot both receive active authority", async () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const moduleUrl = new URL("../src/specification/claims.ts", import.meta.url).href;
    const script = `import { acquireExecutionClaim } from ${JSON.stringify(moduleUrl)};
const handoff = JSON.parse(process.env.CLAIM_HANDOFF);
const result = acquireExecutionClaim(process.env.CLAIM_ROOT, handoff.feature_id, {
  handoff, run_key: process.env.CLAIM_RUN_KEY, owner_kind: "do_work",
  owner_run_id: process.env.CLAIM_OWNER, acquired_at: ${JSON.stringify(FIXED_NOW)}
});
process.stdout.write(JSON.stringify(result));`;
    const run = (owner: string): Promise<ReturnType<typeof acquireAt>> => new Promise((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, CLAIM_ROOT: root, CLAIM_RUN_KEY: runKey, CLAIM_OWNER: owner, CLAIM_HANDOFF: JSON.stringify(handoff) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", rejectChild);
      child.on("close", (code) => code === 0 ? resolveChild(JSON.parse(stdout) as ReturnType<typeof acquireAt>) : rejectChild(new Error(stderr)));
    }, root);
    const [first, second] = await Promise.all([run("run-dw-1"), run("run-dw-2")]);
    assert.equal([first, second].filter((result) => result.ok).length, 1);
    const rejected = [first, second].find((result) => !result.ok);
    assert.ok(rejected && !rejected.ok);
    if (rejected && !rejected.ok) assert.equal(rejected.code, "SPEC_EXECUTION_CLAIMED");
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok);
    if (store.ok) assert.equal(store.value.filter((claim) => claim.status === "active").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent canonical and forged handoffs admit only the canonical owner", async () => {
  const canonical = validImplementationHandoff();
  const forged = freezeImplementationHandoff({
    ...freezeInput(),
    requirements: [{ ...canonical.requirements[0]!, statement: "concurrent forged handoff" }],
  });
  const { root, runKey } = claimProject(canonical);
  try {
    const moduleUrl = new URL("../src/specification/claims.ts", import.meta.url).href;
    const script = `import { acquireExecutionClaim } from ${JSON.stringify(moduleUrl)};
const handoff = JSON.parse(process.env.CLAIM_HANDOFF);
const result = acquireExecutionClaim(process.env.CLAIM_ROOT, handoff.feature_id, {
  handoff, run_key: process.env.CLAIM_RUN_KEY, owner_kind: "do_work",
  owner_run_id: process.env.CLAIM_OWNER, acquired_at: ${JSON.stringify(FIXED_NOW)}
});
process.stdout.write(JSON.stringify(result));`;
    const run = (owner: string, handoff: ImplementationHandoff): Promise<ExecutionClaimAcquisitionResult> => {
      const { promise, resolve, reject } = Promise.withResolvers<ExecutionClaimAcquisitionResult>();
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, CLAIM_ROOT: root, CLAIM_RUN_KEY: runKey, CLAIM_OWNER: owner, CLAIM_HANDOFF: JSON.stringify(handoff) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout) as ExecutionClaimAcquisitionResult) : reject(new Error(stderr)));
      return promise;
    };
    const [winner, rejected] = await Promise.all([
      run("run-canonical", canonical),
      run("run-forged", forged),
    ]);
    assert.equal(winner.ok, true, winner.ok ? "canonical winner" : winner.error);
    assert.equal(rejected.ok, false, rejected.ok ? "forged handoff unexpectedly acquired" : rejected.error);
    const store = readExecutionClaimStore(root, canonical.feature_id);
    assert.ok(store.ok, store.ok ? "claim journal" : store.error);
    if (store.ok) assert.equal(store.value.filter((claim) => claim.status === "active").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a killed claim-lock owner is reclaimed before WAL admission", async () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const claimDir = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
  const lockPath = join(claimDir, "claim.lock");
  const childScript = `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.CLAIM_LOCK_PATH, JSON.stringify({ schema: 2, pid: process.pid, token: "killed-claim-owner", operation: "claim" }));
    process.stdout.write("ready");
    process.stdin.resume();
  `;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      env: { ...process.env, CLAIM_LOCK_PATH: lockPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child!.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("ready")) resolve();
      });
      child!.once("error", reject);
      child!.once("exit", (code, signal) => {
        if (!output.includes("ready")) reject(new Error(`claim-lock child exited before publishing (${code ?? signal ?? "unknown"})`));
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-after-killed-claim-owner");
    assert.equal(acquired.ok, true, acquired.ok ? "claim acquired after dead lock owner" : acquired.error);
    assert.equal(readCurrentExecutionClaim(root, handoff.feature_id).ok, true);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
test("a live legacy PID-only claim-lock owner is never reclaimed", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const claimDir = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
  const lockPath = join(claimDir, "claim.lock");
  try {
    mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    const owner = JSON.stringify({ schema: 2, pid: process.pid, token: "legacy-live-owner", operation: "claim" });
    writeFileSync(lockPath, owner, { mode: 0o600 });
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-live-legacy-owner");
    assert.equal(acquired.ok, false, "a live PID-only claim owner must remain authoritative");
    assert.equal(readFileSync(lockPath, "utf8"), owner, "claim lock bytes remain unchanged after the grace interval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("an exact active acquisition repeat is idempotent", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const first = acquireAt(root, runKey, handoff, "do_work", "run-dw-1");
    const repeat = acquireAt(root, runKey, handoff, "do_work", "run-dw-1");
    assert.ok(first.ok && repeat.ok);
    if (first.ok && repeat.ok) assert.equal(repeat.value.claim_id, first.value.claim_id);
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok);
    if (store.ok) assert.equal(store.value.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("executor choice is enforced before claim persistence", () => {
  const handoff = freezeImplementationHandoff(freezeInput({ execution_choices: ["do-work"] }));
  const { root, runKey } = claimProject(handoff);
  try {
    const result = acquireAt(root, runKey, handoff, "cto", "run-cto-1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_HANDOFF_NOT_READY");
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok);
    if (store.ok) assert.deepEqual(store.value, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("claim store symlinks fail closed without writing outside the feature", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const outside = mkdtempSync(join(tmpdir(), "claim-outside-"));
  try {
    const claimDir = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
    rmSync(claimDir, { recursive: true, force: true });
    symlinkSync(outside, claimDir, "dir");
    const result = acquireAt(root, runKey, handoff, "do_work", "run-dw-1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED");
    rmSync(claimDir, { recursive: true, force: true });
    mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a journal write failure returns typed failure and leaves no active claim", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const dir = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o500);
    const result = acquireAt(root, runKey, handoff, "do_work", "run-dw-1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.code === "SPEC_CLAIM_PERSIST_FAILED" || result.code === "SPEC_PATH_UNAUTHORIZED", result.error);
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok);
    if (store.ok) assert.deepEqual(store.value, []);
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok);
    if (workspace.ok) assert.equal(workspace.value.execution_claim_ref, null);
  } finally {
    try { chmodSync(dir, 0o700); } catch { /* directory may not exist after a failed setup */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("near-limit claim WAL remains readable during crash recovery inspection", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const nearOwner = `run-near-limit-${"o".repeat(170_000)}`;
  const nearTimestamp = `timestamp-${"t".repeat(108_000)}`;
  const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
  const maxWalBytes = 512 * 1024;
  try {
    const acquired = acquireExecutionClaim(root, handoff.feature_id, {
      handoff,
      run_key: runKey,
      owner_kind: "do_work",
      owner_run_id: nearOwner,
      acquired_at: nearTimestamp,
    });
    assert.ok(acquired.ok, acquired.ok ? "near-limit claim acquired" : acquired.error);
    if (!acquired.ok) return;
    const walNames = readdirSync(walDirectory).filter((name) => name.endsWith(".json"));
    assert.equal(walNames.length, 1, "the prepared WAL must remain available for recovery");
    const walBytes = Buffer.byteLength(readFileSync(join(walDirectory, walNames[0]!), "utf8"), "utf8");
    assert.ok(walBytes <= maxWalBytes, `prepared WAL must remain under the reader cap (${walBytes} bytes)`);
    assert.ok(walBytes >= maxWalBytes - 32 * 1024, `prepared WAL should exercise the near-bound reader path (${walBytes} bytes)`);

    const recoveryProbe = validImplementationConformance({ handoffDigest: handoff.handoff_digest });
    const recovered = recoverExecutionClaimCompletion(root, handoff.feature_id, recoveryProbe);
    assert.equal(recovered, null, "a readable acquire WAL with no completion postimage has no completion recovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("planted valid-shaped acquire WAL cannot supply an unrecognized claim identity", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
  try {
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "project root can be pinned");
    if (!pinned) return;
    try {
      const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { specification?: Record<string, unknown> };
      const workspace = state.specification;
      assert.ok(workspace, "canonical workspace exists");
      if (!workspace) return;
      const pathBinding = workspace.path_binding as Parameters<typeof workspacePathBindingDigest>[0];
      const forged = {
        schema: 1,
        operation: "acquire_prepared",
        transaction_id: "acquire-forged-00000001",
        claim: {
          claim_id: "claim-forged-prepared-wal",
          handoff_digest: handoff.handoff_digest,
          owner_kind: "do_work",
          owner_run_id: "run-planted-wal",
          status: "active",
          acquired_at: FIXED_NOW,
          updated_at: FIXED_NOW,
          release_reason: null,
        },
        feature_id: handoff.feature_id,
        run_key: runKey,
        handoff_ref: handoff.handoff_id,
        expected_workspace_digest: workspaceDigestOf(workspace),
        previous_digest: null,
        workspace_path_binding_digest: workspacePathBindingDigest(pathBinding),
        project_root_identity: { canonical_path: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino },
        path_binding: pathBinding,
        created_at: FIXED_NOW,
      };
      mkdirSync(walDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(walDirectory, `${forged.transaction_id}.json`), JSON.stringify(forged) + "\n", "utf8");
    } finally {
      pinned.close();
    }
    const rejected = acquireAt(root, runKey, handoff, "do_work", "run-planted-wal");
    assert.equal(rejected.ok, false, "an unrecognized prepared WAL must not be adopted");
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_CLAIM_RECOVERY_REQUIRED");
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace remains readable" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "implementation_ready");
      assert.equal(workspace.value.execution_claim_ref, null);
      assert.equal(workspace.value.execution_claim_prepare_ref, null);
    }
    assert.deepEqual(readdirSync(walDirectory).filter((name) => name.endsWith(".json")), ["acquire-forged-00000001.json"], "unrecognized WAL is preserved for forensic recovery");
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.equal(current.ok, true, current.ok ? "authority read" : current.error);
    if (current.ok) assert.equal(current.value, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized claim WAL fails before writing or mutating claim state", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const oversizedOwner = `run-oversize-${"o".repeat(220_000)}`;
  const oversizedTimestamp = `timestamp-${"t".repeat(110_000)}`;
  const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
  try {
    const result = acquireExecutionClaim(root, handoff.feature_id, {
      handoff,
      run_key: runKey,
      owner_kind: "do_work",
      owner_run_id: oversizedOwner,
      acquired_at: oversizedTimestamp,
    });
    assert.equal(result.ok, false, "the oversized prepared WAL must be rejected");
    if (!result.ok) assert.equal(result.code, "SPEC_CLAIM_PERSIST_FAILED");
    assert.deepEqual(
      readdirSync(walDirectory).filter((name) => name.endsWith(".json")),
      [],
      "an oversized prepared WAL must not create a file",
    );
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok, store.ok ? "claim store remains readable" : store.error);
    if (store.ok) assert.deepEqual(store.value, [], "an oversized prepared WAL must not append claim authority");
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace remains readable" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "implementation_ready");
      assert.equal(workspace.value.execution_claim_ref, null);
      assert.equal(workspace.value.execution_claim_prepare_ref, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized claim WAL string fails before writing even under the file cap", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const oversizedOwner = `run-string-limit-${"o".repeat(300_000)}`;
  const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
  try {
    const result = acquireExecutionClaim(root, handoff.feature_id, {
      handoff,
      run_key: runKey,
      owner_kind: "do_work",
      owner_run_id: oversizedOwner,
      acquired_at: FIXED_NOW,
    });
    assert.equal(result.ok, false, "a single oversized WAL string must be rejected");
    if (!result.ok) {
      assert.equal(result.code, "SPEC_CLAIM_PERSIST_FAILED");
      assert.match(result.error, /bounded JSON limits/u);
    }
    assert.deepEqual(
      readdirSync(walDirectory).filter((name) => name.endsWith(".json")),
      [],
      "an oversized WAL string must not create a file",
    );
    const store = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(store.ok, store.ok ? "claim store remains readable" : store.error);
    if (store.ok) assert.deepEqual(store.value, [], "an oversized WAL string must not append claim authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized release reason fails before journal append or claim mutation", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-oversized-reason");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    const beforeStore = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(beforeStore.ok, beforeStore.ok ? "claim store before transition" : beforeStore.error);
    if (!beforeStore.ok) return;
    const nextDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "next");
    const beforeNext = readdirSync(nextDirectory);
    const result = releaseExecutionClaim(root, handoff.feature_id, {
      ...identity(acquired.value),
      reason: `oversized-${"r".repeat(300 * 1024)}`,
      updated_at: FIXED_NOW,
    });
    assert.equal(result.ok, false, "an oversized reason must be rejected before journal CAS");
    if (!result.ok) assert.equal(result.code, "SPEC_CLAIM_PERSIST_FAILED");
    const afterStore = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(afterStore.ok, afterStore.ok ? "claim store after transition" : afterStore.error);
    if (afterStore.ok) assert.deepEqual(afterStore.value, beforeStore.value, "failed transition must not mutate claim authority");
    assert.deepEqual(readdirSync(nextDirectory), beforeNext, "failed transition must not append a successor envelope");
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.ok(current.ok, current.ok ? "current claim remains readable" : current.error);
    if (current.ok) assert.equal(current.value?.claim_id, acquired.value.claim_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constitution drift after active append blocks claimed CAS and compensates safely", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  let casCalls = 0;
  let injected = false;
  try {
    setStateTransactionTestHooks({ beforeCas: () => {
      casCalls += 1;
      if (casCalls !== 4 || injected) return;
      injected = true;
      writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
    } }, root);
    const rejected = acquireAt(root, runKey, handoff, "do_work", "run-activation-stale");
    assert.equal(rejected.ok, false, "stale constitution must block claimed activation");
    if (!rejected.ok) assert.ok(rejected.code === "SPEC_STALE" || rejected.code === "SPEC_CLAIM_PERSIST_FAILED");
    assert.equal(injected, true, "the activation CAS hook must run");
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "implementation_ready", "failed activation cleanup leaves readiness unclaimed");
      assert.equal(workspace.value.execution_claim_ref, null);
      assert.equal(workspace.value.execution_claim_prepare_ref, null);
    }
    const claims = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(claims.ok, claims.ok ? "claim history" : claims.error);
    assert.ok(claims.ok, claims.ok ? "claim history" : claims.error);
    const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
    assert.deepEqual(readdirSync(walDirectory), [], "failed activation cleanup leaves no orphan prepared WAL");
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.ok(current.ok, current.ok ? "claim authority" : current.error);
    if (current.ok) assert.equal(current.value, null, "failed activation leaves no claim authority");
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const retry = acquireAt(root, runKey, handoff, "do_work", "run-activation-retry");
    assert.ok(retry.ok, retry.ok ? "corrected constitution remains claimable" : retry.error);
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale release rolls back the journal and preserves active authority", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-heal-stale");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    let injected = false;
    setStateTransactionTestHooks({ beforeCas: () => {
      if (injected) return;
      injected = true;
      writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
    } }, root);
    const released = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "release race", updated_at: FIXED_NOW });
    assert.equal(released.ok, false, "release CAS drift must fail closed");
    if (!released.ok) assert.equal(released.code, "SPEC_STALE");
    setStateTransactionTestHooks(null, root);
    const claims = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(claims.ok, claims.ok ? "claim history" : claims.error);
    if (claims.ok) assert.deepEqual(claims.value.map((claim) => claim.status), ["active"], "a stale release must roll back its appended journal record");
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.ok(current.ok, current.ok ? "current authority" : current.error);
    if (current.ok) {
      assert.equal(current.value?.claim_id, acquired.value.claim_id);
      assert.equal(current.value?.status, "active");
    }
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "claimed");
      assert.equal(workspace.value.execution_claim_ref, acquired.value.claim_id);
    }
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const recovered = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "release after stale retry", updated_at: FIXED_NOW });
    assert.equal(recovered.ok, true, recovered.ok ? "active authority released after stale retry" : recovered.error);
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("release retries a one-shot state CAS interleaving and remains idempotent", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  let casCalls = 0;
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-release-cas-retry");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        casCalls += 1;
        if (casCalls !== 1) return;
        const raced = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
        raced.state_revision = Number(raced.state_revision ?? 0) + 1;
        writeFileSync(sourcePath, JSON.stringify(raced) + "\n", "utf8");
      },
    }, root);
    const released = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "release after one-shot CAS race", updated_at: FIXED_NOW });
    assert.equal(released.ok, true, released.ok ? "release retries against the current state preimage" : released.error);
    assert.ok(casCalls >= 2, "release must retry after the first state CAS conflict");
    setStateTransactionTestHooks(null, root);
    const claims = readExecutionClaimStore(root, handoff.feature_id);
    assert.equal(claims.ok, true, claims.ok ? "claim journal" : claims.error);
    if (claims.ok) assert.deepEqual(claims.value.map((claim) => claim.status), ["active", "released"]);
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "implementation_ready");
      assert.equal(workspace.value.execution_claim_ref, null);
    }
    const repeated = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "repeat release", updated_at: FIXED_NOW });
    assert.equal(repeated.ok, false, "a terminal release cannot append a second release record");
    if (!repeated.ok) assert.equal(repeated.code, "SPEC_EXECUTION_CLAIMED");
    const afterRepeat = readExecutionClaimStore(root, handoff.feature_id);
    assert.equal(afterRepeat.ok, true, afterRepeat.ok ? "claim journal after repeat" : afterRepeat.error);
    if (afterRepeat.ok) assert.equal(afterRepeat.value.length, 2, "repeated release must not append authority");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("release rollback preserves a same-byte journal replacement", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const originalWrite = PinnedProjectRoot.prototype.writeExclusiveWithReceipt;
  let replaced = false;
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-release-same-byte");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = function(relativePath, content) {
        const receipt = originalWrite.call(this, relativePath, content);
        if (!replaced && relativePath.includes("/next/")) {
          replaced = true;
          const absolute = join(root, relativePath);
          const bytes = readFileSync(absolute);
          rmSync(absolute, { force: true });
          writeFileSync(absolute, bytes);
        }
      return receipt;
    };
    setStateTransactionTestHooks({
      beforeCas: () => {
        writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
      },
    }, root);
    const released = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "release replacement race", updated_at: FIXED_NOW });
    assert.equal(replaced, true, "release journal publication must be interposed");
    assert.equal(released.ok, false, "a journal replacement must fail closed");
    if (!released.ok) assert.equal(released.code, "SPEC_CLAIM_PERSIST_FAILED");
    const claimDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
    const releaseEntries = readdirSync(join(claimDirectory, "next")).filter((name) => name.endsWith(".json"));
    assert.equal(releaseEntries.length, 1, "the same-byte replacement must not be removed by rollback");
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.equal(current.ok, true, current.ok ? "authority read" : current.error);
    if (current.ok) assert.equal(current.value, null, "the replaced journal is not silently treated as active authority");
  } finally {
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = originalWrite;
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});


test("prepared WAL cleanup never unlinks a same-byte replacement", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  let replaced = false;
  const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
  const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
  try {
    setStateTransactionTestHooks({ beforeCas: () => {
      if (replaced) return;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { specification?: { execution_claim_prepare_ref?: string | null } };
      const transactionId = state.specification?.execution_claim_prepare_ref;
      if (!transactionId) return;
      const walPath = join(walDirectory, `${transactionId}.json`);
      const bytes = readFileSync(walPath);
      unlinkSync(walPath);
      writeFileSync(walPath, bytes);
      replaced = true;
      writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
    } }, root);
    const result = acquireAt(root, runKey, handoff, "do_work", "run-wal-replacement");
    assert.equal(replaced, true, "the prepared WAL must be replaced before activation cleanup");
    assert.equal(result.ok, false, "a replacement WAL must fail closed");
    if (!result.ok) assert.equal(result.code, "SPEC_CLAIM_PERSIST_FAILED");
    const remaining = readdirSync(walDirectory).filter((name) => name.endsWith(".json"));
    assert.equal(remaining.length, 1, "exact cleanup must preserve the replacement WAL");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("release completes after an ambiguous append when the exact released tail is visible", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const originalWrite = PinnedProjectRoot.prototype.writeExclusiveWithReceipt;
  let ambiguous = false;
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-release-ambiguous");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = function(relativePath, content, options) {
      const receipt = originalWrite.call(this, relativePath, content, options);
      if (!ambiguous && relativePath.includes("/next/")) {
        ambiguous = true;
        throw new Error("simulated append acknowledgement loss");
      }
      return receipt;
    };
    const released = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "ambiguous release", updated_at: FIXED_NOW });
    assert.equal(ambiguous, true, "the release append must cross the ambiguous seam");
    assert.equal(released.ok, true, released.ok ? "exact released tail permits deterministic workspace release" : released.error);
    const claims = readExecutionClaimStore(root, handoff.feature_id);
    assert.equal(claims.ok, true, claims.ok ? "claim journal" : claims.error);
    if (claims.ok) assert.deepEqual(claims.value.map((claim) => claim.status), ["active", "released"]);
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "implementation_ready");
      assert.equal(workspace.value.execution_claim_ref, null);
    }
  } finally {
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("release preserves workspace authority when an ambiguous append has no released tail", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const originalWrite = PinnedProjectRoot.prototype.writeExclusiveWithReceipt;
  let ambiguous = false;
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-release-ambiguous-no-tail");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = function(relativePath, content, options) {
      if (!ambiguous && relativePath.includes("/next/")) {
        ambiguous = true;
        throw new Error("simulated append failure before publication");
      }
      return originalWrite.call(this, relativePath, content, options);
    };
    const rejected = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "ambiguous release without tail", updated_at: FIXED_NOW });
    assert.equal(ambiguous, true, "the release append must cross the ambiguous seam");
    assert.equal(rejected.ok, false, "without the intended released tail, release must fail closed");
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_CLAIM_PERSIST_FAILED");
    const current = readCurrentExecutionClaim(root, handoff.feature_id);
    assert.equal(current.ok, true, current.ok ? "active authority" : current.error);
    if (current.ok) assert.equal(current.value?.status, "active");
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "claimed");
      assert.equal(workspace.value.execution_claim_ref, acquired.value.claim_id);
    }
  } finally {
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
});


test("acquisition compensation retries an already-released tail and cleans exact preparation state", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  const originalWrite = PinnedProjectRoot.prototype.writeExclusive;
  let compensationAppendAmbiguous = false;
  let activationDrifted = false;
  try {
    PinnedProjectRoot.prototype.writeExclusive = function(relativePath, content) {
      const result = originalWrite.call(this, relativePath, content);
      if (!compensationAppendAmbiguous && relativePath.includes("/next/")) {
        let envelope: { claim?: { status?: string } } | null = null;
        try { envelope = JSON.parse(typeof content === "string" ? content : Buffer.from(content).toString("utf8")) as { claim?: { status?: string } }; } catch { /* non-journal writes are ignored */ }
        if (envelope?.claim?.status === "released") {
          compensationAppendAmbiguous = true;
          throw new Error("simulated compensation acknowledgement loss");
        }
      }
      return result;
    };
    setStateTransactionTestHooks({ beforeCas: ({ sourcePath }) => {
      if (activationDrifted) return;
      const state = JSON.parse(readFileSync(sourcePath, "utf8")) as { specification?: { execution_claim_prepare_ref?: string | null } };
      if (!state.specification?.execution_claim_prepare_ref) return;
      activationDrifted = true;
      writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
    } }, root);
    const failed = acquireAt(root, runKey, handoff, "do_work", "run-compensation-retry");
    assert.equal(compensationAppendAmbiguous, true, "compensation must cross the ambiguous append seam");
    assert.equal(failed.ok, false, "the injected activation failure remains visible to the caller");
    setStateTransactionTestHooks(null, root);
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const claims = readExecutionClaimStore(root, handoff.feature_id);
    assert.equal(claims.ok, true, claims.ok ? "claim journal" : claims.error);
    if (claims.ok) assert.deepEqual(claims.value.map((claim) => claim.status), ["active", "released"], "ambiguous compensation must not append a duplicate release");
    const workspace = resolveFeatureWorkspace(root, { feature_id: handoff.feature_id, run_key: runKey });
    assert.ok(workspace.ok, workspace.ok ? "workspace" : workspace.error);
    if (workspace.ok) {
      assert.equal(workspace.value.status, "implementation_ready");
      assert.equal(workspace.value.execution_claim_ref, null);
      assert.equal(workspace.value.execution_claim_prepare_ref, null);
    }
    const walDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "wal");
    assert.deepEqual(readdirSync(walDirectory).filter((name) => name.endsWith(".json")), [], "terminal compensation clears its exact preparation WAL");

    const retried = acquireAt(root, runKey, handoff, "do_work", "run-compensation-retry");
    assert.ok(retried.ok, retried.ok ? "retry acquires after terminal compensation cleanup" : retried.error);
    if (!retried.ok) return;
    const replayed = acquireAt(root, runKey, handoff, "do_work", "run-compensation-retry");
    assert.ok(replayed.ok, replayed.ok ? "repeat acquisition replays" : replayed.error);
    const afterReplay = readExecutionClaimStore(root, handoff.feature_id);
    assert.equal(afterReplay.ok, true, afterReplay.ok ? "claim journal after replay" : afterReplay.error);
    if (afterReplay.ok) assert.deepEqual(afterReplay.value.map((claim) => claim.status), ["active", "released", "active"], "replay must not append a duplicate terminal compensation");
  } finally {
    PinnedProjectRoot.prototype.writeExclusive = originalWrite;
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("release rejects constitution drift before journal advancement", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-release-stale");
    assert.ok(acquired.ok, acquired.ok ? "claim acquired" : acquired.error);
    if (!acquired.ok) return;
    const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
    const beforeState = readFileSync(statePath);
    const beforeStore = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(beforeStore.ok, beforeStore.ok ? "claim store" : beforeStore.error);
    if (!beforeStore.ok) return;
    writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
    const rejected = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "stale release", updated_at: FIXED_NOW });
    assert.equal(rejected.ok, false, "release must not report success against a stale constitution");
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_STALE");
    const afterStore = readExecutionClaimStore(root, handoff.feature_id);
    assert.ok(afterStore.ok, afterStore.ok ? "claim store remains readable" : afterStore.error);
    if (afterStore.ok) assert.deepEqual(afterStore.value, beforeStore.value, "stale release must not append a release journal record");
    assert.deepEqual(readFileSync(statePath), beforeState, "stale release must not mutate feature state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release and block transitions require the exact current owner, run, digest, and claim", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-dw-1");
    assert.ok(acquired.ok); if (!acquired.ok) return;
    const wrong = releaseExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), owner_run_id: "foreign", reason: "wrong" });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.code, "SPEC_EXECUTION_CLAIMED");
    const blocked = blockExecutionClaim(root, handoff.feature_id, { ...identity(acquired.value), reason: "evidence blocked", updated_at: FIXED_NOW });
    assert.ok(blocked.ok); if (!blocked.ok) return;
    const released = releaseExecutionClaim(root, handoff.feature_id, { ...identity(blocked.value), reason: "explicit release", updated_at: FIXED_NOW });
    assert.ok(released.ok);
    if (released.ok) assert.equal(released.value.status, "released");
    const reacquired = acquireAt(root, runKey, handoff, "do_work", "run-dw-2");
    assert.ok(reacquired.ok, reacquired.ok ? "reacquired" : reacquired.error);
    if (reacquired.ok) assert.notEqual(reacquired.value.claim_id, acquired.value.claim_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion persists only exact passing conformance", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-feature-one-1");
    assert.ok(acquired.ok); if (!acquired.ok) return;
    const conformance = validImplementationConformance({ handoffDigest: handoff.handoff_digest });
    conformance.execution_claim_id = acquired.value.claim_id;
    conformance.execution_owner = acquired.value.owner_kind;
    conformance.execution_run_id = acquired.value.owner_run_id;
    conformance.matrix_digest = implementationConformanceMatrixDigest(conformance)!;
    conformance.conformance_id = `implementation-conformance.${conformance.matrix_digest}`;
    const conformanceDir = join(featureArtifactsDir(root, handoff.feature_id), "implementation_conformance");
    mkdirSync(conformanceDir, { recursive: true, mode: 0o700 });
    writeTestArtifact(root, conformanceDir, conformance.conformance_id, conformance);
    const completionInput = { ...identity(acquired.value), conformance, updated_at: FIXED_NOW };
    const completed = completeExecutionClaim(root, handoff.feature_id, completionInput);
    assert.ok(completed.ok, completed.ok ? "completed" : completed.error);
    if (completed.ok) assert.equal(completed.value.status, "completed");
    const exactReplay = completeExecutionClaim(root, handoff.feature_id, completionInput);
    assert.ok(exactReplay.ok, exactReplay.ok ? "exact completion replay" : exactReplay.error);
    const completionStatePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
    const completionClaimJournalPath = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim", "next");
    const beforeAlternateState = readFileSync(completionStatePath);
    const beforeAlternateClaims = readdirSync(completionClaimJournalPath).sort();
    const alternateArtifact = { ...conformance, evaluated_at: "2026-09-14T00:00:01.000Z" };
    const alternateArtifactReplay = completeExecutionClaim(root, handoff.feature_id, { ...completionInput, conformance: alternateArtifact });
    assert.equal(alternateArtifactReplay.ok, false, "an alternate valid artifact envelope must not replay the canonical completion");
    if (!alternateArtifactReplay.ok) assert.equal(alternateArtifactReplay.code, "SPEC_CLAIM_RECOVERY_REQUIRED");
    const alternateMatrix = structuredClone(conformance);
    alternateMatrix.entries[0]!.findings = [{ code: "alternate", subject_id: null, message: "alternate matrix", evidence_refs: [] }];
    alternateMatrix.matrix_digest = implementationConformanceMatrixDigest(alternateMatrix)!;
    alternateMatrix.conformance_id = `implementation-conformance.${alternateMatrix.matrix_digest}`;
    const alternateMatrixReplay = completeExecutionClaim(root, handoff.feature_id, { ...completionInput, conformance: alternateMatrix });
    assert.equal(alternateMatrixReplay.ok, false, "an alternate valid matrix must not replay the canonical completion");
    if (!alternateMatrixReplay.ok) assert.equal(alternateMatrixReplay.code, "SPEC_CLAIM_RECOVERY_REQUIRED");
    const alternateHandoffReplay = completeExecutionClaim(root, handoff.feature_id, { ...completionInput, handoff_digest: sha256("alternate-handoff") });
    assert.equal(alternateHandoffReplay.ok, false, "an alternate handoff identity must not replay the canonical completion");
    const alternateClaimReplay = completeExecutionClaim(root, handoff.feature_id, { ...completionInput, claim_id: "claim-alternate" });
    assert.equal(alternateClaimReplay.ok, false, "an alternate claim identity must not replay the canonical completion");
    assert.deepEqual(readFileSync(completionStatePath), beforeAlternateState, "alternate replay attempts must not mutate the completed workspace");
    assert.deepEqual(readdirSync(completionClaimJournalPath).sort(), beforeAlternateClaims, "alternate replay attempts must not append claim journal receipts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("invalid UTF-8 acquired_at in the claim root fails closed without acquisition mutation", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-invalid-root");
    assert.ok(acquired.ok, acquired.ok ? "initial claim" : acquired.error);
    if (!acquired.ok) return;
    const released = releaseExecutionClaim(root, handoff.feature_id, {
      ...identity(acquired.value),
      reason: "prepare invalid root fixture",
      updated_at: FIXED_NOW,
    });
    assert.ok(released.ok, released.ok ? "released claim" : released.error);
    if (!released.ok) return;

    const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
    const beforeState = readFileSync(statePath);
    const claimDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
    const rootPath = join(claimDirectory, "root.json");
    const originalRoot = readFileSync(rootPath);
    const marker = Buffer.from('"acquired_at": "', "utf8");
    const markerOffset = originalRoot.indexOf(marker);
    assert.ok(markerOffset >= 0, "claim root contains acquired_at");
    const invalidRoot = Buffer.from(originalRoot);
    invalidRoot[markerOffset + marker.byteLength] = 0xff;
    writeFileSync(rootPath, invalidRoot);
    const beforeEntries = readdirSync(claimDirectory).sort();

    const rejected = acquireAt(root, runKey, handoff, "do_work", "run-after-invalid-root");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_STATE_INVALID");
    assert.deepEqual(readFileSync(statePath), beforeState);
    assert.deepEqual(readFileSync(rootPath), invalidRoot);
    assert.deepEqual(readdirSync(claimDirectory).sort(), beforeEntries);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid UTF-8 claim manifest fails closed without recreation", () => {
  const handoff = validImplementationHandoff();
  const { root, runKey } = claimProject(handoff);
  try {
    const acquired = acquireAt(root, runKey, handoff, "do_work", "run-invalid-manifest");
    assert.ok(acquired.ok, acquired.ok ? "initial claim" : acquired.error);
    if (!acquired.ok) return;
    const released = releaseExecutionClaim(root, handoff.feature_id, {
      ...identity(acquired.value),
      reason: "prepare invalid manifest fixture",
      updated_at: FIXED_NOW,
    });
    assert.ok(released.ok, released.ok ? "released claim" : released.error);
    if (!released.ok) return;

    const statePath = join(root, ".work-state", "features", handoff.feature_id, "state.json");
    const beforeState = readFileSync(statePath);
    const claimDirectory = join(featureArtifactsDir(root, handoff.feature_id), "execution_claim");
    const manifestPath = join(claimDirectory, "manifest.json");
    const invalidManifest = readFileSync(manifestPath);
    invalidManifest[0] = 0xff;
    writeFileSync(manifestPath, invalidManifest);
    const beforeEntries = readdirSync(claimDirectory).sort();

    const rejected = acquireAt(root, runKey, handoff, "do_work", "run-after-invalid-manifest");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_STATE_INVALID");
    assert.deepEqual(readFileSync(statePath), beforeState);
    assert.deepEqual(readFileSync(manifestPath), invalidManifest);
    assert.deepEqual(readdirSync(claimDirectory).sort(), beforeEntries);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

