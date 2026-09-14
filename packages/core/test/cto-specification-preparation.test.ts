import { writeTestArtifact } from "./fixtures/artifacts.js";
/**
 * Public-contract tests for CTO-coordinated specification preparation (T101).
 *
 * The resident CTO is a coordinator only. It schedules standard preparation
 * requests, keeps one writer for each feature/phase, records independent
 * trusted decisions, and stops after Tasks approval. It never creates a child
 * CTO or starts implementation.
 *
 */

import { test, describe } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { TEST_CONTEXT, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import { registerTestWorkflowTools } from "./fixtures/host-tool-activation.js";
import { z as zod } from "zod";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointAnswerProof, TeamState, WorkIdentity } from "../src/engine/types.js";
import type { WorkspacePhase, FeatureWorkspace } from "../src/specification/types.js";
import {
  nativeCheckpointPolicy,
} from "../src/engine/checkpoints.js";
import { createCapability } from "../src/engine/durable.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { deriveCtoSpecificationPreparationTeams } from "../src/commands/cto.js";
import type { TeamDef } from "../src/cto/types.js";
import { canonicalJson, digestOf, sha256Hex, validateNativePhase, type NativePhaseValidationInput } from "../src/specification/validation.js";
import { canonicalHandoffDigest } from "../src/specification/handoff.js";
import { resolveState, setStateTransactionTestHooks, updateStateAtomically, writeState } from "../src/engine/state.js";
import {
  readCtoSpecificationDecisions,
  recordCtoSpecificationDecisions,
  setCtoSpecificationDecisionFailureInjector,
} from "../src/cto/decisions.js";
import {
  CTO_RUN_DELIVERY_INDEX_FILE,
  applyAppendWaveTransition,
  ctoRuntimeRunInitialIdentityDigest,
  newCtoState,
  readCtoState,
  writeCtoState,
} from "../src/cto/state.js";
import { scheduleCtoSpecificationPreparation } from "../src/cto/scheduler.js";
import { buildCtoSliceMarker } from "../src/cto/slice-gate.js";
import {
  CTO_SPECIFICATION_PREPARATION_CLASSIFICATION,
  resolveCtoSpecificationPreparationSliceMarker,
} from "../src/cto/specification-preparation.js";
import {
  advanceCtoSpecificationPreparation,
  setCtoSpecificationPreparationFailureInjector,
} from "../src/cto/run.js";
import { buildCtoSpecificationReviewPacketFromDecisionSnapshot } from "../src/cto/specification-review-packet.js";
import { setCanonicalHandoffReadTestHooks } from "../src/specification/canonical-reader.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { resolveFeatureWorkspace } from "../src/specification/workspace.js";
import { materializeFeatureDocuments } from "../src/specification/materialize.js";
import { parseConstitutionPrincipleIdentities, renderCanonicalPhaseDocument, type PersistedPhaseResultEnvelope } from "../src/specification/phase.js";
import { resolveSpecificationLanguage } from "../src/specification/language.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS } from "../src/specification/templates.js";
import { ensureProjectConstitution, readProjectConstitutionGate } from "../src/specification/prerequisite.js";

const CTO_RUN_ID = "cto-preparation-resident";
const PROFILE_HASH = "a".repeat(64);
const SPECIFICATION_CHECKPOINT = "specification_phase_approval";
const SHIPPED_PREPARATION_PROFILE = loadProfile("spec-preparation");
if (!SHIPPED_PREPARATION_PROFILE) throw new Error("canonical preparation fixture requires the shipped spec-preparation profile");
const SHIPPED_PREPARATION_PROFILE_HASH = profileHash(SHIPPED_PREPARATION_PROFILE);
const PREPARATION_CONSTITUTION = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
const RUNTIME_ACTIVATION_MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const RUNTIME_ACTIVATION_MARKER_SHA256 = sha256Hex(RUNTIME_ACTIVATION_MARKER);
function preparationConstitutionBinding() {
  return validConstitutionBinding({
    content_sha256: sha256Hex(PREPARATION_CONSTITUTION),
    semantic_hash: sha256Hex(PREPARATION_CONSTITUTION.replace(/\s+/gu, " ").trim()),
    validation_ref: "constitution.validation." + sha256Hex(PREPARATION_CONSTITUTION),
  });
}
function writeApprovedPreparationConstitution(root: string, binding: ReturnType<typeof preparationConstitutionBinding>, runKey: string): string {
  writeFileSync(join(root, binding.path), PREPARATION_CONSTITUTION, "utf8");
  const ensured = ensureProjectConstitution(root, {
    origin_kind: "native_direct",
    origin_run_key: runKey,
    origin_stage: "specify",
  });
  if (!ensured.ok || ensured.value.status !== "usable" || !ensured.value.binding) {
    throw new Error(`preparation fixture constitution bootstrap failed: ${ensured.ok ? ensured.value.status : ensured.error}`);
  }
  if (ensured.value.binding.content_sha256 !== binding.content_sha256
    || ensured.value.binding.semantic_hash !== binding.semantic_hash
    || ensured.value.binding.validation_ref !== binding.validation_ref) {
    throw new Error("preparation fixture constitution bootstrap produced a different binding");
  }
  return ensured.value.gate_id;
}

type Phase = WorkspacePhase;

interface PreparationRequest {
  request_id: string;
  feature_id: string;
  run_key: string;
  phase: Phase;
  facet_id: string;
  profile_name: string;
  profile_hash: string;
  owner_id?: string;
  active_phase?: Phase;
}

interface PreparationScheduleInput {
  cto_run_id: string;
  resident_cto_run_id: string;
  depth: number;
  max_depth: number;
  capacity: number;
  requests: PreparationRequest[];
}

interface ScheduledRow extends PreparationRequest {
  phase_writer_id: string;
}

interface QueuedRow extends PreparationRequest {
  reason_code: "capacity" | "depth" | "ownership" | "active_phase" | "same_feature_serialized" | "nested_cto";
  reason: string;
}

interface PreparationScheduleResult {
  scheduled: ScheduledRow[];
  queued: QueuedRow[];
  phase_writers: Record<string, string>;
}

interface PreparationDecision {
  feature_id: string;
  run_key: string;
  phase: Phase;
  decision: "approve_continue" | "request_changes" | "approve_stop";
  checkpoint_ref: string;
  trusted_answer_ref: string;
  trusted_proof: CheckpointAnswerProof;
}

interface DecisionsResult {
  decisions: PreparationDecision[];
}

interface AdvanceResult {
  features: Array<{ feature_id: string; status?: string; next_action?: string }>;
  review_packet_ref: string;
  execution_started: false;
  hard_stop: true;
}

// The public functions are intentionally called through their current API
// boundaries. The decision input remains unknown at runtime so negative tests
// can exercise malformed caller data without manufacturing a proof object.
const schedule = scheduleCtoSpecificationPreparation as unknown as (
  input: PreparationScheduleInput,
) => PreparationScheduleResult;
const recordDecisions = recordCtoSpecificationDecisions as unknown as (
  projectRoot: string,
  input: { cto_run_id: string; decisions: unknown[] },
) => DecisionsResult;

const PREPARATION_RUNTIME_SESSION = "cto-spec-preparation-runtime-test-session";
function openPreparationRuntime(root: string, sessionId = PREPARATION_RUNTIME_SESSION) {
  const runtime = openTestCtoRuntime(root, sessionId, "core-test-workflow-tools");
  return { access: runtime.access, release: runtime.close };
}

function advance(projectRoot: string, input: { cto_run_id: string }, sessionId = PREPARATION_RUNTIME_SESSION): AdvanceResult {
  const runtime = openPreparationRuntime(projectRoot, sessionId);
  try {
    return advanceCtoSpecificationPreparation(projectRoot, input, { runtimeAccess: runtime.access, sessionId }) as AdvanceResult;
  } finally {
    runtime.release();
  }
}

function childRuntimeBootstrap(): string {
  const ownerModuleUrl = new URL("../src/registry/owner.ts", import.meta.url).href;
  const runtimeModuleUrl = new URL("../src/cto/runtime-access.ts", import.meta.url).href;
  const sessionAuthorityModuleUrl = new URL("../src/cto/session-authority.ts", import.meta.url).href;
  return `import { createHash } from "node:crypto";
import { openWorkflowActivation, releaseWorkflowOwners, requireRegistryContext } from ${JSON.stringify(ownerModuleUrl)};
import { issueCtoRuntimeSessionAuthority } from ${JSON.stringify(sessionAuthorityModuleUrl)};
import { openCtoRuntimeAccess } from ${JSON.stringify(runtimeModuleUrl)};
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.env.REVIEW_PACKET_CRASH_ROOT;
const runId = process.env.REVIEW_PACKET_CRASH_RUN;
if (!root || !runId) throw new Error("review packet crash root/run is missing");
const markerContent = "omp-core-test-registry-marker-v1";
const markerSha256 = createHash("sha256").update(markerContent).digest("hex");
const owner = {
  owner_id: "core-test-workflow-tools",
  bundle_id: "core-test-workflow-tools",
  owner_kind: "private_omp",
  activation_marker: "core-test-workflow-tools-activation",
  host_range: ">=17.3 <19",
  activation: { marker_id: "core-test-workflow-tools-activation", required: [{ path: ".omp-test-registry-marker", kind: "file", sha256: markerSha256 }] },
  provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
};
const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], owner);
if (!activation.ok) throw new Error(activation.error);
const state = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8"));
const sessionId = state.owner_session;
if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("canonical CTO state owner_session is missing");
const runtimeRoot = realpathSync(root);
const runtimeIdentity = statSync(runtimeRoot);
const sessionManager = Object.freeze({ cwd: root, getSessionId: () => sessionId, getCwd: () => root });
const authority = issueCtoRuntimeSessionAuthority(
  activation.registry_context,
  { canonical_root: runtimeRoot, dev: runtimeIdentity.dev, ino: runtimeIdentity.ino },
  { sessionManager, sessionId },
  () => { requireRegistryContext(activation.registry_context, runtimeRoot, "workflow_tools"); },
);
const opened = openCtoRuntimeAccess(activation.registry_context, authority, root);
if (!opened.ok) {
  releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  throw new Error(opened.error);
}
const runtimeAccess = opened.access;
`;
}

function spawnCrashAfterReviewPacketWrite(root: string): Promise<number> {
  const moduleUrl = new URL("../src/cto/run.ts", import.meta.url).href;
  const runtimeSetup = childRuntimeBootstrap();
  const script = `${runtimeSetup}
import { advanceCtoSpecificationPreparation, setCtoSpecificationPreparationFailureInjector } from ${JSON.stringify(moduleUrl)};
setCtoSpecificationPreparationFailureInjector((point) => {
  if (point === "after_artifact_write") process.exit(73);
});
advanceCtoSpecificationPreparation(root, { cto_run_id: process.env.REVIEW_PACKET_CRASH_RUN }, { runtimeAccess, sessionId });
process.exit(92);`;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, REVIEW_PACKET_CRASH_ROOT: root, REVIEW_PACKET_CRASH_RUN: CTO_RUN_ID },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (code) => {
      if (code !== 73) {
        rejectChild(new Error(`review packet crash child exited with ${code}: ${stderr}`));
        return;
      }
      resolveChild(code);
    });
  });
}

function spawnCrashBeforeReviewPacketPublish(root: string): Promise<number> {
  const moduleUrl = new URL("../src/cto/run.ts", import.meta.url).href;
  const runtimeSetup = childRuntimeBootstrap();
  const script = `${runtimeSetup}
import { advanceCtoSpecificationPreparation, setCtoSpecificationPreparationFailureInjector } from ${JSON.stringify(moduleUrl)};
setCtoSpecificationPreparationFailureInjector((point) => {
  if (point === "before_packet_publish") process.exit(74);
});
advanceCtoSpecificationPreparation(root, { cto_run_id: process.env.REVIEW_PACKET_CRASH_RUN }, { runtimeAccess, sessionId });
process.exit(92);`;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, REVIEW_PACKET_CRASH_ROOT: root, REVIEW_PACKET_CRASH_RUN: CTO_RUN_ID },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (code) => {
      if (code !== 74) {
        rejectChild(new Error(`review packet prepublish crash child exited with ${code}: ${stderr}`));
        return;
      }
      resolveChild(code);
    });
  });
}

function request(
  featureId: string,
  phase: Phase,
  facetId = "primary",
  overrides: Partial<PreparationRequest> = {},
): PreparationRequest {
  return {
    request_id: `${featureId}-${facetId}-${phase}`,
    feature_id: featureId,
    run_key: `${featureId}-run`,
    phase,
    facet_id: facetId,
    profile_name: "spec-preparation",
    profile_hash: PROFILE_HASH,
    ...overrides,
  };
}

function scheduleInput(
  requests: PreparationRequest[],
  overrides: Partial<PreparationScheduleInput> = {},
): PreparationScheduleInput {
  return {
    cto_run_id: CTO_RUN_ID,
    resident_cto_run_id: CTO_RUN_ID,
    depth: 0,
    max_depth: 2,
    capacity: requests.length || 1,
    requests,
    ...overrides,
  };
}

function decision(
  featureId: string,
  phase: Phase,
  value: PreparationDecision["decision"],
  answerId: string,
  proof: CheckpointAnswerProof,
): PreparationDecision {
  return {
    feature_id: featureId,
    run_key: `${featureId}-run`,
    phase,
    decision: value,
    checkpoint_ref: `checkpoint.${phase}.v1`,
    trusted_answer_ref: answerId,
    trusted_proof: proof,
  };
}

function freshProject(): string {
  const root = mkdtempSync(join(tmpdir(), "cto-spec-preparation-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), RUNTIME_ACTIVATION_MARKER, "utf8");
  return root;
}

function preparationWorkspace(root: string, featureId: string): FeatureWorkspace {
  const workspace = validFeatureWorkspace({ featureId, status: "in_progress", constitutionBinding: preparationConstitutionBinding() });
  bindFeatureWorkspaceToRoot(workspace, root);
  workspace.workspace_path = `specs/${featureId}`;
  workspace.state_path = `.work-state/features/${featureId}/state.json`;
  // Trusted answers bind to the shipped profile, not a proof-shaped test fingerprint.
  workspace.profile_hash = SHIPPED_PREPARATION_PROFILE_HASH;
  const placeholderHash = "0".repeat(64);
  workspace.phases = workspace.phases.map((phase) => ({
    ...phase,
    status: "awaiting_approval",
    current_version: 1,
    approved_version: null,
    validation_ref: `validation.${phase.phase}.v1`,
    checkpoint_ref: `checkpoint.${phase.phase}.v1`,
    upstream_versions: phase.phase === "specify"
      ? []
      : phase.phase === "plan"
        ? [{ phase: "specify" as const, version: 1, hash: placeholderHash }]
        : [
            { phase: "specify" as const, version: 1, hash: placeholderHash },
            { phase: "plan" as const, version: 1, hash: placeholderHash },
          ],
  }));
  const language = resolveSpecificationLanguage({ requestLanguage: "en-US" });
  const templates = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(templates.ok, true, templates.ok ? "" : templates.error);
  if (!templates.ok) throw new Error(templates.error);
  workspace.language = language;
  workspace.template_set = templates.value.selection;
  return workspace;
}

function phaseRole(phase: Phase): string {
  return phase === "specify" ? "specification-analyst" : "specification-architect";
}


function seedNativeCheckpointArtifact(
  root: string,
  featureId: string,
  phase: Phase,
  workspace: FeatureWorkspace,
  identity: WorkIdentity,
  issued: ReturnType<typeof createCapability>,
): void {
  const runKey = `${featureId}-run`;
  const artifactId = `${phase}.v1`;
  const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
  const artifactPath = join(artifactsDir, `${artifactId}.json`);
  if (existsSync(artifactPath)) return;
  const binding = workspace.constitution_binding;
  if (!binding) throw new Error("preparation fixture requires a constitution binding");
  const priorPhases: Phase[] = phase === "specify" ? [] : phase === "plan" ? ["specify"] : ["specify", "plan"];
  for (const priorPhase of priorPhases) {
    const priorArtifactPath = join(artifactsDir, `${priorPhase}.v1.json`);
    if (existsSync(priorArtifactPath)) continue;
    const priorIdentity: WorkIdentity = {
      ...identity,
      stage_id: priorPhase,
      stage_cursor: priorPhase,
      capability_id: `capability-${featureId}-${priorPhase}`,
      capability_epoch: `epoch-${featureId}-${priorPhase}`,
      slot_id: phaseRole(priorPhase),
      task_id: `task-${featureId}-${priorPhase}`,
      dispatch_id: `dispatch-${featureId}-${priorPhase}`,
      wave_id: `wave-${featureId}-${priorPhase}`,
    };
    seedNativeCheckpointArtifact(root, featureId, priorPhase, workspace, priorIdentity, issued);
  }
  const constitutionBody = readFileSync(join(root, binding.path), "utf8");
  const principles = parseConstitutionPrincipleIdentities(constitutionBody).map((principle) => ({
    principle_id: principle.principle_id,
    title: principle.title,
    applicability: "applicable" as const,
    status: "pass" as const,
    evidence: "Ship tested work.",
    binding,
  }));
  const upstream = priorPhases.map((priorPhase) => {
    const priorArtifactId = `${priorPhase}.v1`;
    const priorArtifact = JSON.parse(readFileSync(join(artifactsDir, `${priorArtifactId}.json`), "utf8"));
    return { artifact_id: priorArtifactId, version: 1, hash: digestOf(priorArtifact) };
  });
  const requirement = {
    requirement_id: "REQ-PREPARATION-1",
    statement: "The preparation checkpoint fixture remains deterministic and observable.",
    acceptance_ids: ["ACC-PREPARATION-1"],
    source_refs: ["spec.md#requirements"],
    testable: true,
    untestable_reason: null,
  };
  const decision = {
    decision_id: "DEC-PREPARATION-1",
    decision: "Use the canonical preparation fixture path.",
    rationale: "The public checkpoint contract must bind to immutable native evidence.",
    requirement_ids: [requirement.requirement_id],
  };
  const verification = {
    verification_id: "VERIFY-PREPARATION-1",
    requirement_ids: [requirement.requirement_id],
    acceptance_ids: requirement.acceptance_ids,
    task_ids: phase === "tasks" ? ["TASK-PREPARATION-1"] : [],
    observable_behavior: true,
    expected_evidence: "The mounted checkpoint answer is persisted and consumed exactly once.",
  };
  const task = {
    id: "TASK-PREPARATION-1",
    title: "Persist the preparation checkpoint fixture evidence.",
    requirement_ids: [requirement.requirement_id],
    acceptance_ids: requirement.acceptance_ids,
    decision_ids: [decision.decision_id],
    verification_ids: [verification.verification_id],
    depends_on: [],
    expected_outcome: "The exact native checkpoint artifact and validation are available.",
    affected_scope: ["packages/core/test/cto-specification-preparation.test.ts"],
    completion_evidence: ["focused preparation decision proof"],
    parallel_safe: true,
  };
  const sectionText = `Canonical ${phase} preparation evidence for ${featureId}.`;
  const sections = phase === "specify"
    ? { problem: sectionText, scope: sectionText, non_goals: sectionText, actors: sectionText, journeys: sectionText, requirements: sectionText, edge_cases: sectionText, assumptions: sectionText, dependencies: sectionText, success_criteria: sectionText }
    : phase === "plan"
      ? { repository_grounding: "packages/core/test/cto-specification-preparation.test.ts", decisions: sectionText, alternatives: sectionText, contracts: sectionText, data_flow: sectionText, control_flow: sectionText, migration: sectionText, security: sectionText, operations: sectionText, verification_strategy: sectionText, constitution_recheck: sectionText }
      : { task_graph: sectionText, dependencies: sectionText, expected_outcomes: sectionText };
  const semanticModel = {
    schema_version: 1 as const,
    feature_id: featureId,
    run_key: runKey,
    phase,
    version: 1,
    worker: { role: phaseRole(phase), agent: `test-${phaseRole(phase)}`, dispatch_id: identity.dispatch_id },
    constitution_binding: binding,
    upstream_versions: upstream,
    sections,
    requirements: [requirement],
    decisions: phase === "specify" ? [] : [decision],
    tasks: phase === "tasks" ? [task] : [],
    verification: [verification],
    contradictions: [],
    constitution_principles: principles,
  } as const;
  const template = templatesForPreparation().find((candidate) => candidate.template_id === phase);
  assert.ok(template, `missing shipped ${phase} template`);
  if (!template) throw new Error(`missing shipped ${phase} template`);
  const content = renderCanonicalPhaseDocument(phase, semanticModel as never, template);
  const primaryPath = phase === "specify" ? "spec.md" : `${phase}.md`;
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  const sourceArtifact = {
    schema_version: 1,
    feature_id: featureId,
    run_key: runKey,
    version: 1,
    worker: semanticModel.worker,
    constitution_binding: binding,
    document_sha256: sha256Hex(content),
    upstream_versions: upstream,
    semantic_model: semanticModel,
  };
  const artifact: PersistedPhaseResultEnvelope = {
    schema_version: 1,
    feature_id: featureId,
    run_key: runKey,
    request_id: `preparation-${featureId}-${phase}`,
    request_digest: "0".repeat(64),
    source_artifact_id: phase === "specify" ? "specify_draft" : phase === "plan" ? "plan_draft" : "task_graph",
    source_artifact: sourceArtifact,
    artifact_id: artifactId,
    phase,
    version: 1,
    dispatch_id: identity.dispatch_id,
    work_identity: identity,
    capability_epoch: identity.capability_epoch,
    source_artifact_hash: digestOf(sourceArtifact),
    semantic_model: semanticModel as never,
    document_paths: [primaryPath],
    document_hashes: { [primaryPath]: sha256Hex(content) },
    semantic_section_hashes: Object.fromEntries(Object.entries(semanticModel.sections).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, sha256Hex(value)])),
    template_hash: workspace.template_set.content_hash,
    language_hash: workspace.language.selection_hash,
    upstream_versions: upstream,
    created_at: new Date().toISOString(),
    constitution_binding: binding,
  };
  artifact.request_digest = digestOf({ feature_id: featureId, run_key: runKey, phase, version: 1, request_id: artifact.request_id, dispatch_id: identity.dispatch_id, source_artifact: sourceArtifact, documents: [{ path: primaryPath, content }], semantic_sections: semanticModel.sections, constitution_binding: binding, upstream_versions: upstream, template_hash: artifact.template_hash, language_hash: artifact.language_hash });
  const materialized = materializeFeatureDocuments(root, { feature_id: featureId, run_key: runKey, phase, version: 1, documents: [{ path: primaryPath, content }], binding: artifact as never, validation_id: `validation.${phase}.v1` }, { validateBeforeWrite: () => undefined });
  if (!materialized.ok) throw new Error(`preparation fixture materialization failed: ${materialized.error}`);
  writeTestArtifact(root, artifactsDir, artifactId, artifact);
  const validationInput: NativePhaseValidationInput = {
    validation_id: `validation.${phase}.v1`, feature_id: featureId, run_key: runKey, phase, version: 1, artifact_version: artifactId, document_path: primaryPath, document_sha256: sha256Hex(content), sections: semanticModel.sections, upstream_versions: upstream, expected_upstream_versions: upstream, constitution_binding: binding, expected_constitution_binding: binding, constitution_principles: principles.map(({ principle_id, status, evidence }) => ({ principle_id, status, evidence })), requirements: [requirement], decisions: phase === "specify" ? [] : [decision], tasks: phase === "tasks" ? [task] : [], verification: [verification], contradictions: [], validated_at: new Date().toISOString(), validator_version: "specification-validation@3",
  } as never;
  const validation = { ...validateNativePhase(validationInput), artifact_digest: digestOf(artifact) };
  writeTestArtifact(root, artifactsDir, `validation.${phase}.v1`, validation);
}

function templatesForPreparation() {
  const resolved = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value.templates;
}

function armFeaturePhase(root: string, featureId: string, phase: Phase): ReturnType<typeof createCapability> {
  const runKey = `${featureId}-run`;
  const workspaceDir = join(root, "specs", featureId);
  const featureStateDir = join(root, ".work-state", "features", featureId);
  const statePath = join(featureStateDir, "state.json");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(featureStateDir, { recursive: true });

  // Seed a canonical TeamState through the production writer. Generic
  // resolveState intentionally does not accept a bare specification envelope.
  if (!existsSync(statePath)) {
    const workspace = preparationWorkspace(root, featureId);
    const issued = createCapability({
      run_key: runKey,
      branch: "test",
      workflow: SHIPPED_PREPARATION_PROFILE.name,
      profile_hash: SHIPPED_PREPARATION_PROFILE_HASH,
      stage_cursor: "specify",
      kind: "none",
      expected_roster: [],
    });
    const state: TeamState = {
      schema: 1,
      branch: "test",
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", workflow: SHIPPED_PREPARATION_PROFILE.name, autonomous: false },
      task: `prepare ${phase} for ${featureId}`,
      workflow_override: false,
      issue: null,
      run_key: runKey,
      stage_cursor: "specify",
      stages: SHIPPED_PREPARATION_PROFILE.stages.map((candidate) => ({ id: candidate.id, status: candidate.id === "specify" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
      profile_hash: SHIPPED_PREPARATION_PROFILE_HASH,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      specification: workspace,
    };
    workspace.constitution_gate_ref = writeApprovedPreparationConstitution(root, workspace.constitution_binding!, runKey);
    writeState(root, state, { featureSlug: featureId });
  }
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
  assert.ok(selected.state && selected.statePath, "canonical preparation fixture must resolve exact feature/run state");
  const prior = selected.state;
  const workspace = prior.specification ?? preparationWorkspace(root, featureId);
  if (!workspace.constitution_binding) throw new Error("preparation fixture workspace has no constitution binding");
  workspace.constitution_gate_ref = writeApprovedPreparationConstitution(root, workspace.constitution_binding, runKey);
  const stage = SHIPPED_PREPARATION_PROFILE.stages.find((candidate) => candidate.id === phase);
  assert.ok(stage, `shipped preparation profile must declare phase ${phase}`);
  assert.equal(stage.type, "single");
  assert.equal(stage.checkpoint, SPECIFICATION_CHECKPOINT);
  const role = stage.role ?? phaseRole(phase);
  const issued = createCapability({
    run_key: runKey,
    branch: "test",
    workflow: SHIPPED_PREPARATION_PROFILE.name,
    profile_hash: SHIPPED_PREPARATION_PROFILE_HASH,
    stage_cursor: stage.id,
    cursor_epoch: `epoch-${featureId}-${phase}`,
    kind: "single",
    expected_roster: [{ role, agent: `test-${role}` }],
  });
  const identity: WorkIdentity = {
    run_id: runKey,
    wave_id: `wave-${featureId}-${phase}`,
    slice_id: `slice-${featureId}-${phase}`,
    session_id: `session-${featureId}`,
    workflow: SHIPPED_PREPARATION_PROFILE.name,
    stage_id: stage.id,
    stage_cursor: stage.id,
    capability_id: issued.capability_id,
    capability_epoch: issued.state.issued_for!.cursor_epoch,
    slot_id: role,
    task_id: `task-${featureId}-${phase}`,
    dispatch_id: `dispatch-${featureId}-${phase}`,
    attempt: 1,
    worker_id: `test-${role}`,
  };
  const state: TeamState = {
    ...prior,
    classification: {
      type: "SPEC",
      complexity: "MEDIUM",
      confidence: "HIGH",
      workflow: SHIPPED_PREPARATION_PROFILE.name,
      autonomous: false,
    },
    task: `prepare ${phase} for ${featureId}`,
    workflow_override: false,
    issue: null,
    run_key: runKey,
    branch: "test",
    stage_cursor: stage.id,
    stages: ["specify", "plan", "tasks"].map((id) => ({
      id,
      status: id === phase ? "in_progress" as const : "pending" as const,
    })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    profile_hash: SHIPPED_PREPARATION_PROFILE_HASH,
    checkpoint_policy: nativeCheckpointPolicy(SPECIFICATION_CHECKPOINT),
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    work_identity: identity,
    dispatch_capability: { ...issued.state, work_identity: identity },
    specification: workspace,
  };
  writeState(root, state, { target: selected });
  seedNativeCheckpointArtifact(root, featureId, phase, workspace, identity, issued);
  return issued;
}

function writeDerivationHandoff(root: string, featureId: string, affectedScope: string[]): void {
  armFeaturePhase(root, featureId, "tasks");
  const selector = { feature_id: featureId, run_key: `${featureId}-run` };
  const migrated = resolveFeatureWorkspace(root, selector);
  if (!migrated.ok) throw new Error(`derivation fixture workspace migration failed: ${migrated.error}`);
  const selected = resolveState(root, undefined, selector);
  assert.ok(selected.state?.specification, "derivation fixture must have a canonical feature workspace");
  if (!selected.state || !selected.state.specification) throw new Error("derivation fixture workspace is unavailable");
  const handoff = validImplementationHandoff({ featureId });
  handoff.execution_choices = ["cto"];
  handoff.constitution_binding = selected.state.specification.constitution_binding!;
  handoff.tasks[0]!.affected_scope = [...affectedScope];
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const handoffDir = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff");
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(join(handoffDir, `${handoff.handoff_id}.json`), JSON.stringify(handoff) + "\n");
  writeState(root, {
    ...selected.state,
    specification: {
      ...selected.state.specification,
      status: "implementation_ready",
      handoff_ref: handoff.handoff_id,
      constitution_binding: handoff.constitution_binding,
    },
  }, { target: selected });
}

function derivePreparationFixture(root: string, featureId: string, defs: readonly TeamDef[]): ReturnType<typeof deriveCtoSpecificationPreparationTeams> {
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("derivation fixture project root cannot be pinned");
  try {
    return deriveCtoSpecificationPreparationTeams(root, [{ feature_id: featureId, run_key: `${featureId}-run` }], defs, pinnedRoot);
  } finally {
    pinnedRoot.close();
  }
}
type MountedPreparationTool = { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
const mountedPreparationTools = new Map<string, Map<string, MountedPreparationTool>>();

/** Ask the mounted host UI and return the engine-issued proof. */
async function mountedPreparationCheckpointAsk(
  root: string,
  input: Record<string, unknown>,
  decisionValue: PreparationDecision["decision"],
  feedback?: string,
): Promise<Record<string, unknown>> {
  let tools = mountedPreparationTools.get(root);
  if (!tools) {
    tools = new Map<string, MountedPreparationTool>();
    registerTestWorkflowTools(root, {
      zod: { z: zod },
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        if (event === "session_start") handler({}, TEST_CONTEXT(root));
      },
      registerTool(tool: unknown) {
        const mounted = tool as MountedPreparationTool & { name: string };
        tools!.set(mounted.name, mounted);
      },
    } as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd });
    mountedPreparationTools.set(root, tools);
  }
  const ask = tools.get("workflow_checkpoint_ask_selected");
  assert.ok(ask, "selected preparation checkpoint Ask must be mounted");
  const response = await ask!.execute("preparation-fixture-host-ask", input, undefined, undefined, {
    cwd: root,
    sessionManager: TEST_SESSION_MANAGER,
    hasUI: true,
    ui: {
      askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
        const question = questions[0];
        if (!question) return undefined;
        return {
          kind: "submit" as const,
          results: [{
            id: question.id,
            question: question.question,
            header: question.header,
            options: question.options.map((option) => option.label),
            multi: false,
            selectedOptions: [decisionValue],
            ...(feedback !== undefined ? { note: feedback } : {}),
          }],
        };
      },
    },
  });
  return response.details;
}

/** Issue a real engine answer through the mounted host Ask path. */
async function issueCanonicalDecision(
  root: string,
  featureId: string,
  phase: Phase,
  value: PreparationDecision["decision"],
  _answerId: string,
): Promise<PreparationDecision> {
  const issued = armFeaturePhase(root, featureId, phase);
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `${featureId}-run` });
  assert.ok(selected.state && selected.statePath, "canonical preparation fixture must resolve exact feature/run state");
  if (!selected.state || !selected.statePath) throw new Error("canonical preparation fixture state unavailable");
  const details = await mountedPreparationCheckpointAsk(root, {
    feature_id: featureId,
    advance_token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: selected.state.run_key!,
    branch: selected.state.branch,
    workflow: SHIPPED_PREPARATION_PROFILE.name,
    profile_hash: selected.state.profile_hash!,
    stage_cursor: phase,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    checkpoint: SPECIFICATION_CHECKPOINT,
    checkpoint_id: SPECIFICATION_CHECKPOINT,
    checkpoint_kind: "specification_phase_approval",
    loop_iteration: 1,
  }, value, value === "request_changes" ? `Review feedback for ${featureId}/${phase}.` : undefined);
  assert.equal(details.ok, true, JSON.stringify(details));
  const persisted = details.persisted_decision;
  assert.ok(persisted && typeof persisted === "object", "mounted Ask must return persisted decision");
  const actor = (persisted as { actor?: unknown }).actor;
  const proof = actor && typeof actor === "object" ? (actor as { proof?: unknown }).proof : undefined;
  assert.ok(proof && typeof proof === "object", "mounted Ask must return trusted answer proof");
  const trustedProof = proof as CheckpointAnswerProof;
  assert.equal(trustedProof.answer_id, (trustedProof as CheckpointAnswerProof).answer_id);
  const decisionValue = details.decision;
  assert.equal(decisionValue, value);
  return decision(featureId, phase, value, trustedProof.answer_id, trustedProof);
}

function armCanonicalPreparationCheckpoint(root: string, featureId: string, phase: Phase): { state: TeamState; input: Record<string, unknown> } {
  const issued = armFeaturePhase(root, featureId, phase);
  const workspace = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: featureId + "-run" });
  assert.equal(workspace.ok, true, workspace.ok ? "" : workspace.error);
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: featureId + "-run" });
  assert.ok(selected.state && selected.statePath, "selected Ask fixture must resolve exact feature/run state");
  if (!selected.state) throw new Error("selected Ask fixture state unavailable");
  return {
    state: selected.state,
    input: {
      feature_id: featureId,
      advance_token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: selected.state.run_key!,
      branch: selected.state.branch,
      workflow: SHIPPED_PREPARATION_PROFILE.name,
      profile_hash: selected.state.profile_hash!,
      stage_cursor: phase,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      checkpoint: SPECIFICATION_CHECKPOINT,
      checkpoint_id: SPECIFICATION_CHECKPOINT,
      checkpoint_kind: "specification_phase_approval",
      loop_iteration: 1,
    },
  };
}

function deriveStagedDecisionWal(
  root: string,
  pending: PreparationDecision,
  mutate?: (transaction: Record<string, unknown>) => void,
): string {
  const selected = resolveState(root, undefined, { feature_id: pending.feature_id, run_key: pending.run_key });
  assert.ok(selected.state && selected.statePath && selected.stateDir && selected.artifactsDir, "staged WAL fixture must resolve the canonical feature state");
  if (!selected.state || !selected.statePath || !selected.stateDir || !selected.artifactsDir) throw new Error("staged WAL fixture state unavailable");
  const answerId = pending.trusted_answer_ref;
  const sourceState: TeamState = {
    ...selected.state,
    trusted_checkpoint_answers: (selected.state.trusted_checkpoint_answers ?? []).map((answer) => {
      if (answer.answer_id !== answerId) return answer;
      const { consumed_at: _consumedAt, ...unconsumed } = answer;
      return unconsumed;
    }),
  };
  const sourceContent = `${JSON.stringify(sourceState, null, 2)}\n`;
  writeFileSync(selected.statePath, sourceContent, "utf8");
  const transactionDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
  const transactionFile = readdirSync(transactionDir).find((entry) => entry.endsWith(".json"));
  assert.ok(transactionFile, "production must publish a decision WAL before staging the fixture");
  if (!transactionFile) throw new Error("staged WAL fixture transaction is unavailable");
  const transactionPath = join(transactionDir, transactionFile);
  const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as Record<string, unknown>;
  const comparable = (state: TeamState): TeamState => {
    const copy = { ...state };
    delete copy.updated_at;
    delete copy.state_revision;
    return copy;
  };
  const gate = readProjectConstitutionGate(root);
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  if (!gate.ok || !gate.value.binding || !gate.value.provider) throw new Error("staged WAL fixture constitution gate is unavailable");
  transaction.constitution_snapshot = {
    gate_id: gate.value.gate_id,
    status: gate.value.status,
    checkpoint_ref: gate.value.checkpoint_ref,
    resume_marker: gate.value.resume_marker,
    provider: { ...gate.value.provider },
    binding: { ...gate.value.binding },
  };
  transaction.staged_states = [{
    feature_id: pending.feature_id,
    run_key: pending.run_key,
    mutation_id: `${String(transaction.transaction_id)}:${pending.feature_id}:${pending.run_key}`,
    state: selected.state,
    source_content: sourceContent,
    source_state: sourceState,
    source_logical_digest: sha256Hex(canonicalJson(comparable(sourceState))),
    applied: false,
    target: {
      statePath: selected.statePath,
      stateDir: selected.stateDir,
      artifactsDir: selected.artifactsDir,
      isLegacy: false,
    },
    source_digest: sha256Hex(sourceContent),
    target_digest: sha256Hex(canonicalJson(comparable(selected.state))),
  }];
  mutate?.(transaction);
  writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
  return transactionPath;
}

/** Issue the same canonical answer and typed decision that generic workflow tools persist. */
async function issueGenericPhaseDecision(
  root: string,
  featureId: string,
  phase: Phase,
  answerId: string,
  decisionValue: PreparationDecision["decision"] = "approve_continue",
): Promise<PreparationDecision> {
  return issueCanonicalDecision(root, featureId, phase, decisionValue, answerId);
}

/** Consume one issued answer before arming another phase/capability. */
async function recordCanonicalDecision(
  root: string,
  featureId: string,
  phase: Phase,
  value: PreparationDecision["decision"],
  answerId: string,
): Promise<DecisionsResult> {
  const entry = await issueCanonicalDecision(root, featureId, phase, value, answerId);
  return recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [entry] });
}

async function setupResidentPreparation(root: string): Promise<WorkIdentity> {
  const identity: WorkIdentity = {
    run_id: CTO_RUN_ID,
    wave_id: "wave-cto-preparation",
    slice_id: "slice-cto-preparation",
    session_id: PREPARATION_RUNTIME_SESSION,
    workflow: "spec-preparation",
    stage_id: "preparation",
    stage_cursor: "preparation",
    capability_id: "capability-cto-preparation",
    capability_epoch: "epoch-cto-preparation",
    slot_id: "cto",
    task_id: "task-cto-preparation",
    dispatch_id: "dispatch-cto-preparation",
    attempt: 1,
    worker_id: "cto",
  };
  const featureRoot = join(root, ".work-state", "features");
  const featureIds = readdirSync(featureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(featureIds.length > 0, "terminal preparation fixture requires at least one feature");

  // A terminal CTO advance is admissible only after every scheduled feature
  // has the complete Specify/Plan/Tasks decision set. Existing terminal tests
  // seed Tasks first so this fixture fills the two earlier phases with the
  // same canonical trusted-answer path.
  for (const featureId of featureIds) {
    await recordCanonicalDecision(root, featureId, "specify", "approve_continue", `answer-${featureId}-specify`);
    await recordCanonicalDecision(root, featureId, "plan", "approve_continue", `answer-${featureId}-plan`);
    const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `${featureId}-run` });
    assert.ok(selected.state && selected.statePath, "canonical preparation fixture must resolve feature state");
    const workspace = selected.state.specification ?? preparationWorkspace(root, featureId);
    const handoff = validImplementationHandoff({ featureId });
    handoff.execution_choices = ["cto"];
    handoff.constitution_binding = workspace.constitution_binding!;
    handoff.handoff_digest = canonicalHandoffDigest(handoff);
    const readyWorkspace = {
      ...workspace,
      status: "implementation_ready" as const,
      handoff_ref: handoff.handoff_id,
      constitution_binding: handoff.constitution_binding,
      phases: workspace.phases.map((phase) => ({
        ...phase,
        status: "approved" as const,
        current_version: 1,
        approved_version: 1,
        validation_ref: `validation.${phase.phase}.v1`,
        checkpoint_ref: `checkpoint.${phase.phase}.v1`,
      })),
    };
    const handoffDir = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff");
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(join(handoffDir, `${handoff.handoff_id}.json`), JSON.stringify(handoff) + "\n");
    writeState(root, { ...selected.state, specification: readyWorkspace }, { target: selected });
  }

  const state = newCtoState({
    id: CTO_RUN_ID,
    task: "resident specification preparation",
    branch: "test",
    autonomous: false,
    plan: { id: CTO_RUN_ID, task: "resident specification preparation", teams: [], created_at: new Date().toISOString() },
    standby: true,
    owner_session: PREPARATION_RUNTIME_SESSION,
  });
  const preparationState = state as typeof state & {
    preparation_digest: string;
    preparation_features: Array<{
      request_id: string;
      feature_id: string;
      run_key: string;
      workspace_path: string;
      state_path: string;
      profile_name: string;
      profile_hash: string;
      phase_writer_id: string;
      facets: string[];
      request: string;
    }>;
    preparation_queued: [];
    preparation_capability: ReturnType<typeof createCapability>["state"];
  };
  preparationState.preparation_features = featureIds.map((featureId) => ({
    request_id: `${featureId}-primary-specify`,
    feature_id: featureId,
    run_key: `${featureId}-run`,
    workspace_path: `specs/${featureId}`,
    state_path: `.work-state/features/${featureId}/state.json`,
    profile_name: SHIPPED_PREPARATION_PROFILE.name,
    profile_hash: SHIPPED_PREPARATION_PROFILE_HASH,
    phase_writer_id: `cto-writer-${sha256Hex(`${featureId}\u0000specify`).slice(0, 16)}`,
    facets: ["primary"],
    request: `prepare ${featureId}`,
  }));
  preparationState.preparation_queued = [];
  const capability = createCapability({
    run_key: CTO_RUN_ID,
    branch: "test",
    workflow: "spec-preparation",
    profile_hash: SHIPPED_PREPARATION_PROFILE_HASH,
    stage_cursor: "specification-preparation",
    kind: "single",
    expected_roster: [{ role: "cto", agent: "cto" }],
  });
  preparationState.preparation_digest = sha256Hex(canonicalJson({
    cto_run_id: CTO_RUN_ID,
    task: state.task,
    branch: state.branch,
    wave_id: identity.wave_id,
    source_id: "specification-preparation-source",
    features: preparationState.preparation_features,
    queued: preparationState.preparation_queued,
  }));
  preparationState.preparation_capability = capability.state;
  preparationState.work_identity = identity;
  preparationState.teams = preparationState.preparation_features.map((feature) => ({
    id: `preparation-${feature.request_id}`,
    status: "pending" as const,
    escalations: {},
    feature_id: feature.feature_id,
    run_key: feature.run_key,
    task_id: feature.request_id,
    team_def_id: "specification",
    slice_id: feature.phase_writer_id,
    workflow: "spec-preparation",
    classification: { ...CTO_SPECIFICATION_PREPARATION_CLASSIFICATION },
    work_identity: identity,
  }));
  const admitted = applyAppendWaveTransition(preparationState, {
    id: identity.wave_id,
    source: "specification-preparation",
    source_id: "specification-preparation-source",
    task: "coordinate specification preparation",
    slice_ids: preparationState.preparation_features.map((feature) => feature.phase_writer_id),
    work_identity: identity,
  });
  const runtime = openPreparationRuntime(root);
  try {
    const created = runtime.access.createRun(admitted, {
      source_id: "specification-preparation-source",
      initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(admitted),
    });
    assert.equal(created.id, CTO_RUN_ID, "authenticated preparation fixture must create the expected CTO run");
  } finally {
    runtime.release();
  }
  const persisted = readCtoState(CTO_RUN_ID, root);
  assert.ok(persisted, "canonical preparation fixture must survive strict state write/read validation");
  if (!persisted) throw new Error("canonical preparation fixture could not be read after write");
  return identity;
}
import {
  bindFeatureWorkspaceToRoot,
  validConstitutionBinding,
  validFeatureWorkspace,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";

function teamDef(id: string, scope: string[]): TeamDef {
  return { id, name: id, scope, profile: "standard", lead: "developer", roster: ["developer"] };
}

describe("CTO preparation TeamDef candidate derivation", () => {
  test("unions path ownership with exact feature ownership and fails closed", async () => {
    const cases: Array<{
      name: string;
      featureId: string;
      affectedScope: string[];
      defs: TeamDef[];
      teams: string[];
      reason?: "unmatched" | "ambiguous";
      candidates?: string[];
    }> = [
      {
        name: "path containment",
        featureId: "preparation-path-containment",
        affectedScope: ["src/deep/feature.ts"],
        defs: [teamDef("team-path", ["src"]), teamDef("team-prefix", ["preparation-path"])],
        teams: ["team-path"],
      },
      {
        name: "exact feature fallback",
        featureId: "preparation-exact-owner",
        affectedScope: ["src/deep/feature.ts"],
        defs: [teamDef("team-exact", ["preparation-exact-owner"]), teamDef("team-unrelated", ["other-feature"])],
        teams: ["team-exact"],
      },
      {
        name: "duplicate exact owners",
        featureId: "preparation-ambiguous-owner",
        affectedScope: ["src/deep/feature.ts"],
        defs: [teamDef("team-exact-b", ["preparation-ambiguous-owner"]), teamDef("team-exact-a", ["preparation-ambiguous-owner"])],
        teams: [],
        reason: "ambiguous",
        candidates: ["team-exact-a", "team-exact-b"],
      },
      {
        name: "no owner",
        featureId: "preparation-no-owner",
        affectedScope: ["src/deep/feature.ts"],
        defs: [teamDef("team-unrelated", ["other-feature"])],
        teams: [],
        reason: "unmatched",
        candidates: [],
      },
    ];

    for (const scenario of cases) {
      const root = freshProject();
      try {
        writeDerivationHandoff(root, scenario.featureId, scenario.affectedScope);
        const result = derivePreparationFixture(root, scenario.featureId, scenario.defs);
        assert.deepEqual(result.teams.map((team) => team.team), scenario.teams, `${scenario.name}: derived teams`);
        if (scenario.reason) {
          assert.equal(result.unresolved.length, 1, `${scenario.name}: one unresolved task`);
          assert.equal(result.unresolved[0]?.reason, scenario.reason, `${scenario.name}: fail-closed reason`);
          assert.deepEqual(result.unresolved[0]?.candidates.map((candidate) => candidate.id), scenario.candidates, `${scenario.name}: deterministic candidates`);
        } else {
          assert.deepEqual(result.unresolved, [], `${scenario.name}: no unresolved task`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
test("derives canonical feature-local evidence ids and paths in the task DoD contract", async () => {
  const root = freshProject();
  const featureId = "preparation-evidence-contract";
  try {
    writeDerivationHandoff(root, featureId, ["src/deep/feature.ts"]);
    const result = derivePreparationFixture(root, featureId, [teamDef("team-feature", [featureId])]);
    const item = result.teams[0]?.dod.items[0];
    assert.ok(item, "a uniquely owned handoff task must derive one DoD item");
    assert.match(item.verify_method, /focused test run proving the outcome/u, "handoff evidence remains in verify_method");
    assert.match(item.verify_method, new RegExp(`conformance_evidence-${featureId}`));
    assert.match(item.verify_method, new RegExp(`\\.work-state/features/${featureId}/artifacts/conformance_evidence-${featureId}\\.json`));
    assert.match(item.verify_method, new RegExp(`quality_gate_evidence-${featureId}`));
    assert.match(item.verify_method, new RegExp(`\\.work-state/features/${featureId}/artifacts/quality_gate_evidence-${featureId}\\.json`));
    assert.ok(item.verify_method.includes("canonical conformance envelope top-level keys exactly {schema_version,artifact_id,entries}"));
    assert.ok(item.verify_method.includes("canonical quality-gate envelope top-level keys exactly {schema_version,artifact_id,gates}"));
    assert.ok(item.verify_method.includes("no extra top-level source_artifact, kind, source, or gate fields"));
    assert.match(item.verify_method, /quality gate evidence MUST be written first[\s\S]*supporting runtime_test_evidence-<feature_id>\.json conformance_evidence envelope[\s\S]*inner executed_test refs point to that quality ref[\s\S]*finally write conformance_evidence-<feature_id>\.json[\s\S]*outer executed_test refs point to the supporting runtime envelope[\s\S]*never rewrite referenced artifacts/u);
    assert.match(item.verify_method, /standalone implementation_evidence-\* and runtime_test_evidence-\* refs outside that typed envelope are forbidden/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds derived evidence ids independently for each selected feature", async () => {
  const root = freshProject();
  const firstFeature = "preparation-evidence-first";
  const secondFeature = "preparation-evidence-second";
  try {
    writeDerivationHandoff(root, firstFeature, ["src/deep/feature.ts"]);
    writeDerivationHandoff(root, secondFeature, ["src/deep/feature.ts"]);
    const result = derivePreparationFixture(root, firstFeature, [teamDef("team-first", [firstFeature])]);
    const secondResult = derivePreparationFixture(root, secondFeature, [teamDef("team-second", [secondFeature])]);
    const firstMethod = result.teams[0]?.dod.items[0]?.verify_method ?? "";
    const secondMethod = secondResult.teams[0]?.dod.items[0]?.verify_method ?? "";
    assert.notEqual(firstMethod, secondMethod);
    assert.match(firstMethod, /conformance_evidence-preparation-evidence-first/u);
    assert.match(secondMethod, /conformance_evidence-preparation-evidence-second/u);
    assert.doesNotMatch(firstMethod, /conformance_evidence-preparation-evidence-second/u);
    assert.doesNotMatch(secondMethod, /conformance_evidence-preparation-evidence-first/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
describe("CTO specification preparation scheduling", () => {
  test("schedules independent feature workspaces concurrently", async () => {
    const result = schedule(scheduleInput([
      request("feature-a", "specify"),
      request("feature-b", "specify"),
    ], { capacity: 2 }));

    assert.deepEqual(result.queued, []);
    assert.deepEqual(result.scheduled.map(({ feature_id, phase }) => `${feature_id}:${phase}`), [
      "feature-a:specify",
      "feature-b:specify",
    ]);
    assert.equal(result.scheduled[0]?.phase_writer_id !== result.scheduled[1]?.phase_writer_id, true);
    assert.equal(Object.keys(result.phase_writers).length, 2);
  });

  test("serializes facets behind one writer for the same feature and phase", async () => {
    const result = schedule(scheduleInput([
      request("feature-c", "specify", "billing"),
      request("feature-c", "specify", "payments"),
    ], { capacity: 2 }));

    assert.equal(result.scheduled.length, 1);
    assert.equal(result.queued.length, 1);
    assert.equal(result.queued[0]?.reason_code, "same_feature_serialized");
    assert.match(result.queued[0]?.reason ?? "", /feature-c|phase|writer/i);
    assert.equal(Object.keys(result.phase_writers).filter((key) => /feature-c.*specify/.test(key)).length, 1);
  });

  test("keeps queue reasons visible for capacity, depth, active phase, and ownership", async () => {
    const capacity = schedule(scheduleInput([
      request("feature-cap-a", "specify"),
      request("feature-cap-b", "specify"),
    ], { capacity: 1 }));
    assert.equal(capacity.scheduled.length, 1);
    assert.equal(capacity.queued.length, 1);
    assert.equal(capacity.queued[0]?.reason_code, "capacity");

    const depth = schedule(scheduleInput([request("feature-deep", "plan")], {
      depth: 2,
      max_depth: 2,
    }));
    assert.equal(depth.scheduled.length, 0);
    assert.equal(depth.queued[0]?.reason_code, "depth");

    const active = schedule(scheduleInput([request("feature-active", "plan", "primary", {
      active_phase: "specify",
    })]));
    assert.equal(active.scheduled.length, 0);
    assert.equal(active.queued[0]?.reason_code, "active_phase");

    const ownerConflict = schedule(scheduleInput([
      request("feature-owned", "specify", "primary", { owner_id: "writer-a" }),
      request("feature-other", "specify", "primary", { owner_id: "writer-a" }),
    ], { capacity: 2 }));
    assert.equal(ownerConflict.scheduled.length, 1);
    assert.equal(ownerConflict.queued[0]?.reason_code, "ownership");
    assert.match(ownerConflict.queued[0]?.reason ?? "", /owner|writer-a/i);
  });

  test("rejects zero, negative, non-integer, and unsafe capacities before scheduling", async () => {
    const requests = [request("feature-capacity", "specify")];
    for (const capacity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => schedule(scheduleInput(requests, { capacity })), /capacity/i, `capacity ${String(capacity)} must be rejected`);
    }
    const maxSafe = schedule(scheduleInput(requests, { capacity: Number.MAX_SAFE_INTEGER }));
    assert.equal(maxSafe.scheduled.length, 1);
    assert.deepEqual(schedule(scheduleInput([], { capacity: 0 })), { scheduled: [], queued: [], phase_writers: {} });
  });

  test("queues nested CTO attempts rather than creating another resident", async () => {
    const result = schedule(scheduleInput([request("feature-nested", "specify")], {
      cto_run_id: "nested-cto",
      resident_cto_run_id: CTO_RUN_ID,
      depth: 1,
    }));

    assert.equal(result.scheduled.length, 0);
    assert.equal(result.queued.length, 1);
    assert.equal(result.queued[0]?.reason_code, "nested_cto");
    assert.match(result.queued[0]?.reason ?? "", /resident|nested|cto/i);
  });

  test("rejects unsafe scheduler identity segments before deriving writers", async () => {
    const invalid: PreparationRequest[] = [
      request("safe-feature", "specify", "primary", { request_id: "../request" }),
      request("../escape", "specify"),
      request("safe-feature", "specify", "primary", { run_key: "../run" }),
      request("safe-feature", "specify", "facet/escape"),
      request("safe-feature", "specify", "primary", { profile_name: "profile/escape" }),
      request("safe-feature", "specify", "primary", { owner_id: "owner/escape" }),
    ];
    for (const candidate of invalid) {
      assert.throws(() => schedule(scheduleInput([candidate])), /canonical safe feature id|canonical non-reserved state id|must be "spec-preparation"/);
    }
  });
});

describe("CTO specification preparation decisions", () => {
  test("records independent trusted decisions per feature and phase", async () => {
    const root = freshProject();
    try {
      const specify = await recordCanonicalDecision(root, "feature-a", "specify", "approve_continue", "answer-a-specify");
      await recordCanonicalDecision(root, "feature-a", "plan", "approve_stop", "answer-a-plan");
      const result = await recordCanonicalDecision(root, "feature-b", "specify", "request_changes", "answer-b-specify");
      assert.equal(result.decisions.length, 3);
      assert.deepEqual(result.decisions.map(({ feature_id, phase, decision: value }) => `${feature_id}:${phase}:${value}`), [
        "feature-a:specify:approve_continue",
        "feature-a:plan:approve_stop",
        "feature-b:specify:request_changes",
      ]);
      assert.equal(new Set(result.decisions.map(({ trusted_answer_ref }) => trusted_answer_ref)).size, 3);
      for (const recorded of result.decisions) {
        assert.equal(recorded.trusted_proof.answer_id, recorded.trusted_answer_ref);
      }
      assert.equal(specify.decisions[0]?.trusted_proof.answer_id, specify.decisions[0]?.trusted_answer_ref);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("records a final synthesis over generic approved postimages idempotently and rejects stale retries", async () => {
    const root = freshProject();
    try {
      const decisions: PreparationDecision[] = [];
      for (const phase of ["specify", "plan", "tasks"] as const) {
        decisions.push(await issueGenericPhaseDecision(root, "feature-synthesis", phase, `answer-synthesis-${phase}`));
      }
      const first = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions });
      assert.equal(first.decisions.length, 3);
      assert.deepEqual(first.decisions.map(({ phase }) => phase), ["specify", "plan", "tasks"]);
      assert.ok(first.decisions.every(({ trusted_answer_ref, trusted_proof }) => trusted_answer_ref === trusted_proof.answer_id));

      const selected = resolveState(root, undefined, {
        feature_id: "feature-synthesis",
        run_key: "feature-synthesis-run",
      });
      assert.ok(selected.state && selected.statePath);
      if (!selected.state || !selected.statePath || !selected.state.specification) throw new Error("synthesis fixture state unavailable");
      const beforeRetry = selected.state;
      const retry = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions });
      assert.deepEqual(retry.decisions, first.decisions, "an exact final synthesis retry is idempotent");
      const afterRetry = resolveState(root, undefined, {
        feature_id: "feature-synthesis",
        run_key: "feature-synthesis-run",
      });
      assert.ok(afterRetry.state);
      assert.deepEqual(
        afterRetry.state?.specification?.phases,
        beforeRetry.specification.phases,
        "final synthesis does not re-project any generic phase",
      );

      const tampered = {
        ...afterRetry.state!,
        specification: {
          ...afterRetry.state!.specification!,
          phases: afterRetry.state!.specification!.phases.map((phase) =>
            phase.phase === "plan" ? { ...phase, checkpoint_ref: "checkpoint.plan.v2" } : phase,
          ),
        },
      };
      writeState(root, tampered, { target: afterRetry });
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions }),
        /CTO_SPEC_CHECKPOINT_STALE/,
        "an exact synthesis retry must revalidate the approved phase postimages",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("final synthesis rejects generic stop and revision outcomes even when proofs are trusted", async () => {
    const root = freshProject();
    try {
      const stopped = await issueGenericPhaseDecision(root, "feature-final-stop", "specify", "answer-final-stop", "approve_stop");
      const revised = await issueGenericPhaseDecision(root, "feature-final-revise", "plan", "answer-final-revise", "request_changes");
      const stoppedResult = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [stopped] });
      const revisedResult = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [revised] });
      assert.equal(stoppedResult.decisions[0]?.decision, "approve_stop");
      assert.equal(revisedResult.decisions[0]?.decision, "request_changes");
      const stoppedState = resolveState(root, undefined, { feature_id: "feature-final-stop", run_key: "feature-final-stop-run" }).state;
      const revisedState = resolveState(root, undefined, { feature_id: "feature-final-revise", run_key: "feature-final-revise-run" }).state;
      assert.equal(stoppedState?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "approved");
      assert.equal(stoppedState?.specification?.next_action.kind, "none");
      assert.match(stoppedState?.specification?.next_action.reason ?? "", /stopped|no next stage|implementation worker/iu);
      assert.equal(stoppedState?.preparation_start, undefined, "approve_stop never starts preparation execution");
      assert.equal(revisedState?.specification?.phases.find((phase) => phase.phase === "plan")?.status, "revision_required");
      assert.equal(revisedState?.specification?.next_action.kind, "command");
      assert.match(revisedState?.specification?.next_action.command ?? "", /spec-plan/);
      assert.equal(revisedState?.preparation_start, undefined, "request_changes never starts preparation execution");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves mixed review outcomes instead of applying one decision to all workspaces", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-pass", "tasks", "approve_continue", "answer-pass");
      await recordCanonicalDecision(root, "feature-revise", "tasks", "request_changes", "answer-revise");
      const result = await recordCanonicalDecision(root, "feature-stop", "tasks", "approve_stop", "answer-stop");
      const byFeature = new Map(result.decisions.map((entry) => [entry.feature_id, entry]));
      assert.equal(byFeature.get("feature-pass")?.decision, "approve_continue");
      assert.equal(byFeature.get("feature-revise")?.decision, "request_changes");
      assert.equal(byFeature.get("feature-stop")?.decision, "approve_stop");
      assert.notEqual(byFeature.get("feature-pass")?.trusted_answer_ref, byFeature.get("feature-revise")?.trusted_answer_ref);
      assert.notEqual(byFeature.get("feature-revise")?.trusted_answer_ref, byFeature.get("feature-stop")?.trusted_answer_ref);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects tampered and missing proofs instead of accepting proof-shaped DTOs", async () => {
    const root = freshProject();
    try {
      const issued = await issueCanonicalDecision(root, "feature-tampered", "specify", "approve_continue", "answer-tampered");
      const tampered = {
        ...issued,
        trusted_proof: { ...issued.trusted_proof, binding: "tampered-binding" },
      };
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [tampered] }),
        /CTO_SPEC_PROOF_INVALID|binding digest is invalid|binding is stale/,
      );

      const missingProof: Record<string, unknown> = { ...issued };
      delete missingProof.trusted_proof;
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [missingProof] }),
        /CTO_SPEC_PROOF_INVALID|trusted_proof/,
      );
      const selected = resolveState(root, undefined, { feature_id: "feature-tampered", run_key: "feature-tampered-run" });
      assert.ok(selected.state && selected.statePath, "feature-binding negative fixture must resolve state");
      if (!selected.state || !selected.statePath) return;
      const foreignIssued = await issueCanonicalDecision(root, "foreign-feature", "specify", "approve_continue", "answer-foreign-feature");
      const foreignProof = {
        ...issued,
        trusted_answer_ref: foreignIssued.trusted_answer_ref,
        trusted_proof: foreignIssued.trusted_proof,
      };
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [foreignProof] }),
        /feature identity|binding is stale|CTO_SPEC_PROOF_INVALID|CTO_SPEC_CHECKPOINT_STALE/,
      );

      const missingFeature = {
        ...issued,
        trusted_answer_ref: "answer-missing-feature",
        trusted_proof: { ...issued.trusted_proof, answer_id: "answer-missing-feature" },
      };
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [missingFeature] }),
        /feature identity|binding is stale|CTO_SPEC_PROOF_INVALID|CTO_SPEC_CHECKPOINT_STALE/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idempotently replays exact proofs while rejecting cross-run and stale-phase proofs", async () => {
    const root = freshProject();
    try {
      const replayed = await issueCanonicalDecision(root, "feature-replay", "specify", "approve_continue", "answer-replay");
      const firstReplay = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [replayed] });
      const secondReplay = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [replayed] });
      assert.deepEqual(secondReplay.decisions, firstReplay.decisions);
      assert.equal(readCtoSpecificationDecisions(root, CTO_RUN_ID).length, 1, "exact replay must not append a second ledger entry");

      const crossRun = await issueCanonicalDecision(root, "feature-cross-run", "specify", "approve_continue", "answer-cross-run");
      assert.throws(
        () => recordDecisions(root, {
          cto_run_id: CTO_RUN_ID,
          decisions: [{ ...crossRun, run_key: "foreign-run" }],
        }),
        /CTO_SPEC_WORKSPACE_MISMATCH|run identity|binding is stale/,
      );

      const stale = await issueCanonicalDecision(root, "feature-stale", "specify", "approve_continue", "answer-stale");
      armFeaturePhase(root, "feature-stale", "plan");
      assert.throws(
        () => recordDecisions(root, {
          cto_run_id: CTO_RUN_ID,
          decisions: [{ ...stale, phase: "plan", checkpoint_ref: "checkpoint.plan.v1" }],
        }),
        /CTO_SPEC_PROOF_INVALID|CTO_SPEC_PROOF_REPLAYED|stage identity|binding is stale|checkpoint.*phase|already consumed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains every exact phase decision in the durable ledger, not only the latest phase", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-history", "specify", "approve_continue", "answer-history-specify");
      await recordCanonicalDecision(root, "feature-history", "plan", "request_changes", "answer-history-plan");
      await recordCanonicalDecision(root, "feature-history", "tasks", "approve_stop", "answer-history-tasks");
      const persisted = readCtoSpecificationDecisions(root, CTO_RUN_ID);
      assert.deepEqual(
        persisted.map(({ phase, checkpoint_ref }) => `${phase}:${checkpoint_ref}`),
        [
          "specify:checkpoint.specify.v1",
          "plan:checkpoint.plan.v1",
          "tasks:checkpoint.tasks.v1",
        ],
      );
      assert.equal(new Set(persisted.map(({ trusted_answer_ref }) => trusted_answer_ref)).size, 3);
      assert.ok(persisted.every(({ trusted_answer_ref, trusted_proof }) => trusted_answer_ref === trusted_proof.answer_id));
    } finally {

      rmSync(root, { recursive: true, force: true });
    }
  });
  test("recovers a prepared decision exactly once across every reachable durable write boundary", async () => {
    const failurePoints = [
      "before_prepare",
      "after_prepare",
      "before_decisions_write",
      "before_decision_publish",
      "after_decisions_write",
      "after_commit",
    ] as const;

    for (const failurePoint of failurePoints) {
      const root = freshProject();
      try {
        const pending = await issueCanonicalDecision(
          root,
          `feature-recovery-${failurePoint}`,
          "specify",
          "approve_continue",
          `answer-recovery-${failurePoint}`,
        );
        let injected = false;
        setCtoSpecificationDecisionFailureInjector((point) => {
          if (!injected && point === failurePoint) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        });
        assert.throws(
          () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
          /injected|CTO_SPEC_DECISION_COMMIT_FAILED/,
        );
        if (failurePoint === "after_decisions_write") {
          assert.throws(
            () => readCtoSpecificationDecisions(root, CTO_RUN_ID),
            /CTO_SPEC_DECISIONS_PENDING/,
          );
        }
        setCtoSpecificationDecisionFailureInjector(null);

        const retry = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] });
        assert.equal(retry.decisions.length, 1);
        assert.equal(retry.decisions[0]?.trusted_answer_ref, pending.trusted_answer_ref);
        const selected = resolveState(root, undefined, {
          feature_id: pending.feature_id,
          run_key: pending.run_key,
        });
        const consumed = selected.state?.trusted_checkpoint_answers?.find(
          (answer) => answer.answer_id === pending.trusted_answer_ref,
        );
        assert.ok(consumed?.consumed_at, `${failurePoint} retry must durably consume its answer`);
        assert.deepEqual(readCtoSpecificationDecisions(root, CTO_RUN_ID), retry.decisions);
      } finally {
        setCtoSpecificationDecisionFailureInjector(null);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("cleans a fully published decision WAL after constitution drift without rewriting postimages", async () => {
    const root = freshProject();
    const featureId = "feature-recovery-complete-drift";
    try {
      const pending = await issueCanonicalDecision(root, featureId, "specify", "approve_continue", "answer-recovery-complete-drift");
      let staged = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point !== "after_prepare" || staged) return;
        staged = true;
        deriveStagedDecisionWal(root, pending);
        throw new Error("leave staged decision WAL");
      });
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
        /leave staged decision WAL/,
      );
      setCtoSpecificationDecisionFailureInjector(null);

      let interrupted = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point !== "after_commit" || interrupted) return;
        interrupted = true;
        throw new Error("leave fully published decision WAL");
      });
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
        /leave fully published decision WAL/,
      );
      setCtoSpecificationDecisionFailureInjector(null);

      const statePath = join(root, ".work-state", "features", featureId, "state.json");
      const decisionPath = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decisions.json");
      const stateAfterCommit = readFileSync(statePath);
      const decisionsAfterCommit = readFileSync(decisionPath);
      const constitutionPath = join(root, "CONSTITUTION.md");
      const driftedConstitution = PREPARATION_CONSTITUTION.replace("Ship tested work.", "Ship drifted work.");
      writeFileSync(constitutionPath, driftedConstitution, "utf8");

      const retry = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] });
      assert.deepEqual(retry.decisions.map(({ trusted_answer_ref }) => trusted_answer_ref), [pending.trusted_answer_ref]);
      assert.deepEqual(readFileSync(statePath), stateAfterCommit, "fully committed recovery must not rewrite the state postimage");
      assert.deepEqual(readFileSync(decisionPath), decisionsAfterCommit, "fully committed recovery must not rewrite the decision postimage");
      assert.equal(readFileSync(constitutionPath, "utf8"), driftedConstitution, "constitution drift must remain observable");
      const transactionDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
      assert.equal(readdirSync(transactionDir).filter((entry) => entry.endsWith(".json")).length, 0, "fully committed recovery must clean the exact WAL");
    } finally {
      setCtoSpecificationDecisionFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted multi-feature selection without cross-feature consumption", async () => {
    const root = freshProject();
    const firstFeature = "feature-batch-a";
    const secondFeature = "feature-batch-b";
    try {
      const first = await issueCanonicalDecision(root, firstFeature, "specify", "approve_continue", "answer-batch-a");
      const firstRecorded = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [first] });
      assert.equal(firstRecorded.decisions.length, 1);
      const second = armCanonicalPreparationCheckpoint(root, secondFeature, "specify");
      let mutated = false;
      setStateTransactionTestHooks({
        beforeCas: ({ sourcePath }) => {
          if (mutated) return;
          mutated = true;
          const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
          state.updated_at = new Date().toISOString();
          const temporary = sourcePath + ".foreign";
          writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
          renameSync(temporary, sourcePath);
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, second.input, "request_changes", `Review feedback for ${secondFeature}/specify.`);
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the interrupted later Ask must reject its state race");
      assert.match(String(rejected.error), /state moved|state transaction|checkpoint_failed|checkpoint_invalid/);
      assert.equal(resolveState(root, undefined, { feature_id: firstFeature, run_key: `${firstFeature}-run` }).state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "approved");
      const freshSecond = await issueCanonicalDecision(root, secondFeature, "specify", "request_changes", "answer-batch-b-fresh");
      const retry = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [freshSecond] });
      assert.deepEqual(retry.decisions.map(({ feature_id, decision: value }) => `${feature_id}:${value}`), [`${firstFeature}:approve_continue`, `${secondFeature}:request_changes`]);
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborts a staged decision on state CAS conflict and permits a fresh proof", async () => {
    const root = freshProject();
    const featureId = "feature-state-conflict";
    try {
      const armed = armCanonicalPreparationCheckpoint(root, featureId, "specify");
      let mutated = false;
      setStateTransactionTestHooks({
        beforeCas: ({ sourcePath }) => {
          if (mutated) return;
          mutated = true;
          const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
          state.updated_at = new Date().toISOString();
          const temporary = sourcePath + ".foreign";
          writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
          renameSync(temporary, sourcePath);
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, armed.input, "approve_continue");
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the selected Ask must reject a state CAS race");
      assert.match(String(rejected.error), /state moved|state transaction|checkpoint_failed|checkpoint_invalid/);

      const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `${featureId}-run` });
      assert.notEqual(selected.state?.updated_at, armed.state.updated_at, "the newer canonical state must survive the rejected Ask");
      const fresh = await issueCanonicalDecision(root, featureId, "specify", "approve_continue", "answer-state-conflict-fresh");
      const recorded = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [fresh] });
      assert.equal(recorded.decisions.length, 1, "a fresh authoritative answer must proceed after the rejected Ask");
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selected Ask preserves an earlier feature after a later CAS conflict without losing unrelated state", async () => {
    const root = freshProject();
    const firstFeature = "feature-batch-conflict-a";
    const secondFeature = "feature-batch-conflict-b";
    try {
      const first = await issueCanonicalDecision(root, firstFeature, "specify", "approve_continue", "answer-batch-conflict-a");
      const firstRecorded = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [first] });
      assert.equal(firstRecorded.decisions.length, 1);

      const second = armCanonicalPreparationCheckpoint(root, secondFeature, "specify");
      let mutated = false;
      setStateTransactionTestHooks({
        beforeCas: ({ sourcePath }) => {
          if (mutated) return;
          mutated = true;
          const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
          state.updated_at = new Date().toISOString();
          const temporary = sourcePath + ".foreign";
          writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
          renameSync(temporary, sourcePath);
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, second.input, "request_changes", `Review feedback for ${secondFeature}/specify.`);
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the later selected Ask must reject its state CAS race");
      assert.match(String(rejected.error), /state moved|state transaction|checkpoint_failed|checkpoint_invalid/);

      const firstState = resolveState(root, undefined, { feature_id: firstFeature, run_key: `${firstFeature}-run` });
      assert.equal(firstState.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "approved", "the earlier feature must remain approved");
      const secondState = resolveState(root, undefined, { feature_id: secondFeature, run_key: `${secondFeature}-run` });
      assert.notEqual(secondState.state?.updated_at, second.state.updated_at, "the unrelated newer state must survive the rejected Ask");

      const freshSecond = await issueCanonicalDecision(root, secondFeature, "specify", "request_changes", "answer-batch-conflict-b-fresh");
      const retry = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [freshSecond] });
      assert.deepEqual(retry.decisions.map(({ feature_id }) => feature_id), [firstFeature, secondFeature]);
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selected Ask rejects a replaced state inode without overwriting the replacement", async () => {
    const root = freshProject();
    const featureId = "feature-decision-same-byte-replacement";
    try {
      const armed = armCanonicalPreparationCheckpoint(root, featureId, "specify");
      let replaced = false;
      let replacementInode: number | null = null;
      let replacementBytes: Buffer | null = null;
      setStateTransactionTestHooks({
        beforeCas: ({ sourcePath }) => {
          if (replaced) return;
          replaced = true;
          const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
          state.updated_at = new Date().toISOString();
          const temporary = sourcePath + ".foreign";
          writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
          renameSync(temporary, sourcePath);
          replacementInode = statSync(sourcePath).ino;
          replacementBytes = readFileSync(sourcePath);
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, armed.input, "approve_continue");
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the selected Ask must reject a replaced state inode");
      assert.match(String(rejected.error), /state moved|state transaction|checkpoint_failed|checkpoint_invalid/);
      assert.equal(statSync(join(root, ".work-state", "features", featureId, "state.json")).ino, replacementInode, "the replacement inode must remain authoritative");
      assert.deepEqual(readFileSync(join(root, ".work-state", "features", featureId, "state.json")), replacementBytes, "the replacement bytes must remain untouched");
      assert.deepEqual(readCtoSpecificationDecisions(root, CTO_RUN_ID), [], "a rejected selected Ask must not publish a CTO decision WAL");
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selected Ask preserves an earlier state after a later replacement race", async () => {
    const root = freshProject();
    const firstFeature = "feature-state-same-byte-replacement-a";
    const secondFeature = "feature-state-same-byte-replacement-b";
    try {
      const first = await issueCanonicalDecision(root, firstFeature, "specify", "approve_continue", "answer-state-same-byte-replacement-a");
      const firstStateBefore = resolveState(root, undefined, { feature_id: firstFeature, run_key: `${firstFeature}-run` });
      assert.equal(firstStateBefore.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "approved");
      const second = armCanonicalPreparationCheckpoint(root, secondFeature, "specify");
      let replaced = false;
      let replacementInode: number | null = null;
      let replacementBytes: Buffer | null = null;
      setStateTransactionTestHooks({
        beforeCas: ({ sourcePath }) => {
          if (replaced) return;
          replaced = true;
          const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
          state.updated_at = new Date().toISOString();
          const temporary = sourcePath + ".foreign";
          writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
          renameSync(temporary, sourcePath);
          replacementInode = statSync(sourcePath).ino;
          replacementBytes = readFileSync(sourcePath);
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, second.input, "request_changes", `Review feedback for ${secondFeature}/specify.`);
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the later selected Ask must reject its replacement race");
      assert.match(String(rejected.error), /state moved|state transaction|checkpoint_failed|checkpoint_invalid/);
      const firstStateAfter = resolveState(root, undefined, { feature_id: firstFeature, run_key: `${firstFeature}-run` });
      assert.equal(firstStateAfter.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "approved", "the earlier feature must remain approved");
      const secondPath = join(root, ".work-state", "features", secondFeature, "state.json");
      assert.equal(statSync(secondPath).ino, replacementInode, "the later replacement inode must remain authoritative");
      assert.deepEqual(readFileSync(secondPath), replacementBytes, "the later replacement bytes must remain untouched");
      assert.equal(first.trusted_answer_ref, first.trusted_proof.answer_id);
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects forged decision WAL source/postimages and target paths before recovery writes", async () => {
    for (const forge of ["source", "postimage", "target"] as const) {
      const root = freshProject();
      const featureId = `feature-forged-wal-${forge}`;
      try {
        const pending = await issueCanonicalDecision(root, featureId, "specify", "approve_continue", `answer-forged-wal-${forge}`);
        let forged = false;
        setCtoSpecificationDecisionFailureInjector((point) => {
          if (point !== "after_prepare" || forged) return;
          forged = true;
          deriveStagedDecisionWal(root, pending, (transaction) => {
            const staged = (transaction.staged_states as Array<Record<string, unknown>>)[0];
            assert.ok(staged, "derived decision WAL must contain one staged feature state");
            if (!staged) return;
            if (forge === "source") {
              const forgedSource = {
                ...(staged.source_state as Record<string, unknown>),
                task: "forged decision source state",
              };
              staged.source_state = forgedSource;
              const digestState = { ...forgedSource };
              delete digestState.updated_at;
              delete digestState.state_revision;
              staged.source_logical_digest = sha256Hex(canonicalJson(digestState));
            } else if (forge === "postimage") {
              const forgedState = {
                ...(staged.state as Record<string, unknown>),
                task: "forged decision postimage",
              };
              staged.state = forgedState;
              const digestState = { ...forgedState };
              delete digestState.updated_at;
              delete digestState.state_revision;
              staged.target_digest = sha256Hex(canonicalJson(digestState));
            } else {
              const target = staged.target as Record<string, unknown>;
              target.stateDir = join(root, ".work-state", "features", "foreign-target");
            }
          });
          throw new Error(`injected forged ${forge} WAL`);
        });
        assert.throws(
          () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
          /injected forged/,
        );
        setCtoSpecificationDecisionFailureInjector(null);
        const statePath = join(root, ".work-state", "features", featureId, "state.json");
        const stateBeforeRecovery = readFileSync(statePath, "utf8");
        assert.throws(
          () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [] }),
          /CTO_SPEC_TRANSACTION_INVALID|source state content|source state|postimage state|canonical feature state path/,
        );
        assert.equal(readFileSync(statePath, "utf8"), stateBeforeRecovery, `${forge} forged WAL recovery must not mutate feature state`);
        assert.equal(existsSync(join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decisions.json")), false, `${forge} forged WAL must not publish decisions`);
      } finally {
        setCtoSpecificationDecisionFailureInjector(null);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  test("recovers a maximal structurally valid decision WAL and fails closed on an oversized pending WAL", async () => {
    const largeArtifacts = (count: number, payloadBytes: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`artifact-${String(index).padStart(4, "0")}`, "x".repeat(payloadBytes)]),
    );
    const prepare = async (root: string, featureId: string, artifacts: Record<string, string>): Promise<PreparationDecision> => {
      const issued = armFeaturePhase(root, featureId, "specify");
      const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `${featureId}-run` });
      assert.ok(selected.state && selected.statePath);
      if (!selected.state || !selected.statePath) throw new Error("large WAL fixture state unavailable");
      const largeState = { ...selected.state, artifacts };
      writeState(root, largeState, { target: selected });
      const details = await mountedPreparationCheckpointAsk(root, {
        feature_id: featureId,
        advance_token: issued.advance_token,
        capability_id: issued.capability_id,
        run_key: featureId + "-run",
        branch: largeState.branch,
        workflow: SHIPPED_PREPARATION_PROFILE.name,
        profile_hash: largeState.profile_hash!,
        stage_cursor: "specify",
        cursor_epoch: issued.state.issued_for!.cursor_epoch,
        checkpoint: SPECIFICATION_CHECKPOINT,
        checkpoint_id: SPECIFICATION_CHECKPOINT,
        checkpoint_kind: "specification_phase_approval",
        loop_iteration: 1,
      }, "approve_continue");
      assert.equal(details.ok, true, JSON.stringify(details));
      const persisted = details.persisted_decision;
      assert.ok(persisted && typeof persisted === "object");
      const actor = (persisted as { actor?: unknown }).actor;
      const proof = actor && typeof actor === "object" ? (actor as { proof?: unknown }).proof : undefined;
      assert.ok(proof && typeof proof === "object");
      const trustedProof = proof as CheckpointAnswerProof;
      return decision(featureId, "specify", "approve_continue", trustedProof.answer_id, trustedProof);
    };

    const root = freshProject();
    const decisions: PreparationDecision[] = [];
    for (let index = 0; index < 64; index += 1) {
      decisions.push(await prepare(
        root,
        `feature-max-wal-${String(index).padStart(2, "0")}`,
        largeArtifacts(0, 1),
      ));
    }
    try {
      let leftPending = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point === "after_prepare" && !leftPending) {
          leftPending = true;
          deriveStagedDecisionWal(root, decisions[0]!);
          throw new Error("leave maximal WAL");
        }
      });
      assert.throws(() => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions }), /leave maximal WAL/);
      setCtoSpecificationDecisionFailureInjector(null);

      const transactionDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
      const transactionFile = readdirSync(transactionDir).find((entry) => entry.endsWith(".json"));
      assert.ok(transactionFile);
      const transactionPath = join(transactionDir, transactionFile!);
      const original = readFileSync(transactionPath);
      assert.ok(original.byteLength > 0, "maximal WAL must be non-empty");

      writeFileSync(transactionPath, Buffer.concat([original, Buffer.alloc(15 * 1024 * 1024, 0x20)]));
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions }),
        /pending transaction|byte bound|cannot read/u,
        "an over-bound pending WAL must be rejected before publication",
      );
      assert.equal(
        existsSync(join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decisions.json")),
        false,
        "an over-bound pending WAL must not publish decisions",
      );

      writeFileSync(transactionPath, original);
      const recovered = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions });
      assert.equal(recovered.decisions.length, 64);
      assert.equal(recovered.decisions[63]?.trusted_answer_ref, decisions[63]?.trusted_answer_ref);
    } finally {
      setCtoSpecificationDecisionFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }

    const nearRoot = freshProject();
    const nearFeatureId = "feature-near-limit-wal";
    const nearDecision = await prepare(nearRoot, nearFeatureId, largeArtifacts(300, 2 * 1024));
    try {
      let leftPending = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point === "after_prepare" && !leftPending) {
          leftPending = true;
          deriveStagedDecisionWal(nearRoot, nearDecision);
          throw new Error("leave near-limit WAL");
        }
      });
      assert.throws(() => recordDecisions(nearRoot, { cto_run_id: CTO_RUN_ID, decisions: [nearDecision] }), /leave near-limit WAL/);
      setCtoSpecificationDecisionFailureInjector(null);
      const transactionDir = join(nearRoot, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
      const transactionFile = readdirSync(transactionDir).find((entry) => entry.endsWith(".json"));
      assert.ok(transactionFile);
      const transactionPath = join(transactionDir, transactionFile!);
      const transactionBytes = readFileSync(transactionPath).byteLength;
      assert.ok(transactionBytes > 1.5 * 1024 * 1024, `near-limit WAL must retain a substantial staged payload (actual ${transactionBytes} bytes)`);
      const recovered = recordDecisions(nearRoot, { cto_run_id: CTO_RUN_ID, decisions: [nearDecision] });
      assert.equal(recovered.decisions[0]?.trusted_answer_ref, nearDecision.trusted_answer_ref);
    } finally {
      setCtoSpecificationDecisionFailureInjector(null);
      rmSync(nearRoot, { recursive: true, force: true });
    }
  });
  test("archives terminal WAL bytes but preserves a same-byte pending replacement", async () => {
    const root = freshProject();
    const featureId = "feature-terminal-same-byte-replacement";
    try {
      const pending = await issueCanonicalDecision(root, featureId, "specify", "approve_continue", "answer-terminal-same-byte-replacement");
      let leftPending = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point === "after_prepare" && !leftPending) {
          leftPending = true;
          throw new Error("leave terminal WAL pending");
        }
      });
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
        /leave terminal WAL pending/,
      );
      setCtoSpecificationDecisionFailureInjector(null);

      const transactionDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
      const pendingFile = readdirSync(transactionDir).find((entry) => entry.endsWith(".json"));
      assert.ok(pendingFile);
      const pendingPath = join(transactionDir, pendingFile!);
      const terminal = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
      terminal.status = "aborted";
      terminal.abort_reason = "decision_conflict";
      terminal.aborted_at = new Date().toISOString();
      terminal.terminal_at = new Date().toISOString();
      terminal.terminal_disposition = "preserved";
      writeFileSync(pendingPath, `${JSON.stringify(terminal, null, 2)}\n`, "utf8");

      let replaced = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point !== "before_terminal_history_remove" || replaced) return;
        replaced = true;
        const bytes = readFileSync(pendingPath);
        const originalIno = lstatSync(pendingPath).ino;
        unlinkSync(pendingPath);
        writeFileSync(pendingPath, bytes);
        assert.notEqual(lstatSync(pendingPath).ino, originalIno, "replacement pending WAL must have a distinct inode");
      });
      const recovered = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [] });
      setCtoSpecificationDecisionFailureInjector(null);
      assert.deepEqual(recovered.decisions, []);
      assert.equal(replaced, true, "the archival hook must run after the exact read and archive");
      assert.equal(existsSync(pendingPath), true, "same-byte replacement must remain pending");
      const historyDir = join(transactionDir, "history");
      assert.equal(readdirSync(historyDir).filter((entry) => entry.endsWith(".json")).length, 1, "exact read bytes must be archived once");

      const converged = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [] });
      assert.deepEqual(converged.decisions, []);
      assert.equal(existsSync(pendingPath), false, "the replacement is removed only on its own exact archival pass");
    } finally {
      setCtoSpecificationDecisionFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validates aborted WALs before filtering and recovers a sibling pending WAL", async () => {
    const root = freshProject();
    const featureId = "feature-terminal-wal-validation";
    try {
      const pending = await issueCanonicalDecision(root, featureId, "specify", "approve_continue", "answer-terminal-wal-validation");
      let injected = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (!injected && point === "after_prepare") {
          injected = true;
          deriveStagedDecisionWal(root, pending);
          throw new Error("leave sibling pending");
        }
      });
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
        /leave sibling pending/,
      );
      setCtoSpecificationDecisionFailureInjector(null);

      const transactionDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
      const pendingFile = readdirSync(transactionDir).find((entry) => entry.endsWith(".json"));
      assert.ok(pendingFile, "the sibling pending WAL must be durable");
      const pendingPath = join(transactionDir, pendingFile!);
      const original = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
      const decisionsPath = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decisions.json");

      const forgedPath = join(transactionDir, "forged-minimal.json");
      writeFileSync(forgedPath, JSON.stringify({
        schema_version: 1,
        status: "aborted",
        transaction_id: "forged-minimal",
        cto_run_id: CTO_RUN_ID,
      }), "utf8");
      assert.throws(
        () => readCtoSpecificationDecisions(root, CTO_RUN_ID),
        /CTO_SPEC_TRANSACTION_INVALID/,
        "a minimally-shaped aborted record must not suppress a sibling pending WAL",
      );
      assert.equal(existsSync(decisionsPath), false, "invalid terminal WAL must not publish decisions");
      unlinkSync(forgedPath);

      const digestMismatch = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
      digestMismatch.status = "aborted";
      digestMismatch.transaction_id = "forged-digest";
      digestMismatch.abort_reason = "decision_conflict";
      digestMismatch.aborted_at = new Date().toISOString();
      digestMismatch.terminal_at = new Date().toISOString();
      digestMismatch.terminal_disposition = "preserved";
      const digestStaged = (digestMismatch.staged_states as Array<Record<string, unknown>>)[0]!;
      digestStaged.mutation_id = `forged-digest:${featureId}:${featureId}-run`;
      digestStaged.target_digest = "f".repeat(64);
      const digestPath = join(transactionDir, "forged-digest.json");
      writeFileSync(digestPath, `${JSON.stringify(digestMismatch, null, 2)}\n`, "utf8");
      assert.throws(
        () => readCtoSpecificationDecisions(root, CTO_RUN_ID),
        /postimage state and target digest disagree|CTO_SPEC_TRANSACTION_INVALID/,
        "a terminal WAL with a mismatched postimage digest must block recovery",
      );
      assert.equal(existsSync(decisionsPath), false, "digest-invalid terminal WAL must not publish decisions");
      unlinkSync(digestPath);

      const validAborted = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
      validAborted.status = "aborted";
      validAborted.transaction_id = "valid-aborted";
      validAborted.abort_reason = "decision_conflict";
      validAborted.aborted_at = new Date().toISOString();
      validAborted.terminal_at = new Date().toISOString();
      validAborted.terminal_disposition = "preserved";
      const validStaged = (validAborted.staged_states as Array<Record<string, unknown>>)[0]!;
      validStaged.mutation_id = `valid-aborted:${featureId}:${featureId}-run`;
      writeFileSync(join(transactionDir, "valid-aborted.json"), `${JSON.stringify(validAborted, null, 2)}\n`, "utf8");

      const recovered = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] });
      assert.equal(recovered.decisions.length, 1, "a valid terminal WAL must be ignored while its sibling pending WAL recovers");
      assert.equal(recovered.decisions[0]?.trusted_answer_ref, pending.trusted_answer_ref);
      assert.ok(existsSync(decisionsPath), "sibling pending recovery must publish decisions after terminal validation");
    } finally {
      setCtoSpecificationDecisionFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("migrates more than the active pending WAL bound without starving a new transaction", async () => {
    const root = freshProject();
    const conflictFeature = "feature-many-terminal-wal";
    try {
      const pending = await issueCanonicalDecision(root, conflictFeature, "specify", "approve_continue", "answer-many-terminal-wal");
      let leftPending = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point !== "after_prepare" || leftPending) return;
        leftPending = true;
        deriveStagedDecisionWal(root, pending);
        throw new Error("leave conflict WAL");
      });
      assert.throws(() => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }), /leave conflict WAL/);
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point !== "after_feature_state_write") return;
        throw new Error("leave owned-receipt WAL");
      });
      assert.throws(
        () => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [pending] }),
        /leave owned-receipt WAL/,
      );
      setCtoSpecificationDecisionFailureInjector(null);
      const transactionDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions");
      const pendingFile = readdirSync(transactionDir).find((entry) => entry.endsWith(".json"));
      assert.ok(pendingFile, "the interrupted state publication must retain its WAL");
      const pendingPath = join(transactionDir, pendingFile!);
      const pendingTerminal = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
      pendingTerminal.status = "aborting";
      pendingTerminal.abort_reason = "state_conflict";
      pendingTerminal.aborted_at = new Date().toISOString();
      pendingTerminal.terminal_at = new Date().toISOString();
      pendingTerminal.terminal_disposition = "preserved";
      writeFileSync(pendingPath, `${JSON.stringify(pendingTerminal, null, 2)}\n`, "utf8");
      const archived = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [] });
      assert.deepEqual(archived.decisions, []);

      const historyDir = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-decision-transactions", "history");
      const historyFile = readdirSync(historyDir).find((entry) => entry.endsWith(".json"));
      assert.ok(historyFile, "the conflict must retain one terminal WAL in history");
      const archivedTerminal = JSON.parse(readFileSync(join(historyDir, historyFile!), "utf8")) as Record<string, unknown>;
      const staged = archivedTerminal.staged_states as Array<Record<string, unknown>>;
      for (let index = 0; index < 65; index += 1) {
        const transactionId = `legacy-terminal-${index}`;
        const copy = JSON.parse(JSON.stringify(archivedTerminal)) as Record<string, unknown>;
        copy.transaction_id = transactionId;
        copy.staged_states = staged.map((entry) => ({
          ...entry,
          mutation_id: `${transactionId}:${String(entry.feature_id)}:${String(entry.run_key)}`,
        }));
        writeFileSync(join(transactionDir, `${transactionId}.json`), `${JSON.stringify(copy, null, 2)}\n`, "utf8");
      }

      const next = await issueCanonicalDecision(root, "feature-after-terminal-history", "specify", "approve_continue", "answer-after-terminal-history");
      leftPending = false;
      setCtoSpecificationDecisionFailureInjector((point) => {
        if (point === "after_prepare" && !leftPending) {
          leftPending = true;
          throw new Error("leave new pending WAL");
        }
      });
      assert.throws(() => recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [next] }), /leave new pending WAL/);
      setCtoSpecificationDecisionFailureInjector(null);
      const pendingFiles = readdirSync(transactionDir).filter((entry) => entry.endsWith(".json"));
      assert.equal(pendingFiles.length, 1, "terminal history migration must leave only the new active pending WAL");
      const recovered = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [next] });
      assert.equal(recovered.decisions.length, 1);
      assert.equal(readdirSync(historyDir).filter((entry) => entry.endsWith(".json")).length, 66, "all terminal WALs must remain in history");
    } finally {
      setCtoSpecificationDecisionFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("recovers a selected Ask after a state transaction abort", async () => {
    const root = freshProject();
    const featureId = "feature-abort-selected-ask";
    try {
      const armed = armCanonicalPreparationCheckpoint(root, featureId, "specify");
      let mutated = false;
      setStateTransactionTestHooks({
        beforeCas: ({ sourcePath }) => {
          if (mutated) return;
          mutated = true;
          const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
          state.updated_at = new Date().toISOString();
          const temporary = sourcePath + ".foreign";
          writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
          renameSync(temporary, sourcePath);
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, armed.input, "approve_continue");
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the selected Ask must reject its aborted state transaction");
      assert.match(String(rejected.error), /state moved|state transaction|checkpoint_failed|checkpoint_invalid/);
      assert.deepEqual(readCtoSpecificationDecisions(root, CTO_RUN_ID), [], "an aborted selected Ask must not publish CTO decisions");

      const fresh = await issueCanonicalDecision(root, featureId, "specify", "approve_continue", "answer-abort-selected-fresh");
      const recorded = recordDecisions(root, { cto_run_id: CTO_RUN_ID, decisions: [fresh] });
      assert.equal(recorded.decisions.length, 1, "a fresh selected Ask must recover after the aborted transaction");
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selected Ask rejects a replaced root without touching the replacement", async () => {
    const root = freshProject();
    const movedRoot = root + ".opened";
    const replacement = freshProject();
    const replacementEntries = readdirSync(replacement);
    const featureId = "feature-abort-root-replaced";
    let swapped = false;
    try {
      const armed = armCanonicalPreparationCheckpoint(root, featureId, "specify");
      setStateTransactionTestHooks({
        beforeCas: () => {
          if (swapped) return;
          swapped = true;
          renameSync(root, movedRoot);
          symlinkSync(replacement, root, "dir");
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, armed.input, "approve_continue");
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "the selected Ask must reject a replaced root");
      assert.match(String(rejected.error), /root|pinned|checkpoint_failed|checkpoint_invalid/);
      assert.deepEqual(readdirSync(replacement), replacementEntries, "the replacement root must remain untouched");
      unlinkSync(root);
      renameSync(movedRoot, root);
      swapped = false;
      const selected = resolveState(root, undefined, { feature_id: featureId, run_key: featureId + "-run" });
      assert.ok(selected.state, "the original root must remain readable after restoration");
      assert.deepEqual(readCtoSpecificationDecisions(root, CTO_RUN_ID), [], "a replaced-root Ask must not publish a CTO decision");
    } finally {
      setStateTransactionTestHooks(null, root);
      if (swapped) {
        unlinkSync(root);
        renameSync(movedRoot, root);
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(movedRoot, { recursive: true, force: true });
      rmSync(replacement, { recursive: true, force: true });
    }
  });

  test("rechecks the exact constitution source before selected Ask publication", async () => {
    const root = freshProject();
    const featureId = "feature-constitution-drift-selected";
    try {
      const armed = armCanonicalPreparationCheckpoint(root, featureId, "specify");
      let changed = false;
      setStateTransactionTestHooks({
        beforeCas: () => {
          if (changed) return;
          changed = true;
          writeFileSync(join(root, "CONSTITUTION.md"), `${PREPARATION_CONSTITUTION}\nDrifted after selection.\n`, "utf8");
        },
      }, root);
      const rejected = await mountedPreparationCheckpointAsk(root, armed.input, "approve_continue");
      setStateTransactionTestHooks(null, root);
      assert.equal(rejected.ok, false, "selected Ask must reject constitution drift before publication");
      assert.match(String(rejected.error), /constitution|stale|checkpoint_failed|checkpoint_invalid/);
      assert.deepEqual(readCtoSpecificationDecisions(root, CTO_RUN_ID), [], "constitution drift must not publish a CTO decision");
    } finally {
      setStateTransactionTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CTO specification preparation terminal boundary", () => {
  test("engine resolves a distinct exact CTO marker for every scheduled feature", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-a", "tasks", "approve_continue", "answer-marker-a");
      await recordCanonicalDecision(root, "feature-b", "tasks", "approve_continue", "answer-marker-b");
      await setupResidentPreparation(root);
      const expectedA = buildCtoSliceMarker(CTO_RUN_ID, "cto-writer-" + sha256Hex("feature-a\u0000specify").slice(0, 16));
      const expectedB = buildCtoSliceMarker(CTO_RUN_ID, "cto-writer-" + sha256Hex("feature-b\u0000specify").slice(0, 16));
      assert.equal(resolveCtoSpecificationPreparationSliceMarker(root, "feature-a", "feature-a-run"), expectedA);
      assert.equal(resolveCtoSpecificationPreparationSliceMarker(root, "feature-b", "feature-b-run"), expectedB);
      assert.notEqual(expectedA, expectedB, "different features must never share a preparation slice marker");
      assert.equal(resolveCtoSpecificationPreparationSliceMarker(root, "feature-a", "feature-b-run"), null, "cross-feature selector must not resolve a marker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("returns a review packet and hard-stops after preparation without starting execution", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-a", "tasks", "approve_continue", "answer-final-a");
      await recordCanonicalDecision(root, "feature-b", "tasks", "approve_continue", "answer-final-b");
      await setupResidentPreparation(root);
      const result = advance(root, { cto_run_id: CTO_RUN_ID });

      assert.equal(result.execution_started, false);
      assert.equal(result.hard_stop, true);
      assert.match(result.review_packet_ref, /review|packet|cto/i);
      assert.ok(existsSync(result.review_packet_ref), "successful advance must return an existing packet path");
      const packet = readFileSync(result.review_packet_ref, "utf8");
      assert.match(packet, /# CTO Specification Review Packet/);
      for (const row of [
        "feature-a", "feature-b", "feature-a-run", "feature-b-run",
        "tasks", "approve_continue", "checkpoint.tasks.v1",
      ]) assert.match(packet, new RegExp(row.replace(/[.]/g, "\\.")), `packet must include exact row value ${row}`);
      const recorded = readCtoSpecificationDecisions(root, CTO_RUN_ID);
      for (const recordedDecision of recorded) {
        const heading = `## \`${recordedDecision.feature_id}\``;
        const sectionStart = packet.indexOf(heading);
        assert.ok(sectionStart >= 0, `packet must expose heading for ${recordedDecision.feature_id}`);
        const sectionEnd = packet.indexOf("\n## ", sectionStart + heading.length);
        const section = packet.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
        const row = section.split("\n").find((line) => line.startsWith("|")
          && line.includes(`\`${recordedDecision.phase}\``)
          && line.includes(`\`${recordedDecision.checkpoint_ref}\``)
          && line.includes(`\`${recordedDecision.trusted_answer_ref}\``));
        assert.ok(row, `packet table must bind ${recordedDecision.feature_id}/${recordedDecision.phase} to its checkpoint and answer`);
      }
      assert.deepEqual(result.features.map(({ feature_id }) => feature_id).sort(), ["feature-a", "feature-b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("durably closes the preparation wave and capability boundary", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-durable", "tasks", "approve_continue", "answer-durable");
      const identity = await setupResidentPreparation(root);
      const result = advance(root, { cto_run_id: CTO_RUN_ID });
      const finalized = readCtoState(CTO_RUN_ID, root);
      const wave = finalized?.wave_history?.find((entry) => entry.id === identity.wave_id);
      assert.equal(result.hard_stop, true);
      assert.equal(finalized?.active_wave_id, undefined);
      assert.equal(wave?.status, "done");
      assert.equal(finalized?.pending?.status, "succeeded");
      assert.equal(finalized?.pending?.identity.capability_id, identity.capability_id);
      assert.equal(finalized?.completion_envelope?.identity.capability_epoch, identity.capability_epoch);
      const replay = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.equal(replay.hard_stop, true);
      assert.equal(replay.execution_started, false);
      assert.equal(replay.review_packet_ref, result.review_packet_ref);
      assert.equal(readFileSync(replay.review_packet_ref, "utf8"), readFileSync(result.review_packet_ref, "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finalization reads a CTO state preimage above the legacy 1 MiB cap", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-large-cto-preimage", "tasks", "approve_continue", "answer-large-cto-preimage");
      await setupResidentPreparation(root);
      const state = readCtoState(CTO_RUN_ID, root);
      assert.ok(state);
      if (!state) throw new Error("large CTO preimage fixture state is missing");
      state.inbox_quarantine = Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [`quarantine-${String(index).padStart(4, "0")}`, {
          id: `quarantine-${index}`,
          hash: "a".repeat(64),
          received_at: "2026-09-06T00:00:00.000Z",
          by: "terminal",
          status: "quarantined" as const,
          reason: "x".repeat(1_024),
        }]),
      );
      writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
      const statePath = join(root, ".work-state", "cto", CTO_RUN_ID, "state.json");
      assert.ok(readFileSync(statePath).byteLength > 1024 * 1024);
      const finalized = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.equal(finalized.hard_stop, true);
      assert.equal(finalized.execution_started, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a terminal replay when the previously published packet is missing", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-missing-packet", "tasks", "approve_continue", "answer-missing-packet");
      await setupResidentPreparation(root);
      const first = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.ok(existsSync(first.review_packet_ref));
      rmSync(first.review_packet_ref);
      assert.throws(() => advance(root, { cto_run_id: CTO_RUN_ID }), /CTO_REVIEW_PACKET_MISSING/);
      const state = readCtoState(CTO_RUN_ID, root);
      assert.equal(state?.active_wave_id, undefined);
      assert.equal(state?.pending?.status, "succeeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replays one readable packet after crashes before and after each durable boundary", async () => {
    const failurePoints = [
      "before_artifact_write",
      "after_artifact_write",
      "before_state_write",
      "after_state_write",
    ] as const;
    for (const failurePoint of failurePoints) {
      const root = freshProject();
      try {
        await recordCanonicalDecision(root, "feature-replay", "tasks", "approve_continue", `answer-${failurePoint}`);
        await setupResidentPreparation(root);
        let injected = false;
        setCtoSpecificationPreparationFailureInjector((point) => {
          if (!injected && point === failurePoint) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        });
        assert.throws(() => advance(root, { cto_run_id: CTO_RUN_ID }), /injected/);
        setCtoSpecificationPreparationFailureInjector(null);

        const packetPath = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID, "specification-review-packet.md");
        if (failurePoint === "before_artifact_write") assert.equal(existsSync(packetPath), false);
        else assert.ok(existsSync(packetPath), `${failurePoint} must leave the published packet for replay`);
        const replay = advance(root, { cto_run_id: CTO_RUN_ID });
        assert.equal(replay.hard_stop, true);
        assert.equal(replay.execution_started, false);
        assert.equal(replay.review_packet_ref, packetPath);
        assert.ok(existsSync(replay.review_packet_ref));
        assert.match(readFileSync(replay.review_packet_ref, "utf8"), /feature-replay/);
        const packetFiles = readdirSync(join(root, ".work-state", "cto", CTO_RUN_ID)).filter((entry) => entry === "specification-review-packet.md");
        assert.deepEqual(packetFiles, ["specification-review-packet.md"], `${failurePoint} replay must retain one artifact/ref`);
        const replayedState = readCtoState(CTO_RUN_ID, root);
        assert.equal(replayedState?.active_wave_id, undefined, `${failurePoint} replay must close the preparation wave`);
        assert.equal(replayedState?.pending?.status, "succeeded", `${failurePoint} replay must publish one terminal state`);
      } finally {
        setCtoSpecificationPreparationFailureInjector(null);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("replays a post-commit packet WAL after constitution drift", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-post-commit-drift", "tasks", "approve_continue", "answer-post-commit-drift");
      await setupResidentPreparation(root);
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (point === "after_cto_state_write") throw new Error("injected after_cto_state_write");
      });
      assert.throws(() => advance(root, { cto_run_id: CTO_RUN_ID }), /injected after_cto_state_write/);
      setCtoSpecificationPreparationFailureInjector(null);
      const packetPath = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID, "specification-review-packet.md");
      const transactionPath = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID, "review-packet.transaction.json");
      assert.ok(existsSync(packetPath), "post-commit crash must leave the packet postimage");
      assert.ok(existsSync(transactionPath), "post-commit crash must leave the cleanup WAL");
      const committed = readCtoState(CTO_RUN_ID, root);
      assert.equal(committed?.active_wave_id, undefined, "post-commit crash must already have a terminal state");
      assert.equal(committed?.pending?.status, "succeeded", "post-commit crash must retain the committed terminal state");
      writeFileSync(join(root, "CONSTITUTION.md"), `${PREPARATION_CONSTITUTION}\nDrifted after terminal packet commit.\n`, "utf8");
      const replay = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.equal(replay.hard_stop, true);
      assert.equal(replay.execution_started, false);
      assert.equal(replay.review_packet_ref, packetPath);
      assert.equal(existsSync(packetPath), true, "constitution drift must not delete terminal evidence");
      assert.equal(existsSync(transactionPath), false, "terminal replay must remove only its cleanup WAL");
      const terminal = readCtoState(CTO_RUN_ID, root);
      assert.equal(terminal?.active_wave_id, undefined);
      assert.equal(terminal?.pending?.status, "succeeded");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("review packet crash child replays only its WAL-owned postimage", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-packet-crash-child", "tasks", "approve_continue", "answer-packet-crash-child");
      await setupResidentPreparation(root);
      const exitCode = await spawnCrashAfterReviewPacketWrite(root);
      assert.equal(exitCode, 73);
      const runDir = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID);
      const packetPath = join(runDir, "specification-review-packet.md");
      const transactionPath = join(runDir, "review-packet.transaction.json");
      assert.ok(existsSync(packetPath), "child crash must leave the packet postimage visible");
      assert.ok(existsSync(transactionPath), "child crash must leave the durable packet WAL");
      const replay = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.equal(replay.hard_stop, true);
      assert.equal(replay.review_packet_ref, packetPath);
      assert.equal(existsSync(transactionPath), false, "successful adoption must remove the packet WAL");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packet WAL replays after a crash between receipt capture and publication", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-packet-prepublish-crash", "tasks", "approve_continue", "answer-packet-prepublish-crash");
      await setupResidentPreparation(root);
      const exitCode = await spawnCrashBeforeReviewPacketPublish(root);
      assert.equal(exitCode, 74);
      const runDir = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID);
      const packetPath = join(runDir, "specification-review-packet.md");
      const transactionPath = join(runDir, "review-packet.transaction.json");
      assert.equal(existsSync(packetPath), false, "prepublication crash must not expose the packet");
      assert.ok(existsSync(transactionPath), "prepublication crash must retain the prepared WAL");
      const replay = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.equal(replay.hard_stop, true);
      assert.equal(replay.review_packet_ref, packetPath);
      assert.ok(existsSync(packetPath), "replay must publish the packet after cleaning the stale preparation");
      assert.equal(existsSync(transactionPath), false, "successful replay must retire the packet WAL");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packet rollback preserves a same-content concurrent replacement and fails closed", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-packet-same-content-race", "tasks", "approve_continue", "answer-packet-same-content-race");
      await setupResidentPreparation(root);
      const canonicalRoot = realpathSync(root);
      const runDir = join(canonicalRoot, ".work-state", "cto", CTO_RUN_ID);
      const packetPath = join(runDir, "specification-review-packet.md");
      const transactionPath = join(runDir, "review-packet.transaction.json");
      const statePath = join(runDir, "state.json");
      const stateBefore = readFileSync(statePath);
      let originalIno: number | null = null;
      let replacementIno: number | null = null;
      let injected = false;
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (injected || point !== "before_state_write") return;
        injected = true;
        const packetBytes = readFileSync(packetPath);
        originalIno = statSync(packetPath).ino;
        const replacementPath = join(runDir, "foreign-packet.md");
        writeFileSync(replacementPath, packetBytes);
        renameSync(replacementPath, packetPath);
        replacementIno = statSync(packetPath).ino;
        // Force the authenticated runtime state-proof/CAS check to abort after
        // packet publication; the extra newline preserves valid JSON while
        // changing exact bytes.
        writeFileSync(statePath, `${stateBefore.toString("utf8")}\n`);
      });
      assert.throws(() => advance(root, { cto_run_id: CTO_RUN_ID }), /CTO_STATE_CONFLICT|CTO delivery index proof does not authenticate the current index/);
      setCtoSpecificationPreparationFailureInjector(null);
      assert.notEqual(originalIno, replacementIno, "the concurrent replacement must publish a distinct inode");
      assert.ok(existsSync(transactionPath), "descriptor WAL must remain after ownership-safe rollback refusal");
      const foreignPacket = readFileSync(packetPath);
      writeFileSync(statePath, stateBefore);
      assert.throws(() => advance(root, { cto_run_id: CTO_RUN_ID }), /postimage ownership descriptor/);
      assert.deepEqual(readFileSync(packetPath), foreignPacket, "recovery must not clobber a same-content foreign inode");
      assert.equal(statSync(packetPath).ino, replacementIno, "recovery must preserve the replacement inode");
      assert.ok(existsSync(transactionPath), "failed-closed recovery must retain the WAL for operator resolution");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes a concurrent wave append until preparation commits", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-race", "tasks", "approve_continue", "answer-race");
      const identity = await setupResidentPreparation(root);
      const packetPath = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID, "specification-review-packet.md");
      let appendPromise: Promise<void> | undefined;
      let appendError: unknown;
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (point !== "before_artifact_write" || appendPromise) return;
        appendPromise = new Promise<void>((resolve) => {
          queueMicrotask(() => {
            const runtime = openPreparationRuntime(root);
            try {
              runtime.access.withRunTransaction(CTO_RUN_ID, (transaction) => {
                const concurrent = transaction.readState();
                assert.equal(concurrent.id, CTO_RUN_ID, "the concurrent append must start from the canonical CTO state");
                transaction.appendWave({
                  id: "wave-concurrent-inbox",
                  source: "inbox",
                  source_id: "inbox-concurrent-wave",
                  task: "concurrent inbox work",
                });
              });
              appendError = new Error("concurrent append unexpectedly succeeded");
            } catch (error) {
              appendError = error;
            } finally {
              runtime.release();
              resolve();
            }
          });
        });
      });

      const result = advance(root, { cto_run_id: CTO_RUN_ID });
      setCtoSpecificationPreparationFailureInjector(null);
      assert.equal(result.hard_stop, true, "preparation must commit before the queued append acquires the lock");
      const canonicalRoot = realpathSync(root);
      const statePath = join(canonicalRoot, ".work-state", "cto", CTO_RUN_ID, "state.json");
      const indexPath = join(canonicalRoot, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
      const stateBytesBeforeAppend = readFileSync(statePath, "utf8");
      const indexBeforeAppend = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
      await appendPromise;
      assert.match(String(appendError), /cannot append wave to a terminal CTO run/u);

      const stateBytesAfterAppend = readFileSync(statePath, "utf8");
      const indexAfterAppend = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
      assert.equal(stateBytesAfterAppend, stateBytesBeforeAppend, "rejected append must not mutate terminal state/history/revision");
      assert.equal(indexAfterAppend, indexBeforeAppend, "rejected append must not mutate the delivery index");
      const afterRace = readCtoState(CTO_RUN_ID, root);
      assert.equal(afterRace?.wave_history?.some((wave) => wave.id === identity.wave_id && wave.status === "done"), true);
      assert.equal(afterRace?.wave_history?.some((wave) => wave.id === "wave-concurrent-inbox"), false);
      assert.ok(existsSync(packetPath), "the preparation packet must remain durable after the rejected append");
      const retry = advance(root, { cto_run_id: CTO_RUN_ID });
      assert.equal(retry.hard_stop, true, "retry must replay the terminal preparation state rather than reopening a wave");
      assert.equal(retry.execution_started, false);
      assert.equal(readFileSync(statePath, "utf8"), stateBytesAfterAppend, "terminal replay must not mutate state");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a differing existing packet without finalizing the preparation wave", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-collision", "tasks", "approve_continue", "answer-collision");
      const identity = await setupResidentPreparation(root);
      const packetPath = join(realpathSync(root), ".work-state", "cto", CTO_RUN_ID, "specification-review-packet.md");
      writeFileSync(packetPath, "tampered review packet\n");
      assert.throws(() => advance(root, { cto_run_id: CTO_RUN_ID }), /CTO_REVIEW_PACKET_COLLISION/);
      const state = readCtoState(CTO_RUN_ID, root);
      assert.equal(state?.active_wave_id, identity.wave_id);
      assert.equal(state?.pending?.status, undefined);
      assert.equal(readFileSync(packetPath, "utf8"), "tampered review packet\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid UTF-8 and handoff root or leaf swaps before dispatch", async () => {
    for (const kind of ["invalid-utf8", "leaf-swap", "root-swap"] as const) {
      const root = freshProject();
      const movedRoot = `${root}.moved`;
      const replacementRoot = kind === "root-swap" ? freshProject() : null;
      let movedLeaf: string | null = null;
      let rootSwapped = false;
      try {
        const featureId = `feature-handoff-${kind}`;
        await recordCanonicalDecision(root, featureId, "tasks", "approve_continue", `answer-${kind}`);
        const identity = await setupResidentPreparation(root);
        const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `${featureId}-run` });
        const handoffRef = selected.state?.specification?.handoff_ref;
        assert.ok(handoffRef, "ready workspace must carry a handoff reference");
        if (!handoffRef) return;
        const handoffPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${handoffRef}.json`);
        const handoffRelative = `.work-state/features/${featureId}/artifacts/implementation_handoff/${handoffRef}.json`;
        const handoffBytes = readFileSync(handoffPath);
        const statePath = join(root, ".work-state", "cto", CTO_RUN_ID, "state.json");
        const beforeState = readFileSync(statePath);
        const packetPath = join(root, ".work-state", "cto", CTO_RUN_ID, "specification-review-packet.md");
        if (kind === "invalid-utf8") {
          writeFileSync(handoffPath, Buffer.from([0xff, 0xfe, 0x7b]));
        } else {
          setCanonicalHandoffReadTestHooks({
            afterRead: ({ relative_path }) => {
              if (relative_path !== handoffRelative || rootSwapped) return;
              if (kind === "leaf-swap") {
                movedLeaf = `${handoffPath}.moved`;
                renameSync(handoffPath, movedLeaf);
                writeFileSync(handoffPath, handoffBytes);
              } else {
                assert.ok(replacementRoot);
                renameSync(root, movedRoot);
                symlinkSync(replacementRoot, root, "dir");
                rootSwapped = true;
              }
            },
          }, root);
        }
        assert.throws(
          () => advance(root, { cto_run_id: CTO_RUN_ID }),
          /not valid UTF-8|changed while it was being read|project root changed|canonical handoff.*unreadable/i,
          `${kind} must reject before dispatch`,
        );
        setCanonicalHandoffReadTestHooks(null, root);
        if (rootSwapped) {
          unlinkSync(root);
          renameSync(movedRoot, root);
          rootSwapped = false;
        }
        const afterState = readCtoState(CTO_RUN_ID, root);
        assert.equal(afterState?.active_wave_id, identity.wave_id, `${kind} must not dispatch or close the preparation wave`);
        assert.equal(afterState?.pending?.status, undefined, `${kind} must not publish a completion state`);
        assert.equal(existsSync(packetPath), false, `${kind} must not publish a review packet`);
      } finally {
        setCanonicalHandoffReadTestHooks(null, root);
        if (rootSwapped) {
          unlinkSync(root);
          renameSync(movedRoot, root);
        }
        if (movedLeaf) rmSync(movedLeaf, { force: true });
        rmSync(root, { recursive: true, force: true });
        rmSync(movedRoot, { recursive: true, force: true });
        if (replacementRoot) rmSync(replacementRoot, { recursive: true, force: true });
      }
    }
  });
  test("rejects symlinked feature state paths before building a review packet", async () => {
    const root = freshProject();
    const outside = mkdtempSync(join(tmpdir(), "cto-preparation-outside-"));
    try {
      await recordCanonicalDecision(root, "feature-symlink", "tasks", "approve_continue", "answer-symlink");
      await setupResidentPreparation(root);
      const featureDir = join(root, ".work-state", "features", "feature-symlink");
      rmSync(featureDir, { recursive: true, force: true });
      symlinkSync(outside, featureDir, "dir");
      assert.throws(
        () => advance(root, { cto_run_id: CTO_RUN_ID }),
        /symlinked feature state|symlinked state path|unsafe feature state|review packet.*could not be built/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  test("unscoped review still rejects traversal-like feature directory names", async () => {
    const root = freshProject();
    try {
      await recordCanonicalDecision(root, "feature-traversal", "tasks", "approve_continue", "answer-traversal");
      await setupResidentPreparation(root);
      mkdirSync(join(root, ".work-state", "features", "unsafe feature"), { recursive: true });
      writeFileSync(join(root, ".work-state", "features", "unsafe feature", "state.json"), "{}");
      const result = buildCtoSpecificationReviewPacketFromDecisionSnapshot(
        root,
        { cto_run_id: CTO_RUN_ID },
        readCtoSpecificationDecisions(root, CTO_RUN_ID),
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /unsafe feature directory name|unsafe feature state|review packet.*could not be built/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
