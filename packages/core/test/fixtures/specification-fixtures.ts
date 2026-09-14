/**
 * Deterministic specification-aggregate fixtures (T001).
 *
 * Valid and invalid builders for the five canonical aggregate input families:
 *   - FeatureWorkspace            (contracts/feature-workspace.schema.json)
 *   - ConstitutionBinding         (data-model.md / embedded binding shape)
 *   - ImplementationHandoff       (contracts/implementation-handoff.schema.json)
 *   - ExecutionClaim              (data-model.md)
 *   - ImplementationConformanceResult (contracts/implementation-conformance.schema.json)
 *
 * These are test-data builders only. They mirror the canonical contract
 * schemas structurally and import nothing from `src`, so contract tests and
 * story slices can load them before and after the shared-contract
 * implementation (T008–T022) lands. Every digest field is a real SHA-256 of a
 * deterministic input; every timestamp is the fixed constant below. Tests
 * that need fail-closed inputs iterate the INVALID_*_CASES families.
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { digestOf as canonicalDigestOf } from "../../src/specification/validation.js";
import { loadProfile, profileHash } from "../../src/engine/profile.js";

/** Fixed clock for every fixture (audit timestamps are never semantic). */
export const FIXED_NOW = "2026-08-31T12:00:00.000Z";

/** Fixed authorized project root used by all fixture paths. */
export const FIXED_PROJECT_ROOT = realpathSync(process.cwd());

function rootIdentity(root: string): { canonical_path: string; dev: number; ino: number } {
  const canonicalPath = realpathSync(root);
  const info = statSync(canonicalPath);
  return { canonical_path: canonicalPath, dev: info.dev, ino: info.ino };
}

export const FIXED_FEATURE_ID = "feature-one";

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Exact hash of the currently registered specification preparation profile. */
export function specPreparationProfileHash(): string {
  const profile = loadProfile("spec-preparation");
  if (!profile) throw new Error("spec-preparation profile fixture is unavailable");
  return profileHash(profile);
}

/** Deterministic digest over the canonical JSON of a value. */
export function digestOf(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/** Feature ids that must fail safe-path validation everywhere. */
export const UNSAFE_FEATURE_IDS: readonly string[] = [
  "../escape",
  "a/b",
  "a\\b",
  "/absolute",
  ".",
  "..",
  "",
  " ",
  "feature\nid",
  "feature id",
  `${"x".repeat(129)}`,
] as const;

// ── ConstitutionBinding ──────────────────────────────────────────────────────

export interface ConstitutionBindingRecord {
  provider_id: string;
  path: string;
  version: string;
  content_sha256: string;
  semantic_hash: string;
  validation_ref: string;
  bound_at: string;
}

/** The single canonical usable binding every workspace/handoff embeds. */
export function validConstitutionBinding(
  overrides: Partial<ConstitutionBindingRecord> = {},
): ConstitutionBindingRecord {
  const content = "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n";
  return {
    provider_id: "native",
    path: "CONSTITUTION.md",
    version: "1.0.0",
    content_sha256: sha256(content),
    semantic_hash: sha256(content.replace(/\s+/g, " ").trim()),
    validation_ref: "constitution.validation.v1",
    bound_at: FIXED_NOW,
    ...overrides,
  };
}

export const INVALID_CONSTITUTION_BINDING_CASES: Readonly<Record<string, unknown>> = {
  missing_content_fingerprint: (() => {
    const binding = structuredClone(validConstitutionBinding());
    delete (binding as Partial<ConstitutionBindingRecord>).content_sha256;
    return binding;
  })(),
  version_label_without_fingerprint_match: validConstitutionBinding({
    version: "2.0.0",
    content_sha256: sha256("# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n"),
  }),
  malformed_sha256: validConstitutionBinding({ content_sha256: "not-a-digest" }),
  empty_provider_id: validConstitutionBinding({ provider_id: "" }),
  unsafe_binding_path: validConstitutionBinding({ path: "../../etc/constitution.md" }),
  missing_validation_ref: (() => {
    const binding = structuredClone(validConstitutionBinding());
    delete (binding as Partial<ConstitutionBindingRecord>).validation_ref;
    return binding;
  })(),
};

// ── FeatureWorkspace ─────────────────────────────────────────────────────────

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

export interface WorkspaceUpstreamVersionRecord {
  phase: "specify" | "plan" | "tasks";
  version: number;
  hash: string;
}

export interface WorkspacePhaseRecord {
  phase: "specify" | "plan" | "tasks";
  status: WorkspacePhaseStatus;
  current_version: number | null;
  approved_version: number | null;
  validation_ref: string | null;
  checkpoint_ref: string | null;
  upstream_versions: WorkspaceUpstreamVersionRecord[];
  stale_reason: string | null;
  last_feedback: string | null;
}

export interface WorkspaceLanguageSelectionRecord {
  language: string;
  source: "feature_override" | "project_default" | "request_language";
  selection_hash: string;
}

export interface WorkspaceTemplateSelectionRecord {
  template_set_id: string;
  source: "feature_override" | "project_default" | "shipped_default";
  content_hash: string;
  required_markers: string[];
}

export interface WorkspaceNextActionRecord {
  kind: "command" | "checkpoint" | "remediation" | "none";
  command: string | null;
  reason: string;
}

export interface FeatureWorkspaceRecord {
  schema_version: number;
  feature_id: string;
  display_name: string;
  source_kind: "native" | "external" | "legacy";
  project_root: string;
  project_root_identity: { canonical_path: string; dev: number; ino: number };
  workspace_path: string;
  state_path: string;
  profile_name: string;
  profile_hash: string;
  constitution_gate_ref: string | null;
  constitution_binding: ConstitutionBindingRecord | null;
  language: WorkspaceLanguageSelectionRecord;
  template_set: WorkspaceTemplateSelectionRecord;
  phases: WorkspacePhaseRecord[];
  status: WorkspaceStatus;
  next_action: WorkspaceNextActionRecord;
}

export interface ValidWorkspaceOptions {
  featureId?: string;
  sourceKind?: FeatureWorkspaceRecord["source_kind"];
  status?: WorkspaceStatus;
  constitutionBinding?: ConstitutionBindingRecord | null;
  projectRoot?: string;
  projectRootIdentity?: { canonical_path: string; dev: number; ino: number };
  withApprovedSpecify?: boolean;
}

/** A canonical in-progress native workspace (Specify approved, Plan current). */
export function validFeatureWorkspace(options: ValidWorkspaceOptions = {}): FeatureWorkspaceRecord {
  const featureId = options.featureId ?? FIXED_FEATURE_ID;
  const projectRoot = options.projectRoot ?? FIXED_PROJECT_ROOT;
  const binding = options.constitutionBinding === undefined
    ? validConstitutionBinding()
    : options.constitutionBinding;
  const specify: WorkspacePhaseRecord = {
    phase: "specify",
    status: options.withApprovedSpecify ? "approved" : "awaiting_approval",
    current_version: 1,
    approved_version: options.withApprovedSpecify ? 1 : null,
    validation_ref: "validation.specify.v1",
    checkpoint_ref: options.withApprovedSpecify ? "checkpoint.specify.v1" : null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  };
  const plan: WorkspacePhaseRecord = {
    phase: "plan",
    status: "not_started",
    current_version: null,
    approved_version: null,
    validation_ref: null,
    checkpoint_ref: null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  };
  const tasks: WorkspacePhaseRecord = {
    phase: "tasks",
    status: "not_started",
    current_version: null,
    approved_version: null,
    validation_ref: null,
    checkpoint_ref: null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  };
  return {
    schema_version: 2,
    feature_id: featureId,
    display_name: "Feature One",
    source_kind: options.sourceKind ?? "native",
    project_root: projectRoot,
    project_root_identity: options.projectRootIdentity ?? rootIdentity(projectRoot),
    workspace_path: `specs/${featureId}`,
    state_path: `.work-state/features/${featureId}/state.json`,
    profile_name: "spec-preparation",
    profile_hash: specPreparationProfileHash(),
    constitution_gate_ref: "constitution.gate.v1",
    constitution_binding: binding,
    language: {
      language: "en-US",
      source: "project_default",
      selection_hash: sha256("lang:en-US"),
    },
    template_set: {
      template_set_id: "specification-default",
      source: "shipped_default",
      content_hash: sha256("template-set:specification-default"),
      required_markers: ["## Problem", "## Requirements", "## Success Criteria"],
    },
    phases: [specify, plan, tasks],
    status: options.status ?? "in_progress",
    next_action: {
      kind: "checkpoint",
      command: null,
      reason: "Specify validation passed; the hard-human checkpoint is open.",
    },
    handoff_ref: null,
    execution_claim_ref: null,
    implementation_conformance_ref: null,
    import_ref: null,
    migration_receipt_ref: null,
  };
}

/** Bind a fixture to the real canonical identity of a temporary project root. */
export function bindFeatureWorkspaceToRoot<T extends { project_root: string; project_root_identity: { canonical_path: string; dev: number; ino: number } }>(
  workspace: T,
  root: string,
): T {
  const identity = rootIdentity(root);
  workspace.project_root = identity.canonical_path;
  workspace.project_root_identity = identity;
  return workspace;
}

export const INVALID_FEATURE_WORKSPACE_CASES: Readonly<Record<string, unknown>> = {
  unsafe_feature_id: validFeatureWorkspace({ featureId: "../escape" as string }),
  path_mismatch_with_identity: (() => {
    const workspace = validFeatureWorkspace({ featureId: "feature-two" });
    workspace.workspace_path = "specs/feature-one";
    return workspace;
  })(),
  state_path_outside_work_state: (() => {
    const workspace = validFeatureWorkspace();
    workspace.state_path = "somewhere-else/feature-one/state.json";
    return workspace;
  })(),
  unknown_source_kind: (() => {
    const workspace = validFeatureWorkspace();
    (workspace as unknown as Record<string, unknown>).source_kind = "scraped";
    return workspace;
  })(),
  unknown_workspace_status: (() => {
    const workspace = validFeatureWorkspace();
    (workspace as unknown as Record<string, unknown>).status = "almost_done";
    return workspace;
  })(),
  unknown_phase_status: (() => {
    const workspace = validFeatureWorkspace();
    (workspace.phases[0] as WorkspacePhaseRecord).status = "review_pending" as WorkspacePhaseStatus;
    return workspace;
  })(),
  approval_without_validation: (() => {
    const workspace = validFeatureWorkspace({ withApprovedSpecify: true });
    workspace.phases[0]!.validation_ref = null;
    return workspace;
  })(),
  missing_next_action_reason: (() => {
    const workspace = validFeatureWorkspace();
    (workspace.next_action as Partial<WorkspaceNextActionRecord>).reason = "";
    return workspace;
  })(),
  binding_that_misses_fingerprint: validFeatureWorkspace({
    constitutionBinding: validConstitutionBinding({ content_sha256: "short" }),
  }),
  missing_required_field: (() => {
    const workspace = validFeatureWorkspace();
    delete (workspace as Partial<FeatureWorkspaceRecord>).profile_hash;
    return workspace;
  })(),
};

// ── ImplementationHandoff ────────────────────────────────────────────────────

export interface HandoffArtifactVersionRecord {
  artifact_id: string;
  kind: "specify" | "plan" | "tasks" | "import_snapshot" | "supplement";
  version: number;
  sha256: string;
}

export interface HandoffRequirementRecord {
  requirement_id: string;
  statement: string;
  acceptance_ids: string[];
  source_refs: string[];
}

export interface HandoffDecisionRecord {
  decision_id: string;
  decision: string;
  rationale: string;
  requirement_ids: string[];
}

export interface HandoffTaskRecord {
  task_id: string;
  title: string;
  requirement_ids: string[];
  depends_on: string[];
  expected_outcome: string;
  affected_scope: string[];
  completion_evidence: string[];
  parallel_safe: boolean;
}

export interface HandoffVerificationRecord {
  verification_id: string;
  requirement_ids: string[];
  acceptance_ids: string[];
  task_ids: string[];
  observable_behavior: boolean;
  expected_evidence: string;
}

export interface ImplementationHandoffRecord {
  schema_version: number;
  handoff_id: string;
  handoff_digest: string;
  feature_id: string;
  source_kind: "native" | "external" | "legacy";
  content_provenance?: {
    source_kind: "external";
    content_role: "untrusted_inert_data";
    embedded_instruction_policy: "inert_data_only";
    source_refs: string[];
  };
  artifact_versions: HandoffArtifactVersionRecord[];
  scope: { in_scope: string[]; out_of_scope: string[]; constraints: string[] };
  requirements: HandoffRequirementRecord[];
  decisions: HandoffDecisionRecord[];
  tasks: HandoffTaskRecord[];
  verification: HandoffVerificationRecord[];
  validation_refs: string[];
  approval_refs: string[];
  language: string;
  constitution_binding: ConstitutionBindingRecord;
  constitution_impact_ref: string | null;
  risks: string[];
  open_decisions: string[];
  execution_choices: Array<"do-work" | "cto">;
  status: "candidate" | "ready" | "stale";
  import_snapshot_ref: string | null;
  compatibility_supplement_ref: string | null;
  import_framework?: string;
  import_mapping_id?: string;
  import_mapping_version?: string;
  import_selected_paths?: string[];
  import_ignored_candidates?: Array<{ path: string; reason: string }>;
  import_intake_paths?: string[];
  import_document_language?: string;
  import_document_language_source?: "explicit" | "metadata" | "unknown";
  import_source_revision?: string | null;
}

export interface ValidHandoffOptions {
  featureId?: string;
  status?: ImplementationHandoffRecord["status"];
  observableBehavior?: boolean;
}

/** A ready handoff with complete requirement → acceptance → decision → task → verification links. */
export function validImplementationHandoff(options: ValidHandoffOptions = {}): ImplementationHandoffRecord {
  const featureId = options.featureId ?? FIXED_FEATURE_ID;
  const observable = options.observableBehavior ?? true;
  const requirements: HandoffRequirementRecord[] = [
    {
      requirement_id: "FR-1",
      statement: "The tool completes the requested outcome.",
      acceptance_ids: ["AC-1"],
      source_refs: ["specs/feature-one/spec.md#requirements"],
    },
  ];
  const decisions: HandoffDecisionRecord[] = [
    {
      decision_id: "D-1",
      decision: "Use the existing durable engine for state.",
      rationale: "One engine; no second state machine.",
      requirement_ids: ["FR-1"],
    },
  ];
  const tasks: HandoffTaskRecord[] = [
    {
      task_id: "T-1",
      title: "Implement the outcome",
      requirement_ids: ["FR-1"],
      depends_on: [],
      expected_outcome: "The requested outcome is observable.",
      affected_scope: ["src/feature.ts"],
      completion_evidence: ["focused test run proving the outcome"],
      parallel_safe: false,
    },
  ];
  const verification: HandoffVerificationRecord[] = [
    {
      verification_id: "V-1",
      requirement_ids: ["FR-1"],
      acceptance_ids: ["AC-1"],
      task_ids: ["T-1"],
      observable_behavior: observable,
      expected_evidence: "executed runtime evidence for the observable behavior",
    },
  ];
  const artifactVersions: HandoffArtifactVersionRecord[] = [
    { artifact_id: "specify.v1", kind: "specify", version: 1, sha256: sha256("specify.v1") },
    { artifact_id: "plan.v1", kind: "plan", version: 1, sha256: sha256("plan.v1") },
    { artifact_id: "tasks.v1", kind: "tasks", version: 1, sha256: sha256("tasks.v1") },
  ];
  const handoff: ImplementationHandoffRecord = {
    schema_version: 1,
    handoff_id: `${featureId}.handoff.v1`,
    handoff_digest: "0".repeat(64),
    feature_id: featureId,
    source_kind: "native",
    artifact_versions: artifactVersions,
    scope: {
      in_scope: ["the requested outcome"],
      out_of_scope: ["unrelated refactors"],
      constraints: ["same-branch serialized ownership"],
    },
    requirements,
    decisions,
    tasks,
    verification,
    validation_refs: ["validation.specify.v1", "validation.plan.v1", "validation.tasks.v1"],
    approval_refs: ["checkpoint.specify.v1", "checkpoint.plan.v1", "checkpoint.tasks.v1"],
    language: "en-US",
    constitution_binding: validConstitutionBinding(),
    constitution_impact_ref: null,
    risks: [],
    open_decisions: [],
    execution_choices: ["do-work"],
    status: options.status ?? "ready",
    import_snapshot_ref: null,
    compatibility_supplement_ref: null,
    import_framework: "generic",
    import_mapping_id: "generic-requirements-plan-tasks",
    import_mapping_version: "1",
    import_selected_paths: ["requirements.md"],
    import_ignored_candidates: [],
    import_intake_paths: ["external-source"],
    import_document_language: "und",
    import_document_language_source: "unknown",
    import_source_revision: null,
  };
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...content } = handoff;
  handoff.handoff_digest = canonicalDigestOf(content);
  return handoff;
}

export const INVALID_IMPLEMENTATION_HANDOFF_CASES: Readonly<Record<string, unknown>> = {
  requirement_without_acceptance: (() => {
    const handoff = validImplementationHandoff();
    handoff.requirements[0]!.acceptance_ids = [];
    return handoff;
  })(),
  ready_with_open_decision: (() => {
    const handoff = validImplementationHandoff();
    handoff.open_decisions = ["D-9 unresolved"];
    return handoff;
  })(),
  task_with_dangling_dependency: (() => {
    const handoff = validImplementationHandoff();
    handoff.tasks[0]!.depends_on = ["T-404"];
    return handoff;
  })(),
  task_graph_with_cycle: (() => {
    const handoff = validImplementationHandoff();
    handoff.tasks.push({
      task_id: "T-2",
      title: "Second task",
      requirement_ids: ["FR-1"],
      depends_on: ["T-1"],
      expected_outcome: "Done after T-1.",
      affected_scope: ["src/other.ts"],
      completion_evidence: ["test"],
      parallel_safe: true,
    });
    handoff.tasks[0]!.depends_on = ["T-2"];
    return handoff;
  })(),
  verification_without_task_link: (() => {
    const handoff = validImplementationHandoff();
    handoff.verification[0]!.task_ids = [];
    return handoff;
  })(),
  ready_without_approvals: (() => {
    const handoff = validImplementationHandoff();
    handoff.approval_refs = [];
    return handoff;
  })(),
  malformed_digest: (() => {
    const handoff = validImplementationHandoff();
    handoff.handoff_digest = "deadbeef";
    return handoff;
  })(),
};

// ── ExecutionClaim ───────────────────────────────────────────────────────────

export interface ExecutionClaimRecord {
  claim_id: string;
  handoff_digest: string;
  owner_kind: "do_work" | "cto";
  owner_run_id: string;
  status: "active" | "completed" | "released" | "blocked";
  acquired_at: string;
  updated_at: string;
  release_reason: string | null;
}

export interface ValidClaimOptions {
  status?: ExecutionClaimRecord["status"];
  ownerKind?: ExecutionClaimRecord["owner_kind"];
  handoffDigest?: string;
}

/** The exclusive active claim over the canonical handoff digest. */
export function validExecutionClaim(options: ValidClaimOptions = {}): ExecutionClaimRecord {
  const status = options.status ?? "active";
  return {
    claim_id: "claim-feature-one-v1",
    handoff_digest: options.handoffDigest ?? validImplementationHandoff().handoff_digest,
    owner_kind: options.ownerKind ?? "do_work",
    owner_run_id: "run-feature-one-1",
    status,
    acquired_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    release_reason: status === "released" || status === "blocked" ? "handoff changed" : null,
  };
}

export const INVALID_EXECUTION_CLAIM_CASES: Readonly<Record<string, unknown>> = {
  released_without_reason: (() => {
    const claim = validExecutionClaim({ status: "released" });
    claim.release_reason = null;
    return claim;
  })(),
  completed_without_passing_conformance: (() => {
    // `completed` is reachable only after a passing conformance result; a
    // claim carrying no result reference (empty digest binding) is invalid.
    const claim = validExecutionClaim({ status: "completed" });
    claim.handoff_digest = "";
    return claim;
  })(),
  unknown_owner_kind: (() => {
    const claim = validExecutionClaim();
    (claim as unknown as Record<string, unknown>).owner_kind = "agent";
    return claim;
  })(),
  malformed_handoff_digest: validExecutionClaim({ handoffDigest: "xyz" }),
  missing_owner_run: (() => {
    const claim = validExecutionClaim();
    claim.owner_run_id = "";
    return claim;
  })(),
};

/** A second active claim over the same digest — never valid alongside the first. */
export function conflictingActiveClaim(digest?: string): ExecutionClaimRecord {
  const claim = validExecutionClaim({ handoffDigest: digest });
  claim.claim_id = "claim-feature-one-v2-contender";
  claim.owner_kind = "cto";
  claim.owner_run_id = "wave-feature-one-2";
  return claim;
}

// ── ImplementationConformanceResult ──────────────────────────────────────────

export interface ConformanceArtifactRefRecord {
  artifact_id: string;
  path: string;
  sha256: string;
  schema_status: "met" | "failed";
  quality_gate_status: "met" | "pending" | "failed";
}

export interface ConformanceFindingRecord {
  code: string;
  subject_id: string | null;
  message: string;
  evidence_refs: string[];
}

export interface ConformanceTestEvidenceRecord {
  evidence_ref: ConformanceArtifactRefRecord;
  test_kind: "unit" | "integration" | "e2e" | "runtime";
  status: "pass" | "fail";
  executed_at: string;
}

export interface RequirementClosureEntryRecord {
  entry_id: string;
  subject_kind: "requirement" | "acceptance_scenario";
  subject_id: string;
  requirement_id: string;
  observable_behavior: boolean;
  implementation_evidence_refs: ConformanceArtifactRefRecord[];
  review_verdict: "pass" | "fail" | "missing";
  review_evidence_refs: ConformanceArtifactRefRecord[];
  test_evidence: ConformanceTestEvidenceRecord[];
  status: "pass" | "blocked" | "changed_intent";
  findings: ConformanceFindingRecord[];
}

export interface QualityGateResultRecord {
  gate_id: string;
  source: "project_constitution" | "execution_profile";
  status: "pass" | "fail";
  evidence_refs: ConformanceArtifactRefRecord[];
  findings: ConformanceFindingRecord[];
}

export interface ImplementationConformanceRecord {
  schema_version: string;
  conformance_id: string;
  matrix_digest: string;
  feature_id: string;
  handoff_id: string;
  handoff_digest: string;
  execution_claim_id: string;
  execution_owner: "do_work" | "cto";
  execution_run_id: string;
  profile_hash: string;
  evaluated_at: string;
  entries: RequirementClosureEntryRecord[];
  quality_gate_results: QualityGateResultRecord[];
  overall_status: "pass" | "blocked" | "changed_intent";
  blocking_findings: ConformanceFindingRecord[];
  next_action:
    | "complete_feature"
    | "repair_implementation"
    | "repeat_review"
    | "repeat_tests"
    | "repair_quality_gate"
    | "revise_specification";
}

export interface ValidConformanceOptions {
  overallStatus?: ImplementationConformanceRecord["overall_status"];
  featureId?: string;
  handoffDigest?: string;
}

function passingArtifactRef(): ConformanceArtifactRefRecord {
  return {
    artifact_id: "implementation.impl.v1",
    path: "artifacts/implementation.v1.json",
    sha256: sha256("implementation.v1"),
    schema_status: "met",
    quality_gate_status: "met",
  };
}

function passingTestEvidence(): ConformanceTestEvidenceRecord {
  return {
    evidence_ref: passingArtifactRef(),
    test_kind: "runtime",
    status: "pass",
    executed_at: FIXED_NOW,
  };
}

/** A passing matrix covering one requirement and its acceptance scenario. */
export function validImplementationConformance(
  options: ValidConformanceOptions = {},
): ImplementationConformanceRecord {
  const featureId = options.featureId ?? FIXED_FEATURE_ID;
  const handoff = validImplementationHandoff({ featureId });
  const handoffDigest = options.handoffDigest ?? handoff.handoff_digest;
  const claim = validExecutionClaim({ handoffDigest });
  const requirementEntry: RequirementClosureEntryRecord = {
    entry_id: "entry-fr-1",
    subject_kind: "requirement",
    subject_id: "FR-1",
    requirement_id: "FR-1",
    observable_behavior: true,
    implementation_evidence_refs: [passingArtifactRef()],
    review_verdict: "pass",
    review_evidence_refs: [passingArtifactRef()],
    test_evidence: [passingTestEvidence()],
    status: "pass",
    findings: [],
  };
  const acceptanceEntry: RequirementClosureEntryRecord = {
    entry_id: "entry-ac-1",
    subject_kind: "acceptance_scenario",
    subject_id: "AC-1",
    requirement_id: "FR-1",
    observable_behavior: true,
    implementation_evidence_refs: [passingArtifactRef()],
    review_verdict: "pass",
    review_evidence_refs: [passingArtifactRef()],
    test_evidence: [passingTestEvidence()],
    status: "pass",
    findings: [],
  };
  const qualityGates: QualityGateResultRecord[] = [
    {
      gate_id: "project_constitution",
      source: "project_constitution",
      status: "pass",
      evidence_refs: [passingArtifactRef()],
      findings: [],
    },
  ];
  const entries = [requirementEntry, acceptanceEntry];
  const result: ImplementationConformanceRecord = {
    schema_version: "1.0",
    conformance_id: "",
    matrix_digest: "",
    feature_id: featureId,
    handoff_id: handoff.handoff_id,
    handoff_digest: handoffDigest,
    execution_claim_id: claim.claim_id,
    execution_owner: claim.owner_kind,
    execution_run_id: claim.owner_run_id,
    profile_hash: sha256("execution-profile"),
    evaluated_at: FIXED_NOW,
    entries,
    quality_gate_results: qualityGates,
    overall_status: options.overallStatus ?? "pass",
    blocking_findings: [],
    next_action: options.overallStatus === undefined || options.overallStatus === "pass"
      ? "complete_feature"
      : "repair_implementation",
  };
  result.matrix_digest = canonicalDigestOf({
    schema_version: result.schema_version,
    feature_id: result.feature_id,
    handoff_id: result.handoff_id,
    handoff_digest: result.handoff_digest,
    execution_claim_id: result.execution_claim_id,
    execution_owner: result.execution_owner,
    execution_run_id: result.execution_run_id,
    profile_hash: result.profile_hash,
    entries: result.entries,
    quality_gate_results: result.quality_gate_results,
    overall_status: result.overall_status,
    blocking_findings: result.blocking_findings,
    next_action: result.next_action,
  });
  result.conformance_id = `implementation-conformance.${result.matrix_digest}`;
  return result;
}

export const INVALID_CONFORMANCE_RESULT_CASES: Readonly<Record<string, unknown>> = {
  pass_row_without_review_verdict: (() => {
    const result = validImplementationConformance();
    result.entries[0]!.review_verdict = "missing";
    return result;
  })(),
  observable_pass_without_executed_tests: (() => {
    const result = validImplementationConformance();
    result.entries[0]!.test_evidence = [];
    return result;
  })(),
  overall_pass_with_blocking_findings: (() => {
    const result = validImplementationConformance();
    result.blocking_findings = [
      {
        code: "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
        subject_id: "FR-1",
        message: "stale evidence",
        evidence_refs: [],
      },
    ];
    return result;
  })(),
  overall_pass_with_failed_gate: (() => {
    const result = validImplementationConformance();
    result.quality_gate_results[0]!.status = "fail";
    return result;
  })(),
  duplicate_subject_rows: (() => {
    const result = validImplementationConformance();
    result.entries.push(structuredClone(result.entries[0]!));
    return result;
  })(),
  malformed_matrix_digest: (() => {
    const result = validImplementationConformance();
    result.matrix_digest = "nope";
    return result;
  })(),
  evidence_bound_to_other_handoff: (() => {
    const result = validImplementationConformance();
    result.handoff_digest = validImplementationHandoff({ featureId: "feature-two" }).handoff_digest;
    return result;
  })(),
};

// ── Convenience bundles for story slices ─────────────────────────────────────

/** Canonical inputs for one ready native feature end-to-end. */
export function readyNativeFeatureBundle(): {
  workspace: FeatureWorkspaceRecord;
  handoff: ImplementationHandoffRecord;
  claim: ExecutionClaimRecord;
  conformance: ImplementationConformanceRecord;
} {
  const handoff = validImplementationHandoff();
  const claim = validExecutionClaim({ handoffDigest: handoff.handoff_digest });
  const conformance = validImplementationConformance({ handoffDigest: handoff.handoff_digest });
  const workspace = validFeatureWorkspace({
    status: "executing",
    withApprovedSpecify: true,
  });
  workspace.handoff_ref = handoff.handoff_id;
  workspace.execution_claim_ref = claim.claim_id;
  workspace.implementation_conformance_ref = conformance.conformance_id;
  return { workspace, handoff, claim, conformance };
}
