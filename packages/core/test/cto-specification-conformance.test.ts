/**
 * Failing contract for CTO's per-handoff conformance fan-in (T093).
 *
 * CTO execution consumes the same executor-neutral handoff and evidence
 * contract as /do-work. It may combine several handoffs in one wave, but it
 * MUST partition evidence by the frozen handoff digest and evaluate one
 * implementation-conformance matrix per feature. A blocked feature retains
 * its active claim while independent passing features can complete.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  FIXED_NOW,
  sha256,
  validImplementationHandoff,
  validExecutionClaim,
  validFeatureWorkspace,
  bindFeatureWorkspaceToRoot,
  specPreparationProfileHash,
} from "./fixtures/specification-fixtures.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { ctoRuntimeRunInitialIdentityDigest, hasValidCtoRuntimeStateProofPinned, mintCtoRuntimeRunOrigin, newCtoState, readCtoStatePinned, writeCtoRuntimeStateProof, writeCtoState } from "../src/cto/state.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { readPinnedArtifactSnapshot, setArtifactReadTestHooks, writeArtifactWithReference } from "../src/engine/artifacts.js";
import { checkpointAnswerBinding, checkpointPolicyHash, checkpointWorkIdentityHash } from "../src/engine/checkpoints.js";
import { ctoMappingConfirmationStateDigest, signCtoMappingConfirmationProof, writeCtoMappingConfirmationProof } from "../src/engine/cto-mapping-proof.js";
import { executionClaimAuthorizationProjectionDigest, readCurrentExecutionClaim } from "../src/specification/claims.js";
import { validateCtoMappingRecord } from "../src/specification/mapping-record.js";
import { captureWorkspacePathBinding } from "../src/specification/workspace.js";
import {
  computeCtoTerminalTeamsDigest,
  conformanceInputBoundaryIssues,
  ctoConformanceClaimsDigest,
  terminalConformanceEvidenceError,
  evaluateCtoSpecificationConformance,
  issueCtoSpecificationConformanceBinding,
  persistCtoSpecificationConformance,
  readCtoSpecificationConformanceReceipt,
  validateCtoSpecificationConformanceReceipt,
  setCtoConformanceReadTestHooks,
  type ConformanceEvidence,
  type CtoActiveClaimSummary,
  type CtoConformanceReadTestHooks,
  type CtoSpecificationConformanceBinding,
  type CtoSpecificationConformanceResult,
} from "../src/specification/conformance.js";
import { canonicalJson, digestOf, validateImplementationHandoff } from "../src/specification/validation.js";
import type { ExecutionClaim, ImplementationHandoff, QualityGateResult } from "../src/specification/types.js";
import type { CtoState } from "../src/cto/types.js";
import type { CompletionArtifactRef } from "../src/engine/types.js";

function snapshotWorkStateBytes(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  const visit = (relativePath: string): void => {
    const absolutePath = join(root, relativePath);
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      const child = join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) snapshot.set(child, readFileSync(join(root, child)));
    }
  };
  if (existsSync(join(root, ".work-state"))) visit(".work-state");
  return snapshot;
}

function handoff(featureId: string): ImplementationHandoff {
  const value = structuredClone(validImplementationHandoff({ featureId })) as unknown as ImplementationHandoff;
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...digestBody } = value;
  value.handoff_digest = digestOf(digestBody);
  return value;
}

function claimFor(feature: ImplementationHandoff): ExecutionClaim {
  const claim = validExecutionClaim({ handoffDigest: feature.handoff_digest, ownerKind: "cto" }) as unknown as Record<string, unknown>;
  claim.claim_id = `claim-${feature.feature_id}`;
  claim.owner_run_id = "cto-wave-1";
  return claim as unknown as ExecutionClaim;
}

function artifactRef(name: string, schema: "evidence" | "gate" = "evidence"): CompletionArtifactRef {
  const base = schema === "evidence" ? "conformance_evidence" : "quality_gate_evidence";
  const artifactId = `${base}-${name}.v1`;
  return {
    artifact_id: artifactId,
    path: `artifacts/${artifactId}.json`,
    sha256: sha256(name),
    schema_status: "met",
    quality_gate_status: "met",
  };
}

function evidence(
  feature: ImplementationHandoff,
  claim: ExecutionClaim,
  kind: ConformanceEvidence["kind"],
  subjectId: string,
  requirementId: string,
): ConformanceEvidence {
  const base: ConformanceEvidence = {
    evidence_id: `${feature.feature_id}-${kind}-${subjectId}`,
    kind,
    subject_id: subjectId,
    requirement_id: requirementId,
    handoff_digest: feature.handoff_digest,
    execution_claim_id: claim.claim_id,
    artifact: artifactRef(`${feature.feature_id}.${kind}.${subjectId}`),
  };
  if (kind === "review") return { ...base, review_verdict: "pass" };
  if (kind === "executed_test") {
    return {
      ...base,
      test: {
        evidence_ref: artifactRef(`${feature.feature_id}.runtime.${subjectId}`),
        test_kind: "runtime",
        status: "pass",
        executed_at: FIXED_NOW,
      },
    };
  }
  return base;
}

function completeEvidence(feature: ImplementationHandoff, claim: ExecutionClaim): ConformanceEvidence[] {
  return ["FR-1", "AC-1"].flatMap((subjectId) => [
    evidence(feature, claim, "implementation", subjectId, "FR-1"),
    evidence(feature, claim, "review", subjectId, "FR-1"),
    evidence(feature, claim, "executed_test", subjectId, "FR-1"),
  ]);
}

function mappingFor(features: readonly ImplementationHandoff[]): CtoSpecificationMapping {
  const hashBody = {
    schema_version: 1 as const,
    mapping_version: 1,
    cto_run_id: "cto-wave-1",
    execution: { wave_id: "wave-1", source_id: "source-1", capability_id: "capability-1", capability_epoch: "epoch-1", choice: "cto" as const },
    selections: features.map((feature) => ({ feature_id: feature.feature_id, run_key: "run-" + feature.feature_id })),
    execution_choice: "cto" as const,
    feature_ids: features.map((feature) => feature.feature_id),
    handoff_bindings: features.map((feature) => ({
      feature_id: feature.feature_id,
      handoff_id: feature.handoff_id,
      handoff_digest: feature.handoff_digest,
      artifact_versions: feature.artifact_versions,
    })),
    task_to_slice: features.map((feature) => ({
      feature_id: feature.feature_id,
      task_id: "T-1",
      team_id: `team-${feature.feature_id}`,
      slice_id: `slice-${feature.feature_id}`,
      requirement_ids: ["FR-1"],
      verification_ids: ["V-1"],
      evidence_refs: [`${feature.feature_id}-implementation-FR-1`],
      depends_on: [],
    })),
    shared_contracts: [],
    parallelization: features.map((feature) => ({
      slice_id: `slice-${feature.feature_id}`,
      decision: "parallel" as const,
      reason: "feature workspaces and handoff claims are independent",
      worktree: "same_branch" as const,
      depends_on_slice_ids: [],
      shared_contract_ids: [],
    })),
    checkpoint_ref: null,
    status: "awaiting_confirmation" as const,
  };
  const mappingHash = digestOf(hashBody);
  return {
    ...hashBody,
    mapping_id: `cto-mapping-${mappingHash.slice(0, 32)}`,
    mapping_hash: mappingHash,
    created_at: FIXED_NOW,
    checkpoint_ref: "checkpoint.cto-mapping.v1",
    status: "confirmed",
  };
}

interface CtoFeatureInput {
  feature: ImplementationHandoff;
  claim: ExecutionClaim;
  run_key?: string;
}

function durableMappingRecordPath(root: string, ctoRunId: string, mappingId: string): string {
  return join(realpathSync(root), ".work-state", "cto", ctoRunId, "specification-mappings", `${mappingId}.json`);
}
function persistFixtureConfirmation(
  root: string,
  path: string,
  record: Record<string, unknown>,
  mapping: CtoSpecificationMapping,
  ctoRunId: string,
  selections: readonly { feature_id: string; run_key: string }[],
): { path: string; digest: string; selections: Array<{ feature_id: string; run_key: string }> } {
  const first = selections[0]!;
  const statePath = join(realpathSync(root), ".work-state", "features", first.feature_id, "state.json");
  if (!existsSync(statePath)) {
    const body = JSON.stringify(record) + "\n";
    writeFileSync(path, body, "utf8");
    return { path, digest: sha256(body), selections: [...selections] };
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
  const policy = state.checkpoint_policy as Record<string, unknown>;
  const answer = (state.trusted_checkpoint_answers as Array<Record<string, unknown>>).find(
    (candidate) => candidate.answer_id === record.trusted_answer_ref,
  );
  if (!policy || !answer) throw new Error("fixture confirmation anchor was not seeded");
  record.confirmation_context = {
    ...(record.confirmation_context as Record<string, unknown>),
    policy_hash: checkpointPolicyHash(policy as never),
  };
  record.confirmation_state_after_digest = ctoMappingConfirmationStateDigest(state);
  record.confirmation_proof_ref = "tx-fixture-confirmation";
  const body = JSON.stringify(record) + "\n";
  writeFileSync(path, body, "utf8");
  const recordDigest = sha256(body);
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("fixture root cannot be pinned");
  try {
    const proof = signCtoMappingConfirmationProof(pinnedRoot, {
      schema_version: 1,
      root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
      cto_run_id: ctoRunId,
      mapping_id: mapping.mapping_id,
      mapping_hash: mapping.mapping_hash,
      mapping_version: mapping.mapping_version,
      transaction_id: "fixture-confirmation",
      proof_ref: "tx-fixture-confirmation",
      mapping_record_path: relative(pinnedRoot.canonical_root, path).split("/").join("/"),
      mapping_record_digest: recordDigest,
      state_path: `.work-state/features/${first.feature_id}/state.json`,
      state_after_digest: record.confirmation_state_after_digest,
      checkpoint_ref: record.checkpoint_ref,
      trusted_answer_ref: record.trusted_answer_ref,
      confirmation_context: record.confirmation_context,
      confirmed_at: record.confirmed_at,
      trusted_answer: answer,
    } as never);
    if (!proof) throw new Error("fixture confirmation proof could not be signed");
    const written = writeCtoMappingConfirmationProof(pinnedRoot, proof);
    if (!written.ok) throw new Error(`fixture confirmation proof could not be written: ${written.error}`);
    const claimPath = join(pinnedRoot.canonical_root, ".work-state", "features", first.feature_id, "artifacts", "execution_claim", "root.json");
    if (existsSync(claimPath)) {
      const envelope = JSON.parse(readFileSync(claimPath, "utf8")) as { claim: Record<string, any> };
      const proofAnswer = {
        answer_id: answer.answer_id,
        nonce: answer.nonce,
        channel: answer.channel,
        reference: answer.reference,
        binding: answer.binding,
      };
      const admission = envelope.claim.admission_binding as Record<string, unknown>;
      const authorizationDigest = executionClaimAuthorizationProjectionDigest({
        feature_id: first.feature_id,
        run_key: first.run_key,
        stage_id: "constitution_validate",
        capability_id: mapping.execution.capability_id,
        capability_epoch: mapping.execution.capability_epoch,
        capability_stage_id: null,
        checkpoint_ref: mapping.checkpoint_ref,
        trusted_answer_ref: record.trusted_answer_ref as string,
        checkpoint_policy: policy,
        checkpoint_rule: policy.rules?.[mapping.checkpoint_ref] ?? null,
        trusted_answer: answer,
        trusted_proof: proofAnswer,
        constitution_binding: state.specification?.constitution_binding ?? null,
        root_binding: {
          pinned_root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
          workspace_root: state.specification?.project_root_identity ?? null,
        },
        mapping_id: mapping.mapping_id,
        mapping_hash: mapping.mapping_hash,
        mapping_version: mapping.mapping_version,
      });
      envelope.claim.admission_binding = {
        ...admission,
        mapping_record_path: relative(pinnedRoot.canonical_root, path).split("/").join("/"),
        mapping_record_digest: recordDigest,
        confirmation_state_revision: state.state_revision ?? 0,
        feature_state_revision: state.state_revision ?? 0,
        confirmation_state_digest: sha256(readFileSync(statePath)),
        confirmation_authorization_digest: authorizationDigest,
        confirmation_ledger_digest: digestOf({
          checkpoint_policy: state.checkpoint_policy ?? null,
          trusted_checkpoint_answers: state.trusted_checkpoint_answers ?? [],
        }),
        policy_hash: checkpointPolicyHash(policy as never),
      };
      writeFileSync(claimPath, JSON.stringify(envelope) + "\n", "utf8");
    }
  } finally {
    pinnedRoot.close();
  }
  return { path, digest: recordDigest, selections: [...selections] };
}

function persistCtoMappingRecord(root: string, mapping: CtoSpecificationMapping, ctoRunId = "cto-wave-1"): { path: string; digest: string; selections: Array<{ feature_id: string; run_key: string }> } {
  const path = durableMappingRecordPath(root, ctoRunId, mapping.mapping_id);
  const selections = (mapping as CtoSpecificationMapping & { selections?: Array<{ feature_id: string; run_key: string }> }).selections
    ?? mapping.feature_ids.map((feature_id) => ({ feature_id, run_key: `run-${feature_id}` }));
  const first = selections[0]!;
  const record: Record<string, unknown> = {
    schema_version: 1,
    cto_run_id: ctoRunId,
    mapping,
    selections,
    checkpoint_ref: mapping.checkpoint_ref,
    trusted_answer_ref: "trusted-answer.cto-mapping.v1",
    confirmation_context: {
      feature_id: first.feature_id,
      run_key: first.run_key,
      stage_id: "constitution_validate",
      decision: "approve_continue",
      capability_id: "capability-1",
      capability_epoch: "epoch-1",
      policy_hash: sha256("policy"),
    },
    confirmed_at: FIXED_NOW,
  };
  mkdirSync(join(root, ".work-state", "cto", ctoRunId, "specification-mappings"), { recursive: true });
  return persistFixtureConfirmation(root, path, record, mapping, ctoRunId, selections);
}
function bindingFor(
  mapping: CtoSpecificationMapping,
  root: string,
  ctoRunId = "cto-wave-1",
  claims: readonly CtoActiveClaimSummary[] = [],
): CtoSpecificationConformanceBinding {
  const record = persistCtoMappingRecord(root, mapping, ctoRunId);
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("fixture root cannot be pinned for terminal CTO binding");
  try {
    const state = readCtoStatePinned(ctoRunId, pinnedRoot);
    const terminal = computeCtoTerminalTeamsDigest(state, mapping, record.selections);
    if (!terminal.ok) throw new Error(`fixture terminal CTO state is invalid: ${terminal.error}`);
    return issueCtoSpecificationConformanceBinding({
    project_root: realpathSync(root),
    cto_run_id: ctoRunId,
    mapping_id: mapping.mapping_id,
    mapping_hash: mapping.mapping_hash,
    mapping_record_path: record.path,
    mapping_record_digest: record.digest,
    checkpoint_id: "checkpoint.cto-mapping.v1",
    trusted_answer_id: "trusted-answer.cto-mapping.v1",
    active_claims_digest: ctoConformanceClaimsDigest(claims),
    terminal_teams_digest: terminal.digest,
  });
  } finally {
    pinnedRoot.close();
  }
}

function canonicalPersistedRef(
  root: string,
  featureId: string,
  submitted: CompletionArtifactRef,
  bodyValue: unknown,
): CompletionArtifactRef {
  return writeArtifactWithReference(
    root,
    join(root, ".work-state", "features", featureId, "artifacts"),
    submitted.artifact_id,
    bodyValue,
    {
      schema_status: submitted.schema_status,
      quality_gate_status: submitted.quality_gate_status,
    },
  );
}

function seedCtoFeature(
  root: string,
  input: CtoFeatureInput,
  mappingRecord: { path: string; digest: string; mapping: CtoSpecificationMapping },
): void {
  const featureId = input.feature.feature_id;
  const runKey = input.run_key ?? `run-${featureId}`;
  const workspace = bindFeatureWorkspaceToRoot(
    validFeatureWorkspace({ featureId, status: "claimed" }),
    root,
  ) as unknown as Record<string, unknown>;
  workspace.schema_version = 3;
  workspace.handoff_ref = input.feature.handoff_id;
  workspace.execution_claim_prepare_ref = null;
  workspace.execution_claim_ref = input.claim.claim_id;
  const stateDir = join(root, ".work-state", "features", featureId);
  const artifactsDir = join(stateDir, "artifacts");
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  mkdirSync(join(artifactsDir, "execution_claim", "next"), { recursive: true });
  mkdirSync(join(artifactsDir, "implementation_handoff"), { recursive: true });
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("fixture root cannot be pinned");
  try {
    workspace.path_binding = captureWorkspacePathBinding(pinnedRoot, featureId);
  } finally {
    pinnedRoot.close();
  }
  const statePath = join(stateDir, "state.json");
  const constitutionContent = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
  writeFileSync(join(root, "CONSTITUTION.md"), constitutionContent, "utf8");
  const constitutionBinding = workspace.constitution_binding as Record<string, unknown>;
  constitutionBinding.content_sha256 = sha256(constitutionContent);
  constitutionBinding.semantic_hash = sha256(constitutionContent.replace(/\s+/gu, " ").trim());
  const constitutionGateDir = join(root, ".work-state", "specification", "constitution");
  mkdirSync(constitutionGateDir, { recursive: true });
  writeFileSync(join(constitutionGateDir, "gate.json"), JSON.stringify({
    schema_version: 1,
    gate_id: "constitution.gate.v1",
    project_root: root,
    feature_id: null,
    origin: { origin_kind: "native_direct", origin_run_key: runKey, origin_stage: "specify" },
    gate: {
      gate_id: "constitution.gate.v1",
      origin_kind: "native_direct",
      origin_run_key: runKey,
      origin_stage: "specify",
      status: "usable",
      usability_result: "usable",
      provider: { provider_id: "native", path: "CONSTITUTION.md", source: "native_default" },
      binding: constitutionBinding,
      checkpoint_ref: null,
      resume_marker: null,
    },
  }) + "\n", "utf8");
  const context = mappingRecord.mapping;
  const checkpointPolicy = {
    default: "required_human",
    scope: "decision",
    hard_human: ["custom"],
    rules: {
      [context.checkpoint_ref]: {
        kind: "custom",
        default: "required_human",
        allowed_decisions: ["approve_continue"],
        phase: "before_advance",
        rationale: "Fixture mapping confirmation requires a trusted human answer.",
      },
    },
    source: "profile",
    policy_version: 1,
    rationale: "Fixture mapping confirmation is a decision-bound human checkpoint.",
  };
  const state: Record<string, unknown> = {
    schema: 1,
    branch: "test",
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "constitution" },
    task: "conformance fixture",
    workflow_override: false,
    issue: null,
    run_key: runKey,
    state_revision: 0,
    stage_cursor: "constitution_validate",
    stages: [{ id: "constitution_validate", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: FIXED_NOW,
    specification: workspace,
    work_identity: {
      run_id: runKey,
      wave_id: "wave-1",
      slice_id: `slice-${featureId}`,
      session_id: "conformance-fixture",
      workflow: "constitution",
      stage_id: "constitution_validate",
      stage_cursor: "constitution_validate",
      capability_id: context.execution.capability_id,
      capability_epoch: context.execution.capability_epoch,
      slot_id: `slice-${featureId}`,
      task_id: "T-1",
      dispatch_id: `dispatch-${featureId}`,
      attempt: 1,
      worker_id: `team-${featureId}`,
    },
    checkpoint_policy: checkpointPolicy,
  };
  const answerWithoutBinding: Record<string, unknown> = {
    answer_id: "trusted-answer.cto-mapping.v1",
    nonce: "fixture-confirmation-nonce",
    channel: "terminal",
    reference: "fixture-terminal-answer",
    run_id: runKey,
    stage_id: "constitution_validate",
    checkpoint_id: context.checkpoint_ref,
    work_identity_hash: checkpointWorkIdentityHash(state as never, "constitution_validate"),
    capability_id: context.execution.capability_id,
    capability_epoch: context.execution.capability_epoch,
    policy_hash: checkpointPolicyHash(checkpointPolicy as never),
    subject_binding: context.mapping_hash,
    subject_revision: context.mapping_version,
    decision: "approve_continue",
    authority_receipt: "fixture-confirmation-authority",
    issued_at: FIXED_NOW,
    feature_id: featureId,
  };
  const answer = {
    ...answerWithoutBinding,
    binding: checkpointAnswerBinding(answerWithoutBinding as never),
    consumed_at: FIXED_NOW,
  };
  state.trusted_checkpoint_answers = [answer];
  writeFileSync(statePath, JSON.stringify(state) + "\n", "utf8");
  writeFileSync(
    join(artifactsDir, "implementation_handoff", `${input.feature.handoff_id}.json`),
    JSON.stringify(input.feature) + "\n",
    "utf8",
  );
  const claim = input.claim as unknown as Record<string, unknown>;
  claim.admission_binding = {
    mapping_record_path: relative(realpathSync(root), mappingRecord.path).split("/").join("/"),
    mapping_record_digest: mappingRecord.digest,
    mapping_id: context.mapping_id,
    mapping_hash: context.mapping_hash,
    mapping_version: context.mapping_version,
    confirmation_state_revision: 0,
    feature_state_revision: 0,
    confirmation_state_digest: sha256(readFileSync(statePath)),
    confirmation_authorization_digest: sha256("fixture-authorization"),
    confirmation_ledger_digest: digestOf({ checkpoint_policy: null, trusted_checkpoint_answers: [] }),
    checkpoint_ref: context.checkpoint_ref,
    trusted_answer_ref: "trusted-answer.cto-mapping.v1",
    stage_id: "constitution_validate",
    policy_hash: sha256("policy"),
    wave_id: context.execution.wave_id,
    capability_id: context.execution.capability_id,
    capability_epoch: context.execution.capability_epoch,
  };
  writeFileSync(
    join(artifactsDir, "execution_claim", "root.json"),
    JSON.stringify({ schema: 1, previous_digest: null, claim }) + "\n",
    "utf8",
  );
}

function typedEvidenceArtifact(item: ConformanceEvidence): Record<string, unknown> {
  return {
    schema_version: 1,
    artifact_id: item.artifact.artifact_id,
    entries: [{
      evidence_id: item.evidence_id,
      kind: item.kind,
      subject_id: item.subject_id,
      requirement_id: item.requirement_id,
      handoff_digest: item.handoff_digest,
      execution_claim_id: item.execution_claim_id,
      ...(item.kind === "review" ? { review_verdict: item.review_verdict, recorded_at: FIXED_NOW } : {}),
      ...(item.kind === "executed_test" && item.test ? {
        test: {
          evidence_ref: item.test.evidence_ref,
          test_kind: item.test.test_kind,
          status: item.test.status,
          executed_at: item.test.executed_at,
        },
        recorded_at: FIXED_NOW,
      } : {}),
      ...(item.kind === "intent_conflict" ? { intent_message: item.intent_message, recorded_at: FIXED_NOW } : {}),
      ...(item.kind === "implementation" ? { recorded_at: FIXED_NOW } : {}),
    }],
  };
}
function persistedEvidence(
  root: string,
  featureId: string,
  item: ConformanceEvidence,
): ConformanceEvidence {
  const withTest = item.test
    ? {
      ...item,
      test: {
        ...item.test,
        evidence_ref: canonicalPersistedRef(
          root,
          featureId,
          item.test.evidence_ref,
          {
            schema_version: 1,
            artifact_id: item.test.evidence_ref.artifact_id,
            entries: [{
              evidence_id: `${item.evidence_id}.runtime`,
              kind: "implementation",
              subject_id: item.subject_id,
              requirement_id: item.requirement_id,
              handoff_digest: item.handoff_digest,
              execution_claim_id: item.execution_claim_id,
              recorded_at: FIXED_NOW,
            }],
          },
        ),
      },
    }
    : item;
  return {
    ...withTest,
    artifact: canonicalPersistedRef(root, featureId, withTest.artifact, typedEvidenceArtifact(withTest)),
  };
}

function typedQualityGateArtifact(gate: QualityGateResult, artifactId: string, evidenceRefs: readonly CompletionArtifactRef[] = []): Record<string, unknown> {
  return {
    schema_version: 1,
    artifact_id: artifactId,
    gates: [{
      gate_id: gate.gate_id,
      source: gate.source,
      status: gate.status,
      evidence_refs: evidenceRefs,
      findings: [],
      evaluated_at: FIXED_NOW,
    }],
  };
}

interface PreparedCtoConformanceInput {
  mapping: CtoSpecificationMapping;
  handoffs: Array<{ feature_id: string; run_key: string; handoff: ImplementationHandoff; quality_gates?: QualityGateResult[] }>;
  claims: Array<Record<string, unknown>>;
  evidence: ConformanceEvidence[];
  binding: CtoSpecificationConformanceBinding;
  mappingRecordPath: string;
}
function seedCtoTerminalState(
  root: string,
  mapping: CtoSpecificationMapping,
  selections: readonly { feature_id: string; run_key: string }[],
): void {
  const ctoState = newCtoState({
    id: "cto-wave-1",
    task: "conformance fixture",
    branch: "test",
    autonomous: true,
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true },
    plan: { id: "cto-wave-1", task: "conformance fixture", teams: [], created_at: FIXED_NOW },
  });
  ctoState.teams = mapping.task_to_slice.map((owner) => {
    const selection = selections.find((candidate) => candidate.feature_id === owner.feature_id);
    const runKey = selection?.run_key ?? `run-${owner.feature_id}`;
    const identity = {
      run_id: "cto-wave-1",
      wave_id: "wave-1",
      slice_id: owner.slice_id,
      session_id: "conformance-fixture",
      workflow: "standard" as const,
      stage_id: "execution",
      stage_cursor: "execution",
      capability_id: "capability-1",
      capability_epoch: "epoch-1",
      slot_id: owner.slice_id,
      task_id: owner.task_id,
      dispatch_id: `dispatch-${owner.team_id}`,
      attempt: 1,
      worker_id: owner.team_id,
    };
    return {
      id: owner.team_id,
      status: "done" as const,
      escalations: {},
      feature_id: owner.feature_id,
      run_key: runKey,
      task_id: owner.task_id,
      slice_id: owner.slice_id,
      work_identity: identity,
      completion_envelope: {
        schema_version: 1 as const,
        identity,
        outcome: "succeeded" as const,
        terminal_signal: "native_tool_result" as const,
        artifact_refs: [],
        evidence_ref: null,
        conflict_ref: null,
        completed_by: "engine_task_caller" as const,
        emitted_at: FIXED_NOW,
      },
    };
  });
  ctoState.active_wave_id = "wave-1";
  ctoState.wave_history = [{
    id: "wave-1",
    source: "specification-execution",
    source_id: "source-1",
    task: "conformance fixture",
    slice_ids: mapping.parallelization.map((entry) => entry.slice_id),
    status: "active",
    started_at: FIXED_NOW,
    work_identity: ctoState.teams[0]?.work_identity,
  }];
  writeCtoState(ctoState, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
 }

function prepareCtoConformanceInput(root: string, features: readonly CtoFeatureInput[], evidenceItems: readonly ConformanceEvidence[], mapping: CtoSpecificationMapping): PreparedCtoConformanceInput {
  const initialRecord = persistCtoMappingRecord(root, mapping);
  for (const input of features) seedCtoFeature(root, input, { ...initialRecord, mapping });
  const record = persistCtoMappingRecord(root, mapping);
  seedCtoTerminalState(root, mapping, record.selections);
  const handoffs: Array<{ feature_id: string; run_key: string; handoff: ImplementationHandoff; quality_gates?: QualityGateResult[] }> = features.map(({ feature, run_key }) => ({
    feature_id: feature.feature_id,
    run_key: run_key ?? `run-${feature.feature_id}`,
    handoff: feature,
  }));
  const claims = features.map(({ feature, claim }) => ({
    feature_id: feature.feature_id,
    claim_id: claim.claim_id,
    handoff_digest: claim.handoff_digest,
    owner_kind: claim.owner_kind,
    owner_run_id: claim.owner_run_id,
    status: claim.status,
  }));
  const evidence = evidenceItems.map((item) => {
    const owner = features.find(({ feature }) => feature.handoff_digest === item.handoff_digest);
    if (!owner) return item;
    return persistedEvidence(root, owner.feature.feature_id, item);
  });
  for (const entry of handoffs) {
    const featureId = entry.feature_id;
    const ownerEvidence = evidence.find((item) => item.handoff_digest === entry.handoff.handoff_digest);
    const proofId = `profile-gate-proof-${featureId}`;
    const proofRef = ownerEvidence?.artifact ?? canonicalPersistedRef(
      root,
      featureId,
      {
        artifact_id: proofId,
        path: `artifacts/${proofId}.json`,
        sha256: sha256(proofId),
        schema_status: "met",
        quality_gate_status: "met",
      },
      { schema_version: 1, artifact_id: proofId, entries: [] },
    );
    const gate: QualityGateResult = {
      gate_id: `execution-profile.${specPreparationProfileHash()}`,
      source: "execution_profile",
      status: "pass",
      evidence_refs: [],
      findings: [],
    };
    const gateId = `quality_gate_evidence-${featureId}`;
    const gateRef = canonicalPersistedRef(
      root,
      featureId,
      {
        artifact_id: gateId,
        path: `artifacts/${gateId}.json`,
        sha256: sha256(gateId),
        schema_status: "met",
        quality_gate_status: "met",
      },
      typedQualityGateArtifact(gate, gateId),
    );
    entry.quality_gates = [{ ...gate, evidence_refs: [gateRef] }];
  }
  let canonicalEvidence = evidence;
  for (const input of features) {
    const featureId = input.feature.feature_id;
    const owner = handoffs.find((candidate) => candidate.feature_id === featureId);
    const gate = owner?.quality_gates?.[0];
    const qualityRef = gate?.evidence_refs?.[0];
    const rows = canonicalEvidence
      .filter((item) => item.handoff_digest === input.feature.handoff_digest && item.kind === "executed_test" && Boolean(item.test))
      .map((item) => ({
        evidence_id: item.evidence_id,
        kind: item.kind,
        subject_id: item.subject_id,
        requirement_id: item.requirement_id,
        handoff_digest: item.handoff_digest,
        execution_claim_id: item.execution_claim_id,
        test: { ...item.test, evidence_ref: qualityRef },
        recorded_at: FIXED_NOW,
      }));
    if (!qualityRef || rows.length === 0) continue;
    const runtimeId = `runtime_test_evidence-${featureId}`;
    const runtimeRef = canonicalPersistedRef(
      root,
      featureId,
      {
        artifact_id: runtimeId,
        path: `artifacts/${runtimeId}.json`,
        sha256: sha256(runtimeId),
        schema_status: "met",
        quality_gate_status: "met",
      },
      { schema_version: 1, artifact_id: runtimeId, entries: rows },
    );
    canonicalEvidence = canonicalEvidence.map((item) => item.handoff_digest === input.feature.handoff_digest && item.kind === "executed_test" && item.test
      ? { ...item, test: { ...item.test, evidence_ref: runtimeRef } }
      : item);
  }
  canonicalEvidence = canonicalEvidence.map((item) => {
    if (item.kind !== "executed_test") return item;
    const owner = features.find(({ feature }) => feature.handoff_digest === item.handoff_digest);
    if (!owner) return item;
    return { ...item, artifact: canonicalPersistedRef(root, owner.feature.feature_id, item.artifact, typedEvidenceArtifact(item)) };
  });
  return {
    mapping,
    handoffs,
    claims,
    evidence: canonicalEvidence,
    binding: bindingFor(mapping, root, "cto-wave-1", claims as unknown as CtoActiveClaimSummary[]),
    mappingRecordPath: record.path,
  };
}

function evaluateWith(
  features: readonly CtoFeatureInput[],
  evidenceItems: readonly ConformanceEvidence[],
  mapping: CtoSpecificationMapping,
  binding: CtoSpecificationConformanceBinding | undefined,
  persistEvidence = true,
  claimSummaries?: readonly Record<string, unknown>[],
  qualityGates: readonly QualityGateResult[] = [],
  callerHandoffTransform?: (handoff: ImplementationHandoff) => ImplementationHandoff,
  callerEvidenceTransform?: (evidence: ConformanceEvidence[], persistedQualityGates: QualityGateResult[], root: string) => ConformanceEvidence[],
  callerQualityGateTransform?: (gates: QualityGateResult[]) => QualityGateResult[],
  authorityMapping?: CtoSpecificationMapping,
  configureReadHooks?: (root: string) => void,
  afterEvaluate?: (root: string, result: CtoSpecificationConformanceResult) => void,
): CtoSpecificationConformanceResult {
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-"));
  try {
    const authoritySource = authorityMapping ?? mapping;
    const record = persistCtoMappingRecord(root, authoritySource);
    for (const input of features) seedCtoFeature(root, input, { ...record, mapping: authoritySource });
    seedCtoTerminalState(root, authoritySource, record.selections);
    const handoffs: Array<Record<string, unknown>> = features.map(({ feature, run_key }) => ({
      feature_id: feature.feature_id,
      run_key: run_key ?? `run-${feature.feature_id}`,
      handoff: callerHandoffTransform ? callerHandoffTransform(structuredClone(feature)) : feature,
      ...(persistEvidence ? {} : { quality_gates: [] }),
    }));
    const durableClaims = features.map(({ feature, claim }) => ({
      feature_id: feature.feature_id,
      claim_id: claim.claim_id,
      handoff_digest: claim.handoff_digest,
      owner_kind: claim.owner_kind,
      owner_run_id: claim.owner_run_id,
      status: claim.status,
    }));
    const claims = claimSummaries ?? durableClaims;
    const effectiveBinding = binding ?? bindingFor(authoritySource, root, "cto-wave-1", durableClaims as unknown as CtoActiveClaimSummary[]);
    let evidence = evidenceItems.map((item) => {
      if (!persistEvidence) return item;
      const owner = features.find(({ feature }) => feature.handoff_digest === item.handoff_digest);
      if (!owner) return item;
      return persistedEvidence(root, owner.feature.feature_id, item);
    });
    if (qualityGates.length === 0 && persistEvidence) {
      for (const entry of handoffs) {
        const featureId = String(entry.feature_id);
        const profileGateId = `execution-profile.${specPreparationProfileHash()}`;
        const ownerEvidence = evidence.find((item) => item.handoff_digest === (entry.handoff as Record<string, unknown>).handoff_digest);
        const proofId = `profile-gate-proof-${featureId}`;
        const proofRef = ownerEvidence?.artifact ?? canonicalPersistedRef(
          root,
          featureId,
          {
            artifact_id: proofId,
            path: `artifacts/${proofId}.json`,
            sha256: sha256(proofId),
            schema_status: "met",
            quality_gate_status: "met",
          },
          { schema_version: 1, artifact_id: proofId, entries: [] },
        );
        const gate: QualityGateResult = {
          gate_id: profileGateId,
          source: "execution_profile",
          status: "pass",
          evidence_refs: [],
          findings: [],
        };
        const gateId = `quality_gate_evidence-${featureId}`;
        const gateRef = canonicalPersistedRef(
          root,
          featureId,
          {
            artifact_id: gateId,
            path: `artifacts/${gateId}.json`,
            sha256: sha256(gateId),
            schema_status: "met",
            quality_gate_status: "met",
          },
          typedQualityGateArtifact(gate, gateId),
        );
        entry.quality_gates = [{ ...gate, evidence_refs: [gateRef] }];
      }
    }
    if (persistEvidence && qualityGates.length === 0 && callerEvidenceTransform === undefined) {
      let canonicalEvidence = evidence;
      for (const input of features) {
        const featureId = input.feature.feature_id;
        const owner = handoffs.find((candidate) => candidate.feature_id === featureId);
        const gate = owner?.quality_gates?.[0] as QualityGateResult | undefined;
        const rows = canonicalEvidence
          .filter((item) => item.handoff_digest === input.feature.handoff_digest && item.kind === "executed_test" && Boolean(item.test))
          .map((item) => ({
            evidence_id: item.evidence_id,
            kind: item.kind,
            subject_id: item.subject_id,
            requirement_id: item.requirement_id,
            handoff_digest: item.handoff_digest,
            execution_claim_id: item.execution_claim_id,
            test: { ...item.test },
            recorded_at: FIXED_NOW,
          }));
        if (!gate || rows.length === 0) continue;
        const qualityId = `quality_gate_evidence-${featureId}`;
        const qualityRef = canonicalPersistedRef(
          root,
          featureId,
          {
            artifact_id: qualityId,
            path: `artifacts/${qualityId}.json`,
            sha256: sha256(qualityId),
            schema_status: "met",
            quality_gate_status: "met",
          },
          typedQualityGateArtifact(gate, qualityId),
        );
        owner!.quality_gates = [{ ...gate, evidence_refs: [qualityRef] }];
        const runtimeId = `runtime_test_evidence-${featureId}`;
        const runtimeRows = rows.map((row) => ({ ...row, test: { ...row.test, evidence_ref: qualityRef } }));
        const runtimeRef = canonicalPersistedRef(
          root,
          featureId,
          {
            artifact_id: runtimeId,
            path: `artifacts/${runtimeId}.json`,
            sha256: sha256(runtimeId),
            schema_status: "met",
            quality_gate_status: "met",
          },
          { schema_version: 1, artifact_id: runtimeId, entries: runtimeRows },
        );
        canonicalEvidence = canonicalEvidence.map((item) => item.handoff_digest === input.feature.handoff_digest && item.kind === "executed_test" && item.test
          ? { ...item, test: { ...item.test, evidence_ref: runtimeRef } }
          : item);
      }
      evidence = canonicalEvidence;
    }
    const persistedQualityGates = qualityGates.map((gate) => {
      const owner = features[0];
      const submittedRef = gate.evidence_refs[0];
      if (!persistEvidence || !owner || !submittedRef) return gate;
      const persistedRef = canonicalPersistedRef(
        root,
        owner.feature.feature_id,
        submittedRef,
        typedQualityGateArtifact(gate, submittedRef.artifact_id),
      );
      return { ...gate, evidence_refs: [persistedRef] };
    });
    const callerQualityGates = callerQualityGateTransform ? callerQualityGateTransform(persistedQualityGates) : persistedQualityGates;
    const transformedEvidence = callerEvidenceTransform ? callerEvidenceTransform(evidence, persistedQualityGates, root) : evidence;
    const callerEvidence = transformedEvidence.map((item) => {
      if ((!callerEvidenceTransform && qualityGates.length > 0) || !persistEvidence || item.kind !== "executed_test") return item;
      const owner = features.find(({ feature }) => feature.handoff_digest === item.handoff_digest);
      if (!owner) return item;
      return { ...item, artifact: canonicalPersistedRef(root, owner.feature.feature_id, item.artifact, typedEvidenceArtifact(item)) };
    });
    configureReadHooks?.(root);
    const result = evaluateCtoSpecificationConformance({
      project_root: root,
      mapping,
      binding: structuredClone(effectiveBinding),
      handoffs,
      claims,
      evidence: callerEvidence,
      quality_gates: callerQualityGates,
    });
    afterEvaluate?.(root, result);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function evaluateWithReadHook(
  features: readonly CtoFeatureInput[],
  evidenceItems: readonly ConformanceEvidence[],
  mapping: CtoSpecificationMapping,
  hooks: CtoConformanceReadTestHooks,
  cleanup?: () => void,
): CtoSpecificationConformanceResult {
  let registeredRoot: string | null = null;
  try {
    return evaluateWith(
      features,
      evidenceItems,
      mapping,
      undefined,
      true,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      (root) => {
        registeredRoot = root;
        setCtoConformanceReadTestHooks(hooks, root);
      },
    );
  } finally {
    if (registeredRoot) setCtoConformanceReadTestHooks(null, registeredRoot);
    cleanup?.();
  }
}

function evaluate(features: readonly CtoFeatureInput[], evidenceItems: readonly ConformanceEvidence[]): CtoSpecificationConformanceResult {
  const mapping = mappingFor(features.map(({ feature }) => feature));
  return evaluateWith(features, evidenceItems, mapping, undefined);
}

function featureResult(result: CtoSpecificationConformanceResult, featureId: string) {
  const feature = result.features.find((candidate) => candidate.feature_id === featureId);
  assert.ok(feature, `CTO result contains feature '${featureId}'`);
  return feature!;
}

function twoFeatures(): [CtoFeatureInput, CtoFeatureInput] {
  const first = handoff("feature-one");
  const second = handoff("feature-two");
  return [
    { feature: first, claim: claimFor(first) },
    { feature: second, claim: claimFor(second) },
  ];
}

test("mapping records require exact parallelization coverage and unique task owners", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-mapping-record-shape-"));
  try {
    const features = twoFeatures();
    const mapping = mappingFor(features.map(({ feature }) => feature));
    const base = {
      schema_version: 1,
      cto_run_id: "cto-wave-1",
      mapping: {
        ...structuredClone(mapping),
        status: "awaiting_confirmation",
        checkpoint_ref: null,
      },
      selections: structuredClone(mapping.selections),
      checkpoint_ref: null,
      trusted_answer_ref: null,
    } as Record<string, unknown>;
    const rehash = (record: Record<string, unknown>): string => {
      const candidate = record.mapping as Record<string, unknown>;
      const { mapping_id: _id, mapping_hash: _hash, created_at: _created, updated_at: _updated, ...body } = candidate;
      const hash = digestOf({ ...body, checkpoint_ref: null, status: "awaiting_confirmation" });
      candidate.mapping_hash = hash;
      candidate.mapping_id = `cto-mapping-${hash.slice(0, 32)}`;
      return candidate.mapping_id as string;
    };

    const mismatched = structuredClone(base) as Record<string, unknown>;
    const mismatchedMapping = mismatched.mapping as Record<string, unknown>;
    (mismatchedMapping.parallelization as Array<Record<string, unknown>>)[0]!.slice_id = "slice-foreign";
    const mismatchedId = rehash(mismatched);
    assert.match(validateCtoMappingRecord(mismatched, "cto-wave-1", mismatchedId) ?? "", /parallelization.*exactly cover|task slice/u);

    const duplicate = structuredClone(base) as Record<string, unknown>;
    const duplicateMapping = duplicate.mapping as Record<string, unknown>;
    const owners = duplicateMapping.task_to_slice as Array<Record<string, unknown>>;
    owners[1]!.slice_id = owners[0]!.slice_id;
    owners[1]!.team_id = owners[0]!.team_id;
    const duplicateId = rehash(duplicate);
    assert.match(validateCtoMappingRecord(duplicate, "cto-wave-1", duplicateId) ?? "", /duplicate slice, team, or task owners/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO conformance receipt reader rejects tampered feature rows and content refs", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-receipt-reader-"));
  const runId = "cto-receipt-reader";
  const waveId = "wave-receipt-reader";
  const mappingId = "cto-mapping-receipt-reader";
  const mappingPath = join(realpathSync(root), ".work-state", "cto", runId, "specification-mappings", `${mappingId}.json`);
  const binding = issueCtoSpecificationConformanceBinding({
    project_root: realpathSync(root),
    cto_run_id: runId,
    mapping_id: mappingId,
    mapping_hash: "a".repeat(64),
    mapping_record_path: mappingPath,
    mapping_record_digest: "b".repeat(64),
    checkpoint_id: "checkpoint.cto-mapping.v1",
    trusted_answer_id: "trusted-answer.cto-mapping.v1",
    active_claims_digest: "c".repeat(64),
    terminal_teams_digest: "d".repeat(64),
  });
  const body = {
    schema_version: 1 as const,
    cto_run_id: runId,
    wave_id: waveId,
    mapping_id: mappingId,
    mapping_record_digest: "b".repeat(64),
    conformance_capability_id: binding.capability_id,
    active_claims_digest: "c".repeat(64),
    terminal_teams_digest: "d".repeat(64),
    features: [{
      feature_id: "feature-one",
      run_key: "run-feature-one",
      conformance_id: `implementation-conformance.${"e".repeat(64)}`,
      artifact_sha256: "f".repeat(64),
      matrix_digest: "e".repeat(64),
      claim_id: "claim-feature-one",
    }],
  };
  const receipt = { ...body, receipt_ref: `cto-conformance-receipt-${digestOf(body)}` };
  const receiptDir = join(root, ".work-state", "cto", runId, "conformance-receipts");
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = join(receiptDir, `${receipt.receipt_ref}.json`);
  writeFileSync(receiptPath, `${canonicalJson(receipt)}\n`, "utf8");
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  if (!pinnedRoot) return;
  try {
    const valid = readCtoSpecificationConformanceReceipt(pinnedRoot, runId, receipt.receipt_ref);
    assert.equal(valid.ok, true, valid.ok ? "" : valid.error);
    assert.equal(validateCtoSpecificationConformanceReceipt(receipt).ok, true);
    const tampered = { ...receipt, features: [{ ...receipt.features[0]!, artifact_sha256: "0".repeat(64) }] };
    writeFileSync(receiptPath, `${canonicalJson(tampered)}\n`, "utf8");
    const rejected = readCtoSpecificationConformanceReceipt(pinnedRoot, runId, receipt.receipt_ref);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.error, /reference|canonical body/u);
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct CTO persistence gates pending, failed, wrong-run, and stale terminal teams", () => {
  const makeFixture = () => {
    const feature = twoFeatures()[0]!;
    const constitutionContent = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
    const handoffBinding = feature.feature.constitution_binding as unknown as Record<string, unknown>;
    handoffBinding.content_sha256 = sha256(constitutionContent);
    handoffBinding.semantic_hash = sha256(constitutionContent.replace(/\s+/gu, " ").trim());
    const { handoff_id: _handoffId, handoff_digest: _handoffDigest, schema_version: _schemaVersion, status: _status, ...handoffDigestBody } = feature.feature as unknown as Record<string, unknown>;
    feature.feature.handoff_digest = digestOf(handoffDigestBody);
    feature.claim.handoff_digest = feature.feature.handoff_digest;
    const mapping = mappingFor([feature.feature]);
    const root = mkdtempSync(join(tmpdir(), "cto-conformance-persist-terminal-"));
    const prepared = prepareCtoConformanceInput(root, [feature], completeEvidence(feature.feature, feature.claim), mapping);
    const durableClaim = readCurrentExecutionClaim(root, feature.feature.feature_id);
    if (!durableClaim.ok || !durableClaim.value) throw new Error("fixture CTO claim unavailable");
    prepared.claims[0]!.admission_binding = durableClaim.value.admission_binding;
    const runtime = openTestCtoRuntime(root, "conformance-persist-session", "conformance-persist-terminal");
    const runtimeRoot = PinnedProjectRoot.open(root);
    if (!runtimeRoot) throw new Error("fixture root cannot be pinned for runtime proof");
    try {
      const state = readCtoStatePinned("cto-wave-1", runtimeRoot);
      if (!state) throw new Error("fixture CTO state unavailable for runtime proof");
      const sessionId = "conformance-persist-session";
      state.owner_session = sessionId;
      const firstTeam = state.teams[0];
      if (!firstTeam?.work_identity) throw new Error("fixture CTO team identity unavailable for runtime proof");
      const sourceIdentity = { ...firstTeam.work_identity, session_id: sessionId };
      firstTeam.work_identity = sourceIdentity;
      if (firstTeam.completion_envelope) firstTeam.completion_envelope = { ...firstTeam.completion_envelope, identity: sourceIdentity };
      state.work_identity = sourceIdentity;
      state.wave_history = (state.wave_history ?? []).map((wave) => ({ ...wave, work_identity: sourceIdentity }));
      writeCtoState(state, root, { preCommit: ({ pinnedRoot: commitRoot }) => commitRoot.assertStable() });
      const initialDigest = ctoRuntimeRunInitialIdentityDigest(state);
      if (!mintCtoRuntimeRunOrigin(runtimeRoot, state, "conformance-persist-session", "source-1", initialDigest)
        || !writeCtoRuntimeStateProof(runtimeRoot, state)
        || !hasValidCtoRuntimeStateProofPinned(runtimeRoot, state)) throw new Error("fixture CTO runtime proof unavailable");
    } finally {
      runtimeRoot.close();
    }
    prepared.binding = bindingFor(mapping, root, "cto-wave-1", prepared.claims as unknown as CtoActiveClaimSummary[]);
    const updateTeam = (update: (team: CtoState["teams"][number]) => void) => {
      runtime.access.withRunTransaction("cto-wave-1", (transaction) => {
        const next = transaction.readState();
        update(next.teams[0]!);
        transaction.writeState(next);
      });
    };
    const invokeWith = (runtimeAccess: typeof runtime.access, sessionId: string, binding = prepared.binding) => {
      const { mappingRecordPath: _mappingRecordPath, ...input } = prepared;
      return persistCtoSpecificationConformance({
        ...input,
        project_root: root,
        binding,
      } as never, { runtimeAccess, sessionId });
    };
    const invoke = (binding = prepared.binding) => invokeWith(runtime.access, "conformance-persist-session", binding);
    return { feature, mapping, root, prepared, runtime, updateTeam, invoke, invokeWith };
  };

  const pending = makeFixture();
  try {
    pending.updateTeam((team) => { team.status = "in_progress"; });
    const result = pending.invoke();
    assert.equal(result.status, "blocked");
    assert.equal(result.persisted, false);
    assert.equal(existsSync(join(pending.root, ".work-state", "features", pending.feature.feature.feature_id, "artifacts", "implementation_conformance")), false);
  } finally {
    pending.runtime.close();
    rmSync(pending.root, { recursive: true, force: true });
  }

  const failed = makeFixture();
  try {
    failed.updateTeam((team) => {
      team.status = "failed";
      team.completion_envelope = { ...team.completion_envelope!, outcome: "failed", terminal_signal: "contract_failure" };
    });
    const binding = bindingFor(failed.mapping, failed.root, "cto-wave-1", failed.prepared.claims as unknown as CtoActiveClaimSummary[]);
    const result = failed.invoke(binding);
    assert.equal(result.status, "blocked");
    assert.equal(result.persisted, true);
    assert.equal(result.features[0]?.overall_status, "blocked");
    assert.equal(result.features[0]?.claim_action, "retain");
    assert.deepEqual(result.blocked_feature_ids, [failed.feature.feature.feature_id]);
    assert.deepEqual(result.passing_feature_ids, []);
    assert.ok(result.findings.some((finding) => finding.startsWith(`Feature '${failed.feature.feature.feature_id}':`)));
    assert.equal(existsSync(join(failed.root, result.features[0]!.artifact_ref.path)), true);
    assert.equal(readCurrentExecutionClaim(failed.root, failed.feature.feature.feature_id).value?.status, "active");
  } finally {
    failed.runtime.close();
    rmSync(failed.root, { recursive: true, force: true });
  }

  const foreign = makeFixture();
  try {
    const forgedBinding = { ...foreign.prepared.binding, capability_id: "foreign-conformance-capability" } as CtoSpecificationConformanceBinding;
    const result = foreign.invoke(forgedBinding);
    assert.equal(result.status, "blocked");
    assert.equal(result.persisted, false);
    const foreignState = foreign.runtime.access.readState("cto-wave-1") as { wave_history?: Array<{ id: string; conformance_receipt_ref?: string }> } | null;
    assert.equal(foreignState?.wave_history?.find((wave) => wave.id === "wave-1")?.conformance_receipt_ref, undefined);
    assert.equal(existsSync(join(foreign.root, ".work-state", "cto", "cto-wave-1", "conformance-receipts")), false);
  } finally {
    foreign.runtime.close();
    rmSync(foreign.root, { recursive: true, force: true });
  }

  const foreignSession = makeFixture();
  try {
    const foreignRuntime = openTestCtoRuntime(foreignSession.root, "conformance-foreign-session", "conformance-persist-terminal");
    try {
      const before = snapshotWorkStateBytes(foreignSession.root);
      const result = foreignSession.invokeWith(foreignRuntime.access, "conformance-foreign-session");
      assert.equal(result.status, "blocked");
      assert.equal(result.persisted, false);
      assert.match(result.findings.join("; "), /session does not own|owner session|different or unavailable runtime session/i);
      assert.deepEqual([...snapshotWorkStateBytes(foreignSession.root)], [...before], "foreign session rejection must leave all workspace, claim, conformance, and CTO state bytes unchanged");
    } finally {
      foreignRuntime.close();
    }
  } finally {
    foreignSession.runtime.close();
    rmSync(foreignSession.root, { recursive: true, force: true });
  }

  const forgedCallerClaim = makeFixture();
  try {
    forgedCallerClaim.prepared.claims[0]!.claim_id = "forged-caller-claim";
    const result = forgedCallerClaim.invoke();
    assert.equal(result.status, "blocked");
    assert.equal(result.persisted, false);
    const forgedState = forgedCallerClaim.runtime.access.readState("cto-wave-1") as { wave_history?: Array<{ id: string; conformance_receipt_ref?: string }> } | null;
    assert.equal(forgedState?.wave_history?.find((wave) => wave.id === "wave-1")?.conformance_receipt_ref, undefined);
  } finally {
    forgedCallerClaim.runtime.close();
    rmSync(forgedCallerClaim.root, { recursive: true, force: true });
  }

  const wrongRun = makeFixture();
  try {
    wrongRun.updateTeam((team) => { team.run_key = "run-forged"; });
    const result = wrongRun.invoke();
    assert.equal(result.status, "blocked");
    assert.equal(result.persisted, false);
    assert.match(result.findings.join("; "), /terminal.*postimage|run|identity/i);
  } finally {
    wrongRun.runtime.close();
    rmSync(wrongRun.root, { recursive: true, force: true });
  }

  const staleDigest = makeFixture();
  try {
    staleDigest.updateTeam((team) => { team.completion_envelope = { ...team.completion_envelope!, emitted_at: "2026-01-02T00:00:00.000Z" }; });
    const result = staleDigest.invoke();
    assert.equal(result.status, "blocked");
    assert.equal(result.persisted, false);
    assert.match(result.findings.join("; "), /terminal.*postimage|digest|authority/i);
  } finally {
    staleDigest.runtime.close();
    rmSync(staleDigest.root, { recursive: true, force: true });
  }
});

// ── Per-handoff matrix and passing-feature isolation ────────────────────────

test("CTO evaluates one independently bound matrix per handoff and releases only passing claims", () => {
  const features = twoFeatures();
  const result = evaluate(features, features.flatMap(({ feature, claim }) => completeEvidence(feature, claim)));
  assert.deepEqual(result.passing_feature_ids, ["feature-one", "feature-two"]);
  assert.deepEqual(result.blocked_feature_ids, []);
  assert.equal(result.features.length, 2, "one result is emitted for each selected feature");

  for (const { feature, claim } of features) {
    const perFeature = featureResult(result, feature.feature_id);
    assert.equal(perFeature.handoff_digest, feature.handoff_digest);
    assert.equal(perFeature.matrix.feature_id, feature.feature_id);
    assert.equal(perFeature.matrix.handoff_digest, feature.handoff_digest);
    assert.equal(perFeature.matrix.execution_claim_id, claim.claim_id);
    assert.equal(perFeature.matrix.overall_status, "pass");
    assert.equal(perFeature.matrix.next_action, "complete_feature");
    assert.equal(perFeature.result.overall_status, "pass");
    assert.equal(perFeature.claim_action, "release");
  }
});

test("CTO accepts quality-first canonical topology and rejects standalone nested refs", () => {
  const featureInput = twoFeatures()[0]!;
  const featureId = featureInput.feature.feature_id;
  const qualityArtifactId = `quality_gate_evidence-${featureId}`;
  const qualityArtifactRef: CompletionArtifactRef = {
    artifact_id: qualityArtifactId,
    path: `artifacts/${qualityArtifactId}.json`,
    sha256: sha256(qualityArtifactId),
    schema_status: "met",
    quality_gate_status: "met",
  };
  const profileGate: QualityGateResult = {
    gate_id: `execution-profile.${specPreparationProfileHash()}`,
    source: "execution_profile",
    status: "pass",
    evidence_refs: [qualityArtifactRef],
    findings: [],
  };
  const mapping = mappingFor([featureInput.feature]);
  const qualityFirstEvidence = (items: ConformanceEvidence[], gates: QualityGateResult[], root: string): ConformanceEvidence[] => {
    const qualityRef = gates[0]?.evidence_refs[0];
    assert.ok(qualityRef, "quality gate must be persisted before conformance evidence is submitted");
    const runtimeArtifactId = `runtime_test_evidence-${featureId}`;
    const runtimeEntries = items
      .filter((item): item is ConformanceEvidence & { test: NonNullable<ConformanceEvidence["test"]> } => item.kind === "executed_test" && Boolean(item.test))
      .map((item) => ({
        evidence_id: item.evidence_id,
        kind: item.kind,
        subject_id: item.subject_id,
        requirement_id: item.requirement_id,
        handoff_digest: item.handoff_digest,
        execution_claim_id: item.execution_claim_id,
        test: { ...item.test, evidence_ref: qualityRef },
        recorded_at: FIXED_NOW,
      }));
    const runtimeRef = canonicalPersistedRef(
      root,
      featureId,
      {
        artifact_id: runtimeArtifactId,
        path: `artifacts/${runtimeArtifactId}.json`,
        sha256: sha256(runtimeArtifactId),
        schema_status: "met",
        quality_gate_status: "met",
      },
      { schema_version: 1, artifact_id: runtimeArtifactId, entries: runtimeEntries },
    );
    return items.map((item) => item.kind === "executed_test" && item.test
      ? { ...item, test: { ...item.test, evidence_ref: runtimeRef } }
      : item);
  };
  const accepted = evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [profileGate],
    undefined,
    qualityFirstEvidence,
    undefined,
    undefined,
    undefined,
    (root, result) => {
      const pinned = PinnedProjectRoot.open(root);
      assert.ok(pinned, "valid topology root must be pinnable");
      if (!pinned) return;
      try {
        const perFeature = featureResult(result, featureId);
        const error = terminalConformanceEvidenceError(pinned, featureId, perFeature.matrix, featureInput.feature, featureInput.claim);
        assert.equal(error, null, error ?? "valid quality-to-runtime-to-conformance DAG must pass terminal admission");
      } finally {
        pinned.close();
      }
    }
  );
  assert.equal(featureResult(accepted, featureId).matrix.overall_status, "pass");
  assert.deepEqual(accepted.passing_feature_ids, [featureId]);
  const directQuality = evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [profileGate],
    undefined,
    (items, gates) => items.map((item) => item.kind === "executed_test" && item.test
      ? { ...item, test: { ...item.test, evidence_ref: gates[0]!.evidence_refs[0]! } }
      : item),
  );
  const directQualityFeature = featureResult(directQuality, featureId);
  assert.equal(directQualityFeature.matrix.overall_status, "blocked");
  assert.ok(directQualityFeature.matrix.blocking_findings.some((finding) => /conformance|schema|artifact/i.test(finding.message)), "direct quality outer refs are rejected before finalization");

  const standalone = evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [profileGate],
    undefined,
    // The standalone runtime envelope is intentionally malformed below.
    (items, _gates, root) => {
      const runtimeArtifactId = `runtime_test_evidence-${featureId}`;
      const runtimeRef = canonicalPersistedRef(
        root,
        featureId,
        {
          artifact_id: runtimeArtifactId,
          path: `artifacts/${runtimeArtifactId}.json`,
          sha256: sha256(runtimeArtifactId),
          schema_status: "met",
          quality_gate_status: "met",
        },
        { schema_version: 1, artifact_id: runtimeArtifactId, entries: [] },
      );
      return items.map((item) => item.kind === "executed_test" && item.test
        ? { ...item, test: { ...item.test, evidence_ref: runtimeRef } }
        : item);
    },
  );
  const blocked = featureResult(standalone, featureId);
  assert.equal(blocked.matrix.overall_status, "blocked");
  assert.deepEqual(standalone.passing_feature_ids, []);
  assert.ok(blocked.matrix.blocking_findings.some((finding) => /artifact|canonical|unreadable/i.test(finding.message)), "standalone runtime envelopes are rejected by canonical artifact normalization");
});

test("CTO rejects supporting runtime envelopes with wrong rows or duplicate rows", () => {
  const featureInput = twoFeatures()[0]!;
  const featureId = featureInput.feature.feature_id;
  const qualityArtifactRef: CompletionArtifactRef = {
    artifact_id: `quality_gate_evidence-${featureId}`,
    path: `artifacts/quality_gate_evidence-${featureId}.json`,
    sha256: sha256(`quality_gate_evidence-${featureId}`),
    schema_status: "met",
    quality_gate_status: "met",
  };
  const profileGate: QualityGateResult = {
    gate_id: `execution-profile.${specPreparationProfileHash()}`,
    source: "execution_profile",
    status: "pass",
    evidence_refs: [qualityArtifactRef],
    findings: [],
    evaluated_at: FIXED_NOW,
  };
  const mapping = mappingFor([featureInput.feature]);
  const cases: Array<{ label: string; mutate: (entries: Record<string, unknown>[]) => Record<string, unknown>[] }> = [
    {
      label: "wrong row identity",
      mutate: (entries) => [{ ...entries[0]!, subject_id: "foreign-subject" }, ...entries.slice(1)],
    },
    {
      label: "duplicate matching row",
      mutate: (entries) => [...entries, structuredClone(entries[0]!)],
    },
  ];
  for (const candidate of cases) {
    const result = evaluateWith(
      [featureInput],
      completeEvidence(featureInput.feature, featureInput.claim),
      mapping,
      undefined,
      true,
      undefined,
      [profileGate],
      undefined,
      (items, gates, root) => {
        const qualityRef = gates[0]?.evidence_refs[0];
        assert.ok(qualityRef, `${candidate.label}: persisted quality reference is available`);
        const runtimeArtifactId = `runtime_test_evidence-${featureId}`;
        const entries = items
          .filter((item): item is ConformanceEvidence & { test: NonNullable<ConformanceEvidence["test"]> } => item.kind === "executed_test" && Boolean(item.test))
          .map((item) => ({
            evidence_id: item.evidence_id,
            kind: item.kind,
            subject_id: item.subject_id,
            requirement_id: item.requirement_id,
            handoff_digest: item.handoff_digest,
            execution_claim_id: item.execution_claim_id,
            test: { ...item.test, evidence_ref: qualityRef },
            recorded_at: FIXED_NOW,
          }));
        const runtimeEntries = candidate.mutate(entries);
        const runtimeRef = canonicalPersistedRef(
          root,
          featureId,
          {
            artifact_id: runtimeArtifactId,
            path: `artifacts/${runtimeArtifactId}.json`,
            sha256: sha256(runtimeArtifactId),
            schema_status: "met",
            quality_gate_status: "met",
          },
          { schema_version: 1, artifact_id: runtimeArtifactId, entries: runtimeEntries },
        );
        return items.map((item) => item.kind === "executed_test" && item.test
          ? { ...item, test: { ...item.test, evidence_ref: runtimeRef } }
          : item);
      },
    );
    const blocked = featureResult(result, featureId);
    assert.equal(blocked.matrix.overall_status, "blocked", candidate.label);
    assert.ok(blocked.matrix.blocking_findings.some((finding) => /runtime|duplicate|matching|subject/i.test(finding.message)), `${candidate.label}: runtime row violation is reported`);
  }
});

test("CTO rejects an outer test pointing at a conformance envelope", () => {
  const featureInput = twoFeatures()[0]!;
  const featureId = featureInput.feature.feature_id;
  const mapping = mappingFor([featureInput.feature]);
  const qualityArtifactRef: CompletionArtifactRef = {
    artifact_id: `quality_gate_evidence-${featureId}`,
    path: `artifacts/quality_gate_evidence-${featureId}.json`,
    sha256: sha256(`quality_gate_evidence-${featureId}`),
    schema_status: "met",
    quality_gate_status: "met",
  };
  const profileGate: QualityGateResult = {
    gate_id: `execution-profile.${specPreparationProfileHash()}`,
    source: "execution_profile",
    status: "pass",
    evidence_refs: [qualityArtifactRef],
    findings: [],
    evaluated_at: FIXED_NOW,
  };
  const result = evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [profileGate],
    undefined,
    (items, _gates, root) => {
      const executed = items.find((item) => item.kind === "executed_test");
      assert.ok(executed, "an executed-test row is available");
      const shadowId = `conformance_evidence-shadow-${featureId}`;
      const source = typedEvidenceArtifact(executed!);
      const shadowRef = canonicalPersistedRef(
        root,
        featureId,
        {
          artifact_id: shadowId,
          path: `artifacts/${shadowId}.json`,
          sha256: sha256(shadowId),
          schema_status: "met",
          quality_gate_status: "met",
        },
        { ...source, artifact_id: shadowId },
      );
      return items.map((item) => item.kind === "executed_test" && item.test
        ? { ...item, test: { ...item.test, evidence_ref: shadowRef } }
        : item);
    },
  );
  const blocked = featureResult(result, featureId);
  assert.equal(blocked.matrix.overall_status, "blocked");
  assert.ok(blocked.matrix.blocking_findings.some((finding) => /canonical runtime artifact|runtime path/i.test(finding.message)), "conformance envelopes cannot satisfy the supporting runtime role");
});

test("CTO canonical reader rejects forbidden artifacts and persisted quality evidence refs", () => {
  const featureInput = twoFeatures()[0]!;
  const featureId = featureInput.feature.feature_id;
  const mapping = mappingFor([featureInput.feature]);
  const forbidden = evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [],
    undefined,
    (items, _gates, root) => {
      writeFileSync(
        join(root, ".work-state", "features", featureId, "artifacts", "implementation_evidence-unused.json"),
        JSON.stringify({ schema_version: 1, artifact_id: "implementation_evidence-unused", entries: [] }),
        "utf8",
      );
      return items;
    },
  );
  const forbiddenFeature = featureResult(forbidden, featureId);
  assert.equal(forbiddenFeature.matrix.overall_status, "blocked");
  assert.ok(forbiddenFeature.matrix.blocking_findings.some((finding) => /forbidden.*implementation|standalone implementation/i.test(finding.message)), "forbidden implementation artifact is rejected");

  let nonEmptyQualityRef: CompletionArtifactRef | undefined;
  const qualityArtifactRef: CompletionArtifactRef = {
    artifact_id: `quality_gate_evidence-${featureId}`,
    path: `artifacts/quality_gate_evidence-${featureId}.json`,
    sha256: sha256(`quality_gate_evidence-${featureId}`),
    schema_status: "met",
    quality_gate_status: "met",
  };
  const profileGate: QualityGateResult = {
    gate_id: `execution-profile.${specPreparationProfileHash()}`,
    source: "execution_profile",
    status: "pass",
    evidence_refs: [qualityArtifactRef],
    findings: [],
    evaluated_at: FIXED_NOW,
  };
  const nonEmptyQuality = evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [profileGate],
    undefined,
    (items, gates, root) => {
      const submitted = gates[0]?.evidence_refs[0];
      assert.ok(submitted, "quality gate reference is available");
      nonEmptyQualityRef = canonicalPersistedRef(
        root,
        featureId,
        submitted,
        typedQualityGateArtifact(gates[0]!, submitted.artifact_id, [artifactRef("persisted-quality-proof")]),
      );
      gates[0]!.evidence_refs = [nonEmptyQualityRef];
      return items.map((item) => item.kind === "executed_test" && item.test
        ? { ...item, test: { ...item.test, evidence_ref: nonEmptyQualityRef } }
        : item);
    },
  );
  const nonEmptyFeature = featureResult(nonEmptyQuality, featureId);
  assert.equal(nonEmptyFeature.matrix.overall_status, "blocked", "nonempty persisted quality refs are rejected");
});

test("terminal replay rejects a canonical quality artifact with persisted evidence refs", () => {
  const featureInput = twoFeatures()[0]!;
  const featureId = featureInput.feature.feature_id;
  const mapping = mappingFor([featureInput.feature]);
  let checked = false;
  evaluateWith(
    [featureInput],
    completeEvidence(featureInput.feature, featureInput.claim),
    mapping,
    undefined,
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (root, result) => {
      const qualityId = `quality_gate_evidence-${featureId}`;
      const qualityPath = join(root, ".work-state", "features", featureId, "artifacts", `${qualityId}.json`);
      const qualityBody = JSON.parse(readFileSync(qualityPath, "utf8")) as Record<string, unknown>;
      const gate = (qualityBody.gates as Record<string, unknown>[])[0]!;
      gate.evidence_refs = [artifactRef("terminal-quality-proof")];
      const qualityRef = writeArtifactWithReference(root, join(root, ".work-state", "features", featureId, "artifacts"), qualityId, qualityBody, { schema_status: "met", quality_gate_status: "met" });
      const runtimeId = `runtime_test_evidence-${featureId}`;
      const runtimePath = join(root, ".work-state", "features", featureId, "artifacts", `${runtimeId}.json`);
      const runtimeBody = JSON.parse(readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
      const runtimeEntries = (runtimeBody.entries as Record<string, unknown>[]).map((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.test && typeof entry.test === "object" && !Array.isArray(entry.test)
        ? { ...entry, test: { ...entry.test, evidence_ref: qualityRef } }
        : entry);
      const runtimeRef = writeArtifactWithReference(root, join(root, ".work-state", "features", featureId, "artifacts"), runtimeId, { ...runtimeBody, entries: runtimeEntries }, { schema_status: "met", quality_gate_status: "met" });
      const perFeature = featureResult(result, featureId);
      const replayMatrix = {
        ...perFeature.matrix,
        entries: perFeature.matrix.entries.map((entry) => ({
          ...entry,
          test_evidence: entry.test_evidence.map((candidate) => ({ ...candidate, evidence_ref: runtimeRef })),
        })),
        quality_gate_results: perFeature.matrix.quality_gate_results.map((candidate) => ({ ...candidate, evidence_refs: [qualityRef] })),
      };
      const pinned = PinnedProjectRoot.open(root);
      assert.ok(pinned, "terminal replay root must be pinnable");
      if (!pinned) return;
      try {
        const error = terminalConformanceEvidenceError(pinned, featureId, replayMatrix, featureInput.feature, featureInput.claim);
        assert.match(error ?? "", /empty evidence_refs|canonical quality/i);
        checked = true;
      } finally {
        pinned.close();
      }
    },
  );
  assert.equal(checked, true);
});

test("a blocked feature does not poison an unrelated passing feature", () => {
  const features = twoFeatures();
  const [passing, blocked] = features;
  const blockedEvidence = completeEvidence(blocked.feature, blocked.claim).filter(
    (item) => !(item.kind === "implementation" && item.subject_id === "FR-1"),
  );
  const result = evaluate(
    features,
    [...completeEvidence(passing.feature, passing.claim), ...blockedEvidence],
  );

  assert.deepEqual(result.passing_feature_ids, ["feature-one"]);
  assert.deepEqual(result.blocked_feature_ids, ["feature-two"]);
  assert.equal(featureResult(result, "feature-one").matrix.overall_status, "pass");
  assert.equal(featureResult(result, "feature-two").matrix.overall_status, "blocked");
  assert.equal(featureResult(result, "feature-two").result.overall_status, "blocked");
  assert.equal(featureResult(result, "feature-one").claim_action, "release");
});

// ── Claim retention and cross-feature evidence rejection ────────────────────

test("blocked CTO conformance retains the active claim for repair on the same feature", () => {
  const features = twoFeatures();
  const [, blocked] = features;
  const result = evaluate(
    features,
    [
      ...completeEvidence(features[0]!.feature, features[0]!.claim),
      ...completeEvidence(blocked.feature, blocked.claim).filter(
        (item) => !(item.kind === "review" && item.subject_id === "AC-1"),
      ),
    ],
  );

  const perFeature = featureResult(result, blocked.feature.feature_id);
  assert.equal(perFeature.matrix.overall_status, "blocked");
  assert.notEqual(perFeature.matrix.next_action, "complete_feature");
  assert.equal(perFeature.result.overall_status, "blocked");
  assert.equal(perFeature.claim_action, "retain");
  assert.equal(perFeature.matrix.feature_id, blocked.feature.feature_id);
  assert.equal(perFeature.matrix.handoff_digest, blocked.feature.handoff_digest);
  assert.equal(perFeature.matrix.execution_claim_id, blocked.claim.claim_id);
  assert.ok(
    perFeature.matrix.blocking_findings.some(
      (finding) => finding.code === "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
    ),
    "the blocked feature reports conformance remediation instead of releasing ownership",
  );
});

test("evidence from another handoff cannot be borrowed to close a feature", () => {
  const features = twoFeatures();
  const [first, second] = features;
  const firstEvidenceWithoutImplementation = completeEvidence(first.feature, first.claim).filter(
    (item) => !(item.kind === "implementation" && item.subject_id === "FR-1"),
  );
  // The only implementation evidence supplied for FR-1 is bound to feature-two.
  // CTO must partition it to feature-two, not borrow it for feature-one.
  const result = evaluate(
    features,
    [...firstEvidenceWithoutImplementation, ...completeEvidence(second.feature, second.claim)],
  );

  const firstResult = featureResult(result, first.feature.feature_id);
  assert.equal(firstResult.matrix.overall_status, "blocked");
  assert.equal(firstResult.result.overall_status, "blocked");
  assert.equal(firstResult.claim_action, "retain");
  assert.ok(
    firstResult.matrix.blocking_findings.some(
      (finding) => finding.code === "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
    ),
    "cross-feature evidence is rejected rather than merged into the first matrix",
  );
  assert.equal(featureResult(result, second.feature.feature_id).matrix.overall_status, "pass");
  assert.equal(featureResult(result, second.feature.feature_id).result.overall_status, "pass");
  assert.deepEqual(result.passing_feature_ids, ["feature-two"]);
  assert.deepEqual(result.blocked_feature_ids, ["feature-one"]);
});


function assertAuthorityBlocked(result: CtoSpecificationConformanceResult, featureId: string, pattern: RegExp): void {
  const feature = featureResult(result, featureId);
  assert.equal(feature.claim_action, "retain");
  assert.equal(feature.matrix.overall_status, "blocked");
  assert.ok(feature.matrix.blocking_findings.some((finding) => pattern.test(finding.message)), `expected authority finding ${pattern}`);
}

test("CTO conformance accepts only the issuing root and rejects project-A authority replay in project B", () => {
  const features = twoFeatures();
  const evidenceItems = features.flatMap(({ feature, claim }) => completeEvidence(feature, claim));
  const mapping = mappingFor(features.map(({ feature }) => feature));
  const rootA = mkdtempSync(join(tmpdir(), "cto-conformance-root-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "cto-conformance-root-b-"));
  try {
    const source = prepareCtoConformanceInput(rootA, features, evidenceItems, mapping);
    const copied = prepareCtoConformanceInput(rootB, features, evidenceItems, mapping);
    const valid = evaluateCtoSpecificationConformance({
      project_root: rootA,
      mapping: source.mapping,
      binding: source.binding,
      handoffs: source.handoffs,
      claims: source.claims,
      evidence: source.evidence,
    });
    assert.deepEqual(valid.passing_feature_ids, ["feature-one", "feature-two"]);
    assert.deepEqual(valid.blocked_feature_ids, []);

    const replay = evaluateCtoSpecificationConformance({
      project_root: rootB,
      mapping: copied.mapping,
      binding: source.binding,
      handoffs: copied.handoffs,
      claims: copied.claims,
      evidence: copied.evidence,
    });
    assert.deepEqual(replay.passing_feature_ids, []);
    assert.deepEqual(replay.blocked_feature_ids, ["feature-one", "feature-two"]);
    assertAuthorityBlocked(replay, "feature-one", /opaque binding|project root/i);
    assertAuthorityBlocked(replay, "feature-two", /opaque binding|project root/i);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("CTO evaluator rejects a canonical handoff with an unknown status enum", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-status-"));
  try {
    const prepared = prepareCtoConformanceInput(root, [feature], completeEvidence(feature.feature, feature.claim), mapping);
    const handoffPath = join(root, ".work-state", "features", feature.feature.feature_id, "artifacts", "implementation_handoff", `${feature.feature.handoff_id}.json`);
    const canonical = JSON.parse(readFileSync(handoffPath, "utf8")) as Record<string, unknown>;
    canonical.status = "invalid-status";
    writeFileSync(handoffPath, JSON.stringify(canonical) + "\n", "utf8");
    const direct = validateImplementationHandoff(canonical);
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.ok(direct.issues.some((issue) => issue.includes("$.status must be one of")));
    const result = evaluateCtoSpecificationConformance({
      project_root: root,
      mapping: prepared.mapping,
      binding: prepared.binding,
      handoffs: prepared.handoffs,
      claims: prepared.claims,
      evidence: prepared.evidence,
    });
    assertAuthorityBlocked(result, feature.feature.feature_id, /status must be one of|invalid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CTO conformance rejects replaced or removed durable mapping records", () => {
  const features = [twoFeatures()[0]!];
  const evidenceItems = completeEvidence(features[0]!.feature, features[0]!.claim);
  const mapping = mappingFor(features.map(({ feature }) => feature));
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-record-integrity-"));
  try {
    const prepared = prepareCtoConformanceInput(root, features, evidenceItems, mapping);
    const valid = evaluateCtoSpecificationConformance({
      project_root: root,
      mapping: prepared.mapping,
      binding: prepared.binding,
      handoffs: prepared.handoffs,
      claims: prepared.claims,
      evidence: prepared.evidence,
    });
    assert.deepEqual(valid.passing_feature_ids, ["feature-one"]);

    const record = JSON.parse(readFileSync(prepared.mappingRecordPath, "utf8")) as Record<string, unknown>;
    const staleMapping = { ...(record.mapping as Record<string, unknown>), status: "stale" };
    writeFileSync(prepared.mappingRecordPath, JSON.stringify({ ...record, mapping: staleMapping }) + "\n", "utf8");
    const replaced = evaluateCtoSpecificationConformance({
      project_root: root,
      mapping: prepared.mapping,
      binding: prepared.binding,
      handoffs: prepared.handoffs,
      claims: prepared.claims,
      evidence: prepared.evidence,
    });
    assert.deepEqual(replaced.passing_feature_ids, []);
    assertAuthorityBlocked(replaced, "feature-one", /mapping record digest|confirmed mapping|durable/i);

    unlinkSync(prepared.mappingRecordPath);
    const removed = evaluateCtoSpecificationConformance({
      project_root: root,
      mapping: prepared.mapping,
      binding: prepared.binding,
      handoffs: prepared.handoffs,
      claims: prepared.claims,
      evidence: prepared.evidence,
    });
    assert.deepEqual(removed.passing_feature_ids, []);
    assertAuthorityBlocked(removed, "feature-one", /could not be reloaded|missing|durable/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO conformance rejects a fabricated confirmed mapping", () => {
  const features = twoFeatures();
  const mapping = mappingFor(features.map(({ feature }) => feature));
  mapping.mapping_hash = "0".repeat(64);
  mapping.mapping_id = `cto-mapping-${mapping.mapping_hash.slice(0, 32)}`;
  const result = evaluateWith(features, features.flatMap(({ feature, claim }) => completeEvidence(feature, claim)), mapping, undefined);
  assertAuthorityBlocked(result, "feature-one", /canonical mapping hash/i);
  assert.deepEqual(result.passing_feature_ids, []);
});

test("CTO conformance ignores a fabricated claim summary and retains the durable claim", () => {
  const features = twoFeatures();
  const [first] = features;
  const mapping = mappingFor(features.map(({ feature }) => feature));
  const summaries = [
    {
      feature_id: first.feature.feature_id,
      claim_id: "claim-forged",
      handoff_digest: first.claim.handoff_digest,
      owner_kind: "cto",
      owner_run_id: "cto-wave-1",
      status: "active",
    },
    {
      feature_id: features[1]!.feature.feature_id,
      claim_id: features[1]!.claim.claim_id,
      handoff_digest: features[1]!.claim.handoff_digest,
      owner_kind: features[1]!.claim.owner_kind,
      owner_run_id: features[1]!.claim.owner_run_id,
      status: features[1]!.claim.status,
    },
  ];
  const result = evaluateWith(features, features.flatMap(({ feature, claim }) => completeEvidence(feature, claim)), mapping, undefined, true, summaries);
  assertAuthorityBlocked(result, first.feature.feature_id, /does not exactly match the current durable claim/i);
  assert.equal(featureResult(result, first.feature.feature_id).claim_action, "retain");
  assert.equal(featureResult(result, features[1]!.feature.feature_id).claim_action, "release");
});

test("CTO conformance rejects invalid UTF-8 canonical evidence before evaluation or mutation", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-utf8-"));
  try {
    const prepared = prepareCtoConformanceInput(root, [feature], completeEvidence(feature.feature, feature.claim), mapping);
    const statePath = join(root, ".work-state", "features", feature.feature.feature_id, "state.json");
    const stateBefore = readFileSync(statePath);
    const evidence = prepared.evidence[0]!;
    const artifactPath = join(root, evidence.artifact.path);
    const bytes = Buffer.from(readFileSync(artifactPath));
    const timestampOffset = bytes.indexOf(Buffer.from(FIXED_NOW, "utf8"));
    assert.ok(timestampOffset >= 0, "fixture evidence must contain its recorded timestamp");
    bytes[timestampOffset] = 0xff;
    writeFileSync(artifactPath, bytes);
    evidence.artifact.sha256 = createHash("sha256").update(bytes).digest("hex");

    const result = evaluateCtoSpecificationConformance({
      project_root: root,
      mapping: prepared.mapping,
      binding: prepared.binding,
      handoffs: prepared.handoffs,
      claims: prepared.claims,
      evidence: prepared.evidence,
    });
    const perFeature = featureResult(result, feature.feature.feature_id);
    assert.deepEqual(result.passing_feature_ids, []);
    assert.deepEqual(result.blocked_feature_ids, [feature.feature.feature_id]);
    assert.equal(perFeature.claim_action, "retain");
    assert.equal(perFeature.matrix.overall_status, "blocked");
    assert.ok(perFeature.matrix.blocking_findings.some((finding) => /UTF-8|current readable JSON|unreadable/i.test(finding.message)));
    assert.deepEqual(readFileSync(statePath), stateBefore, "invalid canonical evidence must not mutate feature state");
    assert.deepEqual(readFileSync(artifactPath), bytes, "invalid canonical evidence must not be rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO conformance rejects well-shaped evidence references whose canonical bytes do not exist", () => {
  const features = twoFeatures();
  const mapping = mappingFor(features.map(({ feature }) => feature));
  const result = evaluateWith(
    features,
    features.flatMap(({ feature, claim }) => completeEvidence(feature, claim)),
    mapping,
    undefined,
    false,
  );
  assert.deepEqual(result.passing_feature_ids, []);
  for (const { feature } of features) {
    const perFeature = featureResult(result, feature.feature_id);
    assert.equal(perFeature.claim_action, "retain");
    assert.ok(perFeature.matrix.blocking_findings.some((finding) => /missing|current readable JSON|artifact/i.test(finding.message)));
  }
});


test("CTO conformance rejects well-shaped quality-gate references without canonical bytes", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const gate: QualityGateResult = {
    gate_id: "profile-gate",
    source: "execution_profile",
    status: "pass",
    evidence_refs: [artifactRef("profile-gate")],
    findings: [],
  };
  const result = evaluateWith([feature], completeEvidence(feature.feature, feature.claim), mapping, undefined, false, undefined, [gate]);
  const perFeature = featureResult(result, feature.feature.feature_id);
  assert.equal(perFeature.claim_action, "retain");
  assert.ok(perFeature.matrix.blocking_findings.some((finding) => /current readable JSON|missing|artifact/i.test(finding.message)));
});
function assertMappingMutationBlocked(
  mutate: (mapping: ReturnType<typeof mappingFor>) => void,
  findingPattern: RegExp,
): void {
  const features = twoFeatures();
  const evidenceItems = features.flatMap(({ feature, claim }) => completeEvidence(feature, claim));
  const original = mappingFor(features.map(({ feature }) => feature));
  const altered = structuredClone(original);
  mutate(altered);
  assertAuthorityBlocked(
    evaluateWith(features, evidenceItems, altered, undefined, true, undefined, [], undefined, undefined, undefined, original),
    "feature-one",
    findingPattern,
  );
}

test("CTO conformance rejects mapping content altered after verified dispatch", () => {
  assertMappingMutationBlocked(
    (mapping) => { mapping.task_to_slice[0]!.team_id = "substituted-team"; },
    /canonical mapping hash/i,
  );
});

test("CTO conformance rejects mapping hash altered after verified dispatch", () => {
  assertMappingMutationBlocked(
    (mapping) => { mapping.mapping_hash = "f".repeat(64); },
    /canonical mapping hash|verified dispatch binding/i,
  );
});

test("CTO conformance rejects mapping id altered after verified dispatch", () => {
  assertMappingMutationBlocked(
    (mapping) => { mapping.mapping_id = "cto-mapping-fabricated"; },
    /canonical mapping hash identity|verified dispatch binding/i,
  );
});

test("CTO conformance rejects missing or structurally fabricated confirmation context", () => {
  const features = twoFeatures();
  const mapping = mappingFor(features.map(({ feature }) => feature));
  const evidenceItems = features.flatMap(({ feature, claim }) => completeEvidence(feature, claim));
  const handoffs = features.map(({ feature }) => ({ feature_id: feature.feature_id, run_key: `run-${feature.feature_id}`, handoff: feature }));
  const claims = features.map(({ feature, claim }) => ({ feature_id: feature.feature_id, claim_id: claim.claim_id, handoff_digest: claim.handoff_digest, owner_kind: claim.owner_kind, owner_run_id: claim.owner_run_id, status: claim.status }));

  const missing = evaluateCtoSpecificationConformance({ project_root: "/nonexistent", mapping, handoffs, claims, evidence: evidenceItems } as never);
  assertAuthorityBlocked(missing, "feature-one", /opaque binding/i);

  const fabricated = evaluateCtoSpecificationConformance({
    project_root: "/nonexistent",
    mapping,
    binding: { capability_id: "fabricated-capability" },
    handoffs,
    claims,
    evidence: evidenceItems,
  });
  assert.throws(() => issueCtoSpecificationConformanceBinding({ cto_run_id: "cto-wave-1", mapping_id: mapping.mapping_id, mapping_hash: mapping.mapping_hash, checkpoint_id: "checkpoint.cto-mapping.v1", trusted_answer_id: "trusted-answer.cto-mapping.v1" } as never), /invalid CTO specification conformance binding/);
  assertAuthorityBlocked(fabricated, "feature-one", /opaque binding/i);
});

test("CTO conformance rejects do_work and cross-CTO-run execution claims", () => {
  const evidenceFor = (features: readonly CtoFeatureInput[]) => features.flatMap(({ feature, claim }) => completeEvidence(feature, claim));

  const doWorkFeatures = twoFeatures();
  doWorkFeatures[0].claim.owner_kind = "do_work";
  const doWorkMapping = mappingFor(doWorkFeatures.map(({ feature }) => feature));
  const doWorkResult = evaluateWith(doWorkFeatures, evidenceFor(doWorkFeatures), doWorkMapping, undefined);
  assertAuthorityBlocked(doWorkResult, "feature-one", /not CTO/i);
  assert.equal(featureResult(doWorkResult, "feature-two").claim_action, "release", "invalid ownership remains isolated per feature");

  const crossRunFeatures = twoFeatures();
  crossRunFeatures[0].claim.owner_run_id = "different-cto-wave";
  const crossRunMapping = mappingFor(crossRunFeatures.map(({ feature }) => feature));
  const crossRunResult = evaluateWith(crossRunFeatures, evidenceFor(crossRunFeatures), crossRunMapping, undefined);
  assertAuthorityBlocked(crossRunResult, "feature-one", /not the verified run/i);
  assert.equal(featureResult(crossRunResult, "feature-two").claim_action, "release", "cross-run ownership remains isolated per feature");
});

test("CTO conformance ignores a forged caller handoff body and evaluates canonical handoff bytes", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const result = evaluateWith(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    undefined,
    true,
    undefined,
    [],
    (forged) => ({ ...forged, requirements: [], decisions: [], tasks: [], verification: [] }),
  );
  const perFeature = featureResult(result, feature.feature.feature_id);
  assert.equal(perFeature.claim_action, "release");
  assert.equal(perFeature.matrix.overall_status, "pass");
  assert.deepEqual(perFeature.matrix.entries.map((entry) => entry.subject_id).sort(), ["AC-1", "FR-1"]);
});

test("CTO conformance derives review verdict from persisted typed bytes, not a forged wrapper", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const persistedFailure = completeEvidence(feature.feature, feature.claim).map((item) => (
    item.kind === "review" && item.subject_id === "FR-1" ? { ...item, review_verdict: "fail" as const } : item
  ));
  const result = evaluateWith(
    [feature],
    persistedFailure,
    mapping,
    undefined,
    true,
    undefined,
    [],
    undefined,
    (items) => items.map((item) => (
      item.kind === "review" && item.subject_id === "FR-1" ? { ...item, review_verdict: "pass" as const } : item
    )),
  );
  const perFeature = featureResult(result, feature.feature.feature_id);
  assert.equal(perFeature.claim_action, "retain");
  assert.equal(perFeature.matrix.overall_status, "blocked");
  assert.equal(perFeature.matrix.entries.find((entry) => entry.subject_id === "FR-1")?.review_verdict, "fail");
});

test("CTO conformance derives quality-gate status from persisted typed bytes, not a forged wrapper", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const failedGate: QualityGateResult = {
    gate_id: "profile-gate",
    source: "execution_profile",
    status: "fail",
    evidence_refs: [artifactRef("profile-gate", "gate")],
    findings: [],
  };
  const result = evaluateWith(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    undefined,
    true,
    undefined,
    [failedGate],
    undefined,
    undefined,
    (gates) => gates.map((gate) => ({ ...gate, status: "pass" as const })),
  );
  const perFeature = featureResult(result, feature.feature.feature_id);
  assert.equal(perFeature.claim_action, "retain");
  assert.equal(perFeature.matrix.overall_status, "blocked");
  assert.ok(perFeature.matrix.blocking_findings.some((finding) => /quality gate.*failed/i.test(finding.message)));
});
// ── Descriptor-anchored canonical input regressions ─────────────────────────

test("CTO conformance rejects a canonical mapping leaf swapped after its descriptor read", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  let displacedPath: string | null = null;
  let swapped = false;
  const result = evaluateWithReadHook(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    {
      afterRead: ({ path }) => {
        if (swapped || !path.endsWith(`${mapping.mapping_id}.json`)) return;
        swapped = true;
        displacedPath = `${path}.original`;
        renameSync(path, displacedPath);
        symlinkSync(displacedPath, path);
      },
    },
    () => {
      if (displacedPath) rmSync(displacedPath, { force: true });
    },
  );
  assertAuthorityBlocked(result, "feature-one", /mapping record.*(changed|unreadable)|durable/i);
});

test("CTO conformance rejects a canonical mapping ancestor swapped after its descriptor read", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  let displacedPath: string | null = null;
  let swapped = false;
  const result = evaluateWithReadHook(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    {
      afterRead: ({ path }) => {
        if (swapped || !path.endsWith(`${mapping.mapping_id}.json`)) return;
        swapped = true;
        const marker = path.indexOf("/specification-mappings/");
        assert.ok(marker > 0);
        const directory = path.slice(0, marker) + "/specification-mappings";
        displacedPath = `${directory}.original`;
        renameSync(directory, displacedPath);
        mkdirSync(directory);
      },
    },
    () => {
      if (displacedPath) rmSync(displacedPath, { recursive: true, force: true });
    },
  );
  assertAuthorityBlocked(result, "feature-one", /mapping record.*(changed|unreadable)|durable/i);
});

test("CTO conformance rejects a canonical root swapped after its descriptor read", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  let displacedRoot: string | null = null;
  let swapped = false;
  const result = evaluateWithReadHook(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    {
      afterRead: ({ path }) => {
        if (swapped || !path.endsWith(`${mapping.mapping_id}.json`)) return;
        swapped = true;
        const marker = path.indexOf("/.work-state/");
        assert.ok(marker > 0);
        const root = path.slice(0, marker);
        displacedRoot = `${root}.original`;
        renameSync(root, displacedRoot);
        mkdirSync(root);
      },
    },
    () => {
      if (displacedRoot) rmSync(displacedRoot, { recursive: true, force: true });
    },
  );
  assertAuthorityBlocked(result, "feature-one", /mapping record.*(changed|unreadable)|project root.*changed|durable/i);
});

test("CTO conformance rejects a canonical handoff symlink", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  let swapped = false;
  let displacedPath: string | null = null;
  const result = evaluateWithReadHook(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    {
      afterRead: ({ path }) => {
        if (swapped || !path.endsWith(`${mapping.mapping_id}.json`)) return;
        swapped = true;
        const marker = path.indexOf("/.work-state/");
        assert.ok(marker > 0);
        const root = path.slice(0, marker);
        const handoffPath = join(root, ".work-state", "features", feature.feature.feature_id, "artifacts", "implementation_handoff", `${feature.feature.handoff_id}.json`);
        displacedPath = `${handoffPath}.original`;
        renameSync(handoffPath, displacedPath);
        symlinkSync(displacedPath, handoffPath);
      },
    },
    () => {
      if (displacedPath) rmSync(displacedPath, { force: true });
    },
  );
  assertAuthorityBlocked(result, "feature-one", /canonical handoff.*(symlink|regular|unreadable|changed)/i);
});

test("CTO conformance read hooks isolate concurrent distinct roots", async () => {
  const [firstFeature, secondFeature] = twoFeatures();
  const firstRoot = mkdtempSync(join(tmpdir(), "cto-conformance-hook-first-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "cto-conformance-hook-second-"));
  const firstMapping = mappingFor([firstFeature.feature]);
  const secondMapping = mappingFor([secondFeature.feature]);
  const firstInput = prepareCtoConformanceInput(firstRoot, [firstFeature], completeEvidence(firstFeature.feature, firstFeature.claim), firstMapping);
  const secondInput = prepareCtoConformanceInput(secondRoot, [secondFeature], completeEvidence(secondFeature.feature, secondFeature.claim), secondMapping);
  const firstPaths: string[] = [];
  const secondPaths: string[] = [];
  const firstCanonicalRoot = realpathSync(firstRoot);
  const secondCanonicalRoot = realpathSync(secondRoot);
  try {
    setCtoConformanceReadTestHooks({ afterRead: ({ path }) => firstPaths.push(path) }, firstRoot);
    setCtoConformanceReadTestHooks({ afterRead: ({ path }) => secondPaths.push(path) }, secondRoot);
    const [firstResult, secondResult] = await Promise.all([
      Promise.resolve().then(() => evaluateCtoSpecificationConformance({
        project_root: firstRoot,
        mapping: firstInput.mapping,
        binding: firstInput.binding,
        handoffs: firstInput.handoffs,
        claims: firstInput.claims,
        evidence: firstInput.evidence,
      })),
      Promise.resolve().then(() => evaluateCtoSpecificationConformance({
        project_root: secondRoot,
        mapping: secondInput.mapping,
        binding: secondInput.binding,
        handoffs: secondInput.handoffs,
        claims: secondInput.claims,
        evidence: secondInput.evidence,
      })),
    ]);
    assert.ok(featureResult(firstResult, firstFeature.feature.feature_id));
    assert.ok(featureResult(secondResult, secondFeature.feature.feature_id));
    assert.ok(firstPaths.length > 0);
    assert.ok(secondPaths.length > 0);
    assert.ok(firstPaths.every((path) => path.startsWith(`${firstCanonicalRoot}/`)));
    assert.ok(secondPaths.every((path) => path.startsWith(`${secondCanonicalRoot}/`)));
  } finally {
    setCtoConformanceReadTestHooks(null, firstRoot);
    setCtoConformanceReadTestHooks(null, secondRoot);
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("CTO conformance hook clear removes captured aliases after an ancestor symlink swap", () => {
  const feature = twoFeatures()[0]!;
  const realParent = mkdtempSync(join(tmpdir(), "cto-conformance-hook-real-parent-"));
  const realRoot = join(realParent, "project");
  mkdirSync(realRoot);
  const mapping = mappingFor([feature.feature]);
  const input = prepareCtoConformanceInput(realRoot, [feature], completeEvidence(feature.feature, feature.claim), mapping);
  const aliasParent = mkdtempSync(join(tmpdir(), "cto-conformance-hook-alias-parent-"));
  const aliasPath = join(aliasParent, "ancestor");
  const displacedAlias = `${aliasPath}.original`;
  const outsideParent = mkdtempSync(join(tmpdir(), "cto-conformance-hook-outside-parent-"));
  mkdirSync(join(outsideParent, "project"));
  symlinkSync(realParent, aliasPath, "dir");
  const lexicalRoot = join(aliasPath, "project");
  const evaluateInput = () => evaluateCtoSpecificationConformance({
    project_root: realRoot,
    mapping: input.mapping,
    binding: input.binding,
    handoffs: input.handoffs,
    claims: input.claims,
    evidence: input.evidence,
  });
  const baseline = evaluateInput();
  let reads = 0;
  try {
    setCtoConformanceReadTestHooks({ afterRead: () => { reads += 1; } }, lexicalRoot);
    renameSync(aliasPath, displacedAlias);
    symlinkSync(outsideParent, aliasPath, "dir");
    setCtoConformanceReadTestHooks(null, lexicalRoot);
    const result = evaluateInput();
    assert.ok(featureResult(result, feature.feature.feature_id));
    assert.deepEqual(featureResult(result, feature.feature.feature_id), featureResult(baseline, feature.feature.feature_id));
    assert.equal(reads, 0, "clearing the swapped lexical alias must remove the captured registration");
  } finally {
    setCtoConformanceReadTestHooks(null, lexicalRoot);
    rmSync(aliasPath, { recursive: true, force: true });
    rmSync(displacedAlias, { recursive: true, force: true });
    rmSync(realParent, { recursive: true, force: true });
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(outsideParent, { recursive: true, force: true });
  }
});

test("CTO conformance rejects an oversized canonical mapping record at the input boundary", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  const oversizedMapping = { ...mapping, oversized: "x".repeat(8 * 1024 * 1024) } as typeof mapping;
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-boundary-"));
  try {
    const input = {
      project_root: root,
      binding: { capability_id: "fabricated" },
      mapping: oversizedMapping,
      handoffs: [],
      claims: [],
      evidence: [],
    };
    assert.ok(conformanceInputBoundaryIssues(input).some((issue) => /not allowed|aggregate|limit/i.test(issue)));
    const result = persistCtoSpecificationConformance(input as never, undefined as never);
    assert.equal(result.status, "blocked");
    assert.equal(existsSync(join(root, ".work-state")), false, "boundary rejection must not create project state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO conformance rejects canonical mapping bytes changed during the read", () => {
  const feature = twoFeatures()[0]!;
  const mapping = mappingFor([feature.feature]);
  let changed = false;
  const result = evaluateWithReadHook(
    [feature],
    completeEvidence(feature.feature, feature.claim),
    mapping,
    {
      afterRead: ({ path }) => {
        if (changed || !path.endsWith(`${mapping.mapping_id}.json`)) return;
        changed = true;
        writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");
      },
    },
  );
  assertAuthorityBlocked(result, "feature-one", /mapping record.*(changed|unreadable)|durable/i);
});
test("terminal conformance snapshot rejects leaf, ancestor, and root swaps before validation/ref", () => {
  for (const swapKind of ["leaf", "ancestor", "root"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-terminal-snapshot-${swapKind}-`));
    const outside = mkdtempSync(join(tmpdir(), `cto-terminal-snapshot-outside-${swapKind}-`));
    const artifactsRelative = ".work-state/features/terminal/artifacts/implementation_conformance";
    const artifactsDir = join(root, artifactsRelative);
    const artifactPath = join(artifactsDir, "matrix.json");
    const sentinelPath = join(outside, "sentinel");
    const movedPath = `${swapKind === "root" ? root : swapKind === "ancestor" ? join(root, ".work-state", "features") : artifactPath}.moved`;
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({ schema_version: 1, artifact_id: "matrix", entries: [] }) + "\n", "utf8");
    writeFileSync(sentinelPath, "sentinel\n", "utf8");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "terminal snapshot fixture root must be pinnable");
    let swapped = false;
    try {
      setArtifactReadTestHooks({
        afterRead: ({ path }) => {
          if (swapped || !path.endsWith("/matrix.json")) return;
          swapped = true;
          if (swapKind === "leaf") {
            renameSync(artifactPath, movedPath);
            writeFileSync(artifactPath, JSON.stringify({ schema_version: 1, artifact_id: "matrix", entries: [{ forged: true }] }) + "\n", "utf8");
          } else if (swapKind === "ancestor") {
            renameSync(join(root, ".work-state", "features"), movedPath);
            symlinkSync(outside, join(root, ".work-state", "features"), "dir");
          } else {
            renameSync(root, movedPath);
            symlinkSync(outside, root, "dir");
          }
        },
      });
      assert.throws(
        () => readPinnedArtifactSnapshot(pinned, artifactsRelative, "matrix", { verifyPathAfterRead: true }),
        /changed|path|regular|symlink|directory/i,
      );
      assert.equal(swapped, true, `${swapKind} swap seam must execute`);
      assert.equal(readFileSync(sentinelPath, "utf8"), "sentinel\n", `${swapKind} replacement root sentinel must remain unchanged`);
    } finally {
      setArtifactReadTestHooks(null);
      pinned.close();
      if (swapKind === "leaf") {
        rmSync(artifactPath, { force: true });
        if (existsSync(movedPath)) renameSync(movedPath, artifactPath);
      } else if (swapKind === "ancestor") {
        rmSync(join(root, ".work-state", "features"), { recursive: true, force: true });
        if (existsSync(movedPath)) renameSync(movedPath, join(root, ".work-state", "features"));
      } else {
        rmSync(root, { recursive: true, force: true });
        if (existsSync(movedPath)) renameSync(movedPath, root);
      }
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});
