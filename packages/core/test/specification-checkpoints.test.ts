import { writeTestArtifact } from "./fixtures/artifacts.js";
/**
 * Failing contract for the specification phase checkpoints (T038).
 *
 * Canonical APIs under contract:
 *
 *   `packages/core/src/engine/checkpoints.ts` (T041)
 *     - the hard-human `specification_phase_approval` checkpoint policy with
 *       exact allowed decisions `approve_continue | request_changes |
 *       approve_stop`, resolved through the existing durable checkpoint
 *       ledger, trusted answer binding, and policy hash rules
 *
 *   `packages/core/src/specification/phase.ts` (T042)
 *     - presentPhaseCheckpoint(projectRoot, { feature_id, run_key, phase })
 *       opens the hard-human checkpoint for the current artifact version and
 *       only after a current passing validation result; re-presenting the
 *       open checkpoint replays the established record
 *     - the mounted selected checkpoint Ask records one trusted,
 *       attributable human decision and performs exactly one of:
 *         approve_continue -> durable approval + cursor advance; roster-gated
 *                            next phase requires fresh preparation,
 *         approve_stop    -> durable approval + return without dispatch,
 *         request_changes -> durable same-phase revision_required state with
 *                            captured feedback; fresh preparation mints the new
 *                            capability epoch/version
 *
 * This file is intentionally red until T041–T042 implement the named policy
 * and the phase checkpoint surface. Every case encodes observable contract:
 *   - a passing phase exposes exactly the three valid decisions;
 *   - every human decision requires a durable terminal/escalation answer
 *     proof bound to run, stage, checkpoint, capability epoch, and policy
 *     hash; agent provenance and policy automation can never approve;
 *   - replaying an exact decision on its current phase/cursor is idempotent;
 *     an old capability cannot replay after cursor advancement, and no replay
 *     dispatches a phase;
 *   - invalid or missing validation results suppress the checkpoint
 *     entirely (no open checkpoint, no authorizable answer);
 *   - request_changes requires non-empty feedback, keeps the workflow on
 *     the same phase, and binds that feedback to the revision round.
 *
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXED_NOW,
  bindFeatureWorkspaceToRoot,
  sha256,
  specPreparationProfileHash,
  validConstitutionBinding,
  validFeatureWorkspace,
  type FeatureWorkspaceRecord,
  type WorkspacePhaseRecord,
} from "./fixtures/specification-fixtures.js";
import { presentPhaseCheckpoint, renderCanonicalPhaseDocument, setSpecificationPhaseFailureInjector } from "../src/specification/phase.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS } from "../src/specification/templates.js";
import { materializeFeatureDocuments, materializePhaseValidation } from "../src/specification/materialize.js";
import { digestOf, sha256Hex, validateNativePhase, type NativePhaseValidationInput } from "../src/specification/validation.js";
import { advanceCursor, commitCheckpointAnswerSelected, createCapability, issueCurrentTrustedMappingProof, resolveNativePhaseCheckpointSubject } from "../src/engine/durable.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { appendCheckpointDecision, checkpointPolicyHash, findCheckpointDecision, issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, registerTrustedCheckpointHostBridge, selectLatestValidCheckpointDecision, validateCheckpointForAdvance } from "../src/engine/checkpoints.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { CheckpointActor, CheckpointPolicy, TeamState, WorkIdentity } from "../src/engine/types.js";
import type { PhaseArtifactVersion } from "../src/specification/types.js";

const FEATURE_ID = "checkpoint-feature";
const RUN_KEY = "run-phase-1";
const ORIGIN_STAGE = "specify";
/** The exact hard-human policy/checkpoint name mandated by T041. */
const PHASE_CHECKPOINT = "specification_phase_approval";
const EXACT_DECISIONS = ["approve_continue", "request_changes", "approve_stop"] as const;
const CONSTITUTION_DECISIONS = ["approve_continue", "request_changes"] as const;
const REVISION_FEEDBACK = "Tighten the acceptance criteria and add failure paths for concurrent claims.";
const CHECKPOINT_TEMPLATES = (() => {
  const resolved = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
})();
const CHECKPOINT_CONSTITUTION = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
const TEST_CHECKPOINT_BRIDGE = Object.freeze({});
registerTrustedCheckpointHostBridge(TEST_CHECKPOINT_BRIDGE);
const answerAuthorities = new Map<string, { capability: object; advance_token: string }>();
const phaseAdvanceTokens = new Map<string, string>();

function checkpointConstitutionBinding() {
  return validConstitutionBinding({
    content_sha256: sha256Hex(CHECKPOINT_CONSTITUTION),
    semantic_hash: sha256Hex(CHECKPOINT_CONSTITUTION.replace(/\s+/gu, " ").trim()),
  });
}


function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "spec-checkpoints-"));
}

function publishCheckpointAgentMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "specification-analyst": "specification-worker", "specification-architect": "specification-worker" } }) + "\n", "utf8");
  const config = resolveConfig(root);
  writeAgentMapping(root, buildAgentMapping({
    roles: config.roles,
    availableAgents: ["specification-worker"],
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
    genericFallbackRoles: [],
  }));
}

function currentCheckpointMappingProof(root: string) {
  const proof = issueCurrentTrustedMappingProof(root);
  assert.ok(proof, "checkpoint fixture must expose an engine-issued mapping proof");
  if (!proof) throw new Error("checkpoint fixture mapping proof is unavailable");
  return proof;
}

function selector(): { feature_id: string; run_key: string } {
  return { feature_id: FEATURE_ID, run_key: RUN_KEY };
}

/** Epoch of the capability binding a fresh trusted answer would be bound to. */
function epochOf(state: TeamState): string {
  return state.dispatch_capability?.issued_for?.cursor_epoch ?? state.cursor_epoch;
}

/** Typed records used to narrow phase-checkpoint outcomes without any-casts. */
interface PhasePresentationValue {
  phase: WorkspacePhaseRecord["phase"];
  version: number;
  checkpoint_id: string;
  allowed_decisions: string[];
  revision_feedback: string | null;
}
interface PhaseDecisionValue {
  decision: string;
  phase: WorkspacePhaseRecord["phase"];
  version: number;
  replay: boolean;
  status: string;
  revision_feedback: string | null;
  resume_next_phase: WorkspacePhaseRecord["phase"] | null;
  dispatched_next_phase: WorkspacePhaseRecord["phase"] | null;
}
type PhaseCheckpointOutcome<V> = { ok: true; value: V } | { ok: false; code: string; error: string };

function presentPhaseCheckpointContract(
  root: string,
  input: { feature_id: string; run_key: string; phase: WorkspacePhaseRecord["phase"] },
): PhaseCheckpointOutcome<PhasePresentationValue> {
  return presentPhaseCheckpoint(root, input) as PhaseCheckpointOutcome<PhasePresentationValue>;
}

interface PhaseDecisionCall {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhaseRecord["phase"];
  checkpoint_id: string;
  decision: "approve_continue" | "request_changes" | "approve_stop" | (string & {});
  authorization: "human" | "policy_auto" | (string & {});
  actor_provenance: CheckpointActor;
  /** Required non-empty for `request_changes`; ignored otherwise. */
  feedback?: string;
}

function runSelectedCheckpointDecisionContract(
  root: string,
  input: PhaseDecisionCall,
): PhaseCheckpointOutcome<PhaseDecisionValue> {
  if (!EXACT_DECISIONS.some((decision) => decision === input.decision)) {
    return { ok: false, code: "SPEC_DECISION_INVALID", error: "the selected phase checkpoint decision is not policy-allowed" };
  }
  if (input.authorization !== "human" || input.actor_provenance.kind !== "user" || !input.actor_provenance.proof) {
    return { ok: false, code: "SPEC_PROOF_INVALID", error: "phase checkpoint decisions require a trusted selected host answer" };
  }
  const authority = answerAuthorities.get(`${root}\0${input.actor_provenance.proof.answer_id}`);
  if (!authority) return { ok: false, code: "SPEC_PROOF_INVALID", error: "selected checkpoint answer authority is unavailable" };
  const persisted = loadPersisted(root).state;
  const capability = persisted.dispatch_capability;
  if (!capability) return { ok: false, code: "SPEC_PHASE_CONFLICT", error: "checkpoint fixture lacks active capability" };
  const committed = commitCheckpointAnswerSelected(root, {
    feature_id: input.feature_id,
    advance_token: authority.advance_token,
    capability_id: capability.capability_id,
    run_key: input.run_key,
    branch: persisted.branch,
    workflow: persisted.classification.workflow,
    profile_hash: persisted.profile_hash ?? specPreparationProfileHash(),
    stage_cursor: input.phase,
    cursor_epoch: capability.issued_for?.cursor_epoch ?? persisted.cursor_epoch,
    checkpoint: input.checkpoint_id,
    checkpoint_id: input.checkpoint_id,
    checkpoint_kind: PHASE_CHECKPOINT,
    decision: input.decision,
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
  }, { trusted_answer_capability: authority.capability as never, trusted_answer_id: input.actor_provenance.proof.answer_id, apply_decision: true });
  if (!committed.ok) return { ok: false, code: committed.code.toUpperCase(), error: committed.error };
  const advanced = advanceCursor(root, {
    token: authority.advance_token,
    advance_token: authority.advance_token,
    capability_id: capability.capability_id,
    feature_id: input.feature_id,
    run_key: input.run_key,
    branch: persisted.branch,
    workflow: persisted.classification.workflow,
    profile_hash: persisted.profile_hash ?? specPreparationProfileHash(),
    stage_cursor: input.phase,
    cursor_epoch: capability.issued_for?.cursor_epoch ?? persisted.cursor_epoch,
    evidence: "selected checkpoint answer committed by the trusted host Ask",
  }, { trustedMappingProof: currentCheckpointMappingProof(root) });
  const status = input.decision === "request_changes" ? "revision_required" : "approved";
  const nextPhase = input.phase === "specify" ? "plan" : input.phase === "plan" ? "tasks" : null;
  return {
    ok: true,
    value: {
      decision: input.decision,
      phase: input.phase,
      version: committed.persisted_decision?.artifact_version ?? committed.persisted_decision?.artifact_version ?? 1,
      replay: committed.outcome === "already_recorded",
      status,
      revision_feedback: input.feedback ?? null,
      resume_next_phase: nextPhase,
      dispatched_next_phase: advanced.ok && input.decision === "approve_continue" && advanced.handoff ? nextPhase : null,
    },
  };
}

function decisionCall(
  actor: CheckpointActor,
  decision: string,
  overrides: Partial<PhaseDecisionCall> = {},
): PhaseDecisionCall {
  return {
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: "specify",
    checkpoint_id: PHASE_CHECKPOINT,
    decision,
    authorization: "human",
    actor_provenance: actor,
    ...overrides,
  };
}

/** The exact three-decision hard-human phase policy (T041 contract input). */
const PHASE_POLICY: CheckpointPolicy = {
  default: "required_human",
  scope: "decision",
  hard_human: [PHASE_CHECKPOINT, "constitution_approval"],
  rules: {
    [PHASE_CHECKPOINT]: {
      kind: PHASE_CHECKPOINT,
      default: "required_human",
      allowed_decisions: [...EXACT_DECISIONS],
      phase: "before_advance",
      rationale: "Specification phase decisions always require a trusted human answer.",
    },
    constitution_approval: {
      kind: "constitution_approval",
      default: "required_human",
      allowed_decisions: [...CONSTITUTION_DECISIONS],
      phase: "before_advance",
      rationale: "Constitution approval requires a trusted human answer.",
    },
  },
  source: "user",
  policy_version: 1,
  rationale: "Test specification phase hard-human checkpoint policy.",
};

interface SpecifyOverrides {
  status?: WorkspacePhaseRecord["status"];
  currentVersion?: number | null;
  approvedVersion?: number | null;
  validationRef?: string | null;
  checkpointRef?: string | null;
  lastFeedback?: string | null;
}

function specifyRecord(overrides: SpecifyOverrides = {}): WorkspacePhaseRecord {
  return {
    phase: "specify",
    status: overrides.status ?? "awaiting_approval",
    current_version: overrides.currentVersion !== undefined ? overrides.currentVersion : 1,
    approved_version: overrides.approvedVersion ?? null,
    validation_ref: overrides.validationRef !== undefined ? overrides.validationRef : "validation.specify.v1",
    checkpoint_ref: overrides.checkpointRef ?? null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: overrides.lastFeedback ?? null,
  };
}

function pendingPhase(phase: WorkspacePhaseRecord["phase"]): WorkspacePhaseRecord {
  return {
    phase,
    status: "not_started",
    current_version: null,
    approved_version: null,
    validation_ref: null,
    checkpoint_ref: null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  };
}

function phaseState(root: string, specify: WorkspacePhaseRecord): TeamState {
  const profileHash = specPreparationProfileHash();
  const issued = createCapability({
    run_key: RUN_KEY,
    branch: "specification-checkpoints-test",
    workflow: "spec-preparation",
    profile_hash: profileHash,
    stage_cursor: ORIGIN_STAGE,
    kind: "none",
    expected_roster: [],
  });
  const workspace: FeatureWorkspaceRecord = {
    ...validFeatureWorkspace({ featureId: FEATURE_ID, constitutionBinding: checkpointConstitutionBinding() }),
    project_root: root,
    template_set: CHECKPOINT_TEMPLATES.selection,
    phases: [specify, pendingPhase("plan"), pendingPhase("tasks")],
    next_action: {
      kind: "checkpoint",
      command: null,
      reason: "Specify validation passed; the hard-human phase checkpoint is open.",
    },
  };
  bindFeatureWorkspaceToRoot(workspace, root);
  phaseAdvanceTokens.set(root, issued.advance_token);
  return {
    schema: 1,
    branch: "specification-checkpoints-test",
    run_key: RUN_KEY,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: "specification phase checkpoint test",
    workflow_override: false,
    checkpoint_policy: PHASE_POLICY,
    stages: [
      { id: "specify", status: "in_progress" },
      { id: "plan", status: "pending" },
      { id: "tasks", status: "pending" },
    ],
    stage_cursor: ORIGIN_STAGE,
    artifacts: {},
    pause: { kind: "none", reason: "" },
    profile_hash: profileHash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    specification: workspace as TeamState["specification"],
    updated_at: FIXED_NOW,
  };
}

function writeCheckpointProof(root: string, state: TeamState, version: number): void {
  const workspace = state.specification!;
  const binding = workspace.constitution_binding;
  if (!binding) throw new Error("checkpoint fixture requires a constitution binding");
  const artifactId = `specify.v${version}`;
  const validationId = `validation.specify.v${version}`;
  const dispatchId = `checkpoint-fixture-dispatch-v${version}`;
  const requestId = `checkpoint-fixture-request-v${version}`;
  const identity: WorkIdentity = {
    run_id: RUN_KEY,
    wave_id: "wave-checkpoint-fixture",
    slice_id: FEATURE_ID,
    session_id: "session-checkpoint-fixture",
    workflow: "spec-preparation",
    stage_id: ORIGIN_STAGE,
    stage_cursor: ORIGIN_STAGE,
    capability_id: state.dispatch_capability!.capability_id,
    capability_epoch: epochOf(state),
    slot_id: "specification-analyst",
    task_id: `checkpoint-fixture-task-v${version}`,
    dispatch_id: dispatchId,
    attempt: 1,
    worker_id: "specification-worker",
  };
  const semanticModel = {
    schema_version: 1 as const,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: ORIGIN_STAGE as const,
    version,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: identity.dispatch_id },
    constitution_binding: binding,
    upstream_versions: [],
    sections: {
      problem: "A durable checkpoint fixture.",
      scope: "Checkpoint persistence only.",
      non_goals: "No implementation execution.",
      actors: "A human reviewer.",
      journeys: "Review and approve a phase.",
      requirements: "A durable checkpoint fixture requirement.",
      edge_cases: "Missing or stale proof.",
      assumptions: "The project root remains stable.",
      dependencies: "The durable state ledger.",
      success_criteria: "Exactly one durable decision.",
    },
    requirements: [{
      requirement_id: "REQ-CHECKPOINT-1",
      statement: "A durable checkpoint fixture requirement.",
      acceptance_ids: ["ACC-CHECKPOINT-1"],
      source_refs: ["spec.md#requirements"],
      testable: true,
      untestable_reason: null,
    }],
    decisions: [],
    tasks: [],
    verification: [{
      verification_id: "VERIFY-CHECKPOINT-1",
      requirement_ids: ["REQ-CHECKPOINT-1"],
      acceptance_ids: ["ACC-CHECKPOINT-1"],
      task_ids: [],
      observable_behavior: true,
      expected_evidence: "checkpoint fixture proof",
    }],
    contradictions: [],
    constitution_principles: [{
      principle_id: "constitution:1:quality",
      title: "I. Quality",
      applicability: "applicable" as const,
      status: "pass" as const,
      evidence: "Ship tested work.",
      binding,
    }],
  };
  const template = CHECKPOINT_TEMPLATES.templates.find((candidate) => candidate.template_id === ORIGIN_STAGE);
  assert.ok(template, `missing shipped ${ORIGIN_STAGE} template`);
  if (!template) throw new Error(`missing shipped ${ORIGIN_STAGE} template`);
  const content = renderCanonicalPhaseDocument(ORIGIN_STAGE, semanticModel, template);
  const sourceArtifact = {
    schema_version: 1,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    version,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: identity.dispatch_id },
    constitution_binding: binding,
    document_sha256: sha256Hex(content),
    upstream_versions: [],
    semantic_model: semanticModel,
  };
  const artifact = {
    schema_version: 1,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    request_id: requestId,
    request_digest: digestOf({
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      phase: ORIGIN_STAGE,
      version,
      request_id: requestId,
      dispatch_id: identity.dispatch_id,
      source_artifact: sourceArtifact,
      documents: [{ path: "spec.md", content }],
      semantic_sections: semanticModel.sections,
      constitution_binding: binding,
      upstream_versions: [],
      template_hash: workspace.template_set.content_hash,
      language_hash: workspace.language.selection_hash,
    }),
    source_artifact_id: "specify_draft",
    source_artifact: sourceArtifact,
    artifact_id: artifactId,
    phase: ORIGIN_STAGE,
    version,
    dispatch_id: identity.dispatch_id,
    work_identity: identity,
    capability_epoch: identity.capability_epoch,
    source_artifact_hash: digestOf(sourceArtifact),
    document_paths: ["spec.md"],
    document_hashes: { "spec.md": sha256Hex(content) },
    semantic_model: semanticModel,
    semantic_section_hashes: Object.fromEntries(
      Object.entries(semanticModel.sections).sort(([left], [right]) => left.localeCompare(right)).map(([marker, body]) => [marker, sha256Hex(body)]),
    ),
    template_hash: workspace.template_set.content_hash,
    language_hash: workspace.language.selection_hash,
    upstream_versions: [],
    created_at: FIXED_NOW,
    constitution_binding: binding,
  } as unknown as PhaseArtifactVersion;
  const artifactsDir = join(root, ".work-state", "features", FEATURE_ID, "artifacts");
  writeTestArtifact(root, artifactsDir, artifactId, artifact);
  const materialized = materializeFeatureDocuments(root, {
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: ORIGIN_STAGE,
    version,
    documents: [{ path: "spec.md", content }],
    binding: artifact,
  }, {
    validateBeforeWrite: () => {
      const selected = resolveState(root, undefined, selector());
      const current = selected.state?.specification?.constitution_binding;
      if (!current) throw new Error("SPEC_STALE: checkpoint fixture workspace constitution binding is unavailable");
      const pinned = PinnedProjectRoot.open(root);
      if (!pinned) throw new Error("SPEC_PATH_UNAUTHORIZED: checkpoint fixture root cannot be pinned");
      try {
        const live = readPinnedCurrentConstitution(pinned.canonical_root, pinned, current);
        if (!live.ok) throw new Error("SPEC_STALE: " + live.error);
      } finally {
        pinned.close();
      }
    },
  });
  if (!materialized.ok) throw new Error(`checkpoint fixture materialization failed: ${materialized.error}`);
  const validationInput: NativePhaseValidationInput = {
    validation_id: validationId,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: ORIGIN_STAGE,
    version,
    artifact_version: artifactId,
    document_path: "spec.md",
    document_sha256: sha256Hex(content),
    sections: semanticModel.sections,
    upstream_versions: [],
    expected_upstream_versions: [],
    constitution_binding: binding,
    expected_constitution_binding: binding,
    constitution_principles: semanticModel.constitution_principles.map(({ principle_id, status, evidence }) => ({ principle_id, status, evidence })),
    requirements: semanticModel.requirements,
    decisions: semanticModel.decisions,
    tasks: semanticModel.tasks,
    verification: semanticModel.verification,
    contradictions: semanticModel.contradictions,
    validated_at: FIXED_NOW,
  };
  const validation = { ...validateNativePhase(validationInput), artifact_digest: digestOf(artifact) };
  writeTestArtifact(root, artifactsDir, validationId, validation);
  const validationReport = materializePhaseValidation(root, FEATURE_ID, validation, {
    beforeWrite: () => {
      const pinned = PinnedProjectRoot.open(root);
      if (!pinned) throw new Error("SPEC_PATH_UNAUTHORIZED: checkpoint fixture root cannot be pinned");
      try {
        const live = readPinnedCurrentConstitution(pinned.canonical_root, pinned, binding);
        if (!live.ok) throw new Error("SPEC_STALE: " + live.error);
      } finally {
        pinned.close();
      }
    },
  });
  if (!validationReport.ok) throw new Error(`checkpoint fixture validation report failed: ${validationReport.error}`);
}

function writeApprovedConstitutionFixture(root: string, state: TeamState): void {
  const workspace = state.specification;
  if (!workspace?.constitution_binding || !workspace.constitution_gate_ref) throw new Error("checkpoint fixture requires an exact constitution workspace binding");
  const binding = workspace.constitution_binding;
  const gateId = workspace.constitution_gate_ref;
  writeFileSync(join(root, binding.path), CHECKPOINT_CONSTITUTION, "utf8");
  const gateDir = join(root, ".work-state", "specification", "constitution");
  mkdirSync(gateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(gateDir, "gate.json"), JSON.stringify({
    schema_version: 1,
    gate_id: gateId,
    project_root: root,
    feature_id: null,
    origin: { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE },
    gate: {
      gate_id: gateId,
      origin_kind: "native_direct",
      origin_run_key: RUN_KEY,
      origin_stage: ORIGIN_STAGE,
      status: "usable",
      usability_result: "usable",
      provider: { provider_id: binding.provider_id, path: binding.path, source: "native_default" },
      constitution_workflow_ref: null,
      checkpoint_ref: null,
      binding,
      resume_marker: null,
    },
    drafts: [],
    decisions: [],
  }, null, 2) + "\n", "utf8");
}

function seedPhaseState(root: string, specify: WorkspacePhaseRecord = specifyRecord()): TeamState {
  publishCheckpointAgentMapping(root);
  const state = phaseState(root, specify);
  writeApprovedConstitutionFixture(root, state);
  mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
  writeState(root, state, { featureSlug: FEATURE_ID });
  if (specify.status === "awaiting_approval" && specify.current_version !== null && specify.current_version >= 1 && specify.validation_ref === `validation.specify.v${specify.current_version}`) {
    writeCheckpointProof(root, state, specify.current_version);
    const warmedSubject = resolveNativePhaseCheckpointSubject(root, { feature_id: FEATURE_ID, run_key: RUN_KEY, phase: ORIGIN_STAGE });
    if (!warmedSubject.ok) throw new Error(`checkpoint fixture subject warmup failed: ${warmedSubject.error}`);
  }
  return state;
}

type SelectedState = ReturnType<typeof resolveState>;

function loadPersisted(root: string): { state: TeamState; selected: SelectedState } {
  const selected = resolveState(root, undefined, selector());
  if (selected.invalid || !selected.state || !selected.statePath || !selected.stateDir || !selected.artifactsDir) {
    throw new Error("specification checkpoint test requires the exact persisted feature workspace state");
  }
  return { state: selected.state, selected };
}

function specifyOf(state: TeamState): WorkspacePhaseRecord {
  const record = state.specification?.phases.find((phase) => phase.phase === "specify");
  if (!record) throw new Error("fixture workspace lost its specify phase record");
  return record;
}

function phaseOf(state: TeamState, phase: WorkspacePhaseRecord["phase"]): WorkspacePhaseRecord {
  const record = state.specification?.phases.find((candidate) => candidate.phase === phase);
  if (!record) throw new Error(`fixture workspace lost its ${phase} phase record`);
  return record;
}

function typedDecisions(state: TeamState, checkpointId = PHASE_CHECKPOINT) {
  return (state.typed_checkpoint_decisions ?? []).filter(
    (record) => record.stage_id === ORIGIN_STAGE && record.checkpoint_id === checkpointId,
  );
}

function consumedAnswer(state: TeamState, answerId: string) {
  return (state.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === answerId);
}

function recordSyntheticPhaseAnswer(
  state: TeamState,
  answerId: string,
  decision: string,
  feedback?: string,
): ReturnType<typeof recordTrustedCheckpointAnswer> {
  const workspace = state.specification;
  assert.ok(workspace, "synthetic phase answer requires a specification workspace");
  if (!workspace) throw new Error("synthetic phase answer workspace is unavailable");
  const pinned = PinnedProjectRoot.open(workspace.project_root);
  assert.ok(pinned, "synthetic phase answer root must pin");
  if (!pinned) throw new Error("synthetic phase answer root is unavailable");
  try {
    const root = { canonical_root: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino };
    const reference = "terminal-answer/" + answerId;
    const capability = issueTrustedCheckpointAnswerCapability(TEST_CHECKPOINT_BRIDGE, {
      root,
      state,
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: ORIGIN_STAGE,
      checkpoint_id: PHASE_CHECKPOINT,
      decision,
      feature_id: workspace.feature_id,
      ...(feedback === undefined ? {} : { feedback }),
      question: "Authorize the synthetic specification phase checkpoint",
      options: [...EXACT_DECISIONS],
      session_id: "checkpoint-test-session",
      actor_ref: reference,
      profile_hash: state.profile_hash ?? specPreparationProfileHash(),
    });
    return recordTrustedCheckpointAnswer(state, {
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: ORIGIN_STAGE,
      checkpoint_id: PHASE_CHECKPOINT,
      decision,
      feature_id: workspace.feature_id,
      ...(feedback === undefined ? {} : { feedback }),
    }, { capability, root });
  } finally {
    pinned.close();
  }
}

/**
 * Record one trusted terminal answer for the current durable context and
 * persist it, returning the user actor provenance carrying its proof.
 */
function recordPhaseAnswer(
  root: string,
  decision: string,
  answerId: string,
  checkpointId = PHASE_CHECKPOINT,
  feedback?: string,
): CheckpointActor {
  const { state, selected } = loadPersisted(root);
  if (!state.checkpoint_policy || !state.specification) {
    throw new Error("specification checkpoint test state lacks checkpoint context");
  }
  const subject = resolveNativePhaseCheckpointSubject(root, { feature_id: state.specification.feature_id, run_key: state.run_key!, phase: ORIGIN_STAGE });
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("checkpoint fixture root could not be pinned");
  try {
    const stat = { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
    const reference = `terminal-answer/${answerId}`;
    const capability = issueTrustedCheckpointAnswerCapability(TEST_CHECKPOINT_BRIDGE, {
      root: stat,
      state,
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: ORIGIN_STAGE,
      checkpoint_id: checkpointId,
      decision,
      feature_id: state.specification.feature_id,
      ...(subject.ok ? { subject_binding: subject.subject.subject_binding, subject_revision: subject.subject.state_revision + 1 } : {}),
      ...(decision === "request_changes" ? { feedback: feedback ?? REVISION_FEEDBACK } : {}),
      question: "Authorize the current specification phase",
      options: EXACT_DECISIONS,
      session_id: "checkpoint-test-session",
      actor_ref: reference,
      profile_hash: state.profile_hash ?? specPreparationProfileHash(),
    });
    const trusted = recordTrustedCheckpointAnswer(state, {
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: ORIGIN_STAGE,
      checkpoint_id: checkpointId,
      decision,
      feature_id: state.specification.feature_id,
      ...(subject.ok ? { subject_binding: subject.subject.subject_binding, subject_revision: subject.subject.state_revision + 1 } : {}),
      ...(decision === "request_changes" ? { feedback: feedback ?? REVISION_FEEDBACK } : {}),
    }, { capability, root: stat });
    writeState(root, trusted.state, { target: selected });
    const advanceToken = phaseAdvanceTokens.get(root);
    if (!advanceToken) throw new Error("checkpoint fixture lacks advance token");
    answerAuthorities.set(`${root}\0${answerId}`, { capability, advance_token: advanceToken });
    return { kind: "user", ref: trusted.proof.reference, proof: trusted.proof };
  } finally {
    pinnedRoot.close();
  }
}

function typedPhaseDecision(
  state: TeamState,
  actor: CheckpointActor,
  decision: string,
  rationale: string,
): TypedCheckpointDecision {
  const capability = state.dispatch_capability;
  const capabilityId = capability?.capability_id;
  const capabilityEpoch = capability?.issued_for?.cursor_epoch;
  if (!capabilityId || !capabilityEpoch) throw new Error("checkpoint fixture lacks active capability binding");
  return {
    run_id: state.work_identity?.run_id ?? state.run_key ?? state.branch,
    stage_id: ORIGIN_STAGE,
    checkpoint_id: PHASE_CHECKPOINT,
    checkpoint_kind: PHASE_CHECKPOINT,
    decision,
    feature_id: state.specification?.feature_id,
    authorization: "human",
    actor,
    capability_id: capabilityId,
    capability_epoch: capabilityEpoch,
    policy_hash: checkpointPolicyHash(PHASE_POLICY),
    rationale,
    decided_at: FIXED_NOW,
  };
}

// ── Presentation and the exact decision set ──────────────────────────────────

test("checkpoint validation rejects a replaced root without writing replacement state", () => {
  const root = makeProject();
  const original = root + ".original";
  seedPhaseState(root);
  const before = resolveState(root, undefined, selector());
  let swapped = false;
  try {
    setSpecificationPhaseFailureInjector((point) => {
      if (!swapped && point === "before_checkpoint_validation") {
        swapped = true;
        renameSync(root, original);
        mkdirSync(root);
      }
    });
    const presented = presentPhaseCheckpoint(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, false, "checkpoint validation must fail closed after root replacement");
    assert.equal(existsSync(join(root, ".work-state")), false, "replacement root must not receive workflow state");
    assert.equal(existsSync(join(root, "specs")), false, "replacement root must not receive readable projections");
    rmSync(root, { recursive: true, force: true });
    renameSync(original, root);
    const restored = resolveState(root, undefined, selector());
    assert.equal(digestOf(restored.state), digestOf(before.state), "root replacement must preserve original state");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    if (existsSync(original)) {
      rmSync(root, { recursive: true, force: true });
      renameSync(original, root);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a passing specification phase exposes exactly the three valid decisions", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);

    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true, "a current passing validation result opens the phase checkpoint");
    if (!presented.ok) return;
    assert.equal(presented.value.phase, "specify");
    assert.equal(presented.value.version, 1);
    assert.equal(presented.value.checkpoint_id, PHASE_CHECKPOINT, "the checkpoint is the named specification_phase_approval policy");
    assert.deepEqual(presented.value.allowed_decisions, [...EXACT_DECISIONS]);
    assert.equal(presented.value.revision_feedback, null, "a first presentation carries no revision feedback");
    const presentedState = loadPersisted(root);
    assert.equal(presentedState.state.specification?.next_action.reason, "The specify validation passed; the hard-human checkpoint is open.", "first presentation must use the canonical phase-specific checkpoint reason");
    assert.deepEqual(presentedState.state.pause, { kind: "user_checkpoint", reason: presentedState.state.specification?.next_action.reason }, "first presentation must persist the canonical hard-human pause");
    writeState(root, { ...presentedState.state, pause: { kind: "none" as const, reason: "" } }, { target: presentedState.selected });
    assert.deepEqual(loadPersisted(root).state.pause, { kind: "none", reason: "" }, "fixture must reproduce a missing checkpoint pause");

    const again = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    const repairedState = loadPersisted(root).state;
    assert.equal(repairedState.specification?.next_action.reason, "The specify validation passed; the hard-human checkpoint is open.", "replay must retain the canonical phase-specific checkpoint reason");
    assert.deepEqual(repairedState.pause, { kind: "user_checkpoint", reason: repairedState.specification?.next_action.reason }, "replay must repair a stale checkpoint pause");
    assert.equal(again.ok, true, "re-presenting the open checkpoint replays the established record");
    if (!again.ok) return;
    assert.equal(again.value.checkpoint_id, presented.value.checkpoint_id);
    assert.equal(again.value.version, presented.value.version);

    const rejected = runSelectedCheckpointDecisionContract(
      root,
      decisionCall({ kind: "agent", ref: "agent/fabricated-fourth-decision" }, "approve"),
    );
    assert.equal(rejected.ok, false, "a fourth decision value never authorizes a phase checkpoint");
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_DECISION_INVALID");
    const untouched = loadPersisted(root).state;
    assert.equal(typedDecisions(untouched).length, 0, "invalid decisions create no durable record");
    assert.equal(
      untouched.trusted_checkpoint_answers?.length ?? 0,
      0,
      "invalid decisions never enter the trusted answer ledger",
    );
    const stillOpen = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(stillOpen.ok, true, "the checkpoint stays open for a valid decision after a rejection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Approve-and-continue / approve-and-stop ─────────────────────────────────

test("approve_continue with a trusted human proof approves the phase and requires fresh next-phase preparation", () => {
  const root = makeProject();
  try {
    const seeded = seedPhaseState(root);
    const seededEpoch = epochOf(seeded);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;
    const actor = recordPhaseAnswer(root, "approve_continue", "phase-answer/specify.v1/approve_continue");

    const outcome = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_continue"));
    assert.equal(
      outcome.ok,
      true,
      "a bound trusted answer authorizes approve_continue: " + (outcome.ok ? "" : outcome.error),
    );
    if (!outcome.ok) return;
    assert.equal(outcome.value.decision, "approve_continue");
    assert.equal(outcome.value.status, "approved");
    assert.equal(outcome.value.version, 1);
    assert.equal(outcome.value.replay, false);
    assert.equal(outcome.value.resume_next_phase, "plan", "approve_continue resumes at the exact next phase");
    assert.equal(outcome.value.dispatched_next_phase, null, "approve_continue leaves roster selection to the next phase preparation");

    const after = loadPersisted(root).state;
    const records = typedDecisions(after);
    assert.equal(records.length, 1, "exactly one durable decision is recorded");
    const record = records[0]!;
    assert.equal(record.decision, "approve_continue");
    assert.equal(record.authorization, "human");
    assert.equal(record.actor.kind, "user");
    assert.equal(record.run_id, RUN_KEY);
    assert.equal(record.stage_id, ORIGIN_STAGE);
    assert.equal(record.capability_epoch, seededEpoch, "the decision binds the epoch the answer was issued under");
    assert.equal(record.policy_hash, checkpointPolicyHash(PHASE_POLICY), "the decision binds the exact active policy");
    assert.ok(consumedAnswer(after, "phase-answer/specify.v1/approve_continue")?.consumed_at, "the answer is consumed after landing");

    const specify = specifyOf(after);
    assert.equal(specify.status, "approved");
    assert.equal(specify.approved_version, 1);
    assert.equal(specify.current_version, 1);
    assert.ok(specify.checkpoint_ref, "an approved phase records its checkpoint reference");
    assert.equal(phaseOf(after, "plan").status, "not_started", "the next roster phase remains pending until fresh preparation");
    assert.equal(after.specification?.next_action.command, "/spec-plan --feature checkpoint-feature");
    assert.notEqual(after.stage_cursor, ORIGIN_STAGE, "approve_continue advances past the approved phase");

    const replayed = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_continue"));
    assert.equal(replayed.ok, false, "the old selected capability cannot replay after the cursor advances");
    if (!replayed.ok) assert.equal(replayed.code, "SPEC_PHASE_CONFLICT");

    const settled = loadPersisted(root).state;
    assert.equal(typedDecisions(settled).length, 1, "replay appends no duplicate decision");
    assert.equal(epochOf(settled), epochOf(after), "replay issues no new capability epoch");
    assert.equal(phaseOf(settled, "plan").status, "not_started", "replay does not arm the next roster phase");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approve decisions reject feedback before any durable mutation", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;
    const actor = recordPhaseAnswer(root, "approve_continue", "phase-answer/specify.v1/approve-with-feedback");
    const before = readFileSync(resolveState(root, undefined, selector()).statePath!, "utf8");
    const rejected = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_continue", { feedback: "unbound" }));
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_FEEDBACK_INVALID");
    assert.equal(readFileSync(resolveState(root, undefined, selector()).statePath!, "utf8"), before);
    const state = loadPersisted(root).state;
    assert.equal(typedDecisions(state).length, 0, "approval feedback rejection must not append a typed decision");
    assert.equal(consumedAnswer(state, "phase-answer/specify.v1/approve-with-feedback")?.consumed_at, undefined, "approval feedback rejection must not consume the proof");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approve_stop records the same durable approval but returns without dispatching", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;
    const actor = recordPhaseAnswer(root, "approve_stop", "phase-answer/specify.v1/approve_stop");

    const outcome = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_stop"));
    assert.equal(
      outcome.ok,
      true,
      "a bound trusted answer authorizes approve_stop: " + (outcome.ok ? "" : outcome.error),
    );
    if (!outcome.ok) return;
    assert.equal(outcome.value.decision, "approve_stop");
    assert.equal(outcome.value.status, "approved", "approve_stop durably approves the phase like approve_continue");
    assert.equal(outcome.value.version, 1);
    assert.equal(outcome.value.replay, false);
    assert.equal(outcome.value.resume_next_phase, "plan", "a stopped run resumes later at the exact next phase");
    assert.equal(outcome.value.dispatched_next_phase, null, "approve_stop returns without dispatching the next phase");

    const after = loadPersisted(root).state;
    const records = typedDecisions(after);
    assert.equal(records.length, 1, "the stop decision is durable so resume never repeats approval");
    assert.equal(records[0]!.decision, "approve_stop");
    const specify = specifyOf(after);
    assert.equal(specify.status, "approved");
    assert.equal(specify.approved_version, 1);
    assert.ok(specify.checkpoint_ref, "an approved phase records its checkpoint reference");
    assert.equal(phaseOf(after, "plan").status, "not_started", "no next-phase dispatch is prepared after a stop");
    assert.equal(after.stage_cursor, ORIGIN_STAGE, "a stop holds the cursor at the decided phase boundary without arming the next phase");
    assert.equal(after.pause.kind, "done", "approve_stop persists a terminal workflow status");
    assert.match(after.pause.reason, /stopped after the specify checkpoint/u);
    assert.equal(after.specification?.next_action.kind, "none");
    assert.equal(after.specification?.next_action.command, null);
    assert.match(after.specification?.next_action.reason ?? "", /no next stage or implementation worker/u);
    assert.equal(after.specification?.handoff_ref, null, "a stopped phase never leaves an implementation handoff");

    const replayed = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_stop"));
    assert.equal(replayed.ok, false, "the stopped phase no longer exposes the consumed capability");
    if (!replayed.ok) assert.equal(replayed.code, "SPEC_PHASE_CONFLICT");

    const settled = loadPersisted(root).state;
    assert.equal(typedDecisions(settled).length, 1, "replay appends no duplicate decision");
    assert.equal(phaseOf(settled, "plan").status, "not_started", "replay after a stop never starts the next phase");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Feedback-bound revision loop ─────────────────────────────────────────────

test("request_changes reopens the same phase with a new capability epoch and binds the exact feedback", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;
    const actor = recordPhaseAnswer(root, "request_changes", "phase-answer/specify.v1/request_changes");
    const beforeEpoch = epochOf(loadPersisted(root).state);

    const outcome = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(actor, "request_changes", { feedback: REVISION_FEEDBACK }),
    );
    assert.equal(
      outcome.ok,
      true,
      "a bound trusted answer authorizes request_changes: " + (outcome.ok ? "" : outcome.error),
    );
    if (!outcome.ok) return;
    assert.equal(outcome.value.decision, "request_changes");
    assert.equal(outcome.value.status, "revision_required");
    assert.equal(outcome.value.version, 1, "no new version exists until the revised content is produced");
    assert.equal(outcome.value.revision_feedback, REVISION_FEEDBACK, "the captured feedback is bound to the revision round");
    assert.equal(outcome.value.dispatched_next_phase, null, "request_changes never dispatches the next phase");

    const after = loadPersisted(root).state;
    const specify = specifyOf(after);
    assert.equal(
      after.specification?.next_action.command,
      "/specify --feature checkpoint-feature",
      "request_changes persists the canonical phase re-entry command with its feature selector",
    );
    assert.doesNotMatch(
      after.specification?.next_action.command ?? "",
      /\/spec-specify/,
      "request_changes never emits the unsupported /spec-specify command",
    );
    assert.equal(specify.status, "revision_required");
    assert.equal(specify.last_feedback, REVISION_FEEDBACK, "the phase record captures the feedback for the re-dispatched worker");
    assert.equal(specify.current_version, 1);
    assert.equal(specify.approved_version, null);
    assert.equal(specify.checkpoint_ref, null, "the checkpoint is closed until revised content re-validates");
    assert.deepEqual(after.pause, { kind: "none", reason: "" }, "request_changes clears the presentation pause while reopening the phase");
    assert.equal(phaseOf(after, "plan").status, "not_started", "the workflow stays on the same phase");
    assert.equal(after.stage_cursor, ORIGIN_STAGE, "the same content stage is reopened");
    const revisionEpoch = epochOf(after);
    assert.notEqual(revisionEpoch, beforeEpoch, "the same-phase re-dispatch runs under a new capability epoch");
    const records = typedDecisions(after);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.decision, "request_changes");
    assert.equal(records[0]!.capability_epoch, beforeEpoch);
    assert.ok(consumedAnswer(after, "phase-answer/specify.v1/request_changes")?.consumed_at);

    const padded = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(actor, "request_changes", { feedback: ` ${REVISION_FEEDBACK} ` }),
    );
    assert.equal(padded.ok, false, "replay feedback padding must not be normalized into the trusted proof");
    assert.equal(typedDecisions(loadPersisted(root).state).length, 1, "padded replay must not append a decision");

    const replayed = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(actor, "request_changes", { feedback: REVISION_FEEDBACK }),
    );
    assert.equal(replayed.ok, true, "exact idempotent replay returns the established result");
    if (!replayed.ok) return;
    assert.equal(replayed.value.replay, true);
    assert.equal(replayed.value.revision_feedback, REVISION_FEEDBACK);

    const settled = loadPersisted(root).state;
    assert.equal(typedDecisions(settled).length, 1, "replay appends no duplicate decision");
    assert.equal(epochOf(settled), revisionEpoch, "replay issues no additional epoch");
    assert.equal(specifyOf(settled).last_feedback, REVISION_FEEDBACK);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request_changes requires non-empty feedback", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;
    const actor = recordPhaseAnswer(root, "request_changes", "phase-answer/specify.v1/no-feedback");
    const beforeEpoch = epochOf(loadPersisted(root).state);

    const withoutFeedback = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "request_changes"));
    assert.equal(withoutFeedback.ok, false, "request_changes without feedback is rejected");
    if (!withoutFeedback.ok) assert.equal(withoutFeedback.code, "SPEC_FEEDBACK_REQUIRED");

    const blankActor = recordPhaseAnswer(root, "request_changes", "phase-answer/specify.v1/blank-feedback");
    const blankFeedback = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(blankActor, "request_changes", { feedback: "   \n\t " }),
    );
    assert.equal(blankFeedback.ok, false, "whitespace-only feedback is rejected");
    if (!blankFeedback.ok) assert.equal(blankFeedback.code, "SPEC_FEEDBACK_REQUIRED");

    const after = loadPersisted(root).state;
    assert.equal(typedDecisions(after).length, 0, "rejected revisions create no durable decision");
    assert.equal(consumedAnswer(after, "phase-answer/specify.v1/no-feedback")?.consumed_at, undefined);
    assert.equal(consumedAnswer(after, "phase-answer/specify.v1/blank-feedback")?.consumed_at, undefined);
    assert.equal(epochOf(after), beforeEpoch, "rejected revisions issue no new epoch");
    const specify = specifyOf(after);
    assert.equal(specify.status, "awaiting_approval", "the open checkpoint survives rejected revisions");
    assert.equal(specify.last_feedback, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revised content re-presents the same phase as a new version bound to the revision feedback", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;
    const staleActor = recordPhaseAnswer(root, "approve_continue", "phase-answer/specify.v1/stale-proof");
    const feedbackActor = recordPhaseAnswer(root, "request_changes", "phase-answer/specify.v1/request_changes");

    const revision = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(feedbackActor, "request_changes", { feedback: REVISION_FEEDBACK }),
    );
    assert.equal(
      revision.ok,
      true,
      "a bound trusted answer authorizes the revision round: " + (revision.ok ? "" : revision.error),
    );
    if (!revision.ok) return;
    const revisionEpoch = epochOf(loadPersisted(root).state);

    // Simulate the completed same-phase revision: the re-dispatched worker's
    // typed result is materialized and validated as specify v2.
    const { state, selected } = loadPersisted(root);
    const revised = specifyRecord({
      currentVersion: 2,
      validationRef: "validation.specify.v2",
      lastFeedback: REVISION_FEEDBACK,
    });
    const revisionCapabilityState = phaseState(root, revised);
    const reworked: TeamState = {
      ...state,
      cursor_epoch: revisionCapabilityState.cursor_epoch,
      dispatch_capability: revisionCapabilityState.dispatch_capability,
      specification: {
        ...state.specification!,
        phases: [revised, phaseOf(state, "plan"), phaseOf(state, "tasks")],
      },
    };
    writeState(root, reworked, { target: selected });
    writeCheckpointProof(root, reworked, 2);

    const represented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(represented.ok, true, "revised passing content re-opens the same checkpoint");
    if (!represented.ok) return;
    assert.equal(represented.value.version, 2, "the revision round presents the new artifact version");
    assert.equal(represented.value.checkpoint_id, PHASE_CHECKPOINT);
    assert.deepEqual(represented.value.allowed_decisions, [...EXACT_DECISIONS]);
    assert.equal(represented.value.revision_feedback, REVISION_FEEDBACK, "the new checkpoint binds the exact revision feedback");

    const staleAttempt = runSelectedCheckpointDecisionContract(root, decisionCall(staleActor, "approve_continue"));
    assert.equal(staleAttempt.ok, false, "a proof issued under the superseded epoch cannot authorize the new checkpoint");
    if (!staleAttempt.ok) assert.equal(staleAttempt.code, "CHECKPOINT_INVALID");
    assert.equal(
      epochOf(loadPersisted(root).state),
      revisionEpoch,
      "a rejected stale attempt issues no new epoch and records nothing",
    );

    const freshActor = recordPhaseAnswer(root, "approve_continue", "phase-answer/specify.v2/approve_continue");
    const approved = runSelectedCheckpointDecisionContract(root, decisionCall(freshActor, "approve_continue"));
    assert.equal(approved.ok, true, "a fresh proof bound to the new epoch authorizes the revision");
    if (!approved.ok) return;
    assert.equal(approved.value.version, 2);
    assert.equal(approved.value.dispatched_next_phase, null);

    const after = loadPersisted(root).state;
    const specify = specifyOf(after);
    assert.equal(specify.status, "approved");
    assert.equal(specify.approved_version, 2, "the revision round approves the new version");
    assert.equal(specify.current_version, 2);
    const decisions = typedDecisions(after).map((record) => record.decision);
    assert.ok(decisions.includes("request_changes"), "the revision-round decision remains in the ledger");
    assert.ok(decisions.includes("approve_continue"), "the new epoch permits a fresh decision for the same checkpoint");
    assert.equal(phaseOf(after, "plan").status, "not_started");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint ledger keeps revision epochs distinct and projects only the active decision", () => {
  const root = makeProject();
  try {
    const initial = phaseState(root, specifyRecord());
    const v1Answer = recordSyntheticPhaseAnswer(initial, "phase-answer/epoch-v1/request_changes", "request_changes", REVISION_FEEDBACK);
    const v1Actor: CheckpointActor = {
      kind: "user",
      ref: v1Answer.proof.reference,
      proof: v1Answer.proof,
    };
    const v1Decision = typedPhaseDecision(initial, v1Actor, "request_changes", REVISION_FEEDBACK);
    const withV1 = appendCheckpointDecision(v1Answer.state, v1Decision);

    const rotated = createCapability({
      run_key: RUN_KEY,
      branch: withV1.branch,
      workflow: withV1.classification.workflow,
      profile_hash: withV1.profile_hash ?? "",
      stage_cursor: ORIGIN_STAGE,
      kind: "single",
      expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }],
    });
    const v2State: TeamState = {
      ...withV1,
      cursor_epoch: rotated.state.issued_for!.cursor_epoch,
      dispatch_capability: rotated.state,
    };
    const v2Answer = recordSyntheticPhaseAnswer(v2State, "phase-answer/epoch-v2/approve_continue", "approve_continue");
    const v2Actor: CheckpointActor = {
      kind: "user",
      ref: v2Answer.proof.reference,
      proof: v2Answer.proof,
    };
    const v2Decision = typedPhaseDecision(v2State, v2Actor, "approve_continue", "Approve the revised specification.");
    const withV2 = appendCheckpointDecision(v2Answer.state, v2Decision);

    const records = typedDecisions(withV2);
    assert.equal(records.length, 2, "a new capability epoch appends a historical typed decision");
    assert.equal(records[0]!.decision, "request_changes");
    assert.equal(records[0]!.capability_epoch, v1Decision.capability_epoch);
    assert.equal(records[1]!.decision, "approve_continue");
    assert.equal(records[1]!.capability_epoch, v2Decision.capability_epoch);
    assert.equal(withV2.checkpoint_decisions?.length, 1, "the schema-1 mirror remains singular");
    assert.equal(withV2.checkpoint_decisions?.[0]?.decision, "approve_continue", "the mirror represents the active checkpoint");

    const staleOnly: TeamState = { ...withV2, typed_checkpoint_decisions: [v1Decision], checkpoint_decisions: [] };
    const stage = { id: ORIGIN_STAGE, checkpoint: PHASE_CHECKPOINT, checkpoint_policy: PHASE_POLICY };
    const currentSelection = selectLatestValidCheckpointDecision(stage, withV2);
    const advanceSelection = validateCheckpointForAdvance(stage, withV2);
    assert.equal(advanceSelection.ok, true, advanceSelection.ok ? "" : advanceSelection.error);
    if (advanceSelection.ok) assert.equal(advanceSelection.decision.decision, "approve_continue", "advance validation uses the same latest-valid selector");
    assert.equal(currentSelection.ok, true, currentSelection.ok ? "" : currentSelection.error);
    if (currentSelection.ok) assert.equal(currentSelection.decision.decision, "approve_continue", "selector projects the newest valid decision");
    const staleSelection = selectLatestValidCheckpointDecision(stage, staleOnly);
    assert.equal(staleSelection.ok, false, "a stale-only ledger must not authorize advance");
    if (!staleSelection.ok) assert.equal(staleSelection.code, "checkpoint_unverified");

    const replayed = appendCheckpointDecision(withV2, v2Decision);
    assert.deepEqual(replayed, withV2, "exact v2 replay is idempotent");

    const conflictingAnswer = recordSyntheticPhaseAnswer(withV2, "phase-answer/epoch-v2/approve_stop", "approve_stop");
    const conflictingActor: CheckpointActor = {
      kind: "user",
      ref: conflictingAnswer.proof.reference,
      proof: conflictingAnswer.proof,
    };
    const conflictingDecision = typedPhaseDecision(withV2, conflictingActor, "approve_stop", "Conflicting same-epoch value.");
    const conflictState: TeamState = {
      ...conflictingAnswer.state,
      typed_checkpoint_decisions: [...(withV2.typed_checkpoint_decisions ?? []), conflictingDecision],
      checkpoint_decisions: [],
    };
    const conflictSelection = selectLatestValidCheckpointDecision(stage, conflictState);
    assert.equal(conflictSelection.ok, false, "same-timestamp contradictory valid decisions must fail closed");
    if (!conflictSelection.ok) assert.equal(conflictSelection.code, "checkpoint_unverified");
    assert.throws(
      () => appendCheckpointDecision(conflictingAnswer.state, conflictingDecision),
      /migration_conflict/,
      "a different value in the same capability epoch conflicts",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Fail-closed authorization ────────────────────────────────────────────────

test("agent provenance and policy automation can never approve a phase checkpoint", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;

    const autoAttempt = runSelectedCheckpointDecisionContract(
      root,
      decisionCall({ kind: "orchestrator", ref: "orchestrator-auto" }, "approve_continue", {
        authorization: "policy_auto",
      }),
    );
    assert.equal(autoAttempt.ok, false, "the specification phase policy is hard-human: policy_auto never authorizes");

    const orchestratorActor = recordPhaseAnswer(root, "approve_continue", "phase-answer/orchestrator-proof");
    const orchestratorAttempt = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(
        { kind: "orchestrator", ref: orchestratorActor.ref, proof: orchestratorActor.proof },
        "approve_continue",
      ),
    );
    assert.equal(orchestratorAttempt.ok, false, "orchestrator provenance cannot impersonate the user even with a recorded answer");
    if (!orchestratorAttempt.ok) assert.equal(orchestratorAttempt.code, "SPEC_PROOF_INVALID");

    const systemActor = recordPhaseAnswer(root, "approve_continue", "phase-answer/system-proof");
    const systemAttempt = runSelectedCheckpointDecisionContract(
      root,
      decisionCall({ kind: "system", ref: systemActor.ref, proof: systemActor.proof }, "approve_continue"),
    );
    assert.equal(systemAttempt.ok, false, "system provenance cannot impersonate the user even with a recorded answer");
    if (!systemAttempt.ok) assert.equal(systemAttempt.code, "SPEC_PROOF_INVALID");

    const after = loadPersisted(root).state;
    assert.equal(typedDecisions(after).length, 0, "agent attempts record no durable decision");
    assert.equal(consumedAnswer(after, "phase-answer/orchestrator-proof")?.consumed_at, undefined);
    assert.equal(consumedAnswer(after, "phase-answer/system-proof")?.consumed_at, undefined);
    const specify = specifyOf(after);
    assert.equal(specify.status, "awaiting_approval", "the checkpoint stays open for the real user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decisions without a durable trusted proof are rejected", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true);
    if (!presented.ok) return;

    const withoutProof = runSelectedCheckpointDecisionContract(
      root,
      decisionCall({ kind: "user", ref: "terminal-answer/manual" }, "approve_continue"),
    );
    assert.equal(withoutProof.ok, false, "a user claim without a durable answer proof never authorizes");
    if (!withoutProof.ok) assert.equal(withoutProof.code, "SPEC_PROOF_INVALID");

    const fabricated = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(
        {
          kind: "user",
          ref: "terminal-answer/fabricated",
          proof: {
            answer_id: "fabricated-answer",
            nonce: sha256("fabricated-nonce"),
            channel: "terminal",
            reference: "terminal-answer/fabricated",
            binding: sha256("fabricated-binding"),
          },
        },
        "approve_continue",
      ),
    );
    assert.equal(fabricated.ok, false, "caller-minted proof values never authorize");
    if (!fabricated.ok) assert.equal(fabricated.code, "SPEC_PROOF_INVALID");

    const realActor = recordPhaseAnswer(root, "approve_continue", "phase-answer/tamper-target");
    const tamperedNonce = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(
        { kind: "user", ref: realActor.ref, proof: { ...realActor.proof!, nonce: "0".repeat(64) } },
        "approve_continue",
      ),
    );
    assert.equal(tamperedNonce.ok, false, "a tampered answer nonce fails the binding recomputation");
    if (!tamperedNonce.ok) assert.equal(tamperedNonce.code, "SPEC_PROOF_INVALID");

    const tamperedBinding = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(
        { kind: "user", ref: realActor.ref, proof: { ...realActor.proof!, binding: "f".repeat(64) } },
        "approve_continue",
      ),
    );
    assert.equal(tamperedBinding.ok, false, "a tampered binding digest fails verification");
    if (!tamperedBinding.ok) assert.equal(tamperedBinding.code, "SPEC_PROOF_INVALID");

    const otherDecisionActor = recordPhaseAnswer(root, "approve_stop", "phase-answer/other-decision");
    const otherDecision = runSelectedCheckpointDecisionContract(root, decisionCall(otherDecisionActor, "approve_continue"));
    assert.equal(otherDecision.ok, false, "the immutable answer is bound to its exact decision");
    if (!otherDecision.ok) assert.equal(otherDecision.code, "SPEC_PROOF_INVALID");

    const otherCheckpointActor = recordPhaseAnswer(
      root,
      "approve_continue",
      "phase-answer/other-checkpoint",
      "constitution_approval",
    );
    const otherCheckpoint = runSelectedCheckpointDecisionContract(root, decisionCall(otherCheckpointActor, "approve_continue"));
    assert.equal(otherCheckpoint.ok, false, "an answer issued for another checkpoint cannot be reused");
    if (!otherCheckpoint.ok) assert.equal(otherCheckpoint.code, "SPEC_PROOF_INVALID");

    const crossFeature = runSelectedCheckpointDecisionContract(
      root,
      decisionCall(realActor, "approve_continue", { feature_id: "other-feature" }),
    );
    assert.equal(crossFeature.ok, false, "a decision cannot cross the selected feature identity");

    const after = loadPersisted(root).state;
    assert.equal(typedDecisions(after).length, 0, "no failed attempt leaves a durable decision");
    const answers = after.trusted_checkpoint_answers ?? [];
    assert.ok(
      answers.every((candidate) => candidate.consumed_at === undefined),
      "rejected decisions never consume their answers",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Checkpoint suppression ───────────────────────────────────────────────────

test("forged, partial, and missing validation proofs never open a checkpoint or mutate state", () => {
  const cases: Array<[string, ((value: Record<string, unknown>) => void) | null]> = [
    ["forged constitution binding", (value) => {
      const constitution = value.constitution as Record<string, unknown>;
      constitution.binding = { ...(constitution.binding as Record<string, unknown>), validation_ref: "validation.forged" };
    }],
    ["partial validation envelope", (value) => { delete value.checks; }],
    ["missing validation artifact", null],
  ];
  for (const [label, mutate] of cases) {
    const root = makeProject();
    try {
      seedPhaseState(root);
      const validationPath = join(root, ".work-state", "features", FEATURE_ID, "artifacts", "validation.specify.v1.json");
      if (mutate === null) {
        rmSync(validationPath, { force: true });
      } else {
        const validation = JSON.parse(readFileSync(validationPath, "utf8")) as Record<string, unknown>;
        mutate(validation);
        writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");
      }
      const before = loadPersisted(root).state;
      const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
      assert.equal(presented.ok, false, `${label} must block checkpoint presentation`);
      if (!presented.ok) assert.equal(presented.code, "SPEC_CHECKPOINT_BLOCKED");
      const after = loadPersisted(root).state;
      assert.equal(digestOf(after), digestOf(before), `${label} must not mutate durable state`);
      assert.equal(specifyOf(after).checkpoint_ref, null, `${label} must not open a checkpoint`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a phase without a current passing validation result cannot open a checkpoint", () => {
  const blockedRoot = makeProject();
  try {
    // A failed validation leaves the phase in revision_required: no checkpoint.
    seedPhaseState(blockedRoot, specifyRecord({ status: "revision_required" }));
    const blocked = presentPhaseCheckpointContract(blockedRoot, { ...selector(), phase: "specify" });
    assert.equal(blocked.ok, false, "a phase with blocking validation findings has no checkpoint");
    if (!blocked.ok) assert.equal(blocked.code, "SPEC_CHECKPOINT_BLOCKED");

    const actor = recordPhaseAnswer(blockedRoot, "approve_continue", "phase-answer/blocked-attempt");
    const decided = runSelectedCheckpointDecisionContract(blockedRoot, decisionCall(actor, "approve_continue"));
    assert.equal(decided.ok, false, "no recorded answer can authorize a suppressed checkpoint");
    if (!decided.ok) assert.equal(decided.code, "SPEC_CHECKPOINT_UNKNOWN");
    const blockedState = loadPersisted(blockedRoot).state;
    assert.equal(typedDecisions(blockedState).length, 0);
    assert.equal(consumedAnswer(blockedState, "phase-answer/blocked-attempt")?.consumed_at, undefined);
  } finally {
    rmSync(blockedRoot, { recursive: true, force: true });
  }

  const unvalidatedRoot = makeProject();
  try {
    // Validation still running: no validation result exists at all.
    seedPhaseState(unvalidatedRoot, specifyRecord({ status: "validating", validationRef: null }));
    const unvalidated = presentPhaseCheckpointContract(unvalidatedRoot, { ...selector(), phase: "specify" });
    assert.equal(unvalidated.ok, false, "a phase without any validation result has no checkpoint");
  } finally {
    rmSync(unvalidatedRoot, { recursive: true, force: true });
  }

  const staleValidationRoot = makeProject();
  try {
    // The validation result is bound to a superseded artifact version.
    seedPhaseState(staleValidationRoot, specifyRecord({ validationRef: "validation.specify.v2" }));
    const stale = presentPhaseCheckpointContract(staleValidationRoot, { ...selector(), phase: "specify" });
    assert.equal(stale.ok, false, "a validation result must match the current artifact version to authorize a checkpoint");
    if (!stale.ok) assert.equal(stale.code, "SPEC_CHECKPOINT_BLOCKED");
  } finally {
    rmSync(staleValidationRoot, { recursive: true, force: true });
  }
});

test("checkpoint presentation rejects constitution drift at the final CAS and retries cleanly", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const before = loadPersisted(root).state;
    const original = readFileSync(join(root, "CONSTITUTION.md"), "utf8");
    let beforeCas = 0;
    setStateTransactionTestHooks({
      beforeCas: () => {
        beforeCas += 1;
        if (beforeCas === 1) writeFileSync(join(root, "CONSTITUTION.md"), original + "\nCAS drift\n", "utf8");
      },
    }, root);
    const rejected = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must reject presentation" : rejected.error);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_CHECKPOINT_BLOCKED");
    assert.equal(beforeCas, 1, "presentation guard must run at the final state CAS");
    const after = loadPersisted(root).state;
    assert.deepEqual(after, before, "rejected presentation must not open or mutate the checkpoint");
    setStateTransactionTestHooks(null, root);
    writeFileSync(join(root, "CONSTITUTION.md"), original, "utf8");
    const retried = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint decisions reject constitution drift at the final CAS without consuming proof", () => {
  const root = makeProject();
  try {
    seedPhaseState(root);
    const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
    assert.equal(presented.ok, true, presented.ok ? "" : presented.error);
    if (!presented.ok) return;
    const actor = recordPhaseAnswer(root, "approve_stop", "phase-answer/cas-drift");
    const before = loadPersisted(root).state;
    const original = readFileSync(join(root, "CONSTITUTION.md"), "utf8");
    let beforeCas = 0;
    setStateTransactionTestHooks({
      beforeCas: () => {
        beforeCas += 1;
        if (beforeCas === 1) writeFileSync(join(root, "CONSTITUTION.md"), original + "\nCAS drift\n", "utf8");
      },
    }, root);
    const rejected = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_stop"));
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must reject decision" : rejected.error);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_CHECKPOINT_BLOCKED");
    assert.equal(beforeCas, 1, "decision guard must run at the final state CAS");
    const after = loadPersisted(root).state;
    assert.deepEqual(after, before, "rejected decision must not consume proof or persist a decision");
    assert.equal(typedDecisions(after).length, 0);
    assert.equal(consumedAnswer(after, actor.ref)?.consumed_at, undefined);
    setStateTransactionTestHooks(null, root);
    writeFileSync(join(root, "CONSTITUTION.md"), original, "utf8");
    const retried = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_stop"));
    assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase decision replay is rejected when the validated postimage is stale or mismatched", () => {
  const mutations: ReadonlyArray<{ label: string; mutate: (state: TeamState) => TeamState; removeValidation?: boolean }> = [
    {
      label: "missing validation",
      removeValidation: true,
      mutate: (state) => state,
    },
    {
      label: "artifact version mismatch",
      mutate: (state) => ({
        ...state,
        specification: {
          ...state.specification!,
          phases: state.specification!.phases.map((phase) => phase.phase === "specify"
            ? { ...phase, current_version: 2, approved_version: 2, validation_ref: "validation.specify.v2", checkpoint_ref: "checkpoint.specify.v2" }
            : phase),
        },
      }),
    },
    {
      label: "checkpoint mismatch",
      mutate: (state) => ({
        ...state,
        specification: {
          ...state.specification!,
          phases: state.specification!.phases.map((phase) => phase.phase === "specify"
            ? { ...phase, checkpoint_ref: "checkpoint.specify.v2" }
            : phase),
        },
      }),
    },
    {
      label: "constitution mismatch",
      mutate: (state) => ({
        ...state,
        specification: {
          ...state.specification!,
          constitution_binding: { ...state.specification!.constitution_binding!, content_sha256: "f".repeat(64) },
        },
      }),
    },
  ];
  for (const mutation of mutations) {
    const root = makeProject();
    try {
      seedPhaseState(root);
      const presented = presentPhaseCheckpointContract(root, { ...selector(), phase: "specify" });
      assert.equal(presented.ok, true, `${mutation.label}: fixture checkpoint must open`);
      if (!presented.ok) continue;
      const actor = recordPhaseAnswer(root, "approve_continue", `phase-answer/replay/${mutation.label.replaceAll(" ", "-")}`);
      const approved = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_continue"));
      assert.equal(approved.ok, true, `${mutation.label}: initial approval must succeed`);
      if (!approved.ok) continue;
      const selected = loadPersisted(root);
      const mutated = mutation.mutate(selected.state);
      writeState(root, mutated, { target: selected.selected });
      if (mutation.removeValidation) unlinkSync(join(root, ".work-state", "features", FEATURE_ID, "artifacts", "validation.specify.v1.json"));
      const before = loadPersisted(root).state;
      const replay = runSelectedCheckpointDecisionContract(root, decisionCall(actor, "approve_continue"));
      assert.equal(replay.ok, false, `${mutation.label}: stale approval must not replay`);
      if (!replay.ok) assert.equal(replay.code, "SPEC_CHECKPOINT_UNKNOWN", `${mutation.label}: replay must report no open current checkpoint`);
      assert.deepEqual(loadPersisted(root).state, before, `${mutation.label}: stale replay must not mutate state`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
