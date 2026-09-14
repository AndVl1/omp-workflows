/**
 * Canonical versioned specification aggregate contracts (T012).
 *
 * These are the single canonical TypeScript shapes for the readable
 * specification workflow: one FeatureWorkspace aggregate, phase versions,
 * phase validation, checkpoint decisions, traceability, imports, the frozen
 * implementation handoff, exclusive execution claims, and the terminal
 * implementation-conformance result. Producers and consumers MUST use these
 * contracts exactly; no alternate aggregate, state machine, renderer, or
 * completion contract is permitted.
 *
 * The contracts extend the existing durable engine (`TeamState` embeds the
 * `FeatureWorkspace` additively); checkpoint decisions reuse the engine's
 * `TypedCheckpointDecision` and trusted answer ledger, and evidence
 * references reuse `CompletionArtifactRef` — there is no second identity,
 * decision, or artifact-ref vocabulary.
 */
import type {
  CompletionArtifactRef,
  TypedCheckpointDecision,
  WorkIdentity,
} from "../engine/types.js";

// ── Constitution records ─────────────────────────────────────────────────────

/** Exact constitution policy binding embedded in every validated artifact. */
export interface ConstitutionBinding {
  provider_id: string;
  /** Project-relative policy path, realpath-bounded to the authorized project. */
  path: string;
  /** Parsed semantic version label; never trusted without `content_sha256`. */
  version: string;
  /** SHA-256 of the exact bytes used for validation or approval. */
  content_sha256: string;
  /** SHA-256 of normalized policy sections; impact comparison only. */
  semantic_hash: string;
  /** Artifact id proving mandatory structure and unresolved-template checks. */
  validation_ref: string;
  /** Audit only; excluded from content hashes. */
  bound_at: string;
}

export type ConstitutionProviderSource =
  | "explicit_override"
  | "discovered_provider"
  | "native_default";

/** Immutable resolution result for the project policy location. */
export interface ConstitutionProviderSelection {
  provider_id: string;
  source: ConstitutionProviderSource;
  path: string;
  template_ref: string;
  template_hash: string;
  /** Binds provider id, path, template, configuration, discovery evidence. */
  selection_hash: string;
  selected_at: string;
}

export type ConstitutionUsabilityStatus =
  | "usable"
  | "missing"
  | "empty"
  | "unresolved_template"
  | "structurally_invalid";

export type ConstitutionGateStatus =
  | "checking"
  | "usable"
  | "constitution_required"
  | "awaiting_approval"
  | "approved"
  | "blocked";

export type ConstitutionOriginKind =
  | "native_direct"
  | "do_work_nested"
  | "cto_preparation"
  | "external_import";

/** Durable prerequisite record shared by native preparation and external intake. */
export interface ConstitutionGateRecord {
  gate_id: string;
  origin_kind: ConstitutionOriginKind;
  origin_run_key: string;
  origin_stage: string;
  status: ConstitutionGateStatus;
  usability_result: ConstitutionUsabilityStatus | null;
  provider: ConstitutionProviderSelection | null;
  constitution_workflow_ref: string | null;
  /** Required only when a generated or corrected constitution is approved. */
  checkpoint_ref: string | null;
  binding: ConstitutionBinding | null;
  /** Dispatch/idempotency marker consumed exactly once. */
  resume_marker: string | null;
}

export type ConstitutionImpactVerdict = "affected" | "no_impact";

/** Per-artifact verdict with mandatory evidence for both outcomes. */
export interface ConstitutionArtifactImpactResult {
  artifact_id: string;
  verdict: ConstitutionImpactVerdict;
  /** Section/rule/dependency references; required for affected AND no_impact. */
  evidence_refs: string[];
}

/** Typed semantic-impact assessment over the bound artifact set. */
export interface ConstitutionImpactAssessment {
  assessment_id: string;
  previous_binding: ConstitutionBinding;
  current_binding: ConstitutionBinding;
  evaluator_version: string;
  artifact_results: ConstitutionArtifactImpactResult[];
  status: "pass" | "blocked";
  assessed_at: string;
}

// ── Language and templates ───────────────────────────────────────────────────

export type LanguageSelectionSource =
  | "feature_override"
  | "project_default"
  | "request_language";

export interface LanguageSelection {
  language: string;
  source: LanguageSelectionSource;
  /** Bound into every affected phase version. */
  selection_hash: string;
}

export type TemplateSelectionSource =
  | "feature_override"
  | "project_default"
  | "shipped_default";

export interface TemplateSelection {
  template_set_id: string;
  source: TemplateSelectionSource;
  /** SHA-256 over the resolved template set content. */
  content_hash: string;
  /** Stable semantic markers independent of localized heading text. */
  required_markers: string[];
}

// ── FeatureWorkspace aggregate ───────────────────────────────────────────────

export type WorkspacePhase = "specify" | "plan" | "tasks";

export type WorkspacePhaseStatus =
  | "not_started"
  | "generating"
  | "materialized"
  | "validating"
  | "awaiting_approval"
  | "revision_required"
  | "approved"
  | "stale"
  | "blocked";

export type WorkspaceSourceKind = "native" | "external" | "legacy";

export type WorkspaceStatus =
  | "created"
  | "in_progress"
  | "implementation_ready"
  | "claimed"
  | "executing"
  | "completion_validating"
  | "completion_blocked"
  | "completed"
  | "blocked"
  | "stale";

export interface ProjectRootIdentity {
  /** Canonical absolute path captured together with the filesystem identity. */
  canonical_path: string;
  /** Device number from the pinned root descriptor. */
  dev: number;
  /** Inode number from the pinned root descriptor. */
  ino: number;
}

/** No-follow identity of one immutable project-relative directory. */
export interface WorkspacePathIdentity extends ProjectRootIdentity {
  /** Exact project-relative path represented by this identity. */
  relative_path: string;
}

/** Descendant bindings used to fence claim authority against directory swaps. */
export interface WorkspacePathBinding {
  specs: WorkspacePathIdentity;
  feature_state: WorkspacePathIdentity;
  artifacts: WorkspacePathIdentity;
  /** Claim storage is lazily initialized by claim admission. */
  execution_claim: WorkspacePathIdentity | null;
  execution_claim_next: WorkspacePathIdentity | null;
}

export interface WorkspaceUpstreamVersion {
  phase: WorkspacePhase;
  version: number;
  hash: string;
}

export interface WorkspacePhaseRecord {
  phase: WorkspacePhase;
  status: WorkspacePhaseStatus;
  current_version: number | null;
  approved_version: number | null;
  /** Required before `awaiting_approval` or `approved`. */
  validation_ref: string | null;
  /** Required when approved. */
  checkpoint_ref: string | null;
  upstream_versions: WorkspaceUpstreamVersion[];
  /** Required when `status=stale`. */
  stale_reason: string | null;
  /** Captured only from `request_changes`; supplied to the next phase worker. */
  last_feedback: string | null;
}

export type WorkspaceNextActionKind = "command" | "checkpoint" | "remediation" | "none";
export interface WorkspaceNextAction {
  kind: WorkspaceNextActionKind;
  command: string | null;
  reason: string;
}
export interface FeatureWorkspace {
  schema_version: 2 | 3;
  /** Immutable, safe single path segment, branch-independent. */
  feature_id: string;
  /** Human-readable; does not determine identity. */
  display_name: string;
  source_kind: WorkspaceSourceKind;
  /** Absolute, realpath-bounded authorized project root. */
  project_root: string;
  /** Physical root identity captured at workspace creation or authorized migration. */
  project_root_identity: ProjectRootIdentity;
  /** No-follow identities of workspace directories; claim storage is null until admission. */
  path_binding: WorkspacePathBinding;
  /** Exactly `specs/<feature-id>` (project-relative). */
  workspace_path: string;
  /** Exactly `.work-state/features/<feature-id>/state.json` (project-relative). */
  state_path: string;
  profile_name: string;
  profile_hash: string;
  /** Required before native Specify generation or external compatibility validation. */
  constitution_gate_ref: string | null;
  constitution_binding: ConstitutionBinding | null;
  language: LanguageSelection;
  template_set: TemplateSelection;
  phases: WorkspacePhaseRecord[];
  /** Derived from phase/import readiness; never independently trusted. */
  status: WorkspaceStatus;
  next_action: WorkspaceNextAction;
  handoff_ref: string | null;
  /** Transaction id while an acquire WAL is prepared; never claim authority. */
  execution_claim_prepare_ref: string | null;
  /** Committed claim id only. */
  execution_claim_ref: string | null;
  implementation_conformance_ref: string | null;
  /** Required when `source_kind=external`. */
  import_ref: string | null;
  /** Canonical migration receipt artifact id (migration-<24 lowercase hex>), required for legacy state. */
  migration_receipt_ref: string | null;
}

// ── Phase versions ───────────────────────────────────────────────────────────

export interface PhaseUpstreamVersionBinding {
  artifact_id: string;
  version: number;
  hash: string;
}

/**
 * Worker attribution embedded in a phase semantic model. The engine
 * WorkIdentity remains the capability record; this is the exact author of
 * the immutable model projection.
 */
export interface PhaseSemanticWorker {
  role: string;
  agent: string;
  dispatch_id: string;
}

/** Canonical readable section bodies for the Specify phase. */
export interface SpecifySemanticSections {
  problem: string;
  scope: string;
  non_goals: string;
  actors: string;
  journeys: string;
  requirements: string;
  edge_cases: string;
  assumptions: string;
  dependencies: string;
  success_criteria: string;
}

/** Canonical readable section bodies for the Plan phase. */
export interface PlanSemanticSections {
  repository_grounding: string;
  decisions: string;
  alternatives: string;
  contracts: string;
  data_flow: string;
  control_flow: string;
  migration: string;
  security: string;
  operations: string;
  verification_strategy: string;
  constitution_recheck: string;
}

/** Canonical readable section bodies for the Tasks phase. */
export interface TasksSemanticSections {
  task_graph: string;
  dependencies: string;
  expected_outcomes: string;
}

/** Complete requirement row retained in every immutable phase model. */
export interface PhaseSemanticRequirement {
  requirement_id: string;
  statement: string;
  acceptance_ids: string[];
  source_refs: string[];
  testable: boolean;
  untestable_reason: string | null;
}

/** Complete design-decision row retained in every immutable phase model. */
export interface PhaseSemanticDecision {
  decision_id: string;
  decision: string;
  rationale: string;
  requirement_ids: string[];
}

/** Complete implementation task row, including all execution flags/links. */
export interface PhaseSemanticTask {
  id: string;
  title: string;
  requirement_ids: string[];
  acceptance_ids: string[];
  decision_ids: string[];
  verification_ids: string[];
  depends_on: string[];
  expected_outcome: string;
  affected_scope: string[];
  completion_evidence: string[];
  parallel_safe: boolean;
}

/** Immutable pre-implementation verification obligation. */
export interface PhaseSemanticVerification {
  verification_id: string;
  requirement_ids: string[];
  acceptance_ids: string[];
  task_ids: string[];
  observable_behavior: boolean;
  expected_evidence: string;
}

/** Contradiction assessment is an authority field, not validator prose. */
export interface PhaseSemanticContradiction {
  contradiction_id: string;
  subject_ids: string[];
  status: "resolved" | "accepted" | "unresolved";
  assessment: string;
  evidence: string;
}

/** Constitution applicability and its exact binding are frozen per model. */
export interface PhaseSemanticConstitutionPrinciple {
  principle_id: string;
  /** NFC-normalized exact H2 title from the bound constitution artifact. */
  title: string;
  applicability: "applicable" | "not_applicable";
  status: "pass" | "fail" | "not_applicable";
  evidence: string;
  binding: ConstitutionBinding;
}

/** Fields common to the three complete phase semantic models. */
export interface PhaseSemanticModelBase {
  schema_version: 1;
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  version: number;
  worker: PhaseSemanticWorker;
  constitution_binding: ConstitutionBinding;
  upstream_versions: PhaseUpstreamVersionBinding[];
  requirements: PhaseSemanticRequirement[];
  decisions: PhaseSemanticDecision[];
  tasks: PhaseSemanticTask[];
  verification: PhaseSemanticVerification[];
  contradictions: PhaseSemanticContradiction[];
  constitution_principles: PhaseSemanticConstitutionPrinciple[];
}

export interface SpecifySemanticModel extends PhaseSemanticModelBase {
  phase: "specify";
  sections: SpecifySemanticSections;
}

export interface PlanSemanticModel extends PhaseSemanticModelBase {
  phase: "plan";
  sections: PlanSemanticSections;
}

export interface TasksSemanticModel extends PhaseSemanticModelBase {
  phase: "tasks";
  sections: TasksSemanticSections;
}

/** Union consumed by the canonical renderer and immutable phase envelope. */
export type SpecificationSemanticModel = SpecifySemanticModel | PlanSemanticModel | TasksSemanticModel;

/**
 * Immutable content/provenance for one phase revision. Versioned ids such as
 * `specify.v2` are never overwritten; replaced readable projections move to
 * `history/` before the new projection becomes current.
 */
export interface PhaseArtifactVersion {
  artifact_id: string;
  phase: WorkspacePhase;
  version: number;
  /** Proves which subagent dispatch produced the content. */
  dispatch_id: string;
  work_identity: WorkIdentity;
  /** SHA-256 of canonical typed worker output. */
  source_artifact_hash: string;
  /**
   * Complete engine-bound semantic model copied from the worker source
   * artifact. Validation reports are observations against this value; they
   * cannot add, remove, or reinterpret its obligations.
   */
  semantic_model: SpecificationSemanticModel;
  /** All paths remain inside the feature workspace. */
  document_paths: string[];
  /** path → SHA-256; detects manual edits or materialization drift. */
  document_hashes: Record<string, string>;
  /** Stable marker → SHA-256; presentation-only impact evidence. */
  semantic_section_hashes: Record<string, string>;
  template_hash: string;
  language_hash: string;
  upstream_versions: PhaseUpstreamVersionBinding[];
  /** Audit only; excluded from deterministic content hashes. */
  created_at: string;
  constitution_binding: ConstitutionBinding;
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ValidationCheckStatus = "pass" | "fail" | "warning";

export interface ValidationCheck {
  check_id: string;
  status: ValidationCheckStatus;
  evidence: string;
  /** Actionable remediation; required when status is not `pass`. */
  remediation: string | null;
}

export type ValidationFindingSeverity = "blocking" | "warning";

export interface ValidationFinding {
  code: string;
  severity: ValidationFindingSeverity;
  subject_id: string | null;
  message: string;
  evidence_refs: string[];
  remediation: string | null;
}

export interface ConstitutionPrincipleResult {
  principle_id: string;
  status: "pass" | "fail" | "not_applicable";
  evidence: string;
}

export interface TraceabilitySummary {
  requirements_total: number;
  requirements_with_acceptance: number;
  decisions_linked: number;
  tasks_linked: number;
  verification_linked: number;
  missing_ids: string[];
}

/**
 * Readable and machine-readable phase validation bound to one artifact
 * version. Only `pass` permits `awaiting_approval`; a checkpoint is
 * impossible before a current passing validation result exists.
 */
export interface PhaseValidationResult {
  validation_id: string;
  phase: WorkspacePhase;
  /** Must match the current artifact to authorize a checkpoint. */
  artifact_version: string;
  status: "pass" | "fail";
  checks: ValidationCheck[];
  /** Empty when status is `pass`. */
  blocking_findings: ValidationFinding[];
  warnings: ValidationFinding[];
  /** Per-principle result plus the exact binding used. */
  constitution: {
    binding: ConstitutionBinding;
    principles: ConstitutionPrincipleResult[];
  };
  /** Required after Plan and Tasks. */
  traceability_summary: TraceabilitySummary | null;
  /** Digest of the exact immutable phase artifact validated by this result. */
  artifact_digest?: string;
  validator_version: string;
  validated_at: string;
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

/**
 * The existing engine typed checkpoint record is reused for specification
 * decisions — bound to run, stage, checkpoint, work identity, capability
 * id/epoch, policy hash, human actor provenance, and the trusted
 * terminal/escalation answer proof.
 */
export type SpecificationCheckpointDecision = TypedCheckpointDecision;

/** Constitution bootstrap allows exactly these two decisions. */
export type ConstitutionCheckpointDecision = "approve_continue" | "request_changes";

/** Regular specification phases allow exactly these three decisions. */
export type PhaseCheckpointDecision = "approve_continue" | "request_changes" | "approve_stop";

// ── Traceability and tasks ───────────────────────────────────────────────────

/** Requirement traceability link; completeness gates handoff readiness. */
export interface TraceabilityLink {
  requirement_id: string;
  /** At least one per functional requirement. */
  acceptance_ids: string[];
  /** At least one relevant Plan decision before readiness. */
  decision_ids: string[];
  /** At least one before readiness. */
  task_ids: string[];
  /** Pre-implementation obligations; each declares observable behavior. */
  verification_ids: string[];
  /** Required for imported material and supplements. */
  source_refs: string[];
}

/** CTO mapping link binding one requirement to its tasks, verifications, and evidence. */
export interface CtoRequirementTaskEvidenceLink {
  feature_id: string;
  requirement_id: string;
  task_ids: string[];
  verification_ids: string[];
  evidence_refs: string[];
}

/** Normalized canonical task node used by both executors. */
export interface ImplementationTask {
  task_id: string;
  title: string;
  requirement_ids: string[];
  /** No self-reference, dangling id, or cycle. */
  depends_on: string[];
  expected_outcome: string;
  affected_scope: string[];
  completion_evidence: string[];
  parallel_safe: boolean;
}

// ── Implementation handoff ───────────────────────────────────────────────────

export type HandoffArtifactKind = "specify" | "plan" | "tasks" | "import_snapshot" | "supplement";

export interface HandoffArtifactVersion {
  artifact_id: string;
  kind: HandoffArtifactKind;
  version: number;
  sha256: string;
}

export interface HandoffRequirement {
  requirement_id: string;
  statement: string;
  acceptance_ids: string[];
  source_refs: string[];
}

export interface HandoffDecision {
  decision_id: string;
  decision: string;
  rationale: string;
  requirement_ids: string[];
}

export interface HandoffVerification {
  verification_id: string;
  requirement_ids: string[];
  acceptance_ids: string[];
  task_ids: string[];
  /** Terminal conformance requires executed-test evidence when true. */
  observable_behavior: boolean;
  expected_evidence: string;
}

export type HandoffStatus = "candidate" | "ready" | "stale";

export type ExecutionChoice = "do-work" | "cto";

/** Provenance carried with imported text; it can never authorize execution. */
export interface ImportedContentProvenance {
  source_kind: "external";
  content_role: "untrusted_inert_data";
  embedded_instruction_policy: "inert_data_only";
  source_refs: string[];
}

/** Frozen executor-neutral implementation contract. */
export interface ImplementationHandoff {
  schema_version: 1;
  handoff_id: string;
  /** SHA-256; immutable and content-addressed. */
  handoff_digest: string;
  feature_id: string;
  source_kind: WorkspaceSourceKind;
  /** Required for external handoffs; all imported fields remain inert data. */
  content_provenance?: ImportedContentProvenance;
  artifact_versions: HandoffArtifactVersion[];
  scope: { in_scope: string[]; out_of_scope: string[]; constraints: string[] };
  requirements: HandoffRequirement[];
  decisions: HandoffDecision[];
  /** Valid acyclic task graph; the only canonical implementation task source. */
  tasks: ImplementationTask[];
  verification: HandoffVerification[];
  validation_refs: string[];
  approval_refs: string[];
  language: string;
  constitution_binding: ConstitutionBinding;
  constitution_impact_ref: string | null;
  risks: string[];
  /** Open blocking decisions must be empty when ready. */
  open_decisions: string[];
  execution_choices: ExecutionChoice[];
  status: HandoffStatus;
  import_snapshot_ref: string | null;
  compatibility_supplement_ref: string | null;
  /** Selected external provider identity is retained for filesystem revalidation. */
  import_framework?: string;
  import_mapping_id?: string;
  import_mapping_version?: string;
  import_selected_paths?: string[];
  import_ignored_candidates?: Array<{ path: string; reason: string }>;
  /** Exact source-intake roots/paths used to discover the frozen snapshot. */
  import_intake_paths?: string[];
  /** Exact captured source language/provenance and revision for filesystem replay. */
  import_document_language?: string;
  import_document_language_source?: "explicit" | "metadata" | "unknown";
  import_source_revision?: string | null;
  /** Exact normalized import ceilings bound to the persisted snapshot. */
  import_limits?: ImportSnapshotLimits;
}

/** Immutable CTO-side binding to one frozen handoff version; digest-addressed. */
export interface CtoHandoffBinding {
  feature_id: string;
  handoff_id: string;
  /** SHA-256 copied from the frozen handoff; never recomputed or replaced. */
  handoff_digest: string;
  /** Exact artifact versions frozen in the bound handoff. */
  artifact_versions: HandoffArtifactVersion[];
}

/** Additive alias for the canonical CTO handoff binding. */
export type SpecificationHandoffBinding = CtoHandoffBinding;

/** Additive alias for the canonical CTO handoff binding. */
export type CtoSpecificationHandoffBinding = CtoHandoffBinding;

// ── Execution claims ─────────────────────────────────────────────────────────

export type ExecutionClaimOwnerKind = "do_work" | "cto";

export type ExecutionClaimStatus = "active" | "completed" | "released" | "blocked";

/** Exact CTO control-plane image fenced into claim admission CAS. */
export interface ExecutionClaimAdmissionBinding {
  mapping_record_path: string;
  mapping_record_digest: string;
  mapping_id: string;
  mapping_hash: string;
  mapping_version: number;
  /** CTO mapping-state revision captured from the confirmation anchor. */
  confirmation_state_revision: number;
  /** Exact post-claim feature workspace state revision for this feature. */
  feature_state_revision: number;
  confirmation_state_digest: string;
  confirmation_authorization_digest: string;
  confirmation_ledger_digest: string;
  checkpoint_ref: string;
  trusted_answer_ref: string;
  stage_id: string;
  policy_hash: string;
  wave_id: string;
  capability_id: string;
  capability_epoch: string;
}

/** Exclusive ownership of one ready handoff version, keyed by handoff digest. */
export interface ExecutionClaim {
  claim_id: string;
  handoff_digest: string;
  owner_kind: ExecutionClaimOwnerKind;
  owner_run_id: string;
  status: ExecutionClaimStatus;
  acquired_at: string;
  updated_at: string;
  /** Required for release/block. */
  release_reason: string | null;
  /** CTO-only exact mapping/confirmation image used by the admission CAS. */
  admission_binding?: ExecutionClaimAdmissionBinding;
}

export type ClaimDisposition = "created" | "replayed";

export interface ClaimJournalManifest {
  schema: 2;
  feature_id: string;
  project_root_identity: ProjectRootIdentity;
  workspace_path_binding_digest: string;
  claim_directory_identity: WorkspacePathIdentity;
  next_directory_identity: WorkspacePathIdentity;
  journal_format: "legacy-chain-v1+wal-v2";
  legacy_tail_digest: string | null;
}

export interface AcquireClaimPreparedWal {
  schema: 1;
  operation: "acquire_prepared";
  transaction_id: string;
  claim: ExecutionClaim;
  feature_id: string;
  run_key: string;
  handoff_ref: string;
  expected_workspace_digest: string;
  previous_digest: string | null;
  workspace_path_binding_digest: string;
  project_root_identity: ProjectRootIdentity;
  path_binding: WorkspacePathBinding;
  created_at: string;
}

export interface CompleteClaimPreparedWal {
  schema: 1;
  operation: "complete_prepared";
  transaction_id: string;
  claim: ExecutionClaim;
  conformance_ref: string;
  conformance_artifact_digest: string;
  matrix_digest: string;
  expected_workspace_digest: string;
  completed_workspace_digest: string;
  workspace_path_binding_digest: string;
  project_root_identity: ProjectRootIdentity;
  path_binding: WorkspacePathBinding;
  created_at: string;
}

export type ClaimPreparedWal = AcquireClaimPreparedWal | CompleteClaimPreparedWal;

export interface ClaimJournalEnvelopeV2 {
  schema: 2;
  transaction_id: string;
  operation: "active" | "completed";
  previous_digest: string | null;
  claim: ExecutionClaim;
}

// ── Implementation conformance ───────────────────────────────────────────────

export interface ConformanceFinding {
  code: string;
  subject_id: string | null;
  message: string;
  evidence_refs: string[];
}

export type ExecutedTestKind = "unit" | "integration" | "e2e" | "runtime";

export interface ExecutedTestEvidence {
  evidence_ref: CompletionArtifactRef;
  test_kind: ExecutedTestKind;
  status: "pass" | "fail";
  executed_at: string;
}

export type ClosureSubjectKind = "requirement" | "acceptance_scenario";

/** One immutable matrix row for an approved requirement or acceptance scenario. */
export interface RequirementClosureEntry {
  entry_id: string;
  subject_kind: ClosureSubjectKind;
  subject_id: string;
  /** Self for a requirement row; owning requirement for an acceptance row. */
  requirement_id: string;
  /** Copied from the frozen verification obligations, never inferred. */
  observable_behavior: boolean;
  implementation_evidence_refs: CompletionArtifactRef[];
  review_verdict: "pass" | "fail" | "missing";
  review_evidence_refs: CompletionArtifactRef[];
  test_evidence: ExecutedTestEvidence[];
  status: "pass" | "blocked" | "changed_intent";
  findings: ConformanceFinding[];
}

export type QualityGateSource = "project_constitution" | "execution_profile";

export interface QualityGateResult {
  gate_id: string;
  source: QualityGateSource;
  status: "pass" | "fail";
  evidence_refs: CompletionArtifactRef[];
  findings: ConformanceFinding[];
}

export type ConformanceOverallStatus = "pass" | "blocked" | "changed_intent";

export type ConformanceNextAction =
  | "complete_feature"
  | "repair_implementation"
  | "repeat_review"
  | "repeat_tests"
  | "repair_quality_gate"
  | "revise_specification";

/**
 * The executor-neutral requirement-closure matrix that gates terminal
 * feature completion. Derived from the frozen handoff; executors can submit
 * evidence but cannot add, remove, reinterpret, or waive rows.
 */
export interface ImplementationConformanceResult {
  schema_version: "1.0";
  conformance_id: string;
  /** SHA-256; immutable, content-addressed, idempotent for the same inputs. */
  matrix_digest: string;
  feature_id: string;
  handoff_id: string;
  handoff_digest: string;
  execution_claim_id: string;
  execution_owner: ExecutionClaimOwnerKind;
  execution_run_id: string;
  profile_hash: string;
  evaluated_at: string;
  entries: RequirementClosureEntry[];
  quality_gate_results: QualityGateResult[];
  overall_status: ConformanceOverallStatus;
  blocking_findings: ConformanceFinding[];
  next_action: ConformanceNextAction;
}

// ── Import contracts ─────────────────────────────────────────────────────────

export type RecognitionConfidence = "high" | "medium" | "low" | "ambiguous";

/** One deterministic role assigned to a captured source document. */
export type ImportedDocumentRole = "requirements" | "decisions" | "tasks";

/** Declarative source-root-relative role mapping emitted by a recognizer. */
export interface ImportedDocumentRoleMapping {
  source_ref: string;
  role: ImportedDocumentRole;
}

/** Format recognition is advisory and never changes gates. */
export interface FormatRecognitionResult {
  framework: string;
  confidence: RecognitionConfidence;
  /** Immutable source-root-relative references captured by the secure importer. */
  selected_paths: string[];
  ignored_candidates: Array<{ path: string; reason: string }>;
  mapping_id: string;
  mapping_version: string;
}
export interface ImportFileRecord {
  path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
}

/**
 * Normalized import ceilings persisted with every newly-created snapshot.
 * Legacy snapshots may omit this field and are replayed with the documented
 * runtime defaults; a present object is always authenticated by snapshot and
 * handoff content digests.
 */
export interface ImportSnapshotLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxTextBytes: number;
  maxBinaryBytes: number;
  maxDirectoryEntries: number;
  maxHeadings: number;
  maxRequirements: number;
  maxTasks: number;
  maxDecisions: number;
  maxDependencies: number;
  maxMappings: number;
  maxFindings: number;
  maxWork: number;
}

/** Exact physical identity of the canonical authorized source root. */
export interface ImportRootIdentity {
  canonical_path: string;
  dev: number;
  ino: number;
  mode: number;
}

/** Immutable normalization of exact external sources; sources stay read-only. */
export interface ImportSnapshot {
  snapshot_id: string;
  source_root: string;
  source_root_identity: ImportRootIdentity;
  /** Exact normalized ceilings used to capture/replay this snapshot. */
  limits?: ImportSnapshotLimits;
  /** Original explicit intake paths, canonicalized relative to source_root. */
  intake_paths: string[];
  recognition_ref: string;
  /** Selected provider identity and exact source projection. */
  framework: string;
  mapping_id: string;
  mapping_version: string;
  selected_paths: string[];
  ignored_candidates: Array<{ path: string; reason: string }>;
  files: ImportFileRecord[];
  /** Git revision or null; per-file hashes remain authoritative. */
  source_revision: string | null;
  /** Canonical BCP 47 language and its bounded provenance. */
  document_language: string;
  document_language_source: "explicit" | "metadata" | "unknown";
  redactions: Array<{ path: string; reason: string }>;
  /** Typed artifact id; content is treated as data, not instructions. */
  normalized_content_ref: string;
  created_at: string;
}

export type CompatibilityStatus = "ready" | "supplement_required" | "blocked" | "unsupported";

export interface CompatibilityReport {
  report_id: string;
  snapshot_ref: string;
  constitution_binding: ConstitutionBinding;
  document_language: string;
  document_language_source: "explicit" | "metadata" | "unknown";
  status: CompatibilityStatus;
  /** Provider identity is part of the immutable compatibility decision. */
  framework: string;
  mapping_id: string;
  mapping_version: string;
  selected_paths: string[];
  mapping: Array<{ source_ref: string; contract_subject: string; subject_id: string | null }>;
  blocking_findings: ConformanceFinding[];
  warnings: ConformanceFinding[];
  ignored_content: Array<{ path: string; reason: string }>;
  supplement_ref: string | null;
  evaluated_at: string;
}

/** Canonical semantic row supplied by an approved local supplement. */
export interface CompatibilitySemanticRow {
  contract_subject: "requirement" | "decision" | "task";
  subject_id: string;
  statement: string;
  source_refs: string[];
  requirement_ids: string[];
  acceptance_ids: string[];
  depends_on: string[];
  rationale: string;
  expected_outcome: string;
  affected_scope: string[];
  completion_evidence: string[];
}

/** Local, versioned supplement; never alters or impersonates external content. */
export interface CompatibilitySupplement {
  schema_version: 1;
  supplement_id: string;
  feature_id: string;
  snapshot_id: string;
  snapshot_ref: string;
  source_sha256: string;
  framework: string;
  mapping_id: string;
  mapping_version: string;
  semantic_rows: CompatibilitySemanticRow[];
  sections: Array<{
    title: string;
    missing_or_conflict: string;
    source_refs: string[];
  }>;
  approved_by_ref: string;
  approved_at: string;
  content_sha256: string;
}
