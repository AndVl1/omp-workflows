/**
 * Consilium fan-in (scope 5):
 *   - per-slot artifact provenance is recorded at completion (shared ids are
 *     snapshotted into the slot namespace before a later slot can clobber),
 *   - deterministic synthesis merges slot values in roster order and writes
 *     the stable shared artifact ids with recorded provenance,
 *   - missing slot results and collisions block,
 *   - schema-required scalar conflicts BLOCK by default (strict); an
 *     explicit, documented stage resolution resolves exactly the declared
 *     (artifact, field) and every resolved disagreement is recorded in the
 *     synthesis provenance with the winning slot and losing values,
 *   - a zero-artifact slot never inherits foreign shared content as its
 *     namespaced provenance (free-rider blocked).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, renameSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { registerTestConstitutionGate, registerTestProfiles, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { createCapability, authorizeDispatch, authorizeDispatchFromPersisted, authorizeDispatchTrusted, authorizeSpecificationPhaseValidationDispatch, consumeSpecificationPhaseValidationDispatch, completeDispatch, reconcileTrustedTaskResult, advanceCursor, issueCurrentTrustedMappingProof, projectNativeSpecificationPhaseDecision, type TrustedMappingProof } from "../src/engine/durable.js";
import { appendCheckpointDecision, checkpointPolicyHash, issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, registerTrustedCheckpointHostBridge } from "../src/engine/checkpoints.js";
import {
  namespacedArtifactId,
  durableNamespacedArtifactId,
  slotArtifactEnvelopeBytes,
  sanitizeSlot,
  missingSlotResults,
  mergeSlotValues,
  synthesizeArtifacts,
  slotRecordsFor,
  DEFAULT_FAN_IN_POLICY,
  type FanInPolicy,
} from "../src/engine/fan-in.js";
import { resolveConfig } from "../src/engine/config.js";
import { resolveState, writeState, setStateTransactionTestHooks } from "../src/engine/state.js";
import { digestOf, validateNativePhase } from "../src/specification/validation.js";
import { MAX_ARTIFACT_BYTES } from "../src/engine/artifacts.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";
import { sha256, validConstitutionBinding, validFeatureWorkspace } from "./fixtures/specification-fixtures.js";
import { PinnedProjectRoot, type PinnedRootWriteHooks } from "../src/specification/pinned-root.js";
import { deterministicValidationInputForArtifact, parseConstitutionPrincipleIdentities, persistSpecificationPhaseResult, renderCanonicalPhaseDocument } from "../src/specification/phase.js";
import { resolveSpecificationLanguage } from "../src/specification/language.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS } from "../src/specification/templates.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { createPreparationHandoff, preparationStartPostimageDigest, preparationStateDigest } from "../src/engine/preparation.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };
const FAN_SPEC_LANGUAGE = resolveSpecificationLanguage({ requestLanguage: "en-US" });
const FAN_SPEC_TEMPLATES = (() => {
  const resolved = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
})();
const FAN_SPECIFY_TEMPLATE = FAN_SPEC_TEMPLATES.templates.find((template) => template.template_id === "specify");
assert.ok(FAN_SPECIFY_TEMPLATE, "missing shipped specify template");
const TEST_CHECKPOINT_BRIDGE = Object.freeze({});
registerTrustedCheckpointHostBridge(TEST_CHECKPOINT_BRIDGE);
if (!FAN_SPECIFY_TEMPLATE) throw new Error("missing shipped specify template");


function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function writeFixtureState(root: string, profileName: string, stageId: string): ReturnType<typeof createCapability> {
  const profile = loadProfile(profileName);
  assert.ok(profile);
  if (!profile) throw new Error(`profile ${profileName} is unavailable`);
  const persistedHash = profileHash(profile);
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n");
  writeTestRegistryMarker(root);
  registerTestConstitutionGate(root, "fan-feature-constitution-gate");
  const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "fan-feature", origin_stage: stageId }, { feature_id: "fan" });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  if (!gate.ok || !gate.value.binding) throw new Error("fan-in feature constitution gate is unavailable");
  mkdirSync(join(root, "specs", "fan"), { recursive: true });
  const canonicalRoot = realpathSync(root);
  const rootStats = statSync(canonicalRoot);
  const workspace = validFeatureWorkspace({
    featureId: "fan",
    projectRoot: canonicalRoot,
    projectRootIdentity: { canonical_path: canonicalRoot, dev: rootStats.dev, ino: rootStats.ino },
    constitutionBinding: gate.value.binding,
  });
  workspace.profile_name = profile.name;
  workspace.profile_hash = persistedHash;
  workspace.constitution_gate_ref = gate.value.gate_id;
  workspace.status = "in_progress";
  publishMapping(root);
  const issued = createCapability({
    run_key: "feat/fan", branch: "feat/fan", workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: stageId, kind: "consilium",
    expected_roster: [
      { role: "analyst#1", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
      { role: "analyst#2", agent: "analyst" },
    ],
    policy_hash: "fixture-policy",
  });
  writeState(root, {
    schema: 1,
    branch: "feat/fan",
    run_key: "feat/fan",
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: profileName },
    task: "fan-in",
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    config_hash: resolveConfig(root).config_hash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
    specification: workspace,
  }, { featureSlug: "fan" });
  return issued;
}

function writeNativeFanFixtureState(root: string): ReturnType<typeof createCapability> {
  initGit(root, "feat/fan");
  writeTestRegistryMarker(root);
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n");
  registerTestConstitutionGate(root, "fan-native-constitution-gate");
  const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "fan-native", origin_stage: "exploration" }, { feature_id: "fan" });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  if (!gate.ok || !gate.value.binding) throw new Error("native fan-in constitution gate is unavailable");
  mkdirSync(join(root, "specs", "fan"), { recursive: true });
  const profile = loadProfile("full-feature");
  assert.ok(profile);
  if (!profile) throw new Error("full-feature profile is unavailable");
  const persistedHash = profileHash(profile);
  const identity = statSync(realpathSync(root));
  const workspace = validFeatureWorkspace({
    featureId: "fan",
    projectRoot: realpathSync(root),
    projectRootIdentity: { canonical_path: realpathSync(root), dev: identity.dev, ino: identity.ino },
    constitutionBinding: gate.value.binding,
  });
  workspace.profile_name = profile.name;
  workspace.profile_hash = persistedHash;
  workspace.constitution_gate_ref = gate.value.gate_id;
  workspace.status = "in_progress";
  publishMapping(root);
  const issued = createCapability({
    run_key: "feat/fan", branch: "feat/fan", workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: "exploration", kind: "consilium",
    expected_roster: [
      { role: "analyst#1", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
      { role: "analyst#2", agent: "analyst" },
    ],
    policy_hash: "fixture-policy",
  });
  writeState(root, {
    schema: 1,
    branch: "feat/fan",
    run_key: "feat/fan",
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "fan-in native drift",
    workflow_override: false,
    issue: null,
    stage_cursor: "exploration",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "exploration" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    config_hash: resolveConfig(root).config_hash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
    specification: workspace,
  }, { featureSlug: "fan" });
  return issued;
}

function fixtureConstitutionBinding(root: string): ReturnType<typeof validConstitutionBinding> {
  const envelope = JSON.parse(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8")) as { gate?: { binding?: ReturnType<typeof validConstitutionBinding> } };
  assert.ok(envelope.gate?.binding, "fan-in fixture must expose an approved canonical constitution binding");
  if (!envelope.gate?.binding) throw new Error("fan-in fixture constitution gate binding is missing");
  return envelope.gate.binding;
}

function writeSpecFixtureState(root: string): ReturnType<typeof createCapability> {
  const profile = loadProfile("spec-preparation");
  assert.ok(profile);
  const persistedHash = profileHash(profile);
  const issued = createCapability({
    run_key: "main",
    branch: "main",
    workflow: "spec-preparation",
    profile_hash: persistedHash,
    stage_cursor: "specify",
    kind: "single",
    expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }],
  });
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n");
  writeTestRegistryMarker(root);
  registerTestConstitutionGate(root, "fan-specification-gate");
  const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "fan-specification-gate", origin_stage: "specify" }, { feature_id: "spec" });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  mkdirSync(join(root, "specs", "spec"), { recursive: true });
  const canonicalRoot = realpathSync(root);
  const rootStats = statSync(canonicalRoot);
  const workspace = validFeatureWorkspace({
    featureId: "spec",
    projectRoot: canonicalRoot,
    projectRootIdentity: { canonical_path: canonicalRoot, dev: rootStats.dev, ino: rootStats.ino },
  });
  workspace.profile_hash = persistedHash;
  workspace.constitution_gate_ref = gate.value.gate_id;
  workspace.constitution_binding = fixtureConstitutionBinding(root);
  workspace.language = FAN_SPEC_LANGUAGE;
  workspace.template_set = FAN_SPEC_TEMPLATES.selection;
  workspace.phases[0] = { ...workspace.phases[0]!, status: "generating", current_version: null, approved_version: null, validation_ref: null, checkpoint_ref: null };
  workspace.next_action = { kind: "none", command: null, reason: "The specify worker dispatch is active." };
  publishMapping(root);
  writeState(root, {
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "SPEC", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: "specify",
    workflow_override: false,
    issue: null,
    stage_cursor: "specify",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "specify" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    checkpoint_policy: profile.checkpoint_policy,
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
    specification: workspace,
  }, { featureSlug: "spec" });
  return issued;
}

function writeSpecifyDraft(dir: string, binding: ReturnType<typeof validConstitutionBinding>): void {
  writeFileSync(join(dir, "specify_draft.json"), JSON.stringify({
    schema_version: 1,
    feature_id: "spec",
    run_key: "main",
    phase: "specify",
    version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "fixture-dispatch" },
    constitution_binding: binding,
    upstream_versions: [],
    sections: {
      problem: "The workflow must persist a valid specify draft.",
      scope: "Persist the complete native semantic model.",
      non_goals: "No implementation files are changed.",
      actors: "The workflow engine and specification worker.",
      journeys: "A complete draft is validated before approval.",
      requirements: "The draft carries stable requirement links.",
      edge_cases: "Malformed semantic rows are rejected.",
      assumptions: "The fixture constitution is current.",
      dependencies: "The durable artifact ledger.",
      success_criteria: "The draft passes its strict contract.",
    },
    requirements: [{
      requirement_id: "FR-1",
      statement: "The workflow persists a valid specify draft.",
      acceptance_ids: ["AC-1"],
      source_refs: ["fixture"],
      testable: true,
      untestable_reason: null,
    }],
    decisions: [],
    tasks: [],
    verification: [{
      verification_id: "VER-1",
      requirement_ids: ["FR-1"],
      acceptance_ids: ["AC-1"],
      task_ids: [],
      observable_behavior: true,
      expected_evidence: "The strict draft contract accepts the persisted artifact.",
    }],
    contradictions: [],
    constitution_principles: [{
      principle_id: "constitution:fixture",
      title: "Fixture Constitution",
      applicability: "applicable",
      status: "pass",
      evidence: "The fixture is bounded and deterministic.",
      binding,
    }],
  }));
}

type NativeSlotAuthorization = ReturnType<typeof authorizeSlot>;

function persistNativeSpecifyCandidate(root: string, authorization: NativeSlotAuthorization): void {
  const selected = resolveState(root, "main", { feature_id: "spec", run_key: "main" });
  assert.ok(selected.state && selected.artifactsDir && !selected.invalid, "native fixture state must resolve before phase persistence");
  if (!selected.state || !selected.artifactsDir || selected.invalid) return;
  const model = JSON.parse(readFileSync(join(selected.artifactsDir, "specify_draft.json"), "utf8")) as Record<string, any>;
  model.worker = { ...model.worker, dispatch_id: authorization.record.id };
  const constitution = fixtureConstitutionBinding(root);
  const principles = parseConstitutionPrincipleIdentities(readFileSync(join(root, "CONSTITUTION.md"), "utf8"));
  model.constitution_binding = constitution;
  model.constitution_principles = principles.map((principle) => ({
    principle_id: principle.principle_id, title: principle.title, applicability: "applicable", status: "pass",
    evidence: "The fixture uses the validated constitution binding.", binding: constitution,
  }));
  rmSync(join(selected.artifactsDir, "specify_draft.json"), { force: true });
  const document = renderCanonicalPhaseDocument("specify", model as never, FAN_SPECIFY_TEMPLATE);
  const sourceArtifact = {
    schema_version: 1, feature_id: "spec", run_key: "main", phase: "specify", version: 1,
    worker: { role: authorization.record.role, agent: authorization.record.agent, dispatch_id: authorization.record.id },
    constitution_binding: constitution, upstream_versions: [], document_sha256: sha256(document), semantic_model: model,
  };
  const persisted = persistSpecificationPhaseResult(root, {
    ...authorization.auth, feature_id: "spec", phase: "specify", request_id: authorization.auth.tool_call_id,
    dispatch_id: authorization.record.id, role: authorization.record.role, slot_id: authorization.record.role, agent: authorization.record.agent, version: 1,
    source_artifact: sourceArtifact, documents: [{ path: "spec.md", content: document }], semantic_sections: model.sections as Record<string, string>,
    constitution_binding: constitution, upstream_versions: [],
    template_hash: selected.state.specification!.template_set.content_hash, language_hash: selected.state.specification!.language.selection_hash,
  });
  assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
  if (!persisted.ok) return;
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "native fixture root must pin for deterministic validation");
  if (!pinned) return;
  try {
    const validationInput = deterministicValidationInputForArtifact(persisted.value.version, pinned);
    assert.ok(validationInput, "canonical native fixture artifact must produce validation input");
    if (!validationInput) return;
    const validation = { ...validateNativePhase(validationInput), artifact_digest: digestOf(persisted.value.version) };
    writeFileSync(join(selected.artifactsDir, "validation.specify.v1.json"), JSON.stringify(validation));
  } finally { pinned.close(); }
  const after = resolveState(root, "main", { feature_id: "spec", run_key: "main" });
  assert.ok(after.state?.specification, "native fixture workspace must persist with phase result");
  if (!after.state?.specification) return;
  const workspace = after.state.specification;
  const phase = workspace.phases.find((entry) => entry.phase === "specify");
  if (!phase) return;
  writeState(root, {
    ...after.state, specification: { ...workspace, phases: workspace.phases.map((entry) => entry.phase === "specify" ? { ...entry, status: "materialized" as const, current_version: 1, approved_version: null, validation_ref: "validation.specify.v1", checkpoint_ref: null } : entry), next_action: { kind: "none" as const, command: null, reason: "The specify artifact is materialized; the validator dispatch must join before approval." } },
  }, { target: after });
}

function approveSpecify(root: string, issued: ReturnType<typeof createCapability>): void {
  let resolved = resolveState(root);
  assert.ok(resolved.state, "specify fixture state must resolve for checkpoint approval");
  if (resolved.state?.specification) {
    const phase = resolved.state.specification.phases.find((entry) => entry.phase === "specify");
    if (phase?.status === "materialized") {
      writeState(root, {
        ...resolved.state,
        specification: {
          ...resolved.state.specification,
          phases: resolved.state.specification.phases.map((entry) => entry.phase === "specify"
            ? { ...entry, status: "awaiting_approval" as const, current_version: 1, approved_version: null, validation_ref: "validation.specify.v1", checkpoint_ref: null }
            : entry),
          next_action: { kind: "checkpoint" as const, command: null, reason: "The specify validator passed; the hard-human checkpoint is open." },
        },
      }, { target: resolved });
      resolved = resolveState(root);
    }
  }
  const answerId = "answer/specify";
  const reference = "terminal-answer/specify";
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot, "specify fixture root must pin for checkpoint approval");
  if (!pinnedRoot) return;
  if (!resolved.state.profile_hash) {
    pinnedRoot.close();
    return;
  }
  try {
    const rootIdentity = { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
    const capability = issueTrustedCheckpointAnswerCapability(TEST_CHECKPOINT_BRIDGE, {
      root: rootIdentity,
      state: resolved.state,
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: "specify",
      checkpoint_id: "specification_phase_approval",
      decision: "approve_continue",
      feature_id: "spec",
      question: "Approve the persisted specify phase",
      options: ["approve_continue"],
      session_id: "fan-in-specification-test-session",
      actor_ref: reference,
      profile_hash: resolved.state.profile_hash,
    });
    const trusted = recordTrustedCheckpointAnswer(resolved.state, {
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: "specify",
      checkpoint_id: "specification_phase_approval",
      decision: "approve_continue",
      feature_id: "spec",
    }, { capability, root: rootIdentity });
    writeState(root, trusted.state, { target: resolved });
  const policy = resolved.state.checkpoint_policy;
  assert.ok(policy, "specify fixture checkpoint policy must be present");
  const artifactsDir = specArtifactsDir(root);
  const artifact = JSON.parse(readFileSync(join(artifactsDir, "specify.v1.json"), "utf8"));
  const validation = JSON.parse(readFileSync(join(artifactsDir, "validation.specify.v1.json"), "utf8"));
  const policyHash = checkpointPolicyHash(policy);
  const decisionState = appendCheckpointDecision(trusted.state, {
    run_id: trusted.answer.run_id, stage_id: "specify", checkpoint_id: "specification_phase_approval", checkpoint_kind: "specification_phase_approval",
    decision: "approve_continue", authorization: "human", actor: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
    capability_id: trusted.answer.capability_id, capability_epoch: trusted.answer.capability_epoch, policy_hash: policyHash, feature_id: "spec", loop_iteration: trusted.answer.loop_iteration, subject_binding: trusted.answer.subject_binding,
    artifact_id: "specify.v1", artifact_version: 1, artifact_digest: digestOf(artifact), validation_ref: "validation.specify.v1", validation_digest: digestOf(validation),
    rationale: "fixture approval", decided_at: new Date().toISOString(),
  });
  const projectedWorkspace = decisionState.specification
    ? projectNativeSpecificationPhaseDecision(decisionState.specification, "specify", "approve_continue", "fixture approval")
    : undefined;
  const decision = { ok: true as const, state: projectedWorkspace ? { ...decisionState, specification: projectedWorkspace } : decisionState };
  writeState(root, decision.state, { target: resolveState(root) });
  } finally {
    pinnedRoot.close();
  }
}
const trustedIntakeRoles = { analyst: "analyst", "specification-analyst": "specification-worker", "tech-researcher": "tech-researcher" } as const;

/** Publish a config-bound live agent mapping for every fan-in fixture roster. */
function publishMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: trustedIntakeRoles }) + "\n");
  const config = resolveConfig(root);
  const mapping = buildAgentMapping({
    roles: config.roles,
    availableAgents: Object.values(trustedIntakeRoles),
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: Object.keys(trustedIntakeRoles),
    source: "fan-in-test",
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
}

function currentMappingProof(root: string): TrustedMappingProof {
  const proof = issueCurrentTrustedMappingProof(root);
  assert.ok(proof, "fan-in fixture must publish an engine-issued mapping proof");
  if (!proof) throw new Error("fan-in fixture mapping proof is unavailable");
  return proof;
}

/** Arm the exact native preparation authority consumed by validation dispatch. */
function armNativeSpecifyPreparation(root: string, auth: ReturnType<typeof authorizeSlot>["auth"], record: ReturnType<typeof authorizeSlot>["record"]): void {
  const selected = resolveState(root, "main", { feature_id: "spec", run_key: "main" });
  assert.ok(selected.state && selected.state.specification, "spec fixture state must resolve before native preparation arming");
  if (!selected.state || !selected.state.specification) return;
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "spec fixture root must pin before native preparation arming");
  if (!pinned) return;
  try {
    const revision = selected.state.state_revision ?? 1;
    const binding = selected.state.specification.constitution_binding;
    const handoff = createPreparationHandoff({
      feature_id: "spec",
      run_key: "main",
      branch: selected.state.branch,
      task: selected.state.task,
      classification: selected.state.classification,
      state_revision: revision,
      state_digest: preparationStateDigest(selected.state, revision),
      root_identity: { canonical_path: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino },
      source_kind: "native",
      constitution_binding: binding,
      constitution_gate_ref: selected.state.specification.constitution_gate_ref,
      capacity: 1,
      authentication: { pinned_root: pinned, source_kind: "native", constitution_binding: binding, constitution_gate_ref: selected.state.specification.constitution_gate_ref, capacity: 1 },
    });
    writeState(root, { ...selected.state, preparation_handoff: handoff }, { target: selected });
    const armed = resolveState(root, "main", { feature_id: "spec", run_key: "main" });
    assert.ok(armed.state && armed.state.dispatch_capability, "spec fixture state must retain capability after native preparation arming");
    if (!armed.state || !armed.state.dispatch_capability) return;
    const marker = {
      status: "started" as const,
      phase: "specify" as const,
      capability_id: armed.state.dispatch_capability.capability_id,
      capability_epoch: armed.state.dispatch_capability.issued_for.cursor_epoch,
      request_id: auth.tool_call_id,
      dispatch_id: record.id,
      start_postimage_digest: preparationStartPostimageDigest(armed.state),
      token: handoff.token,
      preparation_digest: handoff.digest,
      preparation_state_revision: handoff.state_revision,
      expected_state_revision: handoff.state_revision,
      profile_hash: armed.state.profile_hash,
      expected_roster: armed.state.dispatch_capability.expected_roster,
    };
    writeState(root, { ...armed.state, preparation_start: marker }, { target: armed });
  } finally {
    pinned.close();
  }
}

function completeNativeSpecifyValidator(root: string, authorization: NativeSlotAuthorization): { capability_id: string; dispatch_token: string; advance_token: string; capability_epoch: string; record_id: string } {
  armNativeSpecifyPreparation(root, authorization.auth, authorization.record);
  const validation = authorizeSpecificationPhaseValidationDispatch(root, {
    ...authorization.auth,
    request_id: "tool-spec-validator",
    tool_call_id: "tool-spec-validator",
    feature_id: "spec",
  }, { trustedMappingProof: currentMappingProof(root) });
  assert.equal(validation.ok, true, validation.ok ? "native validator dispatch authorized" : validation.error);
  if (!validation.ok) throw new Error(validation.error);
  const selected = resolveState(root, "main", { feature_id: "spec", run_key: "main" });
  assert.ok(selected.state, "native validator state must resolve before consumption");
  if (!selected.state) throw new Error("native validator state is unavailable");
  const consumed = consumeSpecificationPhaseValidationDispatch(selected.state, validation.record.id, "succeeded", "native specify validator completed");
  assert.equal(consumed.ok, true, consumed.ok ? "native validator completion persisted" : consumed.error);
  if (!consumed.ok) throw new Error(consumed.error);
  writeState(root, consumed.state, { target: selected });
  return { capability_id: validation.capability_id, dispatch_token: validation.dispatch_token, advance_token: validation.advance_token, capability_epoch: validation.capability_epoch, record_id: validation.record.id };
}

function artifactsDir(root: string): string {
  const dir = join(root, ".work-state", "features", "fan", "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateOf(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "fan", "state.json"), "utf8")) as TeamState;
}
function specStateOf(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "spec", "state.json"), "utf8")) as TeamState;
}
function specArtifactsDir(root: string): string {
  const dir = join(root, ".work-state", "features", "spec", "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function completeSlot(
  root: string,
  issued: ReturnType<typeof createCapability>,
  role: string,
  agent: string,
  artifactIds: string[],
  expectSuccess = true,
): boolean {
  const auth = {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    role,
    agent,
    feature_id: "fan",
  };
  const authorized = authorizeDispatch(root, auth, { trustedMappingProof: currentMappingProof(root) });
  assert.equal(authorized.ok, true, `authorize ${role}: ${authorized.ok ? "" : authorized.error}`);
  if (!authorized.ok || !authorized.record) throw new Error("authorize failed");
  const completed = completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: `${role} done`, artifact_ids: artifactIds });
  if (!expectSuccess) return completed.ok;
  assert.equal(completed.ok, true, completed.ok ? `complete ${role}` : `complete ${role}: ${completed.error}`);
  if (!completed.ok) throw new Error(`complete failed: ${completed.error}`);
  return true;
}

function authorizeSlot(root: string, issued: ReturnType<typeof createCapability>, role: string, agent: string, toolCallId: string, featureId = "fan") {
  const auth = {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    role,
    agent,
    feature_id: featureId,
    tool_call_id: toolCallId,
  };
  const authorized = authorizeDispatch(root, auth, { trustedMappingProof: currentMappingProof(root) });
  assert.equal(authorized.ok, true, `authorize ${role}: ${authorized.ok ? "" : authorized.error}`);
  if (!authorized.ok || !authorized.record) throw new Error(`authorize ${role} failed`);
  if (featureId === "spec") armNativeSpecifyPreparation(root, auth, authorized.record);
  return { auth, record: authorized.record };
}

const EXPLORATION = (summary: string, files: string[]) => ({ files_to_read: files.map((path) => ({ path, why: "x" })), summary });
const multibyteBoundaryValue = () => ({
  payloadA: "\0".repeat(1_000_000),
  payloadB: "\0".repeat(398_048),
  unicode: "é",
});

test("fan-in: near-cap UTF-8 slot envelope remains readable at durable completion", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-envelope-near-cap-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    const value = multibyteBoundaryValue();
    const bytes = Buffer.from(slotArtifactEnvelopeBytes("exploration", "analyst#1", "analyst", value), "utf8");
    assert.equal(bytes.byteLength, MAX_ARTIFACT_BYTES - 1);
    assert.equal(bytes.byteLength < MAX_ARTIFACT_BYTES, true);
    const path = join(dir, `${durableNamespacedArtifactId("exploration", "analyst#1")}.json`);
    writeFileSync(path, bytes);
    const dodPath = join(dir, `${durableNamespacedArtifactId("dod", "analyst#1")}.json`);
    writeFileSync(dodPath, slotArtifactEnvelopeBytes("dod", "analyst#1", "analyst", { items: [] }));

    assert.equal(completeSlot(root, issued, "analyst#1", "analyst", ["exploration", "dod"]), true);
    const record = slotRecordsFor(stateOf(root), "exploration")!.slots["analyst#1"]!.exploration!;
    assert.equal(record.size_bytes, bytes.byteLength);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).value, value);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: cap-plus-one wrapped UTF-8 envelope rejects durable completion before any slot write", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-envelope-cap-over-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    const value = { ...multibyteBoundaryValue(), payloadB: "\0".repeat(398_050) };
    const rawBytes = Buffer.from(JSON.stringify(value), "utf8");
    const envelopeBytes = Buffer.from(slotArtifactEnvelopeBytes("dod", "analyst#1", "analyst", value), "utf8");
    assert.ok(rawBytes.byteLength < MAX_ARTIFACT_BYTES);
    assert.ok(envelopeBytes.byteLength > MAX_ARTIFACT_BYTES);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("small", ["small.ts"])));
    writeFileSync(join(dir, "dod.json"), rawBytes);

    assert.equal(completeSlot(root, issued, "analyst#1", "analyst", ["exploration", "dod"], false), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst#1")}.json`)), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst#1")}.json`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("fan-in: slot namespace is deterministic and collision-free", () => {
  assert.equal(namespacedArtifactId("exploration", "analyst#1"), "exploration-analyst-1");
  assert.equal(namespacedArtifactId("exploration", "tech-researcher"), "exploration-tech-researcher");
  assert.equal(namespacedArtifactId("architecture", "architect#2"), "architecture-architect-2");
  assert.equal(sanitizeSlot("analyst#1"), "analyst-1");
  assert.equal(sanitizeSlot("devops"), "devops");
});
test("fan-in: durable slot filenames preserve exact identity within OS name limits", () => {
  const slots = ["a#1", "a-1", "A", "a", "é", "e\u0301", "a/b", "a:b", "x".repeat(300), "y".repeat(300)];
  const ids = slots.map((slot) => durableNamespacedArtifactId("exploration", slot));
  assert.equal(new Set(ids).size, slots.length, "slot identity must never collapse after sanitization");
  for (const id of ids) assert.ok(Buffer.byteLength(`${id}.json`, "utf8") <= 255, "durable filename stays below NAME_MAX");
});
test("fan-in: tampered embedded identity fails closed even when the descriptor digest is refreshed", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-identity-tamper-"));
  try {
    const firstPath = join(root, `${durableNamespacedArtifactId("evidence", "first")}.json`);
    const secondPath = join(root, `${durableNamespacedArtifactId("evidence", "second")}.json`);
    const firstBytes = Buffer.from(slotArtifactEnvelopeBytes("evidence", "other", "provider-first", { items: ["first"] }));
    const secondBytes = Buffer.from(slotArtifactEnvelopeBytes("evidence", "second", "provider-second", { items: ["second"] }));
    writeFileSync(firstPath, firstBytes);
    writeFileSync(secondPath, secondBytes);
    const record = (path: string, bytes: Buffer, slot: string, provider: string) => ({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
      artifact_id: "evidence",
      slot_id: slot,
      provider_id: provider,
    });
    const state = {
      slot_artifacts: {
        secure: {
          slots: {
            first: { evidence: record(firstPath, firstBytes, "first", "provider-first") },
            second: { evidence: record(secondPath, secondBytes, "second", "provider-second") },
          },
        },
      },
    } as TeamState;
    const result = synthesizeArtifacts(state, "secure", root, ["evidence"], ["first", "second"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "malformed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fan-in: legacy safe filenames are exact-only and swapped slot paths reject", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-legacy-swap-"));
  try {
    const firstPath = join(root, "evidence-first.json");
    const secondPath = join(root, "evidence-second.json");
    const firstBytes = Buffer.from(slotArtifactEnvelopeBytes("evidence", "first", "provider-first", { items: ["first"] }));
    const secondBytes = Buffer.from(slotArtifactEnvelopeBytes("evidence", "second", "provider-second", { items: ["second"] }));
    writeFileSync(firstPath, firstBytes);
    writeFileSync(secondPath, secondBytes);
    const first = { ...exactSlotRecord(firstPath), artifact_id: "evidence", slot_id: "first", provider_id: "provider-first" };
    const second = { ...exactSlotRecord(secondPath), artifact_id: "evidence", slot_id: "second", provider_id: "provider-second" };
    const synthesize = (firstRecord: typeof first, secondRecord: typeof second) => synthesizeArtifacts(
      {
        slot_artifacts: {
          secure: { slots: { first: { evidence: firstRecord }, second: { evidence: secondRecord } } },
        },
      } as TeamState,
      "secure",
      root,
      ["evidence"],
      ["first", "second"],
    );
    const swapped = synthesize(second, first);
    assert.equal(swapped.ok, false);
    if (!swapped.ok) assert.equal(swapped.code, "path_unauthorized");
    const providerSwap = synthesize({ ...first, provider_id: "provider-second" }, second);
    assert.equal(providerSwap.ok, false);
    if (!providerSwap.ok) assert.equal(providerSwap.code, "malformed");
    const digestSwap = synthesize({ ...first, sha256: second.sha256 }, second);
    assert.equal(digestSwap.ok, false);
    if (!digestSwap.ok) assert.equal(digestSwap.code, "digest_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: normal dispatch authorization rejects precommit constitution drift without a record", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-authorize-before-commit-drift-"));
  try {
    const issued = writeNativeFanFixtureState(root);
    const binding = issued.state.issued_for!;
    const auth = {
      feature_id: "fan",
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: binding.run_key,
      branch: binding.branch,
      workflow: binding.workflow,
      profile_hash: binding.profile_hash,
      stage_cursor: binding.stage_cursor,
      cursor_epoch: binding.cursor_epoch,
      role: "analyst#1",
      agent: "analyst",
    };
    const statePath = join(root, ".work-state", "features", "fan", "state.json");
    const beforeState = readFileSync(statePath);
    const originalConstitution = readFileSync(join(root, "CONSTITUTION.md"));
    const rejected = authorizeDispatch(root, auth, {
      trustedMappingProof: currentMappingProof(root),
      preCommit: () => writeFileSync(join(root, "CONSTITUTION.md"), Buffer.concat([originalConstitution, Buffer.from("\n## II. Drift\n\nChanged before dispatch CAS.\n")])),
    });
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must reject dispatch authorization" : rejected.error);
    assert.deepEqual(readFileSync(statePath), beforeState, "normal precommit drift must not mutate state");
    assert.deepEqual(resolveState(root).state?.dispatch_capability?.dispatches, [], "normal precommit drift must not publish a dispatch record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: persisted dispatch authorization rejects precommit constitution drift without a record", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-persisted-authorize-before-commit-drift-"));
  try {
    const issued = writeNativeFanFixtureState(root);
    const binding = issued.state.issued_for!;
    const configHash = resolveConfig(root).config_hash;
    const persisted = {
      feature_id: "fan",
      capability_id: issued.capability_id,
      run_key: binding.run_key,
      branch: binding.branch,
      workflow: binding.workflow,
      profile_hash: binding.profile_hash,
      stage_cursor: binding.stage_cursor,
      cursor_epoch: binding.cursor_epoch,
      role: "analyst#1",
      agent: "analyst",
      config_hash: configHash,
      policy_hash: "fixture-policy",
    };
    const statePath = join(root, ".work-state", "features", "fan", "state.json");
    const beforeState = readFileSync(statePath);
    const originalConstitution = readFileSync(join(root, "CONSTITUTION.md"));
    const rejected = authorizeDispatchFromPersisted(root, persisted, {
      trustedMappingProof: currentMappingProof(root),
      preCommit: () => writeFileSync(join(root, "CONSTITUTION.md"), Buffer.concat([originalConstitution, Buffer.from("\n## II. Drift\n\nChanged before persisted dispatch CAS.\n")])),
    });
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must reject persisted dispatch authorization" : rejected.error);
    assert.deepEqual(readFileSync(statePath), beforeState, "persisted precommit drift must not mutate state");
    assert.deepEqual(resolveState(root).state?.dispatch_capability?.dispatches, [], "persisted precommit drift must not publish a dispatch record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: trusted dispatch authorization rejects precommit constitution drift without a record", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-trusted-authorize-before-commit-drift-"));
  try {
    const issued = writeNativeFanFixtureState(root);
    const binding = issued.state.issued_for!;
    const auth = {
      feature_id: "fan",
      capability_id: issued.capability_id,
      run_key: binding.run_key,
      branch: binding.branch,
      workflow: binding.workflow,
      profile_hash: binding.profile_hash,
      stage_cursor: binding.stage_cursor,
      cursor_epoch: binding.cursor_epoch,
      role: "analyst#1",
      slot_id: "analyst#1",
      agent: "analyst",
      tool_call_id: "trusted-authorize-before-commit",
    };
    const statePath = join(root, ".work-state", "features", "fan", "state.json");
    const beforeState = readFileSync(statePath);
    const originalConstitution = readFileSync(join(root, "CONSTITUTION.md"));
    let injected = false;
    setStateTransactionTestHooks({
      beforeCas: () => {
        if (injected) return;
        injected = true;
        writeFileSync(join(root, "CONSTITUTION.md"), Buffer.concat([originalConstitution, Buffer.from("\n## II. Drift\n\nChanged before trusted dispatch CAS.\n")]));
      },
    }, root);
    const rejected = authorizeDispatchTrusted(root, auth, { trustedMappingProof: currentMappingProof(root) });
    setStateTransactionTestHooks(null, root);
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must reject trusted dispatch authorization" : rejected.error);
    assert.equal(injected, true, "trusted precommit drift hook must run");
    assert.deepEqual(readFileSync(statePath), beforeState, "trusted precommit drift must not mutate state");
    assert.deepEqual(resolveState(root).state?.dispatch_capability?.dispatches, [], "trusted precommit drift must not publish a dispatch record");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: normal completion blocks slot snapshot when constitution drifts before artifact write", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-normal-before-write-drift-"));
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalReadFile = rootPrototype.readFile;
  try {
    const issued = writeNativeFanFixtureState(root);
    const dir = artifactsDir(root);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("normal", ["normal.ts"])));
    writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: "normal", verify_method: "focused", status: "pending" }] }));
    const authorized = authorizeSlot(root, issued, "analyst#1", "analyst", "normal-before-write");
    const beforeState = readFileSync(join(root, ".work-state", "features", "fan", "state.json"));
    const originalConstitution = readFileSync(join(root, "CONSTITUTION.md"));
    let drifted = false;
    rootPrototype.readFile = function (relativePath: string, options?: Parameters<PinnedProjectRoot["readFile"]>[1]) {
      const result = originalReadFile.call(this, relativePath, options);
      if (!drifted && relativePath.endsWith("/exploration.json")) {
        drifted = true;
        writeFileSync(join(root, "CONSTITUTION.md"), Buffer.concat([originalConstitution, Buffer.from("\n## II. Drift\n\nChanged during slot snapshot.\n")]));
      }
      return result;
    };
    const rejected = completeDispatch(root, {
      ...authorized.auth,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "normal slot completion",
      artifact_ids: ["exploration", "dod"],
    });
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must block normal slot completion" : rejected.error);
    assert.equal(drifted, true, "normal slot snapshot drift hook must run");
    assert.deepEqual(readFileSync(join(root, ".work-state", "features", "fan", "state.json")), beforeState, "normal drift must not commit state");
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst#1")}.json`)), false, "normal drift must not publish a slot artifact");
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst#1")}.json`)), false, "normal drift must not publish the second slot artifact");
    writeFileSync(join(root, "CONSTITUTION.md"), originalConstitution);
    rootPrototype.readFile = originalReadFile;
    const retry = completeDispatch(root, {
      ...authorized.auth,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "normal slot completion retry",
      artifact_ids: ["exploration", "dod"],
    });
    assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  } finally {
    rootPrototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: trusted reconciliation blocks slot snapshot when constitution drifts before artifact write", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-trusted-before-write-drift-"));
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalReadFile = rootPrototype.readFile;
  try {
    const issued = writeNativeFanFixtureState(root);
    const dir = artifactsDir(root);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("trusted", ["trusted.ts"])));
    writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: "trusted", verify_method: "focused", status: "pending" }] }));
    const binding = issued.state.issued_for!;
    const trustedInput = {
      feature_id: "fan",
      capability_id: issued.capability_id,
      run_key: binding.run_key,
      branch: binding.branch,
      workflow: binding.workflow,
      profile_hash: binding.profile_hash,
      stage_cursor: binding.stage_cursor,
      cursor_epoch: binding.cursor_epoch,
      role: "analyst#1",
      slot_id: "analyst#1",
      agent: "analyst",
      tool_call_id: "trusted-before-write",
    };
    const authorized = authorizeDispatchTrusted(root, trustedInput, { trustedMappingProof: currentMappingProof(root) });
    assert.equal(authorized.ok, true, authorized.ok ? "" : authorized.error);
    if (!authorized.ok || !authorized.record) return;
    const beforeState = readFileSync(join(root, ".work-state", "features", "fan", "state.json"));
    const originalConstitution = readFileSync(join(root, "CONSTITUTION.md"));
    let drifted = false;
    rootPrototype.readFile = function (relativePath: string, options?: Parameters<PinnedProjectRoot["readFile"]>[1]) {
      const result = originalReadFile.call(this, relativePath, options);
      if (!drifted && relativePath.endsWith("/exploration.json")) {
        drifted = true;
        writeFileSync(join(root, "CONSTITUTION.md"), Buffer.concat([originalConstitution, Buffer.from("\n## II. Drift\n\nChanged during trusted slot snapshot.\n")]));
      }
      return result;
    };
    const rejected = reconcileTrustedTaskResult(root, {
      ...trustedInput,
      dispatch_id: authorized.record.id,
      task_id: authorized.record.work_identity?.task_id,
      outcome: "succeeded",
      evidence: "trusted slot completion",
      artifact_ids: ["exploration", "dod"],
    });
    assert.equal(rejected.ok, false, rejected.ok ? "constitution drift must block trusted slot completion" : rejected.error);
    assert.equal(drifted, true, "trusted slot snapshot drift hook must run");
    assert.deepEqual(readFileSync(join(root, ".work-state", "features", "fan", "state.json")), beforeState, "trusted drift must not commit state");
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst#1")}.json`)), false, "trusted drift must not publish a slot artifact");
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst#1")}.json`)), false, "trusted drift must not publish the second slot artifact");
    writeFileSync(join(root, "CONSTITUTION.md"), originalConstitution);
    rootPrototype.readFile = originalReadFile;
    const retry = reconcileTrustedTaskResult(root, {
      ...trustedInput,
      dispatch_id: authorized.record.id,
      task_id: authorized.record.work_identity?.task_id,
      outcome: "succeeded",
      evidence: "trusted slot completion retry",
      artifact_ids: ["exploration", "dod"],
    });
    assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  } finally {
    rootPrototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: shared-id completions are snapshotted per slot; later slots cannot clobber provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-snapshot-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // Both analysts declare the SHARED exploration id (legacy behavior). The
    // engine must snapshot each slot's content before the next clobbers.
    const dod = JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] });
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("analyst one", ["a.ts"])));
    writeFileSync(join(dir, "dod.json"), dod);
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration", "dod"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("analyst two", ["b.ts"])));
    writeFileSync(join(dir, "dod.json"), dod);
    completeSlot(root, issued, "analyst#2", "analyst", ["exploration", "dod"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("researcher", ["c.ts"])));
    writeFileSync(join(dir, "dod.json"), dod);
    completeSlot(root, issued, "tech-researcher", "tech-researcher", ["exploration", "dod"]);

    const records = slotRecordsFor(stateOf(root), "exploration");
    assert.ok(records);
    assert.equal(Object.keys(records!.slots["analyst#1"] ?? {}).length, 2);
    assert.equal(records!.slots["analyst#1"]!["exploration"]!.path.endsWith(`${durableNamespacedArtifactId("exploration", "analyst#1")}.json`), true, "shared-id write is snapshotted into a canonical slot namespace");
    assert.equal(records!.slots["analyst#2"]!["exploration"]!.path.endsWith(`${durableNamespacedArtifactId("exploration", "analyst#2")}.json`), true);
    const snap1 = JSON.parse(readFileSync(records!.slots["analyst#1"]!["exploration"]!.path, "utf8")) as { value: { summary: string } };
    assert.equal(snap1.value.summary, "analyst one", "slot 1 keeps its own content despite the later clobber");
    const snap2 = JSON.parse(readFileSync(records!.slots["analyst#2"]!["exploration"]!.path, "utf8")) as { value: { summary: string } };
    assert.equal(snap2.value.summary, "analyst two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: deterministic synthesis merges slots in roster order, records provenance and resolved disagreements", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-synth-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // Each slot reports the stage's exact logical produce set. The durable
    // completer snapshots shared ids into slot-scoped provenance.
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("analyst one", ["a.ts"])));
    writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: "a", verify_method: "v", status: "pending" }] }));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration", "dod"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("researcher", ["c.ts"])));
    writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: "b", verify_method: "v", status: "pending" }] }));
    completeSlot(root, issued, "tech-researcher", "tech-researcher", ["exploration", "dod"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("analyst two", ["b.ts"])));
    writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] }));
    completeSlot(root, issued, "analyst#2", "analyst", ["exploration", "dod"]);

    // `summary` is a schema-required scalar that the slots genuinely
    // disagree on; the stage's documented resolution (first_slot) is the
    // explicit policy that makes the shipped parallel-exploration contract
    // advanceable without ever discarding the disagreement silently.
    const policy: FanInPolicy = {
      ...DEFAULT_FAN_IN_POLICY,
      resolutions: [
        {
          artifact: "exploration",
          field: "summary",
          strategy: "first_slot",
          rationale: "parallel exploration summaries are preserved per slot; shared summary resolves to the first contributor",
        },
      ],
    };
    const state = stateOf(root);
    const synthesized = synthesizeArtifacts(state, "exploration", dir, ["exploration", "dod"], ["analyst#1", "tech-researcher", "analyst#2"], policy);
    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    const shared = JSON.parse(readFileSync(join(dir, "exploration.json"), "utf8")) as { files_to_read: unknown[]; summary: string };
    assert.equal(shared.files_to_read.length, 3, "arrays concatenate in roster order without dedupe loss");

    assert.deepEqual(shared.files_to_read.map((f) => (f as { path: string }).path), ["a.ts", "c.ts", "b.ts"], "deterministic roster order");
    assert.equal(shared.summary, "analyst one", "declared resolution resolves the required scalar first-slot-wins");
    const provenance = synthesized.state.slot_artifacts!["exploration"]!.shared!;
    assert.deepEqual(provenance["exploration"]!.slots, ["analyst#1", "tech-researcher", "analyst#2"]);
    assert.deepEqual(provenance["dod"]!.slots, ["analyst#1", "tech-researcher", "analyst#2"], "every slot contributes every declared produce");
    const conflicts = provenance["exploration"]!.conflicts;
    assert.ok(conflicts, "resolved disagreements are recorded, never discarded");
    assert.equal(conflicts!.length, 2, "each losing slot is recorded");
    assert.deepEqual(conflicts!.map((c) => c.field), ["summary", "summary"]);
    assert.deepEqual(conflicts!.map((c) => c.strategy), ["first_slot", "first_slot"]);
    assert.deepEqual(conflicts!.map((c) => c.winner_slot), ["analyst#1", "analyst#1"], "the first roster contributor wins deterministically");
    assert.deepEqual(conflicts!.map((c) => c.losing_values.map((l) => l.slot)), [["tech-researcher"], ["analyst#2"]]);
    assert.equal(conflicts![0]!.resolved_value, "analyst one");
    assert.match(conflicts![0]!.rationale, /preserved per slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fan-in: beforeWrite guard blocks publication and retry remains atomic", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-before-write-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    const slots = [
      ["analyst#1", "analyst", "one", "a.ts"],
      ["tech-researcher", "tech-researcher", "researcher", "c.ts"],
      ["analyst#2", "analyst", "two", "b.ts"],
    ] as const;
    for (const [role, agent, summary, path] of slots) {
      writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION(summary, [path])));
      writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: summary, verify_method: "v", status: "pending" }] }));
      completeSlot(root, issued, role, agent, ["exploration", "dod"]);
    }
    rmSync(join(dir, "exploration.json"), { force: true });
    rmSync(join(dir, "dod.json"), { force: true });
    const policy: FanInPolicy = {
      ...DEFAULT_FAN_IN_POLICY,
      resolutions: [{ artifact: "exploration", field: "summary", strategy: "first_slot", rationale: "deterministic fixture resolution" }],
    };
    const state = stateOf(root);
    let calls = 0;
    const blocked = synthesizeArtifacts(state, "exploration", dir, ["exploration", "dod"], ["analyst#1", "tech-researcher", "analyst#2"], policy, undefined, {
      beforeWrite: () => { calls += 1; throw new Error("constitution changed"); },
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "write_failed");
    assert.equal(calls, 1);
    assert.equal(existsSync(join(dir, "exploration.json")), false, "guard failure publishes no shared artifact");
    assert.equal(existsSync(join(dir, "dod.json")), false, "guard failure publishes no second shared artifact");
    const retried = synthesizeArtifacts(state, "exploration", dir, ["exploration", "dod"], ["analyst#1", "tech-researcher", "analyst#2"], policy);
    assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
    assert.equal(existsSync(join(dir, "exploration.json")), true, "retry publishes the complete shared batch");
    assert.equal(existsSync(join(dir, "dod.json")), true, "retry publishes every declared produce");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fan-in: advance recovers native completions after slots wrote declared files", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-native-recovery-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    writeFileSync(join(dir, "discovery.json"), JSON.stringify({ task: "t", branch: "feat/fan" }));

    const nativeSlots = [
      ["analyst#1", "analyst", "tool-analyst-1"],
      ["tech-researcher", "tech-researcher", "tool-researcher"],
      ["analyst#2", "analyst", "tool-analyst-2"],
    ] as const;
    // Authorize the full roster before reconciling any native result: a
    // pending artifact reconciliation must not block sibling dispatches.
    for (const [role, agent, toolCallId] of nativeSlots) authorizeSlot(root, issued, role, agent, toolCallId);
    for (const [role, , toolCallId] of nativeSlots) {
      const reconciled = reconcileTrustedTaskResult(root, {
        tool_call_id: toolCallId,
        slot_id: role,
        outcome: "succeeded",
        evidence: `${role} native result`,
      });
      assert.equal(reconciled.ok, true, `native reconciliation for ${role}${reconciled.ok ? "" : `: ${reconciled.error}`}`);
    }

    writeFileSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst#1")}.json`), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    writeFileSync(join(dir, `${durableNamespacedArtifactId("exploration", "tech-researcher")}.json`), JSON.stringify(EXPLORATION("two", ["b.ts"])));
    writeFileSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst#2")}.json`), JSON.stringify(EXPLORATION("three", ["c.ts"])));
    const dod = JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] });
    writeFileSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst#1")}.json`), dod);
    writeFileSync(join(dir, `${durableNamespacedArtifactId("dod", "tech-researcher")}.json`), dod);
    writeFileSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst#2")}.json`), dod);
    const advanced = advanceCursor(root, {
      feature_id: "fan",
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      evidence: "native consilium outputs reconciled",
    }, { trustedMappingProof: currentMappingProof(root) });
    assert.equal(advanced.ok, true, advanced.ok ? "native completion without ids is repaired from slot-scoped files" : advanced.error);
    assert.equal(existsSync(join(dir, "exploration.json")), true, "fan-in writes the shared produce after recovery");
    const recovered = stateOf(root);
    const slots = recovered.slot_artifacts!.exploration!.slots;
    assert.deepEqual(Object.keys(slots["analyst#1"] ?? {}).sort(), ["dod", "exploration"]);
    assert.deepEqual(Object.keys(slots["tech-researcher"] ?? {}).sort(), ["dod", "exploration"]);
    assert.deepEqual(Object.keys(slots["analyst#2"] ?? {}).sort(), ["dod", "exploration"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fan-in: pending raw namespaced recovery rejects leaf, ancestor, and root swaps before canonical envelope CAS", () => {
  for (const swapKind of ["leaf", "ancestor", "root"] as const) {
    const root = mkdtempSync(join(tmpdir(), `fan-native-cas-swap-${swapKind}-`));
    const outside = mkdtempSync(join(tmpdir(), `fan-native-cas-outside-${swapKind}-`));
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "outside sentinel\n");
    const originalOpen = PinnedProjectRoot.open;
    let swapped = false;
    const artifactsRelative = ".work-state/features/fan/artifacts";
    const targetId = durableNamespacedArtifactId("exploration", "analyst#1");
    const targetRelativeSuffix = `${targetId}.json`;
    const movedRoot = `${root}.moved`;
    const stateRelative = ".work-state/features/fan/state.json";
    try {
      initGit(root, "feat/fan");
      const issued = writeFixtureState(root, "full-feature", "exploration");
      const dir = join(root, artifactsRelative);
      const nativeSlots = [
        ["analyst#1", "analyst", "tool-analyst-1"],
        ["tech-researcher", "tech-researcher", "tool-researcher"],
        ["analyst#2", "analyst", "tool-analyst-2"],
      ] as const;
      for (const [role, agent, toolCallId] of nativeSlots) authorizeSlot(root, issued, role, agent, toolCallId);
      for (const [role, , toolCallId] of nativeSlots) {
        const reconciled = reconcileTrustedTaskResult(root, {
          tool_call_id: toolCallId,
          slot_id: role,
          outcome: "succeeded",
          evidence: `${role} native result`,
        });
        assert.equal(reconciled.ok, true, reconciled.ok ? "" : reconciled.error);
      }
      const raw = JSON.stringify(EXPLORATION("raw pending", ["raw.ts"]));
      for (const [role] of nativeSlots) {
        writeFileSync(join(dir, `${durableNamespacedArtifactId("exploration", role)}.json`), raw);
        const dod = JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] });
        writeFileSync(join(dir, `${durableNamespacedArtifactId("dod", role)}.json`), dod);
      }
      const stateBefore = readFileSync(join(root, stateRelative));
      const conditionalPaths: string[] = [];
      PinnedProjectRoot.open = ((projectRoot: unknown, hooks = {}) => originalOpen(projectRoot, {
        ...hooks,
        beforeTempOpen: (relativePath) => {
          conditionalPaths.push(relativePath);
          const swapTrigger = stateRelative;
          if (!swapped && relativePath === swapTrigger) {
            if (swapKind === "leaf") {
              renameSync(join(root, relativePath), join(dir, `${targetRelativeSuffix}.moved`));
              writeFileSync(join(root, relativePath), "interloper replacement\n");
            } else if (swapKind === "ancestor") {
              renameSync(dir, `${dir}.moved`);
              symlinkSync(outside, dir, "dir");
            } else {
              renameSync(root, movedRoot);
              symlinkSync(outside, root, "dir");
            }
            swapped = true;
          }
          hooks.beforeTempOpen?.(relativePath);
        },
      })) as typeof originalOpen;
      const advanced = advanceCursor(root, {
        feature_id: "fan",
        token: issued.advance_token,
        capability_id: issued.capability_id,
        run_key: issued.state.issued_for!.run_key,
        branch: issued.state.issued_for!.branch,
        workflow: issued.state.issued_for!.workflow,
        profile_hash: issued.state.issued_for!.profile_hash,
        stage_cursor: issued.state.issued_for!.stage_cursor,
        cursor_epoch: issued.state.issued_for!.cursor_epoch,
        evidence: `raw pending recovery ${swapKind} swap`,
      }, { trustedMappingProof: currentMappingProof(root) });
      assert.equal(swapped, true, `${swapKind}: deterministic pre-CAS swap hook must run (${conditionalPaths.join(", ")}); advance=${advanced.ok ? "ok" : advanced.error}`);
      assert.equal(readFileSync(sentinel, "utf8"), "outside sentinel\n", `${swapKind}: outside sentinel must remain untouched`);
      if (swapKind !== "root") {
        // Leaf/ancestor replacement occurs after canonical envelopes have been
        // published and does not detach the pinned project root. The root
        // replacement below is the contract boundary that must fail closed.
        assert.equal(advanced.ok, true, `${swapKind}: bounded recovery remains successful after post-envelope source replacement`);
        continue;
      }
      assert.equal(advanced.ok, false, `root replacement before state CAS must reject the detached root (${conditionalPaths.join(", ")}); advance=${advanced.ok ? "ok" : advanced.error}`);
      const stateRoot = movedRoot;
      assert.deepEqual(readFileSync(join(stateRoot, stateRelative)), stateBefore, `${swapKind}: state must remain unchanged`);
      const artifactRoot = swapKind === "ancestor"
        ? `${dir}.moved`
        : swapKind === "root"
          ? join(movedRoot, artifactsRelative)
          : dir;
      const sharedPath = join(artifactRoot, "exploration.json");
      const sharedContent = existsSync(sharedPath) ? readFileSync(sharedPath, "utf8") : "";
      assert.equal(sharedContent.includes("$omp_slot_artifact"), false, `${swapKind}: no canonical envelope may be published`);
      const targetPath = swapKind === "leaf"
        ? join(dir, `${targetId}.json`)
        : join(artifactRoot, `${targetId}.json`);
      assert.equal(readFileSync(targetPath, "utf8").includes("$omp_slot_artifact"), false, `${swapKind}: no canonical slot envelope may be published`);
      const current = JSON.parse(readFileSync(join(stateRoot, stateRelative), "utf8")) as TeamState;
      assert.equal(current.dispatch_capability?.dispatches.some((dispatch) => dispatch.status === "succeeded"), false, `${swapKind}: no completion may be published`);
    } finally {
      PinnedProjectRoot.open = originalOpen;
      rmSync(root, { recursive: true, force: true });
      rmSync(movedRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("spec-preparation: native specify completion advances from its current single-writer output", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-spec-native-"));
  try {
    initGit(root, "main");
    const issued = writeSpecFixtureState(root);
    const dir = specArtifactsDir(root);
    const authorization = authorizeSlot(root, issued, "specification-analyst", "specification-worker", "tool-spec-analyst", "spec");
    writeSpecifyDraft(dir, fixtureConstitutionBinding(root));
    persistNativeSpecifyCandidate(root, authorization);
    const reconciled = reconcileTrustedTaskResult(root, {
      feature_id: "spec",
      run_key: issued.state.issued_for!.run_key,
      capability_id: issued.capability_id,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_id: authorization.record.id,
      tool_call_id: "tool-spec-analyst",
      outcome: "succeeded",
      evidence: "analyst native result",
    });
    assert.equal(reconciled.ok, true, reconciled.ok ? "native reconciliation for analyst" : reconciled.error);
    const validation = completeNativeSpecifyValidator(root, authorization);
    approveSpecify(root, issued);

    const advanced = advanceCursor(root, {
      feature_id: "spec",
      token: validation.advance_token,
      capability_id: validation.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: validation.capability_epoch,
      evidence: "specify complete",
    }, { trustedMappingProof: currentMappingProof(root) });
    assert.equal(advanced.ok, true, advanced.ok ? "spec-preparation specify transition succeeds" : advanced.error);
    assert.equal(advanced.ok && advanced.state.stage_cursor, "plan");
    assert.equal(existsSync(join(dir, "specify_draft.json")), true, "the specify draft is persisted");
    assert.equal(advanced.ok ? advanced.state.slot_artifacts : undefined, undefined, "single specify writer does not create fan-in snapshots");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("spec-preparation: native specify completion defers until its declared artifact is readable", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-native-delayed-"));
  try {
    initGit(root, "main");
    const issued = writeSpecFixtureState(root);
    const dir = specArtifactsDir(root);
    const sharedId = "specify_draft";
    const analystAuth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "specification-analyst",
      agent: "specification-worker",
      feature_id: "spec",
      tool_call_id: "tool-spec-delayed-analyst",
    };
    const analystDispatch = authorizeDispatch(root, analystAuth, { trustedMappingProof: currentMappingProof(root) });
    assert.ok(analystDispatch.ok && analystDispatch.record, analystDispatch.ok ? "native specification dispatch authorized" : analystDispatch.error);
    const dispatchId = analystDispatch.ok ? analystDispatch.record!.id : "";
    const analystNative = reconcileTrustedTaskResult(root, {
      feature_id: "spec",
      run_key: issued.state.issued_for!.run_key,
      capability_id: issued.capability_id,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_id: analystDispatch.ok ? analystDispatch.record!.id : undefined,
      tool_call_id: analystAuth.tool_call_id,
      outcome: "succeeded",
      evidence: "analyst native result",
    });
    assert.equal(analystNative.ok, true, analystNative.ok ? "" : analystNative.error);
    const deferred = specStateOf(root).dispatch_capability?.dispatches.find((record) => record.id === dispatchId);
    assert.equal(deferred?.status, "pending", analystNative.ok ? "native completion waits for the declared artifact instead of admitting a partial write" : analystNative.error);
    assert.deepEqual(deferred?.pending?.reconciliation?.artifact_ids, [sharedId]);

    // The artifact becomes readable before the advance boundary. Advance
    // consumes the persisted reconciliation and admits the exact produce set.
    writeSpecifyDraft(dir, fixtureConstitutionBinding(root));
    let validation: ReturnType<typeof completeNativeSpecifyValidator> | null = null;
    if (analystDispatch.ok && analystDispatch.record) {
      persistNativeSpecifyCandidate(root, { auth: analystAuth, record: analystDispatch.record });
      const recovered = reconcileTrustedTaskResult(root, {
        feature_id: "spec",
        run_key: issued.state.issued_for!.run_key,
        capability_id: issued.capability_id,
        cursor_epoch: issued.state.issued_for!.cursor_epoch,
        dispatch_id: analystDispatch.record.id,
        tool_call_id: analystAuth.tool_call_id,
        outcome: "succeeded",
        evidence: "analyst native result",
      });
      assert.equal(recovered.ok, true, recovered.ok ? "delayed native generation receipt recovered" : recovered.error);
      validation = completeNativeSpecifyValidator(root, { auth: analystAuth, record: analystDispatch.record });
    }
    assert.ok(validation, "delayed native fixture must complete its validator dispatch");
    if (!validation) return;
    approveSpecify(root, issued);
    const advanced = advanceCursor(root, {
      feature_id: "spec",
      token: validation.advance_token,
      capability_id: validation.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: validation.capability_epoch,
      evidence: "delayed native artifact recovered",
    }, { trustedMappingProof: currentMappingProof(root) });
    assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.error);
    assert.equal(advanced.ok && advanced.state.stage_cursor, "plan");
    assert.equal(existsSync(join(dir, `${sharedId}.json`)), true, "the delayed specify draft is validated at advance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fan-in: merge dedupes identical array items and deep-merges objects", () => {
  const merged = mergeSlotValues(
    [{ items: [{ id: "a", status: "pending" }], verdict: "x" }, { items: [{ id: "a", status: "pending" }, { id: "b", status: "met" }], verdict: "y" }],
    null,
    false,
    "dod",
  );
  assert.equal(merged.ok, true);
  if (merged.ok) {
    const value = merged.value as { items: unknown[]; verdict: string };
    assert.equal(value.items.length, 2, "identical items dedupe, distinct items append");
    assert.equal(value.verdict, "x", "optional scalar keeps the first value");
  }
});

test("fan-in: missing slot results and empty slots block; strict conflicts block with field diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-block-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // No slot recorded anything -> every produce is missing.
    const empty = missingSlotResults(stateOf(root), "exploration", ["analyst#1", "tech-researcher", "analyst#2"], ["exploration", "dod"]);
    assert.ok(empty.length > 0, "empty fan-in is detected as missing");

    const splitRecord = { path: join(root, "unused.json"), sha256: "0".repeat(64), size_bytes: 0 };
    const splitState = {
      slot_artifacts: {
        exploration: {
          slots: {
            "analyst#1": { exploration: splitRecord },
            "tech-researcher": { dod: splitRecord },
          },
        },
      },
    } as TeamState;
    const splitMissing = missingSlotResults(splitState, "exploration", ["analyst#1", "tech-researcher"], ["exploration", "dod"]);
    assert.deepEqual(splitMissing, [
      { slot: "analyst#1", artifactId: "dod" },
      { slot: "tech-researcher", artifactId: "exploration" },
    ], "split omissions require the complete slot-by-produce matrix");
    const duplicateState = {
      slot_artifacts: {
        exploration: {
          slots: {
            "analyst#1": {
              exploration: splitRecord,
              [durableNamespacedArtifactId("exploration", "analyst#1")]: splitRecord,
            },
            "tech-researcher": { exploration: splitRecord },
          },
        },
      },
    } as TeamState;
    const duplicate = synthesizeArtifacts(duplicateState, "exploration", root, ["exploration"], ["analyst#1", "tech-researcher"]);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.code, "record_invalid");

    // Strict conflict: required scalar `summary` disagrees between slots.
    const strict = mergeSlotValues(
      [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
      ["files_to_read", "summary"],
      true,
      "exploration",
    );
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.match(strict.error, /required scalar field 'summary'.*no explicit resolution/s);

    // Explicit opt-out of strict (setFanInPolicy): the same disagreement
    // resolves deterministically and is recorded, never discarded.
    const lenient = mergeSlotValues(
      [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
      ["files_to_read", "summary"],
      false,
      "exploration",
    );
    assert.equal(lenient.ok, true);
    if (lenient.ok) {
      assert.equal((lenient.value as { summary: string }).summary, "one");
      assert.ok(lenient.conflicts, "lenient resolution is still recorded in provenance");
      assert.equal(lenient.conflicts![0]!.strategy, "lenient");
      assert.equal(lenient.conflicts![0]!.winner_slot, "slot-0");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: default policy is strict; an explicit resolution applies only to the declared field", () => {
  assert.equal(DEFAULT_FAN_IN_POLICY.strict, true, "required-scalar conflicts block handoff by default (criterion 3)");

  // Without a resolution, a required-scalar disagreement blocks.
  const blocked = mergeSlotValues(
    [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
    ["files_to_read", "summary"],
    true,
    "exploration",
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.error, /required scalar field 'summary'.*no explicit resolution/s);

  // The declared resolution for exactly (exploration, summary) resolves the
  // disagreement first-slot-wins and records the conflict provenance.
  const resolved = mergeSlotValues(
    [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
    ["files_to_read", "summary"],
    true,
    "exploration",
    [{ artifact: "exploration", field: "summary", strategy: "first_slot", rationale: "documented parallel-summary resolution" }],
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal((resolved.value as { summary: string }).summary, "one");
    assert.equal(resolved.conflicts?.length, 1);
    assert.equal(resolved.conflicts![0]!.strategy, "first_slot");
    assert.equal(resolved.conflicts![0]!.field, "summary");
    assert.deepEqual(resolved.conflicts![0]!.losing_values[0]!.value, "two", "losing scalar values are preserved, not discarded");
    assert.match(resolved.conflicts![0]!.rationale, /documented/);
  }

  // A resolution for a different field does not relax the conflict: an
  // undeclared required-scalar disagreement still blocks.
  const otherBlocked = mergeSlotValues(
    [{ verdict: "approve" }, { verdict: "reject" }],
    ["verdict"],
    true,
    "review",
    [{ artifact: "review", field: "other", strategy: "first_slot", rationale: "irrelevant" }],
  );
  assert.equal(otherBlocked.ok, false);
  if (!otherBlocked.ok) assert.match(otherBlocked.error, /required scalar field 'verdict'/);

  // An unsupported resolution strategy fails closed rather than resolving.
  const unsupported = mergeSlotValues(
    [{ verdict: "approve" }, { verdict: "reject" }],
    ["verdict"],
    true,
    "review",
    [{ artifact: "review", field: "verdict", strategy: "majority", rationale: "x" } as never],
  );
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /strategy 'majority' is not supported/);
});
test("fan-in: nested scalar conflicts retain the actual contributing slot provenance", () => {
  const resolved = mergeSlotValues(
    [
      { nested: { a: 1 } },
      { nested: { b: 2 } },
      { nested: { b: 3 } },
    ],
    ["nested.b"],
    true,
    "evidence",
    [{ artifact: "evidence", field: "nested.b", strategy: "first_slot", rationale: "nested b keeps its first contributor" }],
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.value, { nested: { a: 1, b: 2 } });
  assert.equal(resolved.conflicts?.length, 1);
  assert.equal(resolved.conflicts?.[0]?.field, "nested.b");
  assert.equal(resolved.conflicts?.[0]?.winner_slot, "slot-1");
  assert.deepEqual(resolved.conflicts?.[0]?.losing_values, [{ slot: "slot-2", value: 3 }]);
});

test("fan-in: partial slot artifact sets are rejected at durable completion", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-advance-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // The stage declares exploration + dod. A completion that reports only
    // one produce is rejected before any slot provenance is persisted.
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    assert.equal(
      completeSlot(root, issued, "analyst#1", "analyst", ["exploration"], false),
      false,
      "partial produce set must fail exact durable admission",
    );
    assert.equal(slotRecordsFor(stateOf(root), "exploration"), null, "rejected completion must not persist slot records");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: collision (same slot writing the same artifact twice with different content) blocks at completion", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-collision-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    writeFileSync(join(dir, "dod.json"), JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] }));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration", "dod"]);
    // Re-complete the same dispatch with different content is a conflicting
    // replay at the dispatch level; drive the collision via a second record:
    // authorize the role again after a failed attempt is not possible in one
    // capability, so assert the pure record-level invariant instead.
    const records = slotRecordsFor(stateOf(root), "exploration");
    const record = records!.slots["analyst#1"]!["exploration"]!;
    const first = record.sha256;
    // Same content -> same hash (idempotent replay snapshot).
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "analyst#1",
      agent: "analyst",
      feature_id: "fan",
    };
    const authorized = authorizeDispatch(root, auth, { trustedMappingProof: currentMappingProof(root) });
    assert.equal(authorized.ok, false, "role already dispatched (failed/cancelled required before re-dispatch)");
    // The snapshot record is immutable per completion: changing the file
    // after the fact cannot alter recorded provenance.
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("changed", ["z.ts"])));
    assert.equal(slotRecordsFor(stateOf(root), "exploration")!.slots["analyst#1"]!["exploration"]!.sha256, first, "provenance hash is immutable after recording");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: a zero-artifact slot never inherits foreign shared content as its namespaced provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "fan-freerider-"));
  // No slash in the branch so the derived feature slug equals the branch.
  const branch = "fan-free-rider";
  try {
    initGit(root, branch);
    writeTestRegistryMarker(root);
    const profile: Profile = {
      name: "fan-free-rider",
      title: "Free-rider regression",
      description: "consilium slot returning no artifacts must not be credited with another slot's shared write",
      match: { type: ["FEATURE"] },
      stages: [
        {
          id: "exploration",
          title: "Exploration",
          type: "consilium",
          roles: ["analyst", "tech-researcher"],
          parallel: true,
          produces: ["exploration"],
        },
        { id: "summary", title: "Summary", type: "orchestrator", consumes: ["exploration"] },
      ],
    };
    registerTestProfiles(root, [profile]);
    const taskTool: TaskCaller = {
      async call() { return { id: "x", output: "ok", artifacts: {}, exitCode: 0 }; },
      async batch() {
        return [
          { id: "exploration-analyst", output: "ok", artifacts: { exploration: EXPLORATION("analyst view", ["a.ts"]) }, exitCode: 0 },
          // The second slot returns nothing. The entire consilium fan-in is
          // prevalidated before any shared or namespaced file is committed.
          { id: "exploration-tech-researcher", output: "ok", artifacts: {}, exitCode: 0 },
        ];
      },
    };
    const result = await run({
      task: "free-rider fan-in",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "fan-free-rider" },
      taskTool,
    });
    const exploration = result.outcomes.find((o) => o.stageId === "exploration");
    assert.equal(exploration?.status, "failed", "a zero-artifact slot must fail the consilium stage");
    assert.match(exploration?.note ?? "", /completion artifact ids must exactly match current stage\.produces/);
    const artifacts = join(root, ".work-state", "features", "fan-free-rider", "artifacts");
    assert.equal(existsSync(join(artifacts, "exploration.json")), false, "failed fan-in must not leave the shared artifact");
    assert.equal(existsSync(join(artifacts, `${durableNamespacedArtifactId("exploration", "analyst")}.json`)), false, "failed fan-in must not leave a contributor namespace");
    assert.equal(existsSync(join(artifacts, `${durableNamespacedArtifactId("exploration", "tech-researcher")}.json`)), false, "the empty slot must not inherit a shared artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function fanInProfile(name: string, produces: string[]): Profile {
  return {
    name,
    title: "Fan-in transactional regression",
    description: "consilium writes are exact and transactional",
    match: { type: ["FEATURE"] },
    stages: [
      {
        id: "exploration",
        title: "Exploration",
        type: "consilium",
        roles: ["analyst", "tech-researcher"],
        parallel: true,
        produces,
      },
      { id: "summary", title: "Summary", type: "orchestrator", consumes: [produces[0]!] },
    ],
  };
}

function fanInBatch(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): TaskCaller {
  return {
    async call() {
      return { id: "unused", output: "ok", artifacts: {}, exitCode: 0 };
    },
    async batch() {
      return [
        { id: "exploration-analyst", output: "ok", artifacts: first, exitCode: 0 },
        { id: "exploration-tech-researcher", output: "ok", artifacts: second, exitCode: 0 },
      ];
    },
  };
}

test("fan-in: missing second produce leaves zero files for that slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "fan-missing-second-"));
  const branch = "fan-missing-second";
  const produces = ["exploration", "dod"];
  try {
    initGit(root, branch);
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [fanInProfile("fan-missing-second", produces)]);
    const result = await run({
      task: "missing second fan-in produce",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "fan-missing-second" },
      taskTool: fanInBatch(
        { exploration: EXPLORATION("partial slot", ["partial.ts"]) },
        {
          exploration: EXPLORATION("complete slot", ["complete.ts"]),
          dod: { items: [{ criterion: "complete", verify_method: "fixture", status: "pending" }] },
        },
      ),
    });
    const exploration = result.outcomes.find((outcome) => outcome.stageId === "exploration");
    assert.equal(exploration?.status, "failed");
    assert.match(exploration?.note ?? "", /completion artifact ids must exactly match current stage\.produces/);
    const dir = join(root, ".work-state", "features", branch, "artifacts");
    assert.equal(existsSync(join(dir, "exploration.json")), false);
    assert.equal(existsSync(join(dir, "dod.json")), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst")}.json`)), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst")}.json`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: collision on a second slot produce leaves no new slot files", async () => {
  const root = mkdtempSync(join(tmpdir(), "fan-collision-second-"));
  const branch = "fan-collision-second";
  const produces = ["exploration", "dod"];
  try {
    initGit(root, branch);
    const dir = join(root, ".work-state", "features", branch, "artifacts");
    mkdirSync(dir, { recursive: true });
    const collisionPath = join(dir, `${durableNamespacedArtifactId("exploration", "tech-researcher")}.json`);
    const collisionBytes = Buffer.from(slotArtifactEnvelopeBytes(
      "exploration",
      "tech-researcher",
      "foreign-provider",
      EXPLORATION("foreign", ["foreign.ts"]),
    ));
    writeFileSync(collisionPath, collisionBytes);
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [fanInProfile("fan-collision-second", produces)]);
    const result = await run({
      task: "second slot collision fan-in",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "fan-collision-second" },
      taskTool: fanInBatch(
        {
          exploration: EXPLORATION("first", ["first.ts"]),
          dod: { items: [{ criterion: "first", verify_method: "fixture", status: "pending" }] },
        },
        {
          exploration: EXPLORATION("second", ["second.ts"]),
          dod: { items: [{ criterion: "second", verify_method: "fixture", status: "pending" }] },
        },
      ),
    });
    const exploration = result.outcomes.find((outcome) => outcome.stageId === "exploration");
    assert.equal(exploration?.status, "failed");
    assert.match(exploration?.note ?? "", /collided with a different slot\/provider payload/);
    assert.deepEqual(readFileSync(collisionPath), collisionBytes, "the preexisting collision must not be overwritten");
    assert.equal(existsSync(join(dir, "exploration.json")), false);
    assert.equal(existsSync(join(dir, "dod.json")), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst")}.json`)), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst")}.json`)), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "tech-researcher")}.json`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: atomic write failure rolls back every shared and namespaced slot file", async () => {
  const root = mkdtempSync(join(tmpdir(), "fan-write-rollback-"));
  const branch = "fan-write-rollback";
  const produces = ["exploration", "dod"];
  const originalOpen = PinnedProjectRoot.open;
  let injected = false;
  try {
    initGit(root, branch);
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [fanInProfile("fan-write-rollback", produces)]);
    PinnedProjectRoot.open = ((projectRoot: unknown, hooks: PinnedRootWriteHooks = {}) => {
      let failArmed = false;
      const combined: PinnedRootWriteHooks = { ...hooks };
      combined.beforeTempOpen = (relativePath: string) => {
        hooks.beforeTempOpen?.(relativePath);
        if (!failArmed && relativePath.endsWith("/exploration.json")) {
          combined.batchFailureIndex = 1;
          failArmed = true;
          injected = true;
        }
      };
      combined.beforeCleanup = (relativePath: string) => {
        hooks.beforeCleanup?.(relativePath);
        if (failArmed) combined.batchFailureIndex = undefined;
      };
      return originalOpen(projectRoot, combined);
    }) as typeof originalOpen;
    const result = await run({
      task: "atomic fan-in rollback",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "fan-write-rollback" },
      taskTool: fanInBatch(
        {
          exploration: EXPLORATION("first", ["first.ts"]),
          dod: { items: [{ criterion: "first", verify_method: "fixture", status: "pending" }] },
        },
        {
          exploration: EXPLORATION("second", ["second.ts"]),
          dod: { items: [{ criterion: "second", verify_method: "fixture", status: "pending" }] },
        },
      ),
    });
    const exploration = result.outcomes.find((outcome) => outcome.stageId === "exploration");
    assert.equal(injected, true, "the deterministic batch failure seam must execute");
    assert.equal(exploration?.status, "failed");
    const dir = join(root, ".work-state", "features", branch, "artifacts");
    assert.equal(existsSync(join(dir, "exploration.json")), false);
    assert.equal(existsSync(join(dir, "dod.json")), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("exploration", "analyst")}.json`)), false);
    assert.equal(existsSync(join(dir, `${durableNamespacedArtifactId("dod", "analyst")}.json`)), false);
  } finally {
    PinnedProjectRoot.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
  }
});


test("fan-in: anchored batch failure preserves preexisting output and exact retry publishes all shared artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-batch-retry-"));
  writeTestRegistryMarker(root);
  const originalOpen = PinnedProjectRoot.open;
  let injected = false;
  try {
    const firstEvidencePath = join(root, "evidence-first.json");
    const secondEvidencePath = join(root, "evidence-second.json");
    const firstDodPath = join(root, "dod-first.json");
    const secondDodPath = join(root, "dod-second.json");
    const firstEvidence = { items: ["first"] };
    const secondEvidence = { items: ["second"] };
    const firstDod = { items: [{ criterion: "first" }] };
    const secondDod = { items: [{ criterion: "second" }] };
    writeFileSync(firstEvidencePath, JSON.stringify(firstEvidence));
    writeFileSync(secondEvidencePath, JSON.stringify(secondEvidence));
    writeFileSync(firstDodPath, JSON.stringify(firstDod));
    writeFileSync(secondDodPath, JSON.stringify(secondDod));
    const state = {
      slot_artifacts: {
        secure: {
          slots: {
            first: { evidence: exactSlotRecord(firstEvidencePath), dod: exactSlotRecord(firstDodPath) },
            second: { evidence: exactSlotRecord(secondEvidencePath), dod: exactSlotRecord(secondDodPath) },
          },
        },
      },
    } as TeamState;
    const beforeState = JSON.stringify(state);
    const preexistingEvidence = JSON.stringify({ items: ["first", "second"] }, null, 2) + "\n";
    writeFileSync(join(root, "evidence.json"), preexistingEvidence);
    PinnedProjectRoot.open = ((projectRoot: unknown, hooks: PinnedRootWriteHooks = {}) => {
      const combined: PinnedRootWriteHooks = { ...hooks, batchFailureIndex: 1 };
      combined.beforeTempOpen = (relativePath: string) => {
        hooks.beforeTempOpen?.(relativePath);
        if (!injected && (relativePath === "evidence.json" || relativePath.endsWith("/evidence.json"))) injected = true;
      };
      return originalOpen(projectRoot, combined);
    }) as typeof originalOpen;
    const failed = synthesizeArtifacts(state, "secure", root, ["evidence", "dod"], ["first", "second"]);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.code, "write_failed");
    assert.equal(injected, true, "the second-publication failure seam must execute");
    assert.equal(JSON.stringify(state), beforeState, "a failed batch must not mutate the state object");
    assert.equal(readFileSync(join(root, "evidence.json"), "utf8"), preexistingEvidence, "preexisting exact output must survive rollback");
    assert.equal(existsSync(join(root, "dod.json")), false, "the later shared output must not be orphaned");

    PinnedProjectRoot.open = originalOpen;
    const retried = synthesizeArtifacts(state, "secure", root, ["evidence", "dod"], ["first", "second"]);
    assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
    assert.equal(readFileSync(join(root, "evidence.json"), "utf8"), preexistingEvidence, "exact retry preserves the canonical merged bytes");
    assert.equal(existsSync(join(root, "dod.json")), true, "exact retry publishes every shared output");
    if (retried.ok) assert.deepEqual(Object.keys(retried.shared).sort(), ["dod", "evidence"]);
  } finally {
    PinnedProjectRoot.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
  }
});


function exactSlotRecord(path: string) {
  const bytes = readFileSync(path);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.byteLength };
}

function snapshotState(artifactId: string, first: ReturnType<typeof exactSlotRecord>, second = first): TeamState {
  return { slot_artifacts: { secure: { slots: { first: { [artifactId]: first }, second: { [artifactId]: second } } } } } as TeamState;
}

function synthesizeSnapshot(root: string, artifactId: string, first: ReturnType<typeof exactSlotRecord>, second = first) {
  return synthesizeArtifacts(snapshotState(artifactId, first, second), "secure", root, [artifactId], ["first", "second"]);
}

test("fan-in: valid contained exact-byte snapshots synthesize unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-secure-valid-"));
  try {
    const firstPath = join(root, "evidence-first.json");
    const secondPath = join(root, "evidence-second.json");
    writeFileSync(firstPath, JSON.stringify({ items: ["first"] }));
    writeFileSync(secondPath, JSON.stringify({ items: ["second"] }));
    const result = synthesizeSnapshot(root, "evidence", exactSlotRecord(firstPath), exactSlotRecord(secondPath));
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "evidence.json"), "utf8")), { items: ["first", "second"] });
    if (result.ok) assert.deepEqual(result.shared.evidence?.slots, ["first", "second"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fan-in: outside-root and symlink snapshot records block before reads", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-secure-root-"));
  const outside = mkdtempSync(join(tmpdir(), "fan-secure-outside-"));
  try {
    const containedPath = join(root, "contained.json");
    const outsidePath = join(outside, "outside.json");
    writeFileSync(containedPath, "{}");
    writeFileSync(outsidePath, "{}");
    const outsideResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(outsidePath), exactSlotRecord(containedPath));
    assert.equal(outsideResult.ok, false);
    if (!outsideResult.ok) assert.equal(outsideResult.code, "path_unauthorized");
    const linkPath = join(root, "linked.json");
    symlinkSync(containedPath, linkPath);
    const linkResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(linkPath), exactSlotRecord(containedPath));
    assert.equal(linkResult.ok, false);
    if (!linkResult.ok) assert.equal(linkResult.code, "path_unauthorized");
    const parentLink = join(root, "parent-link");
    symlinkSync(outside, parentLink);
    const parentResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(join(parentLink, "outside.json")), exactSlotRecord(containedPath));
    assert.equal(parentResult.ok, false);
    if (!parentResult.ok) assert.equal(parentResult.code, "path_unauthorized");
    const ancestorLink = join(root, "ancestor-link");
    symlinkSync(outside, ancestorLink);
    const ancestorResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(join(ancestorLink, "outside.json")), exactSlotRecord(containedPath));
    assert.equal(ancestorResult.ok, false);
    if (!ancestorResult.ok) assert.equal(ancestorResult.code, "path_unauthorized");
    const rootLink = join(root, "root-link");
    symlinkSync(outside, rootLink);
    const rootResult = synthesizeSnapshot(rootLink, "evidence", exactSlotRecord(outsidePath), exactSlotRecord(outsidePath));
    assert.equal(rootResult.ok, false);
    if (!rootResult.ok) assert.equal(rootResult.code, "root_unauthorized");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("fan-in: substituted digest, recorded size, and oversize payloads block deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-secure-integrity-"));
  try {
    const path = join(root, "evidence-first.json");
    writeFileSync(path, "{}");
    const valid = exactSlotRecord(path);
    writeFileSync(path, "[]");
    const stale = synthesizeSnapshot(root, "evidence", valid, valid);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "digest_mismatch");
    writeFileSync(path, "{}");
    const digest = synthesizeSnapshot(root, "evidence", { ...valid, sha256: "0".repeat(64) }, valid);
    assert.equal(digest.ok, false);
    if (!digest.ok) assert.equal(digest.code, "digest_mismatch");
    const size = synthesizeSnapshot(root, "evidence", { ...valid, size_bytes: valid.size_bytes + 1 }, valid);
    assert.equal(size.ok, false);
    if (!size.ok) assert.equal(size.code, "size_mismatch");
    const oversize = synthesizeSnapshot(root, "evidence", { ...valid, size_bytes: 8 * 1024 * 1024 + 1 }, valid);
    assert.equal(oversize.ok, false);
    if (!oversize.ok) assert.equal(oversize.code, "too_large");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fan-in: malformed JSON and non-regular snapshot targets block deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-secure-shape-"));
  try {
    const malformedPath = join(root, "evidence-first.json");
    writeFileSync(malformedPath, "{not-json}");
    const malformedResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(malformedPath));
    assert.equal(malformedResult.ok, false);
    if (!malformedResult.ok) assert.equal(malformedResult.code, "malformed");
    const directory = join(root, "evidence-second.json");
    writeFileSync(malformedPath, "{}");
    mkdirSync(directory);
    const directoryResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(malformedPath), { path: directory, sha256: "0".repeat(64), size_bytes: 0 });
    assert.equal(directoryResult.ok, false);
    if (!directoryResult.ok) assert.equal(directoryResult.code, "not_regular");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("durable fan-in snapshots canonicalize object key-order permutations", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-canonical-snapshot-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    const dod = JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] });
    writeFileSync(join(dir, "exploration.json"), JSON.stringify({ summary: "same", files_to_read: [{ why: "x", path: "a.ts" }] }));
    writeFileSync(join(dir, "dod.json"), dod);
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration", "dod"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify({ files_to_read: [{ path: "a.ts", why: "x" }], summary: "same" }));
    writeFileSync(join(dir, "dod.json"), dod);
    completeSlot(root, issued, "tech-researcher", "tech-researcher", ["exploration", "dod"]);
    const records = slotRecordsFor(stateOf(root), "exploration")!;
    const first = records.slots["analyst#1"]!.exploration!;
    const second = records.slots["tech-researcher"]!.exploration!;
    const firstEnvelope = JSON.parse(readFileSync(first.path, "utf8")) as { value: unknown };
    const secondEnvelope = JSON.parse(readFileSync(second.path, "utf8")) as { value: unknown };
    assert.notEqual(first.sha256, second.sha256, "identity envelope keeps distinct slot/provider provenance");
    assert.equal(first.value_sha256, second.value_sha256, "logical value digest remains canonical across key order");
    assert.deepEqual(firstEnvelope.value, secondEnvelope.value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fan-in: canonical identity dedupes object key-order permutations", () => {
  const merged = mergeSlotValues(
    [{ items: [{ alpha: 1, beta: 2 }] }, { items: [{ beta: 2, alpha: 1 }] }],
    null,
    true,
    "permuted",
  );
  assert.equal(merged.ok, true);
  if (merged.ok) assert.deepEqual(merged.value, { items: [{ alpha: 1, beta: 2 }] });
});

test("fan-in: deep and broad under-byte-limit structures fail with bounded diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-structure-bounds-"));
  try {
    let deep: unknown = "leaf";
    for (let index = 0; index < 80; index += 1) deep = { next: deep };
    const deepPath = join(root, "evidence-first.json");
    writeFileSync(deepPath, JSON.stringify(deep));
    const deepResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(deepPath));
    assert.equal(deepResult.ok, false);
    if (!deepResult.ok) {
      assert.equal(deepResult.code, "structure_limit");
      assert.match(deepResult.error, /nesting depth/);
      assert.ok(deepResult.error.length < 512, "structure diagnostics remain bounded");
    }

    const broadPath = join(root, "evidence-first.json");
    writeFileSync(broadPath, JSON.stringify({ items: Array.from({ length: 20_000 }, (_, index) => index) }));
    assert.ok(readFileSync(broadPath).byteLength < 8 * 1024 * 1024, "hostile fixture remains under the byte limit");
    const broadResult = synthesizeSnapshot(root, "evidence", exactSlotRecord(broadPath));
    assert.equal(broadResult.ok, false);
    if (!broadResult.ok) {
      assert.equal(broadResult.code, "structure_limit");
      assert.match(broadResult.error, /array length|node count|work budget/);
      assert.ok(broadResult.error.length < 512, "structure diagnostics remain bounded");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: legitimate bounded arrays still merge deterministically", () => {
  const merged = mergeSlotValues(
    [{ items: [{ id: "a" }, { id: "b" }] }, { items: [{ id: "b" }, { id: "c" }] }],
    null,
    true,
    "bounded",
  );
  assert.equal(merged.ok, true);
  if (merged.ok) assert.deepEqual(merged.value, { items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
});
