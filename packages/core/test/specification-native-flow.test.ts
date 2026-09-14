/**
 * Failing contract for the native Constitution → Specify → Plan → Tasks flow (T023).
 *
 * This file pins the observable native specification contracts that US1 must
 * ship before implementation. It is intentionally red against the current
 * tree: the zero-dependency constitution profile and template (T026), the
 * native Specify/Plan/Tasks stages of `spec-preparation` (T028), and the
 * typed draft/validation/status artifact schemas (T027) do not exist yet.
 * Everything asserted here uses the wave-001 public seams only:
 *   - profile registry/control plane (`loadProfile`, `profileHash`,
 *     `validateProfileControlPlane`, `resolveProfileControlPlane`)
 *   - specification workspace aggregate and deterministic next actions
 *     (`createFeatureWorkspace`, `bindWorkspaceConstitution`,
 *     `persistFeatureWorkspace`, `resolveFeatureWorkspace`,
 *     `nextActionForWorkspace`, `validateFeatureWorkspaceRecord`)
 *   - shipped specification templates and semantic markers
 *   - the durable capability/dispatch/advance ledger
 *   - canonical fixtures from `./fixtures/specification-fixtures.js`
 *
 * Coverage:
 *   - T026: zero-dependency constitution draft/revise/validate profile with
 *     the two-decision bootstrap checkpoint and framework-neutral template;
 *   - T028: declared blocking constitution prerequisite; explicit Specify →
 *     Plan → Tasks stage order before the handoff; subagent-authored stages
 *     producing typed drafts; per-phase hard-human checkpoints with exactly
 *     `approve_continue` / `request_changes` / `approve_stop`;
 *   - T027: typed `constitution_draft`, `specify_draft`, `plan_draft`,
 *     `task_graph`, `phase_validation`, and `specification_status` artifact
 *     schemas with worker attribution, upstream bindings, and constitution
 *     bindings on every validated draft;
 *   - T029: capability-bound dispatch — a forged dispatch token can never
 *     dispatch the armed `specify` stage, and the profile must arm `plan`
 *     after `specify` completes;
 *   - readable projections: shipped `status`/`specify`/`plan`/`tasks`/
 *     `constitution` templates carry stable `omp-spec:` markers and the
 *     status projection exposes phase status, approvals, and next action;
 *   - exact next actions: deterministic `/specify`, `/spec-plan`,
 *     `/spec-tasks` entry commands, checkpoint/remediation actions, and
 *     constitution-first sequencing on freshly created native workspaces.
 *
 * No production behavior is implemented here; these tests are the executable
 * specification the native slice implements against.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProfileDir,
  loadProfile,
  profileHash,
  resolveProfileControlPlane,
  validateProfileControlPlane,
} from "../src/engine/profile.js";
import { authorizeDispatch, authorizeSpecificationPhaseValidationDispatch, completeDispatch, createCapability, advanceCursor, issueTrustedMappingProof, projectNativeSpecificationPhaseDecision, setConstitutionContinuationGate, type DispatchAuth } from "../src/engine/durable.js";
import { appendCheckpointDecision, checkpointPolicyHash, issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, registerTrustedCheckpointHostBridge } from "../src/engine/checkpoints.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import type { Profile } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import {
  bindWorkspaceConstitution,
  createFeatureWorkspace,
  currentConstitutionBinding,
  persistFeatureWorkspace,
  resolveFeatureWorkspace,
} from "../src/specification/workspace.js";
import { loadShippedSpecificationTemplates, resolveSpecificationTemplate } from "../src/specification/templates.js";
import { parseConstitutionPrincipleIdentities, persistSpecificationPhaseResult, persistSpecificationPhaseValidation, renderCanonicalPhaseDocument, setSpecificationPhaseFailureInjector } from "../src/specification/phase.js";
import {
  digestOf,
  extractSemanticMarkers,
  isRecord,
  nextActionForWorkspace,
  validateFeatureWorkspaceRecord,
} from "../src/specification/validation.js";
import type { FeatureWorkspace, WorkspacePhaseRecord, WorkspaceUpstreamVersion } from "../src/specification/types.js";
import { sha256, validConstitutionBinding, validFeatureWorkspace } from "./fixtures/specification-fixtures.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { beginRegistryRegistration, closeRegistryRegistrationContext, commitRegistryRegistration, openWorkflowActivation, releaseWorkflowOwners, rollbackRegistryRegistration } from "../src/registry/owner.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { createPreparationHandoff, preparationStartPostimageDigest, preparationStateDigest } from "../src/engine/preparation.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

const NATIVE_CHECKPOINT_BRIDGE = Object.freeze({});
registerTrustedCheckpointHostBridge(NATIVE_CHECKPOINT_BRIDGE);

function registerNativeConstitutionGate(root: string, ownerId: string): () => void {
  const markerContent = "omp-core-test-registry-marker-v1";
  const markerPath = join(root, ".omp-test-registry-marker");
  writeFileSync(markerPath, markerContent);
  const markerDigest = sha256(markerContent);
  const owner = {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "private_omp" as const,
    activation_marker: `${ownerId}-activation`,
    activation: { marker_id: `${ownerId}-activation`, required: [{ path: ".omp-test-registry-marker", kind: "file" as const, sha256: markerDigest }] },
    host_range: ">=17.3 <19",
    provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
  };
  const activated = openWorkflowActivation(root, ["workflow_registration", "config_writer"], owner);
  if (!activated.ok) throw new Error(`${activated.code}: ${activated.error}`);
  const transaction = beginRegistryRegistration(activated.registry_context, root, ["constitution_gate"]);
  if (!transaction.ok) {
    closeRegistryRegistrationContext(activated.registry_context);
    releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  try {
    setConstitutionContinuationGate(transaction.token, () => null);
    commitRegistryRegistration(transaction.token);
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve original */ }
    closeRegistryRegistrationContext(activated.registry_context);
    releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
    throw error;
  }
  return () => {
    closeRegistryRegistrationContext(activated.registry_context);
    releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
  };
}

const SPEC_PROFILE = loadProfile("spec-preparation");
assert.ok(SPEC_PROFILE, "the shipped spec-preparation profile must load");

const PHASE_CHECKPOINT = "specification_phase_approval";
const EXACT_PHASE_DECISIONS = ["approve_continue", "request_changes", "approve_stop"] as const;

const NATIVE_PHASE_DRAFTS: ReadonlyArray<readonly [string, string]> = [
  ["specify", "specify_draft"],
  ["plan", "plan_draft"],
  ["tasks", "task_graph"],
];

const NO_RUNTIME: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };

function makeProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value) && value.every((entry) => typeof entry === "string"), `${label} must be a string array`);
  return value as string[];
}

function schemaDef(schema: Record<string, unknown>, id: string): Record<string, unknown> {
  const definitions = schema.definitions;
  assert.ok(isRecord(definitions), "artifacts-schema.json must carry definitions");
  const def = (definitions as Record<string, unknown>)[id];
  assert.ok(isRecord(def), `artifacts-schema.json must define the typed '${id}' artifact (T027)`);
  return def as Record<string, unknown>;
}

function requiredOf(def: Record<string, unknown>, id: string): string[] {
  return stringArray(def.required, `${id}.required`);
}

function propertiesOf(def: Record<string, unknown>, id: string): Record<string, unknown> {
  assert.ok(isRecord(def.properties), `${id}.properties must be an object`);
  return def.properties as Record<string, unknown>;
}

function recordField(source: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  const value = source[key];
  assert.ok(isRecord(value), `${label} must be an object schema`);
  return value;
}

function artifactsSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(findProfileDir(), "artifacts-schema.json"), "utf8")) as Record<string, unknown>;
}

function stageById(profile: Profile, id: string) {
  const stage = profile.stages.find((entry) => entry.id === id);
  assert.ok(stage, `the native profile must declare the '${id}' stage (T028)`);
  return stage;
}

function producesInclude(stage: Profile["stages"][number], artifactId: string): void {
  const produced = stage.produces;
  const ids = typeof produced === "string" ? [produced] : Array.isArray(produced) ? produced.map(String) : [];
  assert.ok(
    ids.includes(artifactId),
    `stage '${stage.id}' must declare '${artifactId}' in produces; got ${JSON.stringify(produced)}`,
  );
}

function phaseRecord(phase: WorkspacePhaseRecord["phase"], status: WorkspacePhaseRecord["status"]): WorkspacePhaseRecord {
  return {
    phase,
    status,
    current_version: status === "not_started" ? null : 1,
    approved_version: status === "approved" ? 1 : null,
    validation_ref: status === "not_started" ? null : `validation.${phase}.v1`,
    checkpoint_ref: status === "approved" ? `checkpoint.${phase}.v1` : null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  };
}

// ── T026: the zero-dependency constitution profile ───────────────────────────

test("the zero-dependency constitution profile ships draft, revise, and validate stages", () => {
  const profile = loadProfile("constitution");
  assert.ok(profile, "the shipped constitution profile (draft/revise/validate) must load (T026)");
  assert.deepEqual(
    profile.stages.map((stage) => stage.id),
    ["constitution_draft", "constitution_revise", "constitution_validate"],
    "the constitution profile must run draft → revise → validate in order",
  );
  const draft = stageById(profile, "constitution_draft");
  assert.equal(draft.type, "single", "the constitution draft is one declared subagent, not an orchestrator");
  assert.ok(typeof draft.role === "string" && draft.role.length > 0, "the draft stage must declare its worker role");
  assert.ok(typeof draft.prompt === "string" && draft.prompt.length > 0, "the draft stage must carry dispatch instructions");
  assert.equal(validateProfileControlPlane(profile).ok, true, "the constitution profile must pass the typed control plane");
  assert.equal(profile.completion_intent?.mode, "handoff_only");
  assert.equal(profile.completion_intent?.acceptance, "quality_gates_and_artifacts");
  const serialized = JSON.stringify(profile).toLowerCase();
  assert.doesNotMatch(
    serialized,
    /speckit|openspec|bmad|superpowers|xpowers/,
    "the native constitution profile must stay framework-neutral (zero dependencies)",
  );
});

test("the constitution bootstrap checkpoint allows exactly approve_continue and request_changes", () => {
  const profile = loadProfile("constitution");
  assert.ok(profile, "the shipped constitution profile must load (T026)");
  const validateStage = stageById(profile, "constitution_validate");
  assert.ok(
    typeof validateStage.checkpoint === "string" && validateStage.checkpoint.length > 0,
    "the validated constitution must open a named hard-human checkpoint",
  );
  const projection = resolveProfileControlPlane(profile, "constitution_validate");
  const rule = projection.checkpoint_rule;
  assert.ok(rule, "the constitution validate stage must resolve a typed checkpoint rule");
  assert.equal(rule.default, "required_human", "constitution approval is never autonomous");
  assert.equal(rule.phase, "before_advance");
  assert.deepEqual(
    rule.allowed_decisions,
    ["approve_continue", "request_changes"],
    "bootstrap allows exactly two decisions; approve_stop does not exist for the constitution",
  );
  assert.ok(
    (profile.checkpoint_policy?.hard_human ?? []).includes(rule.kind),
    "the constitution checkpoint must be listed as hard-human",
  );
});

test("the framework-neutral constitution template ships with stable semantic markers", () => {
  const templatePath = join(findProfileDir(), "templates", "constitution", "default.md");
  assert.ok(existsSync(templatePath), "the framework-neutral constitution template must ship (T026)");
  const content = readFileSync(templatePath, "utf8");
  assert.ok(content.trim().length > 0, "the constitution template must not be empty");
  const markers = extractSemanticMarkers(content);
  assert.ok(
    markers.length >= 2,
    `the constitution template must embed stable omp-spec: markers; found ${JSON.stringify(markers)}`,
  );
});

// ── T028: the native progression declared by spec-preparation ────────────────

test("the native profile declares a blocking constitution prerequisite bound to the bootstrap", () => {
  const declared = recordField(
    SPEC_PROFILE as unknown as Record<string, unknown>,
    "constitution_prerequisite",
    "spec-preparation.constitution_prerequisite (T028)",
  );
  assert.equal(declared.required, true, "the constitution prerequisite is always required before native phases");
  assert.equal(
    declared.bootstrap_profile,
    "constitution",
    "the prerequisite must name the shipped constitution bootstrap profile (T026)",
  );
  assert.deepEqual(
    declared.bootstrap_decisions,
    ["approve_continue", "request_changes"],
    "the declared bootstrap exposes exactly the two constitution decisions",
  );
});

test("native stages run specify, plan, and tasks in order before the specification handoff", () => {
  const ids = SPEC_PROFILE.stages.map((stage) => stage.id);
  assert.equal(new Set(ids).size, ids.length, "stage ids must be unique");
  for (const required of ["specify", "plan", "tasks"]) {
    assert.ok(ids.includes(required), `the native profile must declare the '${required}' stage (T028)`);
  }
  const position = (id: string): number => {
    const index = ids.indexOf(id);
    assert.ok(index >= 0, `'${id}' must exist`);
    return index;
  };
  assert.ok(
    position("specify") < position("plan") && position("plan") < position("tasks"),
    "native progression must run specify → plan → tasks in order",
  );
  const handoff = SPEC_PROFILE.stages.find((stage) => stage.id === "handoff");
  assert.ok(handoff, "the specification handoff stage must remain the terminal stage");
  assert.ok(position("tasks") < ids.indexOf("handoff"), "no phase may run after the handoff");
  assert.equal(handoff.type, "orchestrator");
  producesInclude(handoff, "spec_handoff");
  assert.ok(
    SPEC_PROFILE.match.type.includes("SPEC"),
    "the native profile must remain the SPEC-classification workflow",
  );
});

test("specify, plan, and tasks are subagent-authored stages producing typed draft artifacts", () => {
  for (const [phase, draftArtifact] of NATIVE_PHASE_DRAFTS) {
    const stage = stageById(SPEC_PROFILE, phase);
    assert.equal(stage.type, "single", `the ${phase} content is authored by one dispatched worker`);
    assert.ok(typeof stage.role === "string" && stage.role.length > 0, `the ${phase} stage must declare its worker role`);
    assert.ok(
      typeof stage.prompt === "string" && stage.prompt.length > 0,
      `the ${phase} stage must carry its authoring instructions`,
    );
    producesInclude(stage, draftArtifact);
  }
});

test("every native phase gates advancement behind the canonical hard-human checkpoint with exact decisions", () => {
  const policy = SPEC_PROFILE.checkpoint_policy;
  assert.ok(policy, "the native profile must declare its checkpoint policy");
  assert.deepEqual(policy.hard_human, [PHASE_CHECKPOINT], "only the canonical phase checkpoint is hard-human");
  assert.deepEqual(Object.keys(policy.rules), [PHASE_CHECKPOINT], "the profile declares one shared phase checkpoint rule");

  for (const phase of ["specify", "plan", "tasks"] as const) {
    const stage = stageById(SPEC_PROFILE, phase);
    assert.equal(stage.checkpoint, PHASE_CHECKPOINT, `the ${phase} stage references the canonical phase checkpoint`);
    const projection = resolveProfileControlPlane(SPEC_PROFILE, phase);
    const rule = projection.checkpoint_rule;
    assert.ok(rule, `the ${phase} stage must resolve a typed checkpoint rule (T028)`);
    assert.equal(rule.kind, PHASE_CHECKPOINT, `the ${phase} checkpoint uses the native phase-approval kind`);
    assert.equal(rule.default, "required_human", `the ${phase} approval is never autonomous`);
    assert.equal(rule.phase, "before_advance", `the ${phase} checkpoint gates advancement`);
    assert.deepEqual(
      rule.allowed_decisions,
      EXACT_PHASE_DECISIONS,
      `the ${phase} checkpoint exposes exactly the three phase decisions`,
    );
  }
});

// ── T027: typed draft, validation, and status artifact schemas ────────────────

test("typed draft schemas exist and require worker attribution and bindings", () => {
  const schema = artifactsSchema();
  const drafts = ["constitution_draft", ...NATIVE_PHASE_DRAFTS.map(([, artifact]) => artifact)];
  for (const id of drafts) {
    const def = schemaDef(schema, id);
    const required = requiredOf(def, id);
    for (const field of ["worker", "constitution_binding"] as const) {
      assert.ok(required.includes(field), `the '${id}' draft schema must require '${field}'`);
    }
    const worker = recordField(propertiesOf(def, id), "worker", `${id}.worker`);
    assert.deepEqual(
      requiredOf(worker, `${id}.worker`),
      ["role", "agent", "dispatch_id"],
      `${id} must attribute its authoring worker (role, agent, dispatch_id)`,
    );
  }
  const planDraft = schemaDef(schema, "plan_draft");
  assert.ok(
    requiredOf(planDraft, "plan_draft").includes("upstream_versions"),
    "the plan draft must bind its exact upstream specify version (T029)",
  );
  const taskGraph = schemaDef(schema, "task_graph");
  assert.ok(
    requiredOf(taskGraph, "task_graph").includes("upstream_versions"),
    "the task graph must bind its exact upstream plan version (T029)",
  );
  const tasks = recordField(propertiesOf(taskGraph, "task_graph"), "tasks", "task_graph.tasks");
  assert.equal(tasks.type, "array");
  const taskItem = recordField(tasks, "items", "task_graph.tasks.items");
  for (const field of ["id", "title", "depends_on"] as const) {
    assert.ok(requiredOf(taskItem, "task_graph.tasks[]").includes(field), `task nodes must require '${field}'`);
  }
  const taskProperties = propertiesOf(taskItem, "task_graph.tasks[]");
  for (const link of ["requirement_ids", "acceptance_ids", "verification_ids"] as const) {
    assert.ok(link in taskProperties, `task nodes must declare '${link}' traceability links (T033)`);
  }
});

test("phase validation and status schemas pin pass-gated checkpoints and typed next actions", () => {
  const schema = artifactsSchema();
  const phaseValidation = schemaDef(schema, "phase_validation");
  assert.deepEqual(
    requiredOf(phaseValidation, "phase_validation"),
    ["validation_id", "phase", "artifact_version", "status", "checks", "blocking_findings", "constitution", "validator_version"],
    "phase validation must bind one artifact version, its checks, findings, constitution principles, and validator",
  );
  assert.deepEqual(
    propertiesOf(phaseValidation, "phase_validation").status,
    { type: "string", enum: ["pass", "fail"] },
    "only a passing phase validation may open its checkpoint",
  );
  const status = schemaDef(schema, "specification_status");
  for (const field of ["feature_id", "run_key", "phases", "status", "next_action"] as const) {
    assert.ok(requiredOf(status, "specification_status").includes(field), `the status artifact must require '${field}'`);
  }
  const nextAction = recordField(propertiesOf(status, "specification_status"), "next_action", "specification_status.next_action");
  assert.deepEqual(
    requiredOf(nextAction, "specification_status.next_action"),
    ["kind", "command", "reason"],
    "the status next action must be fully typed",
  );
  const nextActionProperties = propertiesOf(nextAction, "specification_status.next_action");
  const kind = recordField(nextActionProperties, "kind", "specification_status.next_action.kind");
  assert.deepEqual(
    (kind as { enum?: unknown }).enum,
    ["command", "checkpoint", "remediation", "none"],
    "next actions must use the canonical WorkspaceNextActionKind vocabulary",
  );
});

// ── Readable projections and exact next actions ──────────────────────────────

test("shipped specification templates expose the readable status projection", () => {
  const shipped = loadShippedSpecificationTemplates();
  for (const id of ["constitution", "specify", "plan", "tasks", "status"] as const) {
    const content = shipped[id];
    assert.ok(typeof content === "string" && content.length > 0, `the shipped '${id}' template must exist`);
    assert.ok(
      extractSemanticMarkers(content).length > 0,
      `the shipped '${id}' template must embed stable omp-spec: markers`,
    );
    const resolved = resolveSpecificationTemplate({ template_id: id });
    assert.ok(resolved.ok, `the shipped '${id}' template must resolve: ${resolved.ok ? "" : resolved.error}`);
    if (resolved.ok) assert.ok(resolved.value.required_markers.length > 0);
  }
  assert.deepEqual(
    extractSemanticMarkers(shipped.status ?? ""),
    ["phase_status", "approvals", "next_action"],
    "the readable status projection must expose phase status, approvals, and the next action",
  );
});

test("next actions name the exact phase entry commands across the native progression", () => {
  const native = (phases: WorkspacePhaseRecord[], hasBinding: boolean, status: FeatureWorkspace["status"] = "in_progress") =>
    nextActionForWorkspace(phases, { status, hasConstitutionBinding: hasBinding, sourceKind: "native" });
  const fresh = [phaseRecord("specify", "not_started"), phaseRecord("plan", "not_started"), phaseRecord("tasks", "not_started")];

  assert.deepEqual(
    native(fresh, false),
    { kind: "remediation", command: "ensure_project_constitution", reason: "The project constitution prerequisite is unresolved; resolve or approve it before phase work." },
    "an unbound workspace must remediate the constitution prerequisite before any phase",
  );
  assert.deepEqual(
    native(fresh, true),
    { kind: "command", command: "/specify", reason: "Enter the specify phase." },
  );
  assert.deepEqual(
    native([phaseRecord("specify", "awaiting_approval"), phaseRecord("plan", "not_started"), phaseRecord("tasks", "not_started")], true),
    { kind: "checkpoint", command: null, reason: "The specify validation passed; the hard-human checkpoint is open." },
  );
  assert.deepEqual(
    native([phaseRecord("specify", "revision_required"), phaseRecord("plan", "not_started"), phaseRecord("tasks", "not_started")], true),
    { kind: "command", command: "/specify", reason: "The specify revision is required; re-enter the phase with the recorded feedback." },
  );
  assert.deepEqual(
    native([phaseRecord("specify", "approved"), phaseRecord("plan", "not_started"), phaseRecord("tasks", "not_started")], true),
    { kind: "command", command: "/spec-plan", reason: "Enter the plan phase." },
  );
  assert.deepEqual(
    native([phaseRecord("specify", "approved"), phaseRecord("plan", "approved"), phaseRecord("tasks", "not_started")], true),
    { kind: "command", command: "/spec-tasks", reason: "Enter the tasks phase." },
  );
  assert.deepEqual(
    native([phaseRecord("plan", "not_started"), phaseRecord("tasks", "not_started")], true),
    { kind: "none", command: null, reason: "The plan phase waits for its upstream approvals." },
    "a phase never dispatches before its upstream approval exists",
  );
});

test("native workspaces sequence the constitution binding before specify entry", () => {
  const root = makeProject("spec-native-workspace");
  try {
    const constitution = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
    writeFileSync(join(root, "CONSTITUTION.md"), constitution, "utf8");
    const constitutionBinding = validConstitutionBinding({
      content_sha256: sha256(constitution),
      semantic_hash: sha256(constitution.replace(/\s+/g, " ").trim()),
    });
    const created = createFeatureWorkspace(root, {
      feature_id: "native-flow",
      display_name: "Native Flow",
      run_key: "run-native-1",
      profile_name: "spec-preparation",
      profile_hash: profileHash(SPEC_PROFILE),
    });
    assert.ok(created.ok, `creating a native workspace must succeed: ${created.ok ? "" : created.error}`);
    if (!created.ok) return;
    assert.deepEqual(
      created.value.phases.map((phase) => phase.phase),
      ["specify", "plan", "tasks"],
    );
    assert.ok(created.value.phases.every((phase) => phase.status === "not_started"));
    assert.equal(created.value.constitution_binding, null, "a fresh workspace is not constitution-bound yet");

    const beforeBinding = nextActionForWorkspace(created.value.phases, {
      status: created.value.status,
      hasConstitutionBinding: false,
      sourceKind: "native",
    });
    assert.equal(beforeBinding.kind, "remediation");
    assert.equal(beforeBinding.command, "ensure_project_constitution");

    const expectedWorkspaceDigest = digestOf(created.value);
    const bound = bindWorkspaceConstitution(created.value, constitutionBinding);
    const persisted = persistFeatureWorkspace(root, bound, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
    assert.ok(persisted.ok, `persisting the bound workspace must succeed: ${persisted.ok ? "" : persisted.error}`);
    if (!persisted.ok) return;

    const resolved = resolveFeatureWorkspace(root, { feature_id: "native-flow", run_key: "run-native-1" });
    assert.ok(resolved.ok, `resolving the explicit selector must succeed: ${resolved.ok ? "" : resolved.error}`);
    if (!resolved.ok) return;
    assert.ok(currentConstitutionBinding(resolved.value), "the constitution binding must round-trip durably");
    assert.equal(resolved.value.profile_name, "spec-preparation");
    assert.equal(
      validateFeatureWorkspaceRecord(resolved.value).ok,
      true,
      "the persisted aggregate must satisfy the canonical workspace validation",
    );
    const entry = nextActionForWorkspace(resolved.value.phases, {
      status: resolved.value.status,
      hasConstitutionBinding: true,
      sourceKind: "native",
    });
    assert.equal(entry.kind, "command");
    assert.equal(entry.command, "/specify", "a bound native workspace enters specify next");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native workspace persistence rejects forged upstream bindings before any transition or state write", () => {
  const root = makeProject("spec-native-upstream-contract");
  try {
    const created = createFeatureWorkspace(root, {
      feature_id: "native-upstream",
      display_name: "Native upstream contract",
      run_key: "run-native-upstream-1",
      profile_name: "spec-preparation",
      profile_hash: profileHash(SPEC_PROFILE),
    });
    assert.ok(created.ok, created.ok ? "workspace created" : created.error);
    if (!created.ok) return;
    const expectedDigest = digestOf(created.value);
    const statePath = join(root, ".work-state", "features", "native-upstream", "state.json");
    const before = readFileSync(statePath, "utf8");
    const valid = (phase: WorkspaceUpstreamVersion["phase"], version = 1): WorkspaceUpstreamVersion => ({
      phase,
      version,
      hash: digestOf(`${phase}.v${version}`),
    });
    const cases: ReadonlyArray<readonly [string, WorkspacePhaseRecord["upstream_versions"]]> = [
      ["plan missing required upstream", []],
      ["plan wrong upstream phase", [valid("tasks")]],
      ["tasks out of order", [valid("plan"), valid("specify")]],
      ["tasks duplicate upstream", [valid("specify"), valid("specify")]],
      ["tasks over cardinality", [valid("specify"), valid("plan"), valid("tasks")]],
      ["plan unsafe version", [{ ...valid("specify"), version: Number.MAX_SAFE_INTEGER + 1 }]],
      ["plan unknown entry key", [{ ...valid("specify"), forged: true } as WorkspaceUpstreamVersion]],
    ];
    for (const [label, upstream] of cases) {
      const candidate = structuredClone(created.value);
      const phase = candidate.phases.find((entry) => entry.phase === (label.startsWith("plan") ? "plan" : "tasks"))!;
      phase.status = "materialized";
      phase.current_version = 1;
      phase.upstream_versions = upstream;
      const persisted = persistFeatureWorkspace(root, candidate, undefined, { expected_workspace_digest: expectedDigest });
      assert.equal(persisted.ok, false, label);
      if (!persisted.ok) assert.equal(persisted.code, "SPEC_STATE_INVALID", label);
      assert.equal(readFileSync(statePath, "utf8"), before, `${label} must not mutate state`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── T029: capability-bound dispatch over the native profile ──────────────────

type IssuedCapabilityState = ReturnType<typeof createCapability>;

function dispatchAuthFor(issued: IssuedCapabilityState): DispatchAuth & { role: string; agent: string } {
  const issuedFor = issued.state.issued_for!;
  const bound = issued.state.expected_roster![0]!;
  return {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issuedFor.run_key,
    branch: issuedFor.branch,
    workflow: issuedFor.workflow,
    profile_hash: issuedFor.profile_hash,
    stage_cursor: issuedFor.stage_cursor,
    cursor_epoch: issuedFor.cursor_epoch,
    role: bound.role,
    agent: bound.agent,
  };
}

test("native phase dispatch is capability-bound and advances specify to plan", () => {
  const root = makeProject("spec-native-capability");
  let closeNativeGate: (() => void) | undefined;
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "spec-native"], { stdio: "ignore" });
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n");
    closeNativeGate = registerNativeConstitutionGate(root, "native-flow-gate");
    const config = resolveConfig(root);
    const mapping = buildAgentMapping({
      roles: config.roles,
      availableAgents: ["specification-worker"],
      extraRoles: config.scope_map.map((entry) => entry.dev_agent),
      genericFallbackRoles: ["specification-worker"],
      source: "spec-native-flow-test",
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
    const ensuredConstitution = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "spec-native", origin_stage: "specify" }, { feature_id: "spec-native" });
    assert.ok(ensuredConstitution.ok && ensuredConstitution.value.binding, ensuredConstitution.ok ? "native constitution gate must resolve" : ensuredConstitution.error);
    if (!ensuredConstitution.ok || !ensuredConstitution.value.binding) return;
    const nativeBinding = ensuredConstitution.value.binding;
    mkdirSync(join(root, "specs", "spec-native"), { recursive: true });
    const canonicalRoot = realpathSync(root);
    const rootStats = statSync(canonicalRoot);
    const baseWorkspace = validFeatureWorkspace({ featureId: "spec-native", projectRoot: canonicalRoot, projectRootIdentity: { canonical_path: canonicalRoot, dev: rootStats.dev, ino: rootStats.ino }, constitutionBinding: nativeBinding });
    const nativeWorkspace = {
      ...baseWorkspace,
      phases: baseWorkspace.phases.map((phase) => phase.phase === "specify"
        ? { ...phase, status: "generating" as const, current_version: null, approved_version: null, validation_ref: null, checkpoint_ref: null }
        : phase),
      status: "in_progress" as const,
      next_action: { kind: "none" as const, command: null, reason: "The specify worker dispatch is active." },
    } as unknown as FeatureWorkspace;
    const profileHashValue = profileHash(SPEC_PROFILE);
    const issued = createCapability({
      run_key: "spec-native",
      branch: "spec-native",
      workflow: "spec-preparation",
      profile_hash: profileHashValue,
      stage_cursor: "specify",
      kind: "single",
      expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }],
    });
    writeState(root, {
      schema: 1,
      branch: "spec-native",
      run_key: "spec-native",
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
      task: "native specification flow",
      workflow_override: false,
      issue: null,
      stage_cursor: "specify",
      stages: SPEC_PROFILE.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "specify" ? "in_progress" as const : "pending" as const,
        ...(stage.produces !== undefined ? { produces: stage.produces } : {}),
      })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHashValue,
      scope: NO_RUNTIME,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
      specification: nativeWorkspace,
    });
    // The native validation seam requires the exact authenticated preparation
    // handoff and started marker that a real phase begin publishes. Build both
    // against this fixture's pinned root rather than bypassing that gate.
    const preparedState = resolveState(root, "spec-native", { feature_id: "spec-native", run_key: "spec-native" }).state;
    if (!preparedState) throw new Error("native fixture state could not be resolved after initial write");
    const preparationRoot = PinnedProjectRoot.open(root);
    if (!preparationRoot) throw new Error("native fixture root could not be pinned for preparation authority");
    try {
      const preparationRevision = (preparedState.state_revision ?? 0) + 1;
      const preparationHandoff = createPreparationHandoff({
        feature_id: "spec-native",
        run_key: "spec-native",
        branch: "spec-native",
        task: preparedState.task,
        classification: preparedState.classification,
        state_revision: preparationRevision,
        state_digest: preparationStateDigest({ ...preparedState, state_revision: preparationRevision }, preparationRevision),
        root_identity: { canonical_path: preparationRoot.canonical_root, dev: preparationRoot.dev, ino: preparationRoot.ino },
        source_kind: "native",
        constitution_binding: nativeBinding,
        constitution_gate_ref: nativeWorkspace.constitution_gate_ref,
        capacity: 1,
        authentication: { pinned_root: preparationRoot, source_kind: "native", constitution_binding: nativeBinding, constitution_gate_ref: nativeWorkspace.constitution_gate_ref, capacity: 1 },
      });
      const withHandoff = { ...preparedState, preparation_handoff: preparationHandoff };
      writeState(root, withHandoff);
      const withMarker = resolveState(root, "spec-native", { feature_id: "spec-native", run_key: "spec-native" }).state;
      if (!withMarker) throw new Error("native fixture state disappeared after preparation handoff");
      writeState(root, { ...withMarker, preparation_start: {
        status: "started",
        phase: "specify",
        capability_id: issued.capability_id,
        capability_epoch: issued.state.issued_for!.cursor_epoch,
        request_id: "native-specify-request",
        dispatch_id: "native-specify-dispatch",
        start_postimage_digest: preparationStartPostimageDigest(withMarker),
        token: preparationHandoff.token,
        preparation_digest: preparationHandoff.digest,
        preparation_state_revision: preparationHandoff.state_revision,
        expected_state_revision: preparationHandoff.state_revision,
        profile_hash: profileHashValue,
        expected_roster: issued.state.expected_roster,
      } });
    } finally {
      preparationRoot.close();
    }

    const auth = { ...dispatchAuthFor(issued), tool_call_id: "native-specify-request" };
    const forged = authorizeDispatch(root, { ...auth, token: "forged-dispatch-token" });
    assert.equal(forged.ok, false, "a forged dispatch token must never authorize the armed specify stage");

    const trustedMappingProof = issueTrustedMappingProof(root, mapping);
    const authorized = authorizeDispatch(root, auth, { trustedMappingProof });
    assert.equal(
      authorized.ok,
      true,
      `the armed specify capability must authorize its bound worker dispatch: ${authorized.ok ? "" : authorized.error}`,
    );
    if (!authorized.ok || !authorized.record) return;

    const selected = resolveState(root, auth.branch);
    assert.ok(
      selected.state && selected.artifactsDir && !selected.invalid,
      "the authorized dispatch state must resolve to its safe artifact directory",
    );
    if (!selected.state || !selected.artifactsDir || selected.invalid) return;
    assert.equal(selected.state.run_key, auth.run_key, "the artifact target must belong to the dispatched run");
    const specifyDraft = {
      schema_version: 1,
      feature_id: "spec-native",
      run_key: auth.run_key,
      phase: "specify",
      version: 1,
      worker: {
        role: authorized.record.role,
        agent: authorized.record.agent,
        dispatch_id: authorized.record.id,
      },
      constitution_binding: nativeBinding,
      upstream_versions: [],
      sections: {
        problem: "The native specify phase must produce a durable worker draft.",
        scope: "Validate and advance one capability-bound semantic model.",
        non_goals: "No implementation files are changed.",
        actors: "The engine and one specification analyst.",
        journeys: "The worker result is validated before a human checkpoint.",
        requirements: "The draft contains one stable requirement.",
        edge_cases: "Forged or malformed rows are rejected.",
        assumptions: "The fixture constitution remains current.",
        dependencies: "The durable dispatch and artifact ledgers.",
        success_criteria: "A strict draft passes the phase completion gate.",
      },
      requirements: [
        {
          requirement_id: "REQ-NATIVE-001",
          statement: "The native specify phase advances only from a capability-bound worker draft.",
          acceptance_ids: ["AC-NATIVE-001"],
          source_refs: ["native-phase-dispatch"],
          testable: true,
          untestable_reason: null,
        },
      ],
      decisions: [],
      tasks: [],
      verification: [{
        verification_id: "VER-NATIVE-001",
        requirement_ids: ["REQ-NATIVE-001"],
        acceptance_ids: ["AC-NATIVE-001"],
        task_ids: [],
        observable_behavior: true,
        expected_evidence: "The native phase completion gate accepts the draft.",
      }],
      contradictions: [],
      constitution_principles: [{
        principle_id: "constitution:fixture",
        title: "Fixture Constitution",
        applicability: "applicable",
        status: "pass",
        evidence: "The fixture uses the validated constitution binding.",
        binding: nativeBinding,
      }],
    };
    const constitutionBinding = nativeBinding;
    const constitutionPrinciples = parseConstitutionPrincipleIdentities(readFileSync(join(root, "CONSTITUTION.md"), "utf8"));
    const semanticModel = {
      ...specifyDraft,
      constitution_binding: constitutionBinding,
      constitution_principles: constitutionPrinciples.map((principle) => ({
        principle_id: principle.principle_id,
        title: principle.title,
        applicability: "applicable" as const,
        status: "pass" as const,
        evidence: "The fixture uses the validated constitution binding.",
        binding: constitutionBinding,
      })),
    };
    const shippedSpecifyTemplate = resolveSpecificationTemplate({ template_id: "specify" });
    assert.equal(shippedSpecifyTemplate.ok, true, shippedSpecifyTemplate.ok ? "" : shippedSpecifyTemplate.error);
    if (!shippedSpecifyTemplate.ok) return;
    const canonicalDocument = renderCanonicalPhaseDocument("specify", semanticModel as any, shippedSpecifyTemplate.value);
    const sourceArtifact = {
      schema_version: 1,
      feature_id: "spec-native",
      run_key: auth.run_key,
      phase: "specify",
      version: 1,
      worker: semanticModel.worker,
      constitution_binding: constitutionBinding,
      upstream_versions: [],
      document_sha256: sha256(canonicalDocument),
      semantic_model: semanticModel,
    };
    const generationInput = {
      ...auth,
      feature_id: "spec-native",
      phase: "specify" as const,
      request_id: auth.tool_call_id,
      dispatch_id: authorized.record.id,
      role: authorized.record.role,
      slot_id: authorized.record.role,
      agent: authorized.record.agent,
      version: 1,
      source_artifact: sourceArtifact,
      documents: [{ path: "spec.md", content: canonicalDocument }],
      semantic_sections: semanticModel.sections,
      constitution_binding: constitutionBinding,
      upstream_versions: [],
      template_hash: nativeWorkspace.template_set.content_hash,
      language_hash: nativeWorkspace.language.selection_hash,
    };
    const generationConstitutionPath = join(root, "CONSTITUTION.md");
    const generationOriginalConstitution = readFileSync(generationConstitutionPath, "utf8");
    const generationStatePath = join(root, ".work-state", "features", "spec-native", "state.json");
    const generationStatePreimage = readFileSync(generationStatePath);
    const generationBeforeState = structuredClone(resolveState(root, auth.branch).state);
    const generationArtifactPath = join(root, ".work-state", "features", "spec-native", "artifacts", "specify.v1.json");
    const generationArtifactPreexists = existsSync(generationArtifactPath);
    const generationPaths = [
      join(root, "specs", "spec-native", "spec.md"),
      join(root, ".work-state", "features", "spec-native", "artifacts", "documents", "specify", "v1.json"),
      join(root, ".work-state", "features", "spec-native", "artifacts", "specify_draft.json"),
    ];
    const generationPreimage = generationPaths.map((path) => existsSync(path) ? readFileSync(path) : null);
    const generationArtifactsDir = join(root, ".work-state", "features", "spec-native", "artifacts");
    const generationWalPreimage = readdirSync(generationArtifactsDir).filter((name) => name.startsWith(".phase-"));
    let generationDriftInjected = false;
    try {
      setStateTransactionTestHooks({
        beforeCas: () => {
          if (generationDriftInjected) return;
          generationDriftInjected = true;
          writeFileSync(generationConstitutionPath, generationOriginalConstitution + "\n## Drift injected before generation CAS\n");
        },
      }, root);
      const driftedGeneration = persistSpecificationPhaseResult(root, generationInput);
      assert.equal(driftedGeneration.ok, false, "constitution drift after generation writes must reject the transaction");
      if (!driftedGeneration.ok) assert.equal(driftedGeneration.code, "SPEC_PHASE_STALE");
    } finally {
      setStateTransactionTestHooks(null, root);
      writeFileSync(generationConstitutionPath, generationOriginalConstitution);
    }
    assert.equal(generationDriftInjected, true, "generation regression must drift constitution before state CAS");
    assert.deepEqual(resolveState(root, auth.branch).state, generationBeforeState, "rejected generation must preserve state and phase revision");
    for (let index = 0; index < generationPaths.length; index += 1) {
      const current = existsSync(generationPaths[index]!) ? readFileSync(generationPaths[index]!) : null;
      assert.deepEqual(current, generationPreimage[index], "rejected generation must restore filesystem preimage for " + generationPaths[index]);
    }
    assert.deepEqual(readdirSync(generationArtifactsDir).filter((name) => name.startsWith(".phase-")), generationWalPreimage, "rejected generation must restore WAL preimage");
    assert.equal(existsSync(generationArtifactPath), generationArtifactPreexists, "rejected generation must clean only an artifact created by this attempt");
    assert.deepEqual(readFileSync(generationStatePath), generationStatePreimage, "rejected generation must preserve state bytes");
    const persisted = persistSpecificationPhaseResult(root, generationInput);
    assert.equal(persisted.ok, true, `the canonical specify artifact must persist: `);
    if (!persisted.ok) return;

    const completed = completeDispatch(root, {
      ...auth,
      role: "specification-analyst",
      agent: "specification-worker",
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "specify draft authored and validated",
      artifact_ids: ["specify_draft"],
    });
    assert.equal(completed.ok, true, `the specify dispatch must complete: ${completed.ok ? "" : completed.error}`);
    const validationMappingProof = issueTrustedMappingProof(root, mapping);
    const validator = authorizeSpecificationPhaseValidationDispatch(root, {
      ...auth,
      feature_id: "spec-native",
      request_id: "native-specify-validation",
    }, { trustedMappingProof: validationMappingProof });
    assert.equal(validator.ok, true, `the specify validation dispatch must authorize: ${validator.ok ? "" : validator.error}`);
    if (!validator.ok) return;
    const validationAt = new Date().toISOString();
    const validation = {
      validation_id: "validation.specify.v1",
      feature_id: "spec-native",
      run_key: auth.run_key,
      phase: "specify" as const,
      version: 1,
      artifact_version: "specify.v1",
      document_path: "spec.md",
      document_sha256: sha256(canonicalDocument),
      sections: semanticModel.sections,
      upstream_versions: [],
      expected_upstream_versions: [],
      constitution_binding: constitutionBinding,
      expected_constitution_binding: constitutionBinding,
      constitution_principles: semanticModel.constitution_principles.map((principle) => ({
        principle_id: principle.principle_id,
        status: principle.status,
        evidence: principle.evidence,
      })),
      requirements: semanticModel.requirements,
      decisions: semanticModel.decisions,
      tasks: semanticModel.tasks.map((task) => ({ ...task, task_id: task.id })),
      verification: semanticModel.verification,
      contradictions: semanticModel.contradictions,
      validated_at: validationAt,
      validator_version: "specification-validation",
    };
    const constitutionPath = join(root, "CONSTITUTION.md");
    const originalConstitution = readFileSync(constitutionPath, "utf8");
    const validationStatePath = join(root, ".work-state", "features", "spec-native", "state.json");
    const validationStatePreimage = readFileSync(validationStatePath);
    const validationEvidencePath = join(root, ".work-state", "features", "spec-native", "artifacts", "validation.specify.v1.json");
    const validationReportPath = join(root, "specs", "spec-native", "validation", "specify.md");
    const validationPaths = [validationEvidencePath, validationReportPath];
    const validationPreimage = validationPaths.map((path) => existsSync(path) ? readFileSync(path) : null);
    const stateBeforeValidationDrift = structuredClone(resolveState(root, auth.branch).state);
    let validationDriftInjected = false;
    let driftedValidation: ReturnType<typeof persistSpecificationPhaseValidation>;
    try {
      setStateTransactionTestHooks({
        beforeCas: () => {
          if (validationDriftInjected) return;
          validationDriftInjected = true;
          writeFileSync(constitutionPath, originalConstitution + "\n## Drift injected before validation CAS\n");
        },
      }, root);
      driftedValidation = persistSpecificationPhaseValidation(root, {
        token: validator.dispatch_token,
        capability_id: validator.capability_id,
        feature_id: "spec-native",
        run_key: auth.run_key,
        branch: auth.branch,
        workflow: auth.workflow,
        profile_hash: auth.profile_hash,
        phase: "specify",
        stage_cursor: "specify",
        cursor_epoch: validator.capability_epoch,
        request_id: "native-specify-validation",
        dispatch_id: validator.record.id,
        role: validator.record.role,
        slot_id: validator.record.role,
        agent: validator.record.agent,
        validation,
      });
    } finally {
      setStateTransactionTestHooks(null, root);
      writeFileSync(constitutionPath, originalConstitution);
    }
    assert.equal(validationDriftInjected, true, "validation regression must drift constitution after final writes");
    assert.equal(driftedValidation.ok, false, "constitution drift before validation CAS must reject the transaction");
    if (!driftedValidation.ok) assert.equal(driftedValidation.code, "SPEC_PHASE_STALE", driftedValidation.error);
    assert.deepEqual(resolveState(root, auth.branch).state, stateBeforeValidationDrift, "rejected validation must preserve state and phase revision");
    assert.deepEqual(readFileSync(validationStatePath), validationStatePreimage, "rejected validation must preserve state bytes");
    for (let index = 0; index < validationPaths.length; index += 1) {
      const current = existsSync(validationPaths[index]!) ? readFileSync(validationPaths[index]!) : null;
      assert.deepEqual(current, validationPreimage[index], "rejected validation must restore filesystem preimage for " + validationPaths[index]);
    }
    const validationPersisted = persistSpecificationPhaseValidation(root, {
      token: validator.dispatch_token,
      capability_id: validator.capability_id,
      feature_id: "spec-native",
      run_key: auth.run_key,
      branch: auth.branch,
      workflow: auth.workflow,
      profile_hash: auth.profile_hash,
      phase: "specify",
      stage_cursor: "specify",
      cursor_epoch: validator.capability_epoch,
      request_id: "native-specify-validation",
      dispatch_id: validator.record.id,
      role: validator.record.role,
      slot_id: validator.record.role,
      agent: validator.record.agent,
      validation,
    });
    assert.equal(validationPersisted.ok, true, `the specify validation evidence must persist: `);
    if (!validationPersisted.ok) return;
    const artifactDigest = digestOf(persisted.value.version);
    const validationDigest = digestOf(validationPersisted.value);
    const checkpointAuth = { ...auth, token: validator.advance_token, capability_id: validator.capability_id, cursor_epoch: validator.capability_epoch };

    const checkpointTarget = resolveState(root, auth.branch);
    assert.ok(
      checkpointTarget.state && !checkpointTarget.invalid,
      "the completed specify capability must resolve before trusted approval is ingested",
    );
    if (!checkpointTarget.state || checkpointTarget.invalid) return;
    const checkpointPolicy = checkpointTarget.state.checkpoint_policy;
    assert.ok(checkpointPolicy, "the active specification phase policy must be projected into durable state");
    if (!checkpointPolicy) return;
    const checkpointRule = checkpointPolicy.rules[PHASE_CHECKPOINT];
    assert.ok(checkpointRule, "the active policy must contain the canonical phase checkpoint rule");
    if (!checkpointRule) return;
    assert.equal(checkpointRule.kind, PHASE_CHECKPOINT);

    const checkpointRoot = PinnedProjectRoot.open(root);
    assert.ok(checkpointRoot, "checkpoint fixture root must be pinnable");
    if (!checkpointRoot) return;
    const checkpointRootIdentity = { canonical_root: checkpointRoot.canonical_root, dev: checkpointRoot.dev, ino: checkpointRoot.ino };
    const checkpointReference = "terminal-answer/spec-native/specify/approve-continue";
    const checkpointCapability = issueTrustedCheckpointAnswerCapability(NATIVE_CHECKPOINT_BRIDGE, {
      root: checkpointRootIdentity,
      state: checkpointTarget.state,
      answer_id: "spec-native-specify-approve-continue",
      channel: "terminal",
      reference: checkpointReference,
      stage_id: "specify",
      checkpoint_id: PHASE_CHECKPOINT,
      decision: "approve_continue",
      feature_id: "spec-native",
      question: "Authorize the current specification phase",
      options: checkpointRule.allowed_decisions,
      session_id: "native-specify-session",
      actor_ref: checkpointReference,
      profile_hash: checkpointTarget.state.profile_hash!,
    });
    const trusted = recordTrustedCheckpointAnswer(checkpointTarget.state, {
      answer_id: "spec-native-specify-approve-continue",
      channel: "terminal",
      reference: checkpointReference,
      stage_id: "specify",
      checkpoint_id: PHASE_CHECKPOINT,
      decision: "approve_continue",
      feature_id: "spec-native",
    }, { capability: checkpointCapability, root: checkpointRootIdentity });
    checkpointRoot.close();
    const policyHash = checkpointPolicyHash(checkpointPolicy);
    assert.equal(trusted.answer.policy_hash, policyHash, "the trusted answer binds the exact active policy");
    const decisionState = appendCheckpointDecision(trusted.state, {
      run_id: trusted.answer.run_id,
      stage_id: "specify",
      checkpoint_id: PHASE_CHECKPOINT,
      checkpoint_kind: checkpointRule.kind,
      decision: "approve_continue",
      authorization: "human",
      actor: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      capability_id: trusted.answer.capability_id,
      capability_epoch: trusted.answer.capability_epoch,
      policy_hash: policyHash,
      feature_id: "spec-native",
      artifact_id: "specify.v1",
      artifact_version: 1,
      artifact_digest: artifactDigest,
      validation_ref: "validation.specify.v1",
      validation_digest: validationDigest,
      rationale: "Explicit trusted consent to continue from specify to plan.",
      decided_at: new Date().toISOString(),
    });
    const projectedWorkspace = decisionState.specification
      ? projectNativeSpecificationPhaseDecision(decisionState.specification, "specify", "approve_continue", "Explicit trusted consent to continue from specify to plan.")
      : undefined;
    const approvedState = projectedWorkspace
      ? { ...decisionState, specification: projectedWorkspace }
      : decisionState;
    const missingWorkspaceState = { ...approvedState };
    delete (missingWorkspaceState as { specification?: unknown }).specification;
    writeState(root, missingWorkspaceState, { target: checkpointTarget });
    const missingWorkspaceAdvance = advanceCursor(root, { ...checkpointAuth, feature_id: "spec-native", evidence: "missing specification workspace binding" }, { trustedMappingProof: issueTrustedMappingProof(root, mapping) });
    assert.equal(missingWorkspaceAdvance.ok, false, "native advance must reject a persisted decision without its specification workspace");
    if (!missingWorkspaceAdvance.ok) assert.match(missingWorkspaceAdvance.error, /native checkpoint decision|feature|binding/i);
    writeState(root, approvedState, { target: checkpointTarget });

    const missingFeatureTyped = approvedState.typed_checkpoint_decisions?.map((decision, index, all) => {
      if (index !== all.length - 1) return decision;
      const { feature_id: _featureId, ...withoutFeature } = decision;
      return withoutFeature;
    });
    const missingFeatureLegacy = approvedState.checkpoint_decisions?.map((decision, index, all) => {
      if (index !== all.length - 1) return decision;
      const { feature_id: _featureId, ...withoutFeature } = decision;
      return withoutFeature;
    });
    const missingFeatureState = {
      ...approvedState,
      ...(missingFeatureTyped ? { typed_checkpoint_decisions: missingFeatureTyped } : {}),
      ...(missingFeatureLegacy ? { checkpoint_decisions: missingFeatureLegacy } : {}),
    };
    assert.equal(missingFeatureState.typed_checkpoint_decisions?.at(-1)?.feature_id, undefined);
    assert.equal(missingFeatureState.checkpoint_decisions?.at(-1)?.feature_id, undefined);
    writeState(root, missingFeatureState, { target: checkpointTarget });
    const missingFeatureAdvance = advanceCursor(root, { ...checkpointAuth, feature_id: "spec-native", evidence: "missing feature binding" }, { trustedMappingProof: issueTrustedMappingProof(root, mapping) });
    assert.equal(missingFeatureAdvance.ok, false, "native advance must reject a persisted decision without feature_id");
    if (!missingFeatureAdvance.ok) assert.match(missingFeatureAdvance.error, /native (?:checkpoint|specify|completion)|feature|binding|mapping/i);
    writeState(root, approvedState, { target: checkpointTarget });
    const foreignFeatureTyped = approvedState.typed_checkpoint_decisions?.map((decision, index, all) =>
      index === all.length - 1 ? { ...decision, feature_id: "foreign-feature" } : decision);
    const foreignFeatureLegacy = approvedState.checkpoint_decisions?.map((decision, index, all) =>
      index === all.length - 1 ? { ...decision, feature_id: "foreign-feature" } : decision);
    const foreignFeatureState = {
      ...approvedState,
      ...(foreignFeatureTyped ? { typed_checkpoint_decisions: foreignFeatureTyped } : {}),
      ...(foreignFeatureLegacy ? { checkpoint_decisions: foreignFeatureLegacy } : {}),
    };
    writeState(root, foreignFeatureState, { target: checkpointTarget });
    const foreignFeatureAdvance = advanceCursor(root, { ...checkpointAuth, feature_id: "spec-native", evidence: "foreign feature binding" }, { trustedMappingProof: issueTrustedMappingProof(root, mapping) });
    assert.equal(foreignFeatureAdvance.ok, false, "native advance must reject a persisted decision for a foreign feature");
    if (!foreignFeatureAdvance.ok) assert.match(foreignFeatureAdvance.error, /native (?:checkpoint|specify|completion)|feature|binding|mapping/i);
    writeState(root, approvedState, { target: checkpointTarget });
    const consumedAnswer = approvedState.trusted_checkpoint_answers?.find(
      (answer) => answer.answer_id === trusted.answer.answer_id,
    );
    assert.ok(consumedAnswer?.consumed_at, "appending the typed phase decision must consume its trusted answer");
    writeState(root, approvedState, { target: checkpointTarget });

    const advanced = advanceCursor(root, { ...checkpointAuth, feature_id: "spec-native", evidence: "specify approved" }, { trustedMappingProof: issueTrustedMappingProof(root, mapping) });
    assert.equal(
      advanced.ok,
      true,
      `the native profile must arm 'plan' after 'specify' completes; declare the native stages (T028): ${advanced.ok ? "" : advanced.error}`,
    );
    if (!advanced.ok || !advanced.handoff) return;
    assert.equal(advanced.state.stage_cursor, "plan", "the cursor advances to the exact next native phase");
  } finally {
    closeNativeGate?.();
    rmSync(root, { recursive: true, force: true });
  }
});
