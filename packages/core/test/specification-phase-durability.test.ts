import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolveDoWorkSpecPreflight } from "../src/commands/do-work.js";
import { registerTestConstitutionGate, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { registerTestWorkflowTools } from "./fixtures/host-tool-activation.js";
import { z as zod } from "zod";
import { specPlanCommand, specifyCommand, specTasksCommand } from "../src/commands/specification.js";
import { authorizeSpecificationPhaseDispatch, authorizeSpecificationPhaseValidationDispatch, completeDispatch, completeNativeSpecificationGeneration, createCapability, issueCurrentTrustedMappingProof, reissueNativeSpecificationCheckpointCapability, finalizeNativeImplementationHandoffMutation, advanceCursor, validateCheckpointAskSelected } from "../src/engine/durable.js";
import { updateStateAtomically, writeState, resolveState, setStateTransactionTestHooks, type ResolvedState } from "../src/engine/state.js";
import {
  dispatchSpecificationPhase,
  startNativeSpecificationPhase,
  persistSpecificationPhaseResult,
  persistSpecificationPhaseValidation,
  renderCanonicalPhaseDocument,
  parseConstitutionPrincipleIdentities,
  setSpecificationPhaseFailureInjector,
  MAX_PHASE_INPUT_BYTES,
  MAX_PHASE_STRING_BYTES,
  MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES,
  MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES,
  MAX_PHASE_SEMANTIC_SECTIONS_AGGREGATE_BYTES,
  MAX_PHASE_RESULT_BYTES,
  type SpecificationWorkerResultInput,
} from "../src/specification/phase.js";
import { nativeCheckpointPolicy } from "../src/engine/checkpoints.js";

import { materializeFeatureDocuments, renderPhaseValidationReport } from "../src/specification/materialize.js";
import { digestOf, MAX_NATIVE_VALIDATION_WORK, prepareNativePhaseValidation, sha256Hex } from "../src/specification/validation.js";
import { createPreparationHandoff, preparationStartPostimageDigest, preparationStateDigest } from "../src/engine/preparation.js";
import type { NativePhaseValidationInput } from "../src/specification/validation.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { resolveSpecificationLanguage } from "../src/specification/language.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS } from "../src/specification/templates.js";
import { validConstitutionBinding, validFeatureWorkspace } from "./fixtures/specification-fixtures.js";
import type { DispatchRecord, TeamState, WorkIdentity } from "../src/engine/types.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import type { FeatureWorkspace, PhaseSemanticRequirement, SpecificationSemanticModel } from "../src/specification/types.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

interface PhaseDurabilityRun {
  root: string;
  input: SpecificationWorkerResultInput;
  artifactPath: string;
  manifestPath: string;
  journalPath: string;
}

const FEATURE_ID = "phase-durability";
const RUN_KEY = "phase-durability-run";
const BRANCH = "phase-durability-branch";
const PROFILE_HASH = profileHash(loadProfile("spec-preparation")!);
function renderDurabilityDocument(phase: "specify" | "plan" | "tasks", model: any): string {
  const templates = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(templates.ok, true, templates.ok ? "" : templates.error);
  if (!templates.ok) throw new Error(templates.error);
  const template = templates.value.templates.find((candidate) => candidate.template_id === phase);
  assert.ok(template, `missing shipped ${phase} template`);
  if (!template) throw new Error(`missing shipped ${phase} template`);
  return renderCanonicalPhaseDocument(phase, model, template);
}

const FAILURE_POINTS = [
  "before_prepare",
  "after_prepare",
  "before_artifact_write",
  "after_artifact_write",
  "before_state_write",
  "after_state_write",
  "before_projection",
  "after_projection",
  "after_commit",
  "before_cleanup",
  "after_cleanup",
] as const;


const phaseRaceDirectory = dirname(fileURLToPath(import.meta.url));
const phaseRaceModule = join(phaseRaceDirectory, "../src/specification/phase.ts");
const durableRaceModule = join(phaseRaceDirectory, "../src/engine/durable.ts");
const phaseRaceChildScript = [
  "const [root, mode, payload, readyPath, releasePath, startedPath, donePath] = process.argv.slice(1);",
  "const { existsSync, writeFileSync } = await import(\"node:fs\");",
  "const phase = await import(" + JSON.stringify(phaseRaceModule) + ");",
  "const durable = await import(" + JSON.stringify(durableRaceModule) + ");",
  "const input = JSON.parse(payload);",
  "let result;",
  "if (mode === \"phase\") {",
  "  phase.setSpecificationPhaseFailureInjector((point) => {",
  "    if (point !== \"before_prepare\") return;",
  "    writeFileSync(readyPath, \"ready\");",
  "    const signal = new Int32Array(new SharedArrayBuffer(4));",
  "    const deadline = Date.now() + 10000;",
  "    while (!existsSync(releasePath)) {",
  "      if (Date.now() >= deadline) throw new Error(\"race barrier release timeout\");",
  "      Atomics.wait(signal, 0, 0, 25);",
  "    }",
  "  });",
  "  result = phase.persistSpecificationPhaseResult(root, input);",
  "} else if (mode === \"crash\") {",
  "  phase.setSpecificationPhaseFailureInjector((point) => { if (point === \"before_projection\") process.exit(71); });",
  "  phase.persistSpecificationPhaseResult(root, input);",
  "} else {",
  "  writeFileSync(startedPath, \"started\");",
"  const dispatch = phase.dispatchSpecificationPhase(root, input.dispatch);",
"  const failure = durable.completeDispatch(root, input.failure);",
  "  const retry = durable.authorizeSpecificationPhaseDispatch(root, input.retry);",
  "  result = { dispatch, failure, retry };",
  "}",
  "writeFileSync(donePath, JSON.stringify(result));",
  "process.stdout.write(JSON.stringify(result));",
].join("\n");

function waitForRaceFile(path: string, timeoutMs = 5000): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("race barrier timeout waiting for " + path);
    Atomics.wait(signal, 0, 0, 25);
  }
}

function runPhaseRaceChild(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", phaseRaceChildScript, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) { reject(new Error("phase race child exited " + code + "\n" + stderr)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error("phase race child returned invalid JSON: " + String(error) + "\n" + stderr)); }
    });
  });
}

function setup(): PhaseDurabilityRun {
  const root = mkdtempSync(join(tmpdir(), "spec-phase-durability-"));
  mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  writeTestRegistryMarker(root);
  registerTestConstitutionGate(root, "phase-durability-gate");
  const constitution = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: "specify" }, { feature_id: FEATURE_ID });
  assert.ok(constitution.ok && constitution.value.binding, constitution.ok ? "constitution binding must be available" : constitution.error);
  if (!constitution.ok || !constitution.value.binding) throw new Error("native phase fixture constitution binding unavailable");
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "specification-analyst": "specification-worker", "specification-architect": "specification-worker" } }) + "\n", "utf8");
  const config = resolveConfig(root);
  writeAgentMapping(root, buildAgentMapping({
    roles: config.roles,
    availableAgents: ["specification-worker"],
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: [],
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
  }));
  const issued = createCapability({
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: PROFILE_HASH,
    stage_cursor: "specify",
    kind: "single",
    expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }],
    dispatch_secret: "phase-dispatch-secret",
    advance_secret: "phase-advance-secret",
  });
  const templates = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  const language = resolveSpecificationLanguage({ requestLanguage: "en-US" });
  assert.equal(templates.ok, true, templates.ok ? "" : templates.error);
  if (!templates.ok) throw new Error(templates.error);
  const base = validFeatureWorkspace({ featureId: FEATURE_ID, constitutionBinding: constitution.value.binding }) as unknown as FeatureWorkspace;
  const workspace: FeatureWorkspace = {
    ...base,
    schema_version: 2,
    project_root: realpathSync(root),
    project_root_identity: { canonical_path: realpathSync(root), dev: statSync(root).dev, ino: statSync(root).ino },
    profile_hash: PROFILE_HASH,
    language,
    template_set: templates.value.selection,
    phases: base.phases.map((phase) => phase.phase === "specify" ? {
      ...phase,
      status: "generating" as const,
      current_version: null,
      approved_version: null,
      validation_ref: null,
      checkpoint_ref: null,
    } : phase),
    next_action: { kind: "none", command: null, reason: "Specify worker is active." },
  };
  const identity: WorkIdentity = {
    run_id: RUN_KEY,
    wave_id: "wave-phase-durability",
    slice_id: FEATURE_ID,
    session_id: "session-phase-durability",
    workflow: "spec-preparation",
    stage_id: "specify",
    stage_cursor: "specify",
    capability_id: issued.capability_id,
    capability_epoch: issued.state.issued_for!.cursor_epoch,
    slot_id: "specification-analyst",
    task_id: "phase-task",
    dispatch_id: "phase-dispatch",
    attempt: 1,
    worker_id: "specification-worker",
  };
  const dispatch: DispatchRecord = {
    id: identity.dispatch_id,
    role: "specification-analyst",
    agent: "specification-worker",
    tool_call_id: "phase-request",
    status: "authorized",
    attempt: 1,
    created_at: new Date().toISOString(),
    work_identity: identity,
    completion_envelope: { schema_version: 1, identity, outcome: "pending", terminal_signal: null, artifact_refs: [], evidence_ref: null, conflict_ref: null, completed_by: "engine_task_caller", emitted_at: new Date().toISOString() },
  };
  const state: TeamState = {
    schema: 1,
    branch: BRANCH,
    run_key: RUN_KEY,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: "phase durability test",
    workflow_override: false,
    issue: null,
    stage_cursor: "specify",
    stages: [{ id: "specify", status: "in_progress" }, { id: "plan", status: "pending" }, { id: "tasks", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    profile_hash: PROFILE_HASH,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: undefined,
    specification: workspace,
  };
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  writeState(root, state, { featureSlug: FEATURE_ID, pinnedRoot });
  pinnedRoot.close();
  const preparedRoot = PinnedProjectRoot.open(root);
  assert.ok(preparedRoot);
  if (!preparedRoot) throw new Error("native preparation fixture root unavailable");
  const prepared = updateStateAtomically(root, (snapshot) => {
    if (!snapshot.state) return { op: "fail" as const, code: "state_missing", error: "native preparation fixture state unavailable" };
    const nextRevision = snapshot.revision + 1;
    const handoff = createPreparationHandoff({
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      task: snapshot.state.task,
      classification: snapshot.state.classification,
      state_revision: nextRevision,
      state_digest: preparationStateDigest(snapshot.state, nextRevision),
      root_identity: { canonical_path: preparedRoot.canonical_root, dev: preparedRoot.dev, ino: preparedRoot.ino },
      source_kind: "native",
      constitution_binding: snapshot.state.specification?.constitution_binding ?? null,
      constitution_gate_ref: snapshot.state.specification?.constitution_gate_ref ?? null,
      capacity: 1,
      authentication: {
        source_kind: "native",
        constitution_binding: snapshot.state.specification?.constitution_binding ?? null,
        constitution_gate_ref: snapshot.state.specification?.constitution_gate_ref ?? null,
        capacity: 1,
        pinned_root: preparedRoot,
      },
    });
    return { op: "commit" as const, state: { ...snapshot.state, preparation_handoff: handoff } };
  }, { selector: { feature_id: FEATURE_ID, run_key: RUN_KEY }, pinnedRoot: preparedRoot });
  preparedRoot.close();
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error);
  const compositeStart = startNativeSpecificationPhase(root, { feature_id: FEATURE_ID, run_key: RUN_KEY, preparation_handoff: resolveState(root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!.preparation_handoff! });
  assert.equal(compositeStart.ok, true, compositeStart.ok ? "" : compositeStart.error);
  if (!compositeStart.ok) throw new Error(compositeStart.error);
  const startedHandoff = compositeStart.value.handoff;
  const constitutionIdentities = parseConstitutionPrincipleIdentities("# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n");
  const specifySections = {
    problem: "The durable phase path must recover safely.",
    scope: "Persist one immutable phase result and its readable projection.",
    non_goals: "No unrelated workflow state changes.",
    actors: "The worker and a trusted validation stage.",
    journeys: "A worker result is validated before approval.",
    requirements: "REQ-1 is deterministic and observable.",
    edge_cases: "Late and stale attempts are rejected.",
    assumptions: "The project root remains pinned.",
    dependencies: "The durable state lock and artifact store.",
    success_criteria: "The exact version opens one checkpoint.",
  };
  const specifyModel = {
    schema_version: 1, feature_id: FEATURE_ID, run_key: RUN_KEY, phase: "specify" as const, version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: identity.dispatch_id },
    constitution_binding: workspace.constitution_binding, upstream_versions: [], sections: specifySections,
    requirements: [{ requirement_id: "REQ-1", statement: specifySections.requirements, acceptance_ids: ["AC-1"], source_refs: ["spec.md#requirements"], testable: true, untestable_reason: null }],
    decisions: [], tasks: [],
    verification: [{ verification_id: "VERIFY-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "focused phase durability test" }],
    contradictions: [],
    constitution_principles: constitutionIdentities.map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable" as const, status: "pass" as const, evidence: "Ship tested work." , binding: workspace.constitution_binding })),
  };
  const documents = [
    { path: "spec.md", content: renderDurabilityDocument("specify", specifyModel as any) },
    { path: "notes/design.md", content: "# Design Notes\n\nThe projection is replayed without data loss.\n" },
    { path: "appendix.md", content: "# Appendix\n\nEvery readable document remains byte-exact.\n" },
  ];
  const input: SpecificationWorkerResultInput = {
    token: "phase-dispatch-secret",
    capability_id: issued.capability_id,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: PROFILE_HASH,
    phase: "specify",
    request_id: "phase-request",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_id: identity.dispatch_id,
    version: 1,
    source_artifact: {
      schema_version: 1,
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      version: 1,
      worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: identity.dispatch_id },
      constitution_binding: workspace.constitution_binding,
      semantic_model: specifyModel,
      document_sha256: sha256Hex(documents[0]!.content),
      upstream_versions: [],
    },
    documents,
    semantic_sections: specifyModel.sections,
    constitution_binding: workspace.constitution_binding!,
    upstream_versions: [],
    template_hash: workspace.template_set.content_hash,
    language_hash: workspace.language.selection_hash,
  };
  input.token = startedHandoff.token;
  input.capability_id = startedHandoff.capability_id;
  input.request_id = startedHandoff.request_id;
  input.cursor_epoch = startedHandoff.cursor_epoch;
  input.dispatch_id = startedHandoff.dispatch_id;
  input.source_artifact = {
    ...input.source_artifact,
    worker: { ...input.source_artifact.worker, dispatch_id: startedHandoff.dispatch_id },
    semantic_model: { ...input.source_artifact.semantic_model, worker: { ...input.source_artifact.semantic_model.worker, dispatch_id: startedHandoff.dispatch_id } },
  };
  const canonicalDocument = renderDurabilityDocument("specify", input.source_artifact.semantic_model);
  input.documents = input.documents.map((document) => document.path === "spec.md" ? { ...document, content: canonicalDocument } : document);
  input.source_artifact.document_sha256 = sha256Hex(canonicalDocument);
  const requestDigest = digestOf({ feature_id: FEATURE_ID, run_key: RUN_KEY, phase: "specify", version: 1, request_id: input.request_id, dispatch_id: input.dispatch_id, source_artifact: input.source_artifact, documents: [...input.documents].sort((left, right) => left.path.localeCompare(right.path)), semantic_sections: input.semantic_sections, constitution_binding: input.constitution_binding, upstream_versions: input.upstream_versions, template_hash: input.template_hash, language_hash: input.language_hash });
  return {
    root,
    input,
    artifactPath: join(root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json"),
    manifestPath: join(root, ".work-state", "features", FEATURE_ID, "artifacts", "documents", "specify", "v1.json"),
    journalPath: join(root, ".work-state", "features", FEATURE_ID, "artifacts", `.phase-${requestDigest}.json`),
  };
}
function nativeProfileHash(run: ReturnType<typeof setup>): string {
  return resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.profile_hash ?? PROFILE_HASH;
}

function alignNativeRuntimeProfile(run: ReturnType<typeof setup>): void {
  const profile = loadProfile("spec-preparation");
  assert.ok(profile);
  if (!profile) return;
  const gate = ensureProjectConstitution(run.root, {
    origin_kind: "native_direct",
    origin_run_key: RUN_KEY,
    origin_stage: "specify",
  }, { feature_id: FEATURE_ID });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  if (!gate.ok || !gate.value.binding) return;
  const selected = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  assert.ok(selected.state);
  if (!selected.state) return;
  const templates = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  if (!templates.ok) return;
  const hash = profileHash(profile);
  const language = resolveSpecificationLanguage({ requestLanguage: "en-US" });
  assert.equal(templates.ok, true, templates.ok ? "" : templates.error);
  if (!templates.ok) throw new Error(templates.error);
  const templateSet = templates.value.selection;
  const currentWorkspace = selected.state.specification;
  if (selected.state.profile_hash === hash
    && currentWorkspace?.profile_hash === hash
    && currentWorkspace.language.selection_hash === language.selection_hash
    && currentWorkspace.template_set.content_hash === templateSet.content_hash
    && run.input.profile_hash === hash
    && run.input.language_hash === language.selection_hash
    && run.input.template_hash === templateSet.content_hash) return;
  const semanticModel = run.input.source_artifact.semantic_model;
  run.input.profile_hash = hash;
  run.input.language_hash = language.selection_hash;
  run.input.template_hash = templateSet.content_hash;
  run.input.constitution_binding = gate.value.binding;
  run.input.source_artifact = {
    ...run.input.source_artifact,
    constitution_binding: gate.value.binding,
    semantic_model: {
      ...semanticModel,
      constitution_binding: gate.value.binding,
      constitution_principles: semanticModel.constitution_principles.map((principle) => ({ ...principle, binding: gate.value.binding })),
    },
  };
  const canonicalDocument = renderDurabilityDocument("specify", run.input.source_artifact.semantic_model);
  run.input.documents = run.input.documents.map((document, index) => index === 0 ? { ...document, content: canonicalDocument } : document);
  run.input.source_artifact.document_sha256 = sha256Hex(canonicalDocument);
  run.input.semantic_sections = run.input.source_artifact.semantic_model.sections;
  writeState(run.root, {
    ...selected.state,
    profile_hash: hash,
    dispatch_capability: selected.state.dispatch_capability ? {
      ...selected.state.dispatch_capability,
      profile_hash: hash,
      issued_for: selected.state.dispatch_capability.issued_for ? {
        ...selected.state.dispatch_capability.issued_for,
        profile_hash: hash,
      } : selected.state.dispatch_capability.issued_for,
    } : selected.state.dispatch_capability,
    specification: selected.state.specification ? {
      ...selected.state.specification,
      profile_hash: hash,
      constitution_gate_ref: gate.value.gate_id,
      constitution_binding: gate.value.binding,
      template_set: templateSet,
    } : selected.state.specification,
  }, { target: selected });
}

function currentTrustedMappingProof(root: string) {
  const proof = issueCurrentTrustedMappingProof(root);
  if (!proof) throw new Error("phase durability fixture mapping proof unavailable");
  return proof;
}

function validationDispatch(root: string, run: ReturnType<typeof setup>, credentials: { token: string; capability_id: string; cursor_epoch: string; retry_of?: string } = run.input): { token: string; capability_id: string; request_id: string; dispatch_id: string; cursor_epoch: string } {
  const authorized = authorizeSpecificationPhaseValidationDispatch(root, {
    token: credentials.token, capability_id: credentials.capability_id, feature_id: FEATURE_ID, run_key: RUN_KEY, branch: BRANCH, workflow: "spec-preparation", profile_hash: PROFILE_HASH, stage_cursor: "specify", cursor_epoch: credentials.cursor_epoch, request_id: "phase-validation-request", ...(credentials.retry_of ? { retry_of: credentials.retry_of } : {}),
  }, { trustedMappingProof: currentTrustedMappingProof(root) });
  if (!authorized.ok) throw new Error(authorized.error);
  return { token: authorized.dispatch_token, capability_id: authorized.capability_id, request_id: authorized.record.tool_call_id!, dispatch_id: authorized.record.id, cursor_epoch: authorized.capability_epoch };
}

function validationDispatchForPhase(run: ReturnType<typeof setup>, phase: "specify" | TestPhase, credentials: { token: string; capability_id: string; cursor_epoch: string }): { token: string; capability_id: string; request_id: string; dispatch_id: string; cursor_epoch: string; advance_token: string } {
  const authorized = authorizeSpecificationPhaseValidationDispatch(run.root, {
    token: credentials.token,
    capability_id: credentials.capability_id,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: nativeProfileHash(run),
    stage_cursor: phase,
    cursor_epoch: credentials.cursor_epoch,
    request_id: "validation-" + phase + "-request",
  }, { trustedMappingProof: currentTrustedMappingProof(run.root) });
  if (!authorized.ok) throw new Error(authorized.error);
  return { token: authorized.dispatch_token, capability_id: authorized.capability_id, request_id: authorized.record.tool_call_id!, dispatch_id: authorized.record.id, cursor_epoch: authorized.capability_epoch, advance_token: authorized.advance_token };
}

function expectInvalidValidationDispatchRejected(run: ReturnType<typeof setup>, phase: "specify" | TestPhase, credentials: { token: string; capability_id: string; cursor_epoch: string }): void {
  const authorized = authorizeSpecificationPhaseValidationDispatch(run.root, {
    token: credentials.token,
    capability_id: credentials.capability_id,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: nativeProfileHash(run),
    stage_cursor: phase,
    cursor_epoch: credentials.cursor_epoch,
    request_id: "model-less-" + phase + "-validation-request",
  }, { trustedMappingProof: currentTrustedMappingProof(run.root) });
  assert.equal(authorized.ok, false, "invalid canonical phase history must not issue validator capability");
  if (!authorized.ok) assert.match(authorized.error, /current immutable phase artifact|canonical phase artifact|artifact/i);
  const state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
  assert.equal(state.dispatch_capability?.dispatches.some((dispatch) => dispatch.purpose === "validation"), false, "rejected model-less history must not persist validator dispatch");
}

function validationPayload(run: ReturnType<typeof setup>, principles: Array<{ principle_id: string; status: "pass" | "not_applicable"; evidence: string }>): import("../src/specification/validation.js").NativePhaseValidationInput {
  const currentVersion = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!.specification?.phases.find((phase) => phase.phase === "specify")?.current_version ?? 1;
  const currentArtifactPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", `specify.v${currentVersion}.json`);
  const artifact = JSON.parse(readFileSync(currentArtifactPath, "utf8")) as { source_artifact: { semantic_model?: any } };
  const model = artifact.source_artifact.semantic_model ?? run.input.source_artifact.semantic_model;
  const binding = run.input.constitution_binding;
  const content = readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8");
  return {
    validation_id: "validation.specify.v1", feature_id: FEATURE_ID, run_key: RUN_KEY, phase: "specify", version: 1, artifact_version: "specify.v1", document_path: "spec.md", document_sha256: sha256Hex(content),
    sections: model.sections, upstream_versions: [], expected_upstream_versions: [], constitution_binding: binding, expected_constitution_binding: binding,
    constitution_principles: principles.length === 0 ? [] : model.constitution_principles.map((item: any) => ({ principle_id: item.principle_id, status: item.status, evidence: item.evidence })),
    requirements: model.requirements, decisions: [], tasks: [], verification: model.verification, contradictions: model.contradictions, validated_at: "2026-09-01T00:00:00.000Z",
  };
}

type TestPhase = "plan" | "tasks";
function nativeRoleForPhase(phase: "specify" | TestPhase): "specification-analyst" | "specification-architect" {
  return phase === "specify" ? "specification-analyst" : "specification-architect";
}
function validationPayloadForNativePhase(run: ReturnType<typeof setup>, phase: "specify" | TestPhase): NativePhaseValidationInput {
  const state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
  const record = state.specification?.phases.find((candidate) => candidate.phase === phase);
  const version = record?.current_version ?? 1;
  const artifact = JSON.parse(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", `${phase}.v${version}.json`), "utf8")) as { source_artifact: { semantic_model?: unknown } };
  const model = artifact.source_artifact.semantic_model as Record<string, unknown>;
  const binding = run.input.constitution_binding;
  const documentPath = phase === "specify" ? "spec.md" : `${phase}.md`;
  const content = readFileSync(join(run.root, "specs", FEATURE_ID, documentPath), "utf8");
  const principles = model.constitution_principles as Array<Record<string, unknown>>;
  return {
    validation_id: `validation.${phase}.v${version}`,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase,
    version,
    artifact_version: `${phase}.v${version}`,
    document_path: documentPath,
    document_sha256: sha256Hex(content),
    sections: model.sections as NativePhaseValidationInput["sections"],
    upstream_versions: model.upstream_versions as NativePhaseValidationInput["upstream_versions"],
    expected_upstream_versions: model.upstream_versions as NativePhaseValidationInput["expected_upstream_versions"],
    constitution_binding: binding,
    expected_constitution_binding: binding,
    constitution_principles: principles.map((item) => ({
      principle_id: String(item.principle_id),
      status: item.status as "pass" | "not_applicable",
      evidence: String(item.evidence),
    })),
    requirements: model.requirements as NativePhaseValidationInput["requirements"],
    decisions: model.decisions as NativePhaseValidationInput["decisions"],
    tasks: (model.tasks as Array<Record<string, unknown>>).map((task) => ({ ...task, task_id: task.id })) as NativePhaseValidationInput["tasks"],
    verification: model.verification as NativePhaseValidationInput["verification"],
    contradictions: model.contradictions as NativePhaseValidationInput["contradictions"],
    validated_at: "2026-09-01T00:00:00.000Z",
  };
}
function validateNativePhase(run: ReturnType<typeof setup>, phase: "specify" | TestPhase, credentials: { token: string; capability_id: string; cursor_epoch: string }): ReturnType<typeof validationDispatchForPhase> {
  const authorized = validationDispatchForPhase(run, phase, credentials);
  const validation = persistSpecificationPhaseValidation(run.root, {
    token: authorized.token,
    capability_id: authorized.capability_id,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: nativeProfileHash(run),
    phase,
    request_id: authorized.request_id,
    cursor_epoch: authorized.cursor_epoch,
    dispatch_id: authorized.dispatch_id,
    validation: validationPayloadForNativePhase(run, phase),
  });
  assert.equal(validation.ok, true, validation.ok ? "" : validation.error);
  return authorized;
}

function beginTestPhase(run: ReturnType<typeof setup>, phase: TestPhase): { dispatch_id: string; token: string; capability_id: string; request_id: string; cursor_epoch: string; workspace: FeatureWorkspace; upstream: Array<{ artifact_id: string; version: number; hash: string }> } {
  const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
  const upstream: Array<{ artifact_id: string; version: number; hash: string }> = [];
  for (const upstreamPhase of phase === "plan" ? ["specify"] : ["specify", "plan"]) {
    const artifactId = upstreamPhase + ".v1";
    const artifactPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", artifactId + ".json");
    upstream.push({ artifact_id: artifactId, version: 1, hash: digestOf(JSON.parse(readFileSync(artifactPath, "utf8"))) });
  }
  const workspace: FeatureWorkspace = {
    ...before.specification!,
    phases: before.specification!.phases.map((record) => record.phase === "specify" && phase === "plan"
      ? { ...record, status: "approved" as const, current_version: 1, approved_version: 1, validation_ref: "validation.specify.v1", checkpoint_ref: "checkpoint.specify.v1" }
      : record.phase === "plan" && phase === "tasks"
        ? { ...record, status: "approved" as const, current_version: 1, approved_version: 1, validation_ref: "validation.plan.v1", checkpoint_ref: "checkpoint.plan.v1" }
        : record.phase === phase ? { ...record, status: "generating" as const, current_version: null, approved_version: null, validation_ref: null, checkpoint_ref: null } : record),
    next_action: { kind: "none", command: null, reason: phase + " worker is active." },
  };
  const { dispatch_capability: _dispatchCapability, preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, ...withoutAuthority } = before;
  writeState(run.root, {
    ...withoutAuthority,
    stage_cursor: phase,
    stages: before.stages.map((stage) => stage.id === phase ? { ...stage, status: "in_progress" as const } : stage),
    specification: workspace,
  }, { featureSlug: FEATURE_ID });
  const preparedRoot = PinnedProjectRoot.open(run.root);
  assert.ok(preparedRoot);
  if (!preparedRoot) throw new Error("phase preparation fixture root unavailable");
  const prepared = updateStateAtomically(run.root, (snapshot) => {
    if (!snapshot.state) return { op: "fail" as const, code: "state_missing", error: "phase preparation fixture state unavailable" };
    const nextRevision = snapshot.revision + 1;
    const handoff = createPreparationHandoff({
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      task: snapshot.state.task,
      classification: snapshot.state.classification,
      state_revision: nextRevision,
      state_digest: preparationStateDigest(snapshot.state, nextRevision),
      root_identity: { canonical_path: preparedRoot.canonical_root, dev: preparedRoot.dev, ino: preparedRoot.ino },
      source_kind: "native",
      constitution_binding: snapshot.state.specification?.constitution_binding ?? null,
      constitution_gate_ref: snapshot.state.specification?.constitution_gate_ref ?? null,
      capacity: 1,
      authentication: {
        source_kind: "native",
        constitution_binding: snapshot.state.specification?.constitution_binding ?? null,
        constitution_gate_ref: snapshot.state.specification?.constitution_gate_ref ?? null,
        capacity: 1,
        pinned_root: preparedRoot,
      },
    });
    return { op: "commit" as const, state: { ...snapshot.state, preparation_handoff: handoff } };
  }, { selector: { feature_id: FEATURE_ID, run_key: RUN_KEY }, pinnedRoot: preparedRoot });
  preparedRoot.close();
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error);
  if (!prepared.ok) throw new Error(prepared.error);
  const selected = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
  const preparationHandoff = selected?.preparation_handoff;
  assert.ok(preparationHandoff);
  if (!preparationHandoff) throw new Error("phase preparation handoff unavailable");
  const started = startNativeSpecificationPhase(run.root, { feature_id: FEATURE_ID, run_key: RUN_KEY, preparation_handoff: preparationHandoff });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  if (!started.ok) throw new Error(started.error);
  const handoff = started.value.handoff;
  assert.match(handoff.worker_name, new RegExp(`^spec-${phase}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "u"));
  return { dispatch_id: handoff.dispatch_id, token: handoff.token, capability_id: handoff.capability_id, request_id: handoff.request_id, cursor_epoch: handoff.cursor_epoch, workspace, upstream };
}
type MountedSelectedAskFixture = {
  tool: { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
  sessionStart?: (event: unknown, ctx: unknown) => unknown;
  sessionManager: { getSessionId: () => string; getCwd: () => string };
};
const mountedSelectedAskFixtures = new Map<string, MountedSelectedAskFixture>();

async function mountedSelectedAsk(
  root: string,
  input: Record<string, unknown>,
  decision: string,
  feedback?: string,
  beforeCommit?: () => void,
): Promise<{ details: Record<string, unknown> }> {
  let fixture = mountedSelectedAskFixtures.get(root);
  if (!fixture) {
    let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
    const sessionManager = { getSessionId: () => "phase-durability-session", getCwd: () => root };
    registerTestWorkflowTools(root, {
      zod: { z: zod },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "session_start") sessionStart = handler; },
      registerTool(tool: unknown) {
        const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
        tools.set(mounted.name, mounted);
      },
    } as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd }, "phase-durability-gate");
    const tool = tools.get("workflow_checkpoint_ask_selected");
    assert.ok(tool, "selected Ask tool must be mounted");
    if (!tool) throw new Error("selected Ask tool is unavailable");
    fixture = { tool, sessionStart, sessionManager };
    mountedSelectedAskFixtures.set(root, fixture);
  }
  const context = {
    cwd: root,
    mode: "rpc",
    hasUI: true,
    sessionManager: fixture.sessionManager,
    ui: {
      askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }> }>) => {
        beforeCommit?.();
        const question = questions[0];
        if (!question) return undefined;
        return { kind: "submit" as const, results: [{ id: question.id, question: question.question, header: question.header, options: question.options.map((option) => option.label), multi: false, selectedOptions: [decision], ...(feedback === undefined ? {} : { note: feedback }) }] };
      },
    },
  };
  fixture.sessionStart?.({}, context);
  return fixture.tool.execute("phase-durability-selected-ask", input, undefined, undefined, context);
}

async function stopNativePhase(run: ReturnType<typeof setup>, phase: "specify" | "plan" | "tasks", credentials: { token: string; capability_id: string; cursor_epoch: string; advance_token: string }): Promise<{ advance_token: string }> {
  const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
  const capability = before.dispatch_capability;
  assert.ok(capability?.capability_id && capability.issued_for, "validated phase capability must remain available for stop Ask");
  if (!capability?.capability_id || !capability.issued_for) return { advance_token: credentials.advance_token };
  const phaseOrder = ["specify", "plan", "tasks"];
  const phaseIndex = phaseOrder.indexOf(phase);
  const baseState: TeamState = {
    ...before,
    stage_cursor: phase,
    stages: before.stages.map((stage) => {
      const index = phaseOrder.indexOf(stage.id);
      return { ...stage, status: index < phaseIndex ? "done" as const : index === phaseIndex ? "in_progress" as const : "pending" as const };
    }),
    specification: {
      ...before.specification!,
      next_action: { kind: "none", command: null, reason: `${phase} worker is active.` },
    },
    checkpoint_policy: nativeCheckpointPolicy("specification_phase_approval"),
    pause: { kind: "none", reason: "" },
  };
  const marker = before.preparation_start;
  const openState = marker && marker.status === "started"
    ? { ...baseState, preparation_start: { ...marker, start_postimage_digest: preparationStartPostimageDigest(baseState) } }
    : baseState;
  writeState(run.root, openState, { featureSlug: FEATURE_ID });
  const askInput = {
    feature_id: FEATURE_ID,
    advance_token: credentials.advance_token,
    capability_id: capability.capability_id,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: nativeProfileHash(run),
    stage_cursor: phase,
    cursor_epoch: credentials.cursor_epoch,
    checkpoint: "specification_phase_approval",
    checkpoint_id: "specification_phase_approval",
    checkpoint_kind: "specification_phase_approval",
  };
  const asked = await mountedSelectedAsk(run.root, askInput, "approve_stop");
  assert.equal(asked.details.ok, true, asked.details.error ? String(asked.details.error) : JSON.stringify(asked.details));
  if (asked.details.ok !== true) return;
  return { advance_token: String(asked.details.required_next_tool && typeof asked.details.required_next_tool === "object"
    ? (asked.details.required_next_tool as { arguments?: { advance_token?: unknown } }).arguments?.advance_token
    : "") };
}
function advanceStoppedPhase(run: ReturnType<typeof setup>, phase: "specify" | "plan" | "tasks", advanceToken: string): ReturnType<typeof advanceCursor> {
  const current = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
  const capability = current?.dispatch_capability;
  if (!capability?.capability_id || !capability.issued_for) return { ok: false, error: "stopped phase capability is unavailable", state: current };
  const proof = issueCurrentTrustedMappingProof(run.root);
  return advanceCursor(run.root, {
    feature_id: FEATURE_ID, token: advanceToken, capability_id: capability.capability_id, run_key: RUN_KEY, branch: BRANCH,
    workflow: "spec-preparation", profile_hash: nativeProfileHash(run), stage_cursor: phase, cursor_epoch: capability.issued_for.cursor_epoch, evidence: "selected approve_stop decision advanced through the mounted workflow descriptor",
  }, proof === undefined ? {} : { trustedMappingProof: proof });
}

function phaseInputFor(run: ReturnType<typeof setup>, phase: TestPhase, dispatchId: string, upstream: Array<{ artifact_id: string; version: number; hash: string }>, wrongHeading = false, credentials?: { token: string; capability_id: string; cursor_epoch: string; request_id?: string }): SpecificationWorkerResultInput {
  const workspace = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!.specification!;
  const specifyArtifact = JSON.parse(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json"), "utf8"));
  const specify = specifyArtifact.source_artifact.semantic_model;
  const decision = "Use canonical semantic model.";
  const rationale = "Stable model binding preserves deterministic validation.";
  const taskTitle = "Persist canonical task graph.";
  const taskOutcome = "The task graph is rendered exactly once.";
  const scope = "packages/core/src/specification/phase.ts";
  const evidence = "focused phase durability test";
  const model = phase === "plan"
    ? {
        schema_version: 1, feature_id: FEATURE_ID, run_key: RUN_KEY, phase: "plan" as const, version: 1, worker: { role: nativeRoleForPhase(phase), agent: "specification-worker", dispatch_id: dispatchId }, constitution_binding: workspace.constitution_binding, upstream_versions: upstream,
        sections: { repository_grounding: "packages/core/src/specification/phase.ts", decisions: decision + "\n" + rationale, alternatives: "Keep the semantic model immutable.", contracts: "The artifact and document share one digest.", data_flow: "Worker -> immutable artifact -> validator.", control_flow: "Authorize, persist, validate, approve.", migration: "No migration in this native fixture.", security: "Reject caller-selected semantic facts.", operations: "Use the durable state lock.", verification_strategy: "Focused phase durability test.", constitution_recheck: "Quality principle remains satisfied." },
        requirements: specify.requirements, decisions: [{ decision_id: "DEC-1", decision, rationale, requirement_ids: ["REQ-1"] }], tasks: [],
        verification: [{ verification_id: "VERIFY-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: evidence }], contradictions: specify.contradictions, constitution_principles: specify.constitution_principles,
      }
    : {
        schema_version: 1, feature_id: FEATURE_ID, run_key: RUN_KEY, phase: "tasks" as const, version: 1, worker: { role: nativeRoleForPhase(phase), agent: "specification-worker", dispatch_id: dispatchId }, constitution_binding: workspace.constitution_binding, upstream_versions: upstream,
        sections: { task_graph: taskTitle, dependencies: "TASK-1 has no dependencies.", expected_outcomes: taskOutcome + "\n" + scope + "\n" + evidence },
        requirements: specify.requirements, decisions: JSON.parse(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "plan.v1.json"), "utf8")).source_artifact.semantic_model.decisions,
        tasks: [{ id: "TASK-1", title: taskTitle, requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], decision_ids: ["DEC-1"], verification_ids: ["VERIFY-1"], depends_on: [], expected_outcome: taskOutcome, affected_scope: [scope], completion_evidence: [evidence], parallel_safe: true }],
        verification: [{ verification_id: "VERIFY-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: ["TASK-1"], observable_behavior: true, expected_evidence: evidence }], contradictions: specify.contradictions, constitution_principles: JSON.parse(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "plan.v1.json"), "utf8")).source_artifact.semantic_model.constitution_principles,
      };
  const document = { path: phase === "plan" ? "plan.md" : "tasks.md", content: renderDurabilityDocument(phase, model as any) };
  if (wrongHeading) document.content = document.content.replace(phase === "plan" ? decision : taskTitle, "");
  return { token: credentials?.token ?? "unused", capability_id: credentials?.capability_id ?? "unused", feature_id: FEATURE_ID, run_key: RUN_KEY, branch: BRANCH, workflow: "spec-preparation", profile_hash: nativeProfileHash(run), phase, request_id: credentials?.request_id ?? "phase-" + phase + "-result", cursor_epoch: credentials?.cursor_epoch ?? "unused", dispatch_id: dispatchId, version: 1, source_artifact: { schema_version: 1, feature_id: FEATURE_ID, run_key: RUN_KEY, version: 1, worker: { role: nativeRoleForPhase(phase), agent: "specification-worker", dispatch_id: dispatchId }, constitution_binding: workspace.constitution_binding, document_sha256: sha256Hex(document.content), upstream_versions: upstream, semantic_model: model }, documents: [document], semantic_sections: model.sections, constitution_binding: workspace.constitution_binding!, upstream_versions: upstream, template_hash: workspace.template_set.content_hash, language_hash: workspace.language.selection_hash };
}

test("constitution principle identities are normalized and model set is fail-closed", () => {
  const parsed = parseConstitutionPrincipleIdentities("# Конституция\n\n## I. Качество   проекта\n\n<!-- omp-spec:principle:optional -->\n## II. Security\n## III. Security\n");
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]!.title, "I. Качество проекта");
  assert.equal(parsed[1]!.optional, true);
  assert.notEqual(parsed[1]!.principle_id, parsed[2]!.principle_id, "ordinal disambiguates duplicate normalized headings");
  for (const [index, identity] of parsed.entries()) assert.equal(identity.principle_id, `constitution:${index + 1}:` + identity.principle_id.split(":")[2]);

  const cases: Array<(model: any) => void> = [
    (model) => { model.constitution_principles = []; },
    (model) => { model.constitution_principles = [...model.constitution_principles, { ...model.constitution_principles[0], principle_id: "constitution:2:extra", title: "II. Injected" }]; },
    (model) => { model.constitution_principles[0] = { ...model.constitution_principles[0], applicability: "not_applicable", status: "not_applicable" }; },
  ];
  for (const mutate of cases) {
    const run = setup();
    try {
      const model = structuredClone(run.input.source_artifact.semantic_model) as any;
      mutate(model);
      const content = renderDurabilityDocument("specify", model);
      const rejected = persistSpecificationPhaseResult(run.root, { ...run.input, source_artifact: { ...run.input.source_artifact, document_sha256: sha256Hex(content), semantic_model: model }, documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content } : document), semantic_sections: model.sections });
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.code, "SPEC_PHASE_STALE");
    } finally { rmSync(run.root, { recursive: true, force: true }); }
  }
});

test("plan model is bound to approved specify artifact and canonical document", () => {
  const run = setup();
  try {
    assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
    const specifyProjection = JSON.parse(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json"), "utf8"));
    assert.deepEqual(specifyProjection, run.input.source_artifact.semantic_model, "downstream plan preparation must see the exact engine projection of the approved specify model");
    const phase = beginTestPhase(run, "plan");
    const planInput = phaseInputFor(run, "plan", phase.dispatch_id, phase.upstream, false, phase);
    const persisted = persistSpecificationPhaseResult(run.root, planInput);
    assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
    const divergent = persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", phase.dispatch_id, phase.upstream, true, phase));
    assert.equal(divergent.ok, false);
    if (!divergent.ok) assert.equal(divergent.code, "SPEC_PHASE_STALE");
    const upstreamPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json");
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf8")) as Record<string, unknown>;
    upstream.source_artifact = { ...(upstream.source_artifact as Record<string, unknown>), semantic_model: { ...(upstream.source_artifact as Record<string, unknown>).semantic_model as Record<string, unknown>, requirements: [] } };
    writeFileSync(upstreamPath, JSON.stringify(upstream, null, 2) + "\n", "utf8");
    const tamperedUpstream = persistSpecificationPhaseResult(run.root, planInput);
    assert.equal(tamperedUpstream.ok, false);
    if (!tamperedUpstream.ok) assert.equal(tamperedUpstream.code, "SPEC_PHASE_STALE");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("model-less plan history fails typed and requires plan revision", () => {
  const run = setup();
  try {
    assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
    const planPhase = beginTestPhase(run, "plan");
    const planInput = phaseInputFor(run, "plan", planPhase.dispatch_id, planPhase.upstream, false, planPhase);
    assert.equal(persistSpecificationPhaseResult(run.root, planInput).ok, true);
    const artifactPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "plan.v1.json");
    const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const source = { ...(raw.source_artifact as Record<string, unknown>) };
    delete source.semantic_model;
    raw.source_artifact = source;
    raw.source_artifact_hash = digestOf(source);
    writeFileSync(artifactPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    expectInvalidValidationDispatchRejected(run, "plan", planPhase);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("task graph model binds approved specify and plan artifacts", () => {
  const run = setup();
  try {
    assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
    const planPhase = beginTestPhase(run, "plan");
    assert.equal(persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", planPhase.dispatch_id, planPhase.upstream, false, planPhase)).ok, true);
    const taskPhase = beginTestPhase(run, "tasks");
    const taskInput = phaseInputFor(run, "tasks", taskPhase.dispatch_id, taskPhase.upstream, false, taskPhase);
    const persisted = persistSpecificationPhaseResult(run.root, taskInput);
    assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
    const divergent = persistSpecificationPhaseResult(run.root, phaseInputFor(run, "tasks", taskPhase.dispatch_id, taskPhase.upstream, true, taskPhase));
    assert.equal(divergent.ok, false);
    if (!divergent.ok) assert.equal(divergent.code, "SPEC_PHASE_STALE");
    const upstreamPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "plan.v1.json");
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf8")) as Record<string, unknown>;
    upstream.source_artifact = { ...(upstream.source_artifact as Record<string, unknown>), semantic_model: { ...(upstream.source_artifact as Record<string, unknown>).semantic_model as Record<string, unknown>, decisions: [] } };
    writeFileSync(upstreamPath, JSON.stringify(upstream, null, 2) + "\n", "utf8");
    const tamperedUpstream = persistSpecificationPhaseResult(run.root, taskInput);
    assert.equal(tamperedUpstream.ok, false);
    if (!tamperedUpstream.ok) assert.equal(tamperedUpstream.code, "SPEC_PHASE_STALE");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("task validation rejects dangling links and dependency cycles from the pinned model", () => {
  const run = setup();
  try {
    assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
    const planPhase = beginTestPhase(run, "plan");
    assert.equal(persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", planPhase.dispatch_id, planPhase.upstream, false, planPhase)).ok, true);
    const taskPhase = beginTestPhase(run, "tasks");
    const taskInput = phaseInputFor(run, "tasks", taskPhase.dispatch_id, taskPhase.upstream, false, taskPhase);
    assert.equal(persistSpecificationPhaseResult(run.root, taskInput).ok, true);
    const artifactPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "tasks.v1.json");
    const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const source = { ...(raw.source_artifact as Record<string, unknown>) };
    const model = { ...(source.semantic_model as Record<string, unknown>) };
    model.tasks = [{ ...((model.tasks as Array<Record<string, unknown>>)[0]!), requirement_ids: ["REQ-UNKNOWN"], depends_on: ["TASK-1"] }];
    source.semantic_model = model;
    raw.source_artifact = source;
    raw.source_artifact_hash = digestOf(source);
    writeFileSync(artifactPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    expectInvalidValidationDispatchRejected(run, "tasks", taskPhase);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("model-less task graph history fails typed and requires task revision", () => {
  const run = setup();
  try {
    assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
    const planPhase = beginTestPhase(run, "plan");
    assert.equal(persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", planPhase.dispatch_id, planPhase.upstream, false, planPhase)).ok, true);
    const taskPhase = beginTestPhase(run, "tasks");
    assert.equal(persistSpecificationPhaseResult(run.root, phaseInputFor(run, "tasks", taskPhase.dispatch_id, taskPhase.upstream, false, taskPhase)).ok, true);
    const artifactPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "tasks.v1.json");
    const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const source = { ...(raw.source_artifact as Record<string, unknown>) };
    delete source.semantic_model;
    raw.source_artifact = source;
    raw.source_artifact_hash = digestOf(source);
    writeFileSync(artifactPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    expectInvalidValidationDispatchRejected(run, "tasks", taskPhase);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("phase validation persists failure evidence, retries strict pass, and replays after restart", () => {
  const run = setup();
  try {
    const persisted = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persisted.ok, true);
    const auth = validationDispatch(run.root, run);
    const base = {
      token: auth.token,
      capability_id: auth.capability_id,
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: PROFILE_HASH,
      phase: "specify" as const,
      request_id: auth.request_id,
      cursor_epoch: auth.cursor_epoch,
      dispatch_id: auth.dispatch_id,
    };
    const invalid = persistSpecificationPhaseValidation(run.root, { ...base, validation: validationPayload(run, []) });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.code, "SPEC_CHECKPOINT_BLOCKED");
    assert.equal(existsSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "validation.specify.v1.json")), false, "strictly invalid pass must not poison canonical evidence");
    const failedValidationReportPath = join(run.root, "specs", FEATURE_ID, "validation", "specify.md");
    assert.equal(existsSync(failedValidationReportPath), true, "artifact-bound failed validation must emit a readable validation report");
    const failedValidationReport = readFileSync(failedValidationReportPath, "utf8");
    assert.match(failedValidationReport, /## Blocking findings/u);
    assert.match(failedValidationReport, /SPEC_[A-Z_]+/u);
    assert.match(failedValidationReport, /## Approval proof[\s\S]*No approval proof exists/u);
    assert.match(failedValidationReport, /## First valid next action[\s\S]*\/specify/u);
    assert.ok(readdirSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts")).some((entry) => entry.startsWith("validation.specify.v1.attempt.")), "failed validation must leave readable attempt evidence");
    const failedState = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.equal(failedState.specification?.phases.find((phase) => phase.phase === "specify")?.status, "revision_required");
    assert.equal(failedState.pending, undefined, "failed validation must not leave a top-level pending lifecycle");
    const generationCapability = createCapability({ run_key: RUN_KEY, branch: BRANCH, workflow: "spec-preparation", profile_hash: PROFILE_HASH, stage_cursor: "specify", kind: "single", expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }], dispatch_secret: "phase-revision-secret", advance_secret: "phase-revision-advance" });
    writeState(run.root, { ...failedState, cursor_epoch: generationCapability.state.issued_for!.cursor_epoch, dispatch_capability: { ...generationCapability.state, status: "ready" } }, { featureSlug: FEATURE_ID });
    const generation = dispatchSpecificationPhase(run.root, {
      token: generationCapability.dispatch_token, capability_id: generationCapability.capability_id, feature_id: FEATURE_ID, run_key: RUN_KEY, branch: BRANCH, workflow: "spec-preparation", profile_hash: PROFILE_HASH, phase: "specify", request_id: "phase-revision-request", cursor_epoch: generationCapability.state.issued_for!.cursor_epoch, role: "specification-analyst", slot_id: "specification-analyst", agent: "specification-worker",
    });
    assert.equal(generation.ok, true);
    if (!generation.ok) throw new Error("generation authorization failed");
    const revisionModel = { ...(run.input.source_artifact.semantic_model as Record<string, unknown>), version: 2, worker: { ...(run.input.source_artifact.worker as Record<string, unknown>), dispatch_id: generation.value.dispatch_id } };
    const revisionDocumentContent = renderDurabilityDocument("specify", revisionModel as any);
    const revisionInput = { ...run.input, token: generationCapability.dispatch_token, capability_id: generationCapability.capability_id, cursor_epoch: generationCapability.state.issued_for!.cursor_epoch, request_id: "phase-revision-request", dispatch_id: generation.value.dispatch_id, version: 2, source_artifact: { ...run.input.source_artifact, version: 2, document_sha256: sha256Hex(revisionDocumentContent), worker: { ...(run.input.source_artifact.worker as Record<string, unknown>), dispatch_id: generation.value.dispatch_id }, semantic_model: revisionModel }, documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content: revisionDocumentContent } : document), semantic_sections: revisionModel.sections as Record<string, string> };
    const revised = persistSpecificationPhaseResult(run.root, revisionInput);
    assert.equal(revised.ok, true);
    const retryAuth = validationDispatch(run.root, run, { token: generationCapability.dispatch_token, capability_id: generationCapability.capability_id, cursor_epoch: generationCapability.state.issued_for!.cursor_epoch });
    const retryBase = { ...base, token: retryAuth.token, capability_id: retryAuth.capability_id, request_id: retryAuth.request_id, dispatch_id: retryAuth.dispatch_id, cursor_epoch: retryAuth.cursor_epoch };
    const valid = persistSpecificationPhaseValidation(run.root, { ...retryBase, validation: { ...validationPayload(run, [{ principle_id: "constitution", status: "pass", evidence: "verified" }]), validation_id: "validation.specify.v2", version: 2, artifact_version: "specify.v2", document_sha256: sha256Hex(readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8")), } });
    assert.equal(valid.ok, true, valid.ok ? "valid" : valid.error);
    if (valid.ok) assert.equal(valid.value.status, "pass");
    const validationReportPath = join(run.root, "specs", FEATURE_ID, "validation", "specify.md");
    assert.equal(existsSync(validationReportPath), true, "strict pass must emit the readable phase validation report");
    const validationReport = readFileSync(validationReportPath, "utf8");
    const validationHistoryPath = join(run.root, "specs", FEATURE_ID, "validation", "history", "specify", "v1.md");
    assert.equal(existsSync(validationHistoryPath), true, "revising a phase must archive its prior immutable validation report");
    assert.match(readFileSync(validationHistoryPath, "utf8"), /Artifact version \/ ID:.*specify\.v1/u);
    if (valid.ok) {
      assert.equal(validationReport, renderPhaseValidationReport(valid.value), "validation report bytes must equal the canonical materialize renderer");
      assert.match(validationReport, /Artifact version \/ ID:.*specify\.v2/u);
      assert.match(validationReport, /Status:.*pass/u);
    }
    const reportBytesBeforeReplay = Buffer.from(validationReport);
    const stateAfterPass = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.equal(stateAfterPass.pending, undefined, "passed validation must not leave a top-level pending lifecycle");
    assert.equal(stateAfterPass.specification?.phases.find((phase) => phase.phase === "specify")?.status, "awaiting_approval");
    const replay = persistSpecificationPhaseValidation(run.root, { ...retryBase, validation: { ...validationPayload(run, [{ principle_id: "constitution", status: "pass", evidence: "verified" }]), validation_id: "validation.specify.v2", version: 2, artifact_version: "specify.v2", document_sha256: sha256Hex(readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8")), } });
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.pending, undefined, "validation replay after restart must remain terminal");
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.replayed, true);
    assert.deepEqual(readFileSync(validationReportPath), reportBytesBeforeReplay, "validation replay must preserve exact readable report bytes");
    writeFileSync(validationReportPath, "tampered report\n", "utf8");
    const reportMismatch = persistSpecificationPhaseValidation(run.root, { ...retryBase, validation: { ...validationPayload(run, [{ principle_id: "constitution", status: "pass", evidence: "verified" }]), validation_id: "validation.specify.v2", version: 2, artifact_version: "specify.v2", document_sha256: sha256Hex(readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8")), } });
    assert.equal(reportMismatch.ok, false, "a mismatched readable validation report must fail closed");
    if (!reportMismatch.ok) assert.equal(reportMismatch.code, "SPEC_PHASE_PERSIST_FAILED");
    writeFileSync(validationReportPath, reportBytesBeforeReplay);
    writeFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "tampered", "utf8");
    const stale = persistSpecificationPhaseValidation(run.root, { ...retryBase, validation: { ...validationPayload(run, [{ principle_id: "constitution", status: "pass", evidence: "verified" }]), validation_id: "validation.specify.v2", version: 2, artifact_version: "specify.v2", document_sha256: sha256Hex(readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8")), } });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "SPEC_PHASE_STALE");
    assert.deepEqual(readFileSync(validationReportPath), reportBytesBeforeReplay, "stale validation must not emit a replacement readable report");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});


test("validation issuer rejects generation retry links and forged dispatch purposes", () => {
  const run = setup();
  try {
    const persisted = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persisted.ok, true);
    const state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    const generationRetry = authorizeSpecificationPhaseValidationDispatch(run.root, {
      token: run.input.token,
      capability_id: run.input.capability_id,
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: PROFILE_HASH,
      stage_cursor: "specify",
      cursor_epoch: run.input.cursor_epoch,
      request_id: "phase-validation-generation-retry",
      retry_of: run.input.dispatch_id,
    });
    assert.equal(generationRetry.ok, false);
    const readyCapability = createCapability({ run_key: RUN_KEY, branch: BRANCH, workflow: "spec-preparation", profile_hash: PROFILE_HASH, stage_cursor: "specify", kind: "single", expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }], dispatch_secret: "phase-ready-secret", advance_secret: "phase-ready-advance" });
    writeState(run.root, { ...state, cursor_epoch: readyCapability.state.issued_for!.cursor_epoch, dispatch_capability: { ...readyCapability.state, status: "ready" } }, { featureSlug: FEATURE_ID });
    const readyValidation = authorizeSpecificationPhaseValidationDispatch(run.root, {
      token: readyCapability.dispatch_token,
      capability_id: readyCapability.capability_id,
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: PROFILE_HASH,
      stage_cursor: "specify",
      cursor_epoch: readyCapability.state.issued_for!.cursor_epoch,
      request_id: "phase-validation-ready",
    });
    assert.equal(readyValidation.ok, true);
    if (!readyValidation.ok) throw new Error("validation authorization failed");
    const forged = {
      ...resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!,
      dispatch_capability: {
        ...state.dispatch_capability!,
        dispatches: (state.dispatch_capability?.dispatches ?? []).map((record) => ({ ...record, purpose: "forged" as never })),
      },
    };
    writeState(run.root, forged, { featureSlug: FEATURE_ID });
    const rejected = authorizeSpecificationPhaseValidationDispatch(run.root, {
      token: readyValidation.dispatch_token,
      capability_id: readyValidation.capability_id,
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: PROFILE_HASH,
      stage_cursor: "specify",
      cursor_epoch: readyValidation.capability_epoch,
      request_id: "phase-validation-forged-purpose",
    });
    assert.equal(rejected.ok, false);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
test("validation dispatch requires a bounded regular current phase artifact", () => {
  const cases = ["positive", "oversized", "directory", "symlink", "fifo", "root-swap"] as const;
  for (const scenario of cases) {
    const run = setup();
    const displacedRoot = `${run.root}.displaced`;
    try {
      let rootSwapBaseline: { replacementEntries: string[]; stateBytes: string; artifactBytes: string } | null = null;
      const persisted = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
      const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.ok(before.state);
      if (!before.state) continue;
      if (scenario === "oversized") {
        truncateSync(run.artifactPath, 8 * 1024 * 1024 + 1);
      } else if (scenario === "directory") {
        unlinkSync(run.artifactPath);
        mkdirSync(run.artifactPath);
        writeFileSync(join(run.artifactPath, "child.json"), "{}", "utf8");
      } else if (scenario === "symlink") {
        const displacedArtifact = `${run.artifactPath}.regular`;
        renameSync(run.artifactPath, displacedArtifact);
        symlinkSync(displacedArtifact, run.artifactPath);
      } else if (scenario === "fifo") {
        unlinkSync(run.artifactPath);
        execFileSync("/usr/bin/mkfifo", [run.artifactPath]);
      } else if (scenario === "root-swap") {
        const stateBytes = readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8");
        const artifactBytes = readFileSync(run.artifactPath, "utf8");
        renameSync(run.root, displacedRoot);
        mkdirSync(run.root);
        rootSwapBaseline = { replacementEntries: readdirSync(run.root), stateBytes, artifactBytes };
      }
      const result = (() => {
        try {
          validationDispatch(run.root, run);
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      })();
      if (scenario === "positive") {
        assert.equal(result.ok, true, result.ok ? "" : result.error);
      } else {
        assert.equal(result.ok, false, `${scenario} artifact must not authorize validation`);
        if (scenario === "root-swap") {
          assert.ok(rootSwapBaseline);
          if (!rootSwapBaseline) throw new Error("root-swap baseline was not captured");
          assert.deepEqual(readdirSync(run.root), rootSwapBaseline.replacementEntries, "root swap must not create files in the replacement root");
          assert.equal(readFileSync(join(displacedRoot, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), rootSwapBaseline.stateBytes, "root swap must not mutate displaced state");
          assert.equal(readFileSync(join(displacedRoot, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json"), "utf8"), rootSwapBaseline.artifactBytes, "root swap must not mutate displaced artifact");
        } else {
          const after = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
          assert.equal(after.state ? digestOf(after.state) : null, before.state ? digestOf(before.state) : null, `${scenario} rejection must not mutate state`);
        }
      }
    } finally {
      if (existsSync(displacedRoot) && !existsSync(join(run.root, ".work-state"))) {
        rmSync(run.root, { recursive: true, force: true });
        renameSync(displacedRoot, run.root);
      }
      rmSync(run.root, { recursive: true, force: true });
      rmSync(displacedRoot, { recursive: true, force: true });
    }
  }
});
test("model-less immutable phase history fails typed and requires revision", () => {
  const run = setup();
  try {
    const persisted = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persisted.ok, true);
    const raw = JSON.parse(readFileSync(run.artifactPath, "utf8")) as Record<string, unknown>;
    const source = { ...(raw.source_artifact as Record<string, unknown>) };
    delete source.semantic_model;
    raw.source_artifact = source;
    raw.source_artifact_hash = digestOf(source);
    writeFileSync(run.artifactPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    expectInvalidValidationDispatchRejected(run, "specify", run.input);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("phase persistence owns a canonical request snapshot before caller mutation", async () => {
  const run = setup();
  try {
    const callerInput = { ...run.input, source_artifact: { ...run.input.source_artifact, semantic_model: { ...(run.input.source_artifact.semantic_model as Record<string, unknown>) }, }, documents: run.input.documents.map((document) => ({ ...document })) };
    const persisted = persistSpecificationPhaseResult(run.root, callerInput);
    assert.equal(persisted.ok, true);
    queueMicrotask(() => {
      callerInput.documents[0]!.content = "mutated after the durable call";
      (callerInput.source_artifact.semantic_model as Record<string, unknown>).requirements = [];
    });
    await Promise.resolve();
    const stored = JSON.parse(readFileSync(run.artifactPath, "utf8")) as { source_artifact: { semantic_model: { requirements: unknown[] } }; document_hashes: Record<string, string> };
    assert.equal(stored.source_artifact.semantic_model.requirements.length, 1);
    assert.equal(stored.document_hashes["spec.md"], sha256Hex(run.input.documents[0]!.content));
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("generation rejects a model fact rendered under the wrong heading", () => {
  const run = setup();
  try {
    const primary = run.input.documents.find((document) => document.path === "spec.md")!;
    const wrongContent = primary.content
      .replace("Persist one immutable phase result and its readable projection.", "Persist one immutable phase result and its readable projection.\n\nFORGED TOKEN")
      .replace("REQ-1 is deterministic and observable.", "A different requirement.");
    const wrongModel = {
      ...(run.input.source_artifact.semantic_model as Record<string, unknown>),
      requirements: [{ requirement_id: "REQ-1", statement: "FORGED TOKEN", acceptance_ids: ["AC-1"], source_refs: ["spec.md#requirements"] }],
    };
    const rejected = persistSpecificationPhaseResult(run.root, {
      ...run.input,
      request_id: run.input.request_id,
      source_artifact: { ...run.input.source_artifact, document_sha256: sha256Hex(wrongContent), semantic_model: wrongModel },
      documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content: wrongContent } : document),
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_PHASE_STALE");
    assert.equal(existsSync(run.artifactPath), false);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("validation cannot fabricate semantic facts or hold the lock with oversized input", () => {
  const run = setup();
  try {
    const persisted = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persisted.ok, true);
    const auth = validationDispatch(run.root, run);
    const base = {
      token: auth.token,
      capability_id: auth.capability_id,
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: PROFILE_HASH,
      phase: "specify" as const,
      request_id: auth.request_id,
      cursor_epoch: auth.cursor_epoch,
      dispatch_id: auth.dispatch_id,
    };
    const valid = validationPayload(run, [{ principle_id: "constitution", status: "pass", evidence: "verified" }]);
    const oversized = persistSpecificationPhaseValidation(run.root, {
      ...base,
      validation: { ...valid, sections: { ...valid.sections, problem: "x".repeat(1_000_001) } },
    });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.code, "SPEC_PHASE_REQUEST_INVALID");
    const nearLimitValidation = {
      ...valid,
      requirements: Array.from({ length: 4_000 }, (_, index) => ({ requirement_id: "R-" + index, statement: "Near-limit requirement " + index, acceptance_ids: ["A-" + index] })),
    };
    const preparedNearLimit = prepareNativePhaseValidation(nearLimitValidation);
    assert.equal(preparedNearLimit.ok, true);
    if (preparedNearLimit.ok) {
      assert.equal(preparedNearLimit.indexes.budget_exceeded, false, "near-limit semantic validation must remain below the configured work budget");
      assert.ok(preparedNearLimit.indexes.operation_count <= MAX_NATIVE_VALIDATION_WORK, "near-limit semantic validation must remain within the configured bounded work budget");
    }
    const nearLimit = persistSpecificationPhaseValidation(run.root, { ...base, validation: nearLimitValidation });
    assert.equal(nearLimit.ok, false);
    if (!nearLimit.ok) assert.equal(nearLimit.code, "SPEC_PHASE_STALE");
    const forged = persistSpecificationPhaseValidation(run.root, {
      ...base,
      validation: {
        ...valid,
        sections: Object.fromEntries(Object.keys(valid.sections).map((key) => [key, "a"])),
        requirements: [{ requirement_id: "FORGED", statement: "caller-authored pass", acceptance_ids: [] }],
      },
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.code, "SPEC_CHECKPOINT_BLOCKED");
    const evidenceDirectory = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts");
    const failedEvidence = readdirSync(evidenceDirectory).filter((name) => /^validation\.specify\.v1\.attempt\.[a-f0-9]{64}\.json$/u.test(name));
    assert.equal(failedEvidence.length, 1, "a bound failed validation remains durable as an immutable attempt");
    const forgedValidation = JSON.parse(readFileSync(join(evidenceDirectory, failedEvidence[0]!), "utf8")) as { status?: string };
    assert.equal(forgedValidation.status, "fail");
    const forgedState = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(forgedState.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "revision_required");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});


test("late terminal worker cannot publish after retry authority changes", () => {
  const run = setup();
  writeFileSync(join(dirname(run.artifactPath), "specify_draft.json"), "{}\n");
  try {
    const genericBefore = readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "state.json"));
    const generic = completeDispatch(run.root, {
      token: run.input.token, capability_id: run.input.capability_id, feature_id: run.input.feature_id, run_key: run.input.run_key,
      branch: run.input.branch, workflow: run.input.workflow, profile_hash: run.input.profile_hash, stage_cursor: run.input.phase,
      cursor_epoch: run.input.cursor_epoch, role: "specification-analyst", agent: "specification-worker", dispatch_id: run.input.dispatch_id,
      outcome: "failed", artifact_ids: ["specify_draft"], evidence: "generic completion must not terminalize native generation",
    });
    assert.equal(generic.ok, false);
    if (!generic.ok) assert.match(generic.error, /NATIVE_COMPOSITE_REQUIRED/);
    assert.deepEqual(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "state.json")), genericBefore);
    const failed = completeNativeSpecificationGeneration(run.root, {
      token: run.input.token, capability_id: run.input.capability_id, feature_id: run.input.feature_id, run_key: run.input.run_key,
      branch: run.input.branch, workflow: run.input.workflow, profile_hash: run.input.profile_hash, stage_cursor: run.input.phase,
      cursor_epoch: run.input.cursor_epoch, role: "specification-analyst", agent: "specification-worker", dispatch_id: run.input.dispatch_id,
      outcome: "failed", artifact_ids: ["specify_draft"], evidence: "composite finalizer observed first worker failure",
    });
    assert.equal(failed.ok, true, failed.ok ? "" : failed.error);
    const retryAuth = {
      ...run.input,
      request_id: run.input.request_id,
      stage_cursor: run.input.phase,
      role: "specification-analyst",
      agent: "specification-worker",
      retry_of: run.input.dispatch_id,
    };
    const retryProof = issueCurrentTrustedMappingProof(run.root);
    const retryDispatch = authorizeSpecificationPhaseDispatch(run.root, retryAuth, retryProof === undefined ? {} : { trustedMappingProof: retryProof });
    assert.equal(retryDispatch.ok, true, retryDispatch.ok ? "" : retryDispatch.error);
    if (!retryDispatch.ok) return;
    const retryRecord = retryDispatch.record;

    const beforeLate = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    const late = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(late.ok, false, "the terminal first attempt must be rejected before any persistence");
    if (!late.ok) assert.equal(late.code, "SPEC_PHASE_FORBIDDEN");
    const afterLate = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(digestOf(afterLate.state), digestOf(beforeLate.state), "late terminal attempt must not change durable state");
    assert.equal(existsSync(run.artifactPath), false, "late terminal attempt must not publish an immutable artifact");
    assert.equal(existsSync(run.manifestPath), false, "late terminal attempt must not publish a projection manifest");
    assert.equal(existsSync(run.journalPath), false, "late terminal attempt must not create a persistence journal");

    const retryModel = { ...(run.input.source_artifact.semantic_model as Record<string, unknown>), worker: { ...(run.input.source_artifact.worker as Record<string, unknown>), dispatch_id: retryRecord.id } };
    const retryDocumentContent = renderDurabilityDocument("specify", retryModel as any);
    const retryInput: SpecificationWorkerResultInput = {
      ...run.input, request_id: retryAuth.request_id, dispatch_id: retryRecord.id, role: "specification-analyst", agent: "specification-worker",
      source_artifact: { ...run.input.source_artifact, document_sha256: sha256Hex(retryDocumentContent), worker: { ...run.input.source_artifact.worker as Record<string, unknown>, dispatch_id: retryRecord.id }, semantic_model: retryModel },
      documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content: retryDocumentContent } : document), semantic_sections: retryModel.sections as Record<string, string>,
    };
    const succeeded = persistSpecificationPhaseResult(run.root, retryInput);
    assert.equal(succeeded.ok, true, succeeded.ok ? "" : succeeded.error);
    if (!succeeded.ok) return;
    const completedRetry = completeDispatch(run.root, {
      ...retryAuth,
      dispatch_id: retryRecord.id,
      artifact_ids: ["specify_draft"],
      outcome: "succeeded",
      evidence: "retry worker committed the phase result",
    });
    assert.equal(completedRetry.ok, true, completedRetry.ok ? "" : completedRetry.error);
    const committedReplay = persistSpecificationPhaseResult(run.root, retryInput);
    assert.equal(committedReplay.ok, true, committedReplay.ok ? "" : committedReplay.error);
    const committedState = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    const committedArtifact = readFileSync(run.artifactPath, "utf8");

    const lateReplay = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(lateReplay.ok, false, "the terminal first attempt must remain rejected after retry success");
    if (!lateReplay.ok) assert.equal(lateReplay.code, "SPEC_PHASE_FORBIDDEN");
    const afterReplay = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(digestOf(afterReplay.state), digestOf(committedState.state), "late terminal replay must not change committed state");
    assert.equal(readFileSync(run.artifactPath, "utf8"), committedArtifact, "late terminal replay must not rewrite the retry artifact");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("cross-process phase authority lock serializes terminal retry race", async () => {
  const run = setup();
  writeFileSync(join(dirname(run.artifactPath), "specify_draft.json"), "{}\n");
  const raceDir = mkdtempSync(join(run.root, "race-"));
  const readyPath = join(raceDir, "a-ready");
  const releasePath = join(raceDir, "release");
  const bStartedPath = join(raceDir, "b-started");
  const aDonePath = join(raceDir, "a-done");
  const bDonePath = join(raceDir, "b-done");
  const children: Promise<unknown>[] = [];
  try {
    const failure = {
      token: run.input.token,
      capability_id: run.input.capability_id,
      feature_id: run.input.feature_id,
      run_key: run.input.run_key,
      branch: run.input.branch,
      workflow: run.input.workflow,
      profile_hash: run.input.profile_hash,
      stage_cursor: run.input.phase,
      cursor_epoch: run.input.cursor_epoch,
      role: "specification-analyst",
      agent: "specification-worker",
      artifact_ids: ["specify_draft"],
      dispatch_id: run.input.dispatch_id,
      outcome: "failed",
      evidence: "stale worker failure",
    };
    const dispatch = {
      ...run.input,
      role: "specification-analyst",
      agent: "specification-worker",
    };
    const retry = {
      token: run.input.token,
      capability_id: run.input.capability_id,
      feature_id: run.input.feature_id,
      run_key: run.input.run_key,
      branch: run.input.branch,
      workflow: run.input.workflow,
      profile_hash: run.input.profile_hash,
      stage_cursor: run.input.phase,
      cursor_epoch: run.input.cursor_epoch,
      role: "specification-analyst",
      agent: "specification-worker",
      request_id: "phase-request-race-retry",
      retry_of: run.input.dispatch_id,
    };
    const phasePromise = runPhaseRaceChild([run.root, "phase", JSON.stringify(run.input), readyPath, releasePath, bStartedPath, aDonePath]);
    children.push(phasePromise);
    waitForRaceFile(readyPath);
    const retryPromise = runPhaseRaceChild([run.root, "retry", JSON.stringify({ dispatch, failure, retry }), readyPath, releasePath, bStartedPath, bDonePath]);
    children.push(retryPromise);
    waitForRaceFile(bStartedPath);
    const waitSignal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitSignal, 0, 0, 100);
    assert.equal(existsSync(bDonePath), false, "retry process must still be blocked on the phase state lock");
    writeFileSync(releasePath, "release");
    const [aRaw, bRaw] = await Promise.all(children);
    const aResult = aRaw as { ok: boolean; error?: string };
    const bResult = bRaw as { dispatch: { ok: boolean; error?: string; code?: string }; failure: { ok: boolean; error?: string }; retry: { ok: boolean; error?: string; record?: DispatchRecord } };
    assert.equal(aResult.ok, true, aResult.ok ? "" : aResult.error);
    assert.equal(bResult.dispatch.ok, false, "phase dispatch must revalidate the committed snapshot before authorizing a retry");
    assert.match(bResult.dispatch.error ?? "", /cannot dispatch from status|phase .*cannot dispatch/i);
    assert.equal(bResult.failure.ok, true, bResult.failure.ok ? "" : bResult.failure.error);
    assert.equal(bResult.retry.ok, true, bResult.retry.ok ? "" : bResult.retry.error);
    assert.ok(bResult.retry.record);
    const committed = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(committed.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "materialized");
    assert.equal(existsSync(run.artifactPath), true, "the lock winner must publish the canonical artifact");
    assert.equal(existsSync(run.manifestPath), true, "the lock winner must publish the readable projection");
    const artifactBeforeLate = readFileSync(run.artifactPath, "utf8");
    const stateBeforeLate = digestOf(committed.state);

    const lateD1 = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(lateD1.ok, false, "the terminal d1 worker must remain rejected after d2 authorization");
    if (!lateD1.ok) assert.equal(lateD1.code, "SPEC_PHASE_FORBIDDEN");

    const retryRecord = bResult.retry.record!;
    const retryModel = { ...(run.input.source_artifact.semantic_model as Record<string, unknown>), worker: { ...(run.input.source_artifact.worker as Record<string, unknown>), dispatch_id: retryRecord.id } };
    const retryDocumentContent = renderDurabilityDocument("specify", retryModel as any);
    const retryInput: SpecificationWorkerResultInput = {
      ...run.input, request_id: retry.request_id, dispatch_id: retryRecord.id, role: "specification-analyst", agent: "specification-worker",
      source_artifact: { ...run.input.source_artifact, document_sha256: sha256Hex(retryDocumentContent), worker: { ...run.input.source_artifact.worker as Record<string, unknown>, dispatch_id: retryRecord.id }, semantic_model: retryModel },
      documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content: retryDocumentContent } : document), semantic_sections: retryModel.sections as Record<string, string>,
    };
    const staleD2 = persistSpecificationPhaseResult(run.root, retryInput);
    assert.equal(staleD2.ok, false, "a retry arriving after the committed d1 artifact must conflict before publication");
    if (!staleD2.ok) assert.equal(staleD2.code, "SPEC_PHASE_IMMUTABLE");
    const afterLate = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(digestOf(afterLate.state), stateBeforeLate, "late workers must not mutate durable state");
    assert.equal(readFileSync(run.artifactPath, "utf8"), artifactBeforeLate, "late workers must not rewrite the authoritative artifact");
  } finally {
    writeFileSync(releasePath, "release");
    await Promise.allSettled(children);
    rmSync(run.root, { recursive: true, force: true });
  }
});

function swapProjectRoot(root: string): () => void {
  const original = root + ".original";
  renameSync(root, original);
  mkdirSync(root);
  return () => {
    rmSync(root, { recursive: true, force: true });
    renameSync(original, root);
  };
}

test("root replacement cannot receive phase WAL, artifact, projection, or state writes", () => {
  for (const seam of ["before_prepare", "before_artifact_write", "after_projection"] as const) {
    const run = setup();
    const before = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    let swapped = false;
    let restore: (() => void) | null = null;
    try {
      setSpecificationPhaseFailureInjector((point) => {
        if (!swapped && point === seam) {
          swapped = true;
          restore = swapProjectRoot(run.root);
        }
      });
      const result = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(result.ok, false, seam + " must fail closed after the project root is replaced");
      assert.equal(existsSync(join(run.root, ".work-state")), false, seam + " must not write state into the replacement root");
      assert.equal(existsSync(join(run.root, "specs")), false, seam + " must not write readable documents into the replacement root");
      (restore as (() => void) | null)?.();
      restore = null;
      const after = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.equal(digestOf(after.state), digestOf(before.state), seam + " must preserve the original state when root identity changes");
    } finally {
      setSpecificationPhaseFailureInjector(null);
      (restore as (() => void) | null)?.();
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("dispatch authorization rejects a replaced root without writing replacement state", () => {
  const run = setup();
  const before = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const original = run.root + ".original";
  let swapped = false;
  try {
    setSpecificationPhaseFailureInjector((point) => {
      if (!swapped && point === "before_dispatch_transition") {
        swapped = true;
        renameSync(run.root, original);
        mkdirSync(run.root);
      }
    });
    const result = dispatchSpecificationPhase(run.root, { ...run.input, role: "specification-analyst", agent: "specification-worker" });
    assert.equal(result.ok, false, "dispatch must fail closed after root replacement");
    assert.equal(existsSync(join(run.root, ".work-state")), false, "replacement root must not receive dispatch state");
    assert.equal(existsSync(join(run.root, "specs")), false, "replacement root must not receive dispatch projections");
    rmSync(run.root, { recursive: true, force: true });
    renameSync(original, run.root);
    const after = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(digestOf(after.state), digestOf(before.state), "dispatch root replacement must preserve original state");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    if (existsSync(original)) {
      rmSync(run.root, { recursive: true, force: true });
      renameSync(original, run.root);
    }
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("direct phase persistence rejects constitution drift before any publication", () => {
  const run = setup();
  const constitutionPath = join(run.root, "CONSTITUTION.md");
  const original = readFileSync(constitutionPath, "utf8");
  const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  try {
    writeFileSync(constitutionPath, original + "\n## Drift\nThis source is no longer the approved constitution.\n", "utf8");
    const rejected = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(rejected.ok, false, "a generation token bound to old constitution bytes must fail closed");
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_PHASE_STALE");
    assert.equal(existsSync(run.artifactPath), false, "stale constitution must not publish an immutable artifact");
    assert.equal(existsSync(run.manifestPath), false, "stale constitution must not publish readable projections");
    assert.equal(existsSync(run.journalPath), false, "stale constitution must not create a recovery journal");
    const after = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(digestOf(after.state), digestOf(before.state), "stale constitution must not mutate workflow state");
    writeFileSync(constitutionPath, original, "utf8");
    const retry = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
  } finally {
    writeFileSync(constitutionPath, original, "utf8");
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("phase result recovery publishes canonical artifact/state and readable manifest across every boundary", () => {
  for (const failurePoint of FAILURE_POINTS) {
    const run = setup();
    const beforeState = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    let injected = false;
    try {
      setSpecificationPhaseFailureInjector((point) => {
        if (!injected && point === failurePoint) {
          injected = true;
          throw new Error(`injected ${point}`);
        }
      });
      const first = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(first.ok, false, `${failurePoint} must report the injected interruption`);
      const projectionPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json");
      const stateAfterFailure = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      const stateCommitted = stateAfterFailure.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status === "materialized";
      if (failurePoint === "after_state_write") {
        assert.equal(stateCommitted, true, "after_state_write runs after the canonical state commit");
        assert.notEqual(digestOf(stateAfterFailure.state), digestOf(beforeState.state), "after_state_write must retain the committed workspace postimage");
        assert.equal(existsSync(run.artifactPath), true, "after_state_write must retain the immutable artifact already published");
        assert.equal(existsSync(run.journalPath), false, "after_state_write runs after the complete output transaction and WAL cleanup");
        assert.equal(existsSync(run.manifestPath), true, "after_state_write must retain the readable manifest");
        assert.equal(existsSync(projectionPath), true, "after_state_write must retain the native projection");
        for (const document of run.input.documents) {
          assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, document.path)), true, `after_state_write must retain ${document.path}`);
        }
      } else {
        assert.equal(stateCommitted, false, `${failurePoint} must discard an uncommitted phase attempt`);
        assert.equal(digestOf(stateAfterFailure.state), digestOf(beforeState.state), `${failurePoint} must restore the workflow-state preimage`);
        assert.equal(existsSync(run.artifactPath), false, `${failurePoint} must remove the attempt-owned immutable artifact`);
        assert.equal(existsSync(run.manifestPath), false, `${failurePoint} must not expose a partial manifest`);
        assert.equal(existsSync(run.journalPath), false, `${failurePoint} must remove the attempt-owned WAL`);
        assert.equal(existsSync(projectionPath), false, `${failurePoint} must not expose a partial native projection`);
        for (const document of run.input.documents) {
          assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, document.path)), false, `${failurePoint} must restore ${document.path} to its preimage`);
        }
      }
      setSpecificationPhaseFailureInjector(null);
      const retry = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(retry.ok, true, `${failurePoint} retry must converge: ${retry.ok ? "ok" : retry.error}`);
      assert.equal(existsSync(run.artifactPath), true, "canonical immutable phase artifact must be published");
      assert.equal(existsSync(run.manifestPath), true, "readable projection manifest must be recovered");
      assert.equal(existsSync(run.journalPath), false, "durable phase journal must be cleaned after commit");
      const committed = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.equal(committed.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "materialized");
      const envelope = JSON.parse(readFileSync(run.artifactPath, "utf8")) as { document_hashes: Record<string, string> };
      const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as { documents: Array<{ path: string; sha256: string }> };
      assert.deepEqual(Object.fromEntries(manifest.documents.map((document) => [document.path, document.sha256])), envelope.document_hashes, "projection must remain bound to the committed immutable artifact");
    } finally {
      setSpecificationPhaseFailureInjector(null);
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});


test("phase persistence requires the exact journal receipt after prepare replacement", () => {
  const run = setup();
  const before = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const replacementPath = run.journalPath + ".replacement";
  let swapped = false;
  try {
    setSpecificationPhaseFailureInjector((point) => {
      if (swapped || point !== "after_prepare") return;
      swapped = true;
      const journalBytes = readFileSync(run.journalPath);
      renameSync(run.journalPath, replacementPath);
      writeFileSync(run.journalPath, journalBytes);
    });
    const rejected = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(rejected.ok, false, "a journal replacement after prepare must fail closed");
    if (!rejected.ok) {
      assert.equal(rejected.code, "SPEC_PHASE_RECOVERY_REQUIRED");
      assert.match(rejected.error, /journal descriptor changed after prepare/u);
    }
    assert.equal(swapped, true, "the deterministic replacement seam must run");
    const replacementBytes = readFileSync(run.journalPath);
    assert.deepEqual(readFileSync(replacementPath), replacementBytes, "the original journal must remain preserved");
    assert.equal(existsSync(run.artifactPath), false, "receipt mismatch must precede immutable artifact publication");
    assert.equal(existsSync(run.manifestPath), false, "receipt mismatch must precede readable projection");
    assert.equal(digestOf(resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state), digestOf(before.state), "receipt mismatch must not advance workflow state");

    setSpecificationPhaseFailureInjector(null);
    unlinkSync(run.journalPath);
    renameSync(replacementPath, run.journalPath);
    const recovered = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.error);
    assert.equal(existsSync(run.journalPath), false, "recovery must consume the restored journal");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("native artifact projection repairs same-request failure and rejects conflicts", () => {
  const run = setup();
  const projectionPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json");
  let injected = false;
  try {
    setSpecificationPhaseFailureInjector((point) => {
      if (!injected && point === "before_projection_artifact") {
        injected = true;
        throw new Error("injected native artifact projection failure");
      }
    });
    const failed = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(failed.ok, false, "projection failure must be reported");
    if (!failed.ok) {
      assert.equal(failed.code, "SPEC_PHASE_PERSIST_FAILED");
      assert.match(failed.error, /injected native artifact projection failure/u);
    }
    assert.equal(existsSync(run.artifactPath), false, "a failed native projection must remove its attempt-created immutable envelope");
    assert.equal(existsSync(run.manifestPath), false, "a failed native projection must remove its attempt-created readable manifest");
    assert.equal(existsSync(run.journalPath), false, "a failed native projection must remove its attempt-created WAL");
    assert.equal(existsSync(projectionPath), false, "failed projection must not publish a partial generic artifact");
    for (const document of run.input.documents) {
      assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, document.path)), false, `failed projection must remove attempt-created ${document.path}`);
    }

    setSpecificationPhaseFailureInjector(null);
    const repaired = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(repaired.ok, true, repaired.ok ? "" : repaired.error);
    if (!repaired.ok) return;
    assert.equal(repaired.replayed, false, "an attempt-owned envelope removed by rollback must be recreated by the exact retry");
    const expectedProjection = `${JSON.stringify(run.input.source_artifact.semantic_model, null, 2)}\n`;
    assert.equal(readFileSync(projectionPath, "utf8"), expectedProjection, "projection bytes must equal the canonical semantic model");

    const replay = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (!replay.ok) return;
    assert.equal(replay.replayed, true, "identical replay must remain idempotent");
    assert.equal(readFileSync(projectionPath, "utf8"), expectedProjection, "identical replay must preserve projection bytes");

    const tampered = structuredClone(run.input.source_artifact.semantic_model) as SpecificationSemanticModel;
    tampered.sections = { ...tampered.sections, problem: "tampered projection" };
    writeFileSync(projectionPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const conflict = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(conflict.ok, false, "conflicting projection bytes must fail closed");
    if (!conflict.ok) assert.equal(conflict.code, "SPEC_PHASE_IMMUTABLE");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("native projection refuses lower or invalid bytes without an owning WAL", () => {
  const run = setup();
  const projectionPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json");
  try {
    const first = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    const lower = { ...(run.input.source_artifact.semantic_model as Record<string, unknown>), version: 0 };
    writeFileSync(projectionPath, `${JSON.stringify(lower, null, 2)}\n`, "utf8");
    const lowerBytes = readFileSync(projectionPath);
    const lowerReplay = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(lowerReplay.ok, false);
    if (!lowerReplay.ok) assert.equal(lowerReplay.code, "SPEC_PHASE_IMMUTABLE");
    assert.deepEqual(readFileSync(projectionPath), lowerBytes, "an unowned lower-version projection must remain untouched");

    writeFileSync(projectionPath, "{}\n", "utf8");
    const invalidBytes = readFileSync(projectionPath);
    const invalidReplay = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(invalidReplay.ok, false);
    if (!invalidReplay.ok) assert.equal(invalidReplay.code, "SPEC_PHASE_IMMUTABLE");
    assert.deepEqual(readFileSync(projectionPath), invalidBytes, "an invalid projection without an active WAL must remain untouched");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("native projection CAS accepts a cross-process winner for an owned repair", () => {
  const run = setup();
  const projectionPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json");
  let raced = false;
  try {
    writeFileSync(projectionPath, "{}\n", "utf8");
    const expected = `${JSON.stringify(run.input.source_artifact.semantic_model, null, 2)}\n`;
    setSpecificationPhaseFailureInjector((point) => {
      if (point !== "before_projection_artifact_replace" || raced) return;
      raced = true;
      execFileSync(process.execPath, ["-e", "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], process.argv[2], 'utf8');", projectionPath, expected], { stdio: "ignore" });
    });
    const persisted = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
    assert.equal(raced, true, "the separate writer must win the projection CAS race");
    assert.equal(readFileSync(projectionPath, "utf8"), expected, "the CAS loser must accept the exact cross-process winner");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("failed phase projection restores the preimage before retry commits exactly once", () => {
  const run = setup();
  const before = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const projectionPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json");
  assert.ok(before.state);
  const beforeWorkspaceDigest = digestOf(before.state?.specification);
  let injected = false;
  try {
    setSpecificationPhaseFailureInjector((point) => {
      if (!injected && point === "after_projection") {
        injected = true;
        throw new Error("injected after projection");
      }
    });
    const failed = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(failed.ok, false, "a post-projection failure must be reported");
    if (!failed.ok) assert.equal(failed.code, "SPEC_PHASE_PERSIST_FAILED");
    const afterFailure = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(digestOf(afterFailure.state?.specification), beforeWorkspaceDigest, "a failed post-projection attempt must not expose its staged workspace");
    assert.equal(afterFailure.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "generating");
    assert.equal(existsSync(run.artifactPath), false, "the failed attempt must remove its immutable artifact");
    assert.equal(existsSync(run.manifestPath), false, "the failed attempt must remove its manifest");
    assert.equal(existsSync(run.journalPath), false, "the failed attempt must remove its WAL");
    assert.equal(existsSync(projectionPath), false, "the failed attempt must remove its native projection");
    for (const document of run.input.documents) {
      assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, document.path)), false, `the failed attempt must restore ${document.path} to its preimage`);
    }

    setSpecificationPhaseFailureInjector(null);
    const recovered = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.error);
    const afterRecovery = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(afterRecovery.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "materialized");
    assert.notEqual(digestOf(afterRecovery.state?.specification), beforeWorkspaceDigest, "recovery must publish the staged workspace exactly once");
    assert.equal(existsSync(run.journalPath), false, "successful recovery must consume the replay journal");
    const recoveredArtifact = readFileSync(run.artifactPath, "utf8");
    const recoveredRevision = afterRecovery.revision;

    const replay = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (replay.ok) assert.equal(replay.replayed, true, "a terminal retry must be reported as a replay");
    const afterReplay = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(afterReplay.revision, recoveredRevision, "replaying a committed phase must not advance state twice");
    assert.equal(digestOf(afterReplay.state?.specification), digestOf(afterRecovery.state?.specification));
    assert.equal(readFileSync(run.artifactPath, "utf8"), recoveredArtifact, "replay must not rewrite the immutable artifact");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});


test("phase projection replays after every readable document boundary", () => {
  for (const boundaryIndex of [0, 1, 2]) {
    const run = setup();
    let injected = false;
    try {
      setSpecificationPhaseFailureInjector((point, boundary) => {
        if (!injected && point === "after_projection_document" && boundary?.index === boundaryIndex) {
          injected = true;
          throw new Error(`injected readable document boundary ${boundaryIndex}`);
        }
      });
      const first = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(first.ok, false, `boundary ${boundaryIndex} must report the injected interruption`);
      assert.equal(existsSync(run.artifactPath), false, `boundary ${boundaryIndex} must remove the attempt-owned immutable artifact`);
      assert.equal(existsSync(run.manifestPath), false, `boundary ${boundaryIndex} must not expose a manifest`);
      assert.equal(existsSync(run.journalPath), false, `boundary ${boundaryIndex} must remove the attempt-owned WAL`);
      assert.equal(existsSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json")), false, `boundary ${boundaryIndex} must remove the native projection`);
      for (const document of run.input.documents) {
        assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, document.path)), false, `boundary ${boundaryIndex} must restore ${document.path} to its preimage`);
      }
      const committed = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.equal(committed.state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "generating");

      setSpecificationPhaseFailureInjector(null);
      const retry = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(retry.ok, true, `boundary ${boundaryIndex} retry must converge: ${retry.ok ? "ok" : retry.error}`);
      for (const document of run.input.documents) {
        assert.equal(
          readFileSync(join(run.root, "specs", FEATURE_ID, document.path), "utf8"),
          document.content,
          `${document.path} must contain the exact expected projection bytes`,
        );
      }
      assert.equal(existsSync(run.manifestPath), true, "manifest must be published after all readable documents");
      assert.equal(existsSync(run.journalPath), false, "journal must be cleaned after replay commit");
    } finally {
      setSpecificationPhaseFailureInjector(null);
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("phase replay rejects tampered immutable envelopes without advancing state or materialization", () => {
  const mutations: Record<string, (artifact: Record<string, unknown>) => void> = {
    body: (artifact) => {
      const source = artifact.source_artifact as Record<string, unknown>;
      artifact.source_artifact = { ...source, tampered_body: "must not be accepted" };
    },
    partial: (artifact) => { delete artifact.work_identity; },
    hash: (artifact) => { artifact.source_artifact_hash = "0".repeat(64); },
    phase: (artifact) => { artifact.phase = "plan"; },
    feature: (artifact) => { artifact.feature_id = "other-feature"; },
    version: (artifact) => { artifact.version = 2; },
    constitution_ref: (artifact) => {
      artifact.constitution_binding = {
        ...(artifact.constitution_binding as Record<string, unknown>),
        validation_ref: "validation.tampered",
      };
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const run = setup();
    try {
      const first = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(first.ok, true, `${label}: initial publication must succeed`);
      if (!first.ok) continue;
      const beforeState = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      const beforeManifest = readFileSync(run.manifestPath, "utf8");
      const beforeDocuments = Object.fromEntries(run.input.documents.map((document) => [document.path, readFileSync(join(run.root, "specs", FEATURE_ID, document.path), "utf8")]));
      const artifact = JSON.parse(readFileSync(run.artifactPath, "utf8")) as Record<string, unknown>;
      mutate(artifact);
      writeFileSync(run.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

      const replay = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(replay.ok, false, `${label}: tampered artifact must fail closed`);
      if (!replay.ok) assert.equal(replay.code, "SPEC_PHASE_IMMUTABLE", `${label}: failure must identify immutable artifact tampering`);
      const afterState = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.equal(digestOf(afterState.state), digestOf(beforeState.state), `${label}: rejected replay must not advance workspace state`);
      assert.equal(readFileSync(run.manifestPath, "utf8"), beforeManifest, `${label}: rejected replay must not rewrite the manifest`);
      for (const [path, content] of Object.entries(beforeDocuments)) assert.equal(readFileSync(join(run.root, "specs", FEATURE_ID, path), "utf8"), content, `${label}: rejected replay must not rewrite ${path}`);
    } finally {
      setSpecificationPhaseFailureInjector(null);
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("phase replay requires the exact journal receipt after parse replacement", async () => {
  const run = setup();
  const before = resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const replacementPath = run.journalPath + ".replacement";
  let swapped = false;
  try {
    await assert.rejects(
      runPhaseRaceChild([run.root, "crash", JSON.stringify(run.input), "", "", "", ""]),
      /phase race child exited 71/u,
      "the interrupted child must leave a replayable journal",
    );
    const journalBytes = readFileSync(run.journalPath);
    const artifactBytes = readFileSync(run.artifactPath);
    setSpecificationPhaseFailureInjector((point) => {
      if (swapped || point !== "after_journal_parse") return;
      swapped = true;
      renameSync(run.journalPath, replacementPath);
      writeFileSync(run.journalPath, journalBytes);
    });
    const rejected = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(rejected.ok, false, "a journal replacement after parse must fail closed");
    if (!rejected.ok) {
      assert.equal(rejected.code, "SPEC_PHASE_RECOVERY_REQUIRED");
      assert.match(rejected.error, /journal descriptor changed after parse/u);
    }
    assert.equal(swapped, true, "the deterministic replacement seam must run");
    assert.deepEqual(readFileSync(run.journalPath), journalBytes, "the replacement journal must remain untouched");
    assert.deepEqual(readFileSync(replacementPath), journalBytes, "the original journal must remain preserved for recovery");
    assert.deepEqual(readFileSync(run.artifactPath), artifactBytes, "the immutable artifact must not be replayed before receipt verification");
    assert.equal(existsSync(run.manifestPath), false, "receipt mismatch must not materialize readable documents");
    assert.equal(digestOf(resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state), digestOf(before.state), "receipt mismatch must not advance workflow state");

    setSpecificationPhaseFailureInjector(null);
    unlinkSync(run.journalPath);
    renameSync(replacementPath, run.journalPath);
    const recovered = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.error);
    assert.equal(existsSync(run.journalPath), false, "recovery must consume the restored journal exactly once");
    assert.equal(resolveState(run.root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "materialized");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("phase replay rejects a mismatched preexisting readable document without overwriting it", async () => {
  const run = setup();
  const mismatched = run.input.documents[1]!;
  const mismatchedPath = join(run.root, "specs", FEATURE_ID, mismatched.path);
  try {
    await assert.rejects(
      runPhaseRaceChild([run.root, "crash", JSON.stringify(run.input), "", "", "", ""]),
      /phase race child exited 71/u,
      "the interrupted child must die after the state commit without running handled rollback",
    );
    setSpecificationPhaseFailureInjector(null);
    assert.equal(existsSync(run.artifactPath), true, "the interrupted child must leave its canonical immutable envelope");
    assert.equal(existsSync(run.journalPath), true, "the interrupted child must leave its canonical WAL");
    const journalBefore = readFileSync(run.journalPath);
    const artifactBefore = readFileSync(run.artifactPath);
    assert.equal(existsSync(run.manifestPath), false);
    assert.equal(existsSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json")), false);
    for (const document of run.input.documents) {
      assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, document.path)), false, `the interrupted child must not expose ${document.path} before projection`);
    }
    mkdirSync(join(run.root, "specs", FEATURE_ID, "notes"), { recursive: true });
    writeFileSync(mismatchedPath, "# User content must not be overwritten.\n", "utf8");
    const before = readFileSync(mismatchedPath, "utf8");

    setSpecificationPhaseFailureInjector(null);
    const retry = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(retry.ok, false, "mismatched readable content must fail closed");
    if (!retry.ok) assert.equal(retry.code, "SPEC_PHASE_PERSIST_FAILED");
    assert.equal(readFileSync(mismatchedPath, "utf8"), before, "mismatched readable bytes must remain untouched");
    assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, run.input.documents[0]!.path)), false, "a blocked replay must restore every attempt-created readable document to its preimage");
    assert.equal(existsSync(run.manifestPath), false, "a blocked replay must not publish a manifest");
    assert.equal(existsSync(run.journalPath), true, "a blocked replay must retain the canonical interrupted journal");
    assert.deepEqual(readFileSync(run.journalPath), journalBefore, "a blocked replay must preserve the exact interrupted WAL bytes");
    assert.deepEqual(readFileSync(run.artifactPath), artifactBefore, "a blocked replay must preserve the exact interrupted immutable envelope bytes");
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(run.root, { recursive: true, force: true });
  }
});


test("phase replay rejects missing and foreign readable projection bindings", () => {
  const mutations: Array<[string, (manifest: Record<string, unknown>) => void]> = [
    ["missing", (manifest) => { delete manifest.binding; }],
    ["foreign", (manifest) => {
      const binding = manifest.binding as Record<string, unknown>;
      const worker = binding.worker as Record<string, unknown>;
      binding.worker = { ...worker, dispatch_id: "foreign-dispatch" };
    }],
    ["presentation-tamper", (manifest) => {
      const binding = manifest.binding as Record<string, unknown>;
      const presentation = binding.presentation as Record<string, unknown>;
      binding.presentation = { ...presentation, language_hash: sha256Hex("foreign-language") };
    }],
  ];
  for (const [label, mutate] of mutations) {
    const run = setup();
    try {
      setSpecificationPhaseFailureInjector(null);
      const first = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(first.ok, true, `${label} setup must materialize`);
      const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as Record<string, unknown>;
      mutate(manifest);
      writeFileSync(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const retry = persistSpecificationPhaseResult(run.root, run.input);
      assert.equal(retry.ok, false, `${label} binding must fail closed`);
      if (!retry.ok) assert.equal(retry.code, "SPEC_PHASE_PERSIST_FAILED");
    } finally {
      setSpecificationPhaseFailureInjector(null);
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});


test("revision replay preserves exact archives while completing unwritten current documents", () => {
  const run = setup();
  const v1Documents = [
    { path: "spec.md", content: "# Specification v1\n" },
    { path: "notes/design.md", content: "# Design v1\n" },
  ];
  const v2Documents = [
    { path: "spec.md", content: "# Specification v2\n" },
    { path: "notes/design.md", content: "# Design v2\n" },
  ];
  const validateBeforeWrite = () => {};
  const request = (version: number, documents: Array<{ path: string; content: string }>) => ({
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: "specify" as const,
    version,
    documents,
  });
  try {
    const first = materializeFeatureDocuments(run.root, request(1, v1Documents), { validateBeforeWrite });
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    assert.throws(() => materializeFeatureDocuments(run.root, request(2, v2Documents), {
      validateBeforeWrite,
      afterDocumentWrite: (index) => {
        if (index === 0) throw new Error("injected revision boundary");
      },
    }), /injected revision boundary/);
    const archivedSpecPath = join(run.root, "specs", FEATURE_ID, "history", "specify", "v1", "spec.md");
    const archivedDesignPath = join(run.root, "specs", FEATURE_ID, "history", "specify", "v1", "notes", "design.md");
    const legacyFlatArchivePath = join(run.root, "specs", FEATURE_ID, "history", "specify", "v1.md");
    assert.equal(existsSync(archivedSpecPath), false, "failed replay must restore the missing spec archive");
    assert.equal(existsSync(archivedDesignPath), false, "failed replay must restore the missing design archive");
    assert.equal(existsSync(legacyFlatArchivePath), false, "multi-document history must not create a flat legacy archive");
    const retry = materializeFeatureDocuments(run.root, request(2, v2Documents), { replay: true, validateBeforeWrite });
    assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
    assert.equal(readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8"), v2Documents[0]!.content);
    assert.equal(readFileSync(join(run.root, "specs", FEATURE_ID, "notes", "design.md"), "utf8"), v2Documents[1]!.content);
    assert.equal(readFileSync(archivedSpecPath, "utf8"), v1Documents[0]!.content);
    assert.equal(readFileSync(archivedDesignPath, "utf8"), v1Documents[1]!.content);
    assert.equal(existsSync(legacyFlatArchivePath), false, "multi-document history must not create a flat legacy archive");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});


test("transaction snapshots keep explicit feature selectors branch-neutral while legacy targets stay stale", () => {
  const run = setup();
  try {
    const selected = updateStateAtomically<null>(
      run.root,
      (snapshot) => {
        assert.equal(snapshot.target.isStale, false, "explicit feature selectors must not become stale on a branch mismatch");
        return { op: "discard", value: null };
      },
      { selector: { feature_id: FEATURE_ID, run_key: RUN_KEY }, branch: "different-active-branch" },
    );
    assert.equal(selected.ok, true);

    const legacy = updateStateAtomically<null>(
      run.root,
      (snapshot) => {
        assert.equal(snapshot.target.isStale, true, "selector-free workflows must retain branch stale detection");
        return { op: "discard", value: null };
      },
      { branch: "different-active-branch" },
    );
    assert.equal(legacy.ok, true);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
test("state lock recovery reclaims an old ownerless legacy lock but never steals a live owner", () => {
  const run = setup();
  const lockPath = join(run.root, ".work-state", ".state.lock");
  try {
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 1000);
    utimesSync(lockPath, old, old);
    const recovered = updateStateAtomically<null>(
      run.root,
      () => ({ op: "discard", value: null }),
      { selector: { feature_id: FEATURE_ID, run_key: RUN_KEY }, lockTimeoutMs: 500 },
    );
    assert.equal(recovered.ok, true, `old ownerless locks are safely reclaimed: ${JSON.stringify(recovered)}`);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live-owner", acquired_at: new Date().toISOString() }), { encoding: "utf8", flag: "w" });
    const held = updateStateAtomically<null>(
      run.root,
      () => ({ op: "discard", value: null }),
      { selector: { feature_id: FEATURE_ID, run_key: RUN_KEY }, lockTimeoutMs: 75 },
    );
    assert.equal(held.ok, false, "a live owner lock is never stolen");
    if (!held.ok) assert.equal(held.code, "state_lock_unavailable");
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
    rmSync(run.root, { recursive: true, force: true });
  }
});

interface PhaseDurabilityRun {
  root: string;
  input: SpecificationWorkerResultInput;
  artifactPath: string;
  manifestPath: string;
  journalPath: string;
}
function tamperNativePhaseArtifactConsistently(run: PhaseDurabilityRun): () => void {
  const artifactOriginal = readFileSync(run.artifactPath, "utf8");
  const manifestOriginal = readFileSync(run.manifestPath, "utf8");
  const primaryPath = "spec.md";
  const primaryFile = join(run.root, "specs", FEATURE_ID, primaryPath);
  const primaryOriginal = readFileSync(primaryFile, "utf8");
  const artifact = JSON.parse(artifactOriginal) as Record<string, any>;
  const source = artifact.source_artifact as Record<string, any>;
  const model = JSON.parse(JSON.stringify(source.semantic_model)) as Record<string, any>;
  model.sections = { ...model.sections, problem: `${model.sections.problem}\nA self-consistent tamper must still be rejected.` };
  const primaryContent = renderDurabilityDocument("specify", model as any);
  source.semantic_model = model;
  source.document_sha256 = sha256Hex(primaryContent);
  artifact.source_artifact = source;
  artifact.semantic_model = model;
  artifact.source_artifact_hash = digestOf(source);
  artifact.semantic_section_hashes = Object.fromEntries(
    Object.entries(model.sections).sort(([left], [right]) => left.localeCompare(right)).map(([marker, content]) => [marker, sha256Hex(String(content))]),
  );
  artifact.document_hashes = { ...artifact.document_hashes, [primaryPath]: sha256Hex(primaryContent) };
  const documents = (artifact.document_paths as string[])
    .map((path) => ({ path, content: path === primaryPath ? primaryContent : readFileSync(join(run.root, "specs", FEATURE_ID, path), "utf8") }))
    .sort((left, right) => left.path.localeCompare(right.path));
  artifact.request_digest = digestOf({
    feature_id: artifact.feature_id,
    run_key: artifact.run_key,
    phase: artifact.phase,
    version: artifact.version,
    request_id: artifact.request_id,
    dispatch_id: artifact.dispatch_id,
    source_artifact: artifact.source_artifact,
    documents,
    semantic_sections: model.sections,
    constitution_binding: artifact.constitution_binding,
    upstream_versions: artifact.upstream_versions,
    template_hash: artifact.template_hash,
    language_hash: artifact.language_hash,
  });
  writeFileSync(run.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  writeFileSync(primaryFile, primaryContent, "utf8");
  const manifest = JSON.parse(manifestOriginal) as Record<string, any>;
  const manifestDocuments = manifest.documents as Array<Record<string, any>>;
  const primaryManifest = manifestDocuments.find((document) => document.path === primaryPath);
  if (primaryManifest) primaryManifest.sha256 = sha256Hex(primaryContent);
  writeFileSync(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return () => {
    writeFileSync(run.artifactPath, artifactOriginal, "utf8");
    writeFileSync(run.manifestPath, manifestOriginal, "utf8");
    writeFileSync(primaryFile, primaryOriginal, "utf8");
  };
}

function materializeAndApproveNativePhases(run: PhaseDurabilityRun): ResolvedState {
  assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
  validateNativePhase(run, "specify", run.input);
  const plan = beginTestPhase(run, "plan");
  assert.equal(
    persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", plan.dispatch_id, plan.upstream, false, plan)).ok,
    true,
  );
  validateNativePhase(run, "plan", plan);
  const tasks = beginTestPhase(run, "tasks");
  assert.equal(
    persistSpecificationPhaseResult(run.root, phaseInputFor(run, "tasks", tasks.dispatch_id, tasks.upstream, false, tasks)).ok,
    true,
  );
  validateNativePhase(run, "tasks", tasks);
  const selected = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  assert.ok(selected.state?.specification);
  const workspace = selected.state!.specification!;
  const approvedWorkspace: FeatureWorkspace = {
    ...workspace,
    phases: workspace.phases.map((phase) => ({
      ...phase,
      status: "approved" as const,
      approved_version: phase.current_version,
      validation_ref: `validation.${phase.phase}.v${phase.current_version}`,
      checkpoint_ref: `checkpoint.${phase.phase}.v${phase.current_version}`,
    })),
  };
  writeState(run.root, { ...selected.state!, specification: approvedWorkspace }, { target: selected });
  return resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
}

test("native Specify → Plan → Tasks approvals finalize an immutable implementation handoff", () => {
  const run = setup();
  try {
    assert.equal(persistSpecificationPhaseResult(run.root, run.input).ok, true);
    validateNativePhase(run, "specify", run.input);
    const plan = beginTestPhase(run, "plan");
    assert.equal(
      persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", plan.dispatch_id, plan.upstream, false, plan)).ok,
      true,
    );
    validateNativePhase(run, "plan", plan);
    const tasks = beginTestPhase(run, "tasks");
    assert.equal(
      persistSpecificationPhaseResult(run.root, phaseInputFor(run, "tasks", tasks.dispatch_id, tasks.upstream, false, tasks)).ok,
      true,
    );

    validateNativePhase(run, "tasks", tasks);
    const selected = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.ok(selected.state?.specification);
    const specification = selected.state!.specification!;
    const approvedWorkspace: FeatureWorkspace = {
      ...specification,
      phases: specification.phases.map((phase) => ({
        ...phase,
        status: "approved" as const,
        approved_version: phase.current_version,
        validation_ref: `validation.${phase.phase}.v${phase.current_version}`,
        checkpoint_ref: `checkpoint.${phase.phase}.v${phase.current_version}`,
      })),
    };
    const approvedState = { ...selected.state!, specification: approvedWorkspace };
    writeState(run.root, approvedState, { target: selected });

    const target = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.ok(target.state);
    const pinnedRoot = PinnedProjectRoot.open(run.root);
    assert.ok(pinnedRoot);
    if (!pinnedRoot || !target.state) return;
    const finalized = finalizeNativeImplementationHandoffMutation(target.state, target, pinnedRoot, RUN_KEY);
    pinnedRoot.close();
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok || !finalized.state) return;
    writeState(run.root, finalized.state, { target });
    const preflight = resolveDoWorkSpecPreflight(run.root, { spec: FEATURE_ID, task: "implement TASK-1" });
    assert.equal(preflight.outcome, "ready", JSON.stringify(preflight));
    if (preflight.outcome === "ready") {
      assert.equal(preflight.handoff_id, finalized.handoff_ref);
      assert.equal(preflight.handoff_digest, finalized.handoff_digest);
    }
    assert.equal(finalized.status, "implementation_ready");
    assert.equal(finalized.next_action, `/do-work --spec ${FEATURE_ID}`);
    assert.equal(finalized.state.specification?.status, "implementation_ready");
    assert.equal(finalized.state.specification?.handoff_ref, finalized.handoff_ref);
    assert.match(finalized.handoff_digest, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff", `${finalized.handoff_ref}.json`)), true);
    assert.equal(existsSync(join(run.root, "specs", FEATURE_ID, "handoff.md")), true);

    const replayRoot = PinnedProjectRoot.open(run.root);
    assert.ok(replayRoot);
    if (!replayRoot) return;
    const replayTarget = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    const replay = finalizeNativeImplementationHandoffMutation(finalized.state, replayTarget, replayRoot, RUN_KEY);
    replayRoot.close();
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (replay.ok) {
      assert.equal(replay.replayed, true);

      assert.equal(replay.handoff_digest, finalized.handoff_digest);
      assert.deepEqual(replay.state?.specification, finalized.state.specification);
    }
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
test("native handoff finalizer rollback removes canonical artifact and readable projection", () => {
  const run = setup();
  const rollbackCleanups: Array<() => void> = [];
  let pinnedRoot: PinnedProjectRoot | undefined;
  try {
    const prepared = materializeAndApproveNativePhases(run);
    assert.ok(prepared.state);
    if (!prepared.state) return;
    const target = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.ok(target.state);
    pinnedRoot = PinnedProjectRoot.open(run.root) ?? undefined;
    assert.ok(pinnedRoot);
    if (!pinnedRoot || !target.state) return;
    const finalized = finalizeNativeImplementationHandoffMutation(
      target.state,
      target,
      pinnedRoot,
      RUN_KEY,
      (cleanup) => { rollbackCleanups.push(cleanup); },
    );
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) return;
    const canonicalPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff", `${finalized.handoff_ref}.json`);
    const projectionPath = join(run.root, "specs", FEATURE_ID, "handoff.md");
    assert.equal(existsSync(canonicalPath), true, "finalizer must publish the canonical handoff before the enclosing state CAS");
    assert.equal(existsSync(projectionPath), true, "finalizer must publish the readable handoff projection before the enclosing state CAS");
    for (const cleanup of rollbackCleanups.reverse()) cleanup();
    assert.equal(existsSync(canonicalPath), false, "aborted native handoff must remove its attempt-owned canonical artifact");
    assert.equal(existsSync(projectionPath), false, "aborted native handoff must remove its attempt-owned readable projection");
  } finally {
    pinnedRoot?.close();
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("tasks checkpoint rolls back canonical handoff when constitution drifts before the outer state CAS", async () => {
  const run = setup();
  try {
    const prepared = materializeAndApproveNativePhases(run);
    assert.ok(prepared.state?.specification);
    if (!prepared.state?.specification) return;
    const capability = createCapability({
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: nativeProfileHash(run),
      stage_cursor: "tasks",
      kind: "single",
      expected_roster: [{ role: nativeRoleForPhase("tasks"), agent: "specification-worker" }],
      dispatch_secret: "tasks-checkpoint-dispatch-secret",
      advance_secret: "tasks-checkpoint-advance-secret",
    });
    const openState: TeamState = {
      ...prepared.state,
      stage_cursor: "tasks",
      stages: prepared.state.stages.map((stage) => ({
        ...stage,
        status: stage.id === "tasks" ? "in_progress" as const : "done" as const,
      })),
      cursor_epoch: capability.state.issued_for!.cursor_epoch,
      dispatch_capability: { ...capability.state, status: "ready" },
      checkpoint_policy: nativeCheckpointPolicy("specification_phase_approval"),
      pause: { kind: "none", reason: "" },
      specification: {
        ...prepared.state.specification,
        status: "in_progress",
        handoff_ref: null,
        phases: prepared.state.specification.phases.map((phase) => phase.phase === "tasks"
          ? { ...phase, status: "awaiting_approval" as const, approved_version: null, checkpoint_ref: null }
          : phase),
        next_action: { kind: "checkpoint", command: null, reason: "The tasks validation passed; the hard-human checkpoint is open." },
      },
    };
    writeState(run.root, openState, { featureSlug: FEATURE_ID });
    const askInput = {
      feature_id: FEATURE_ID,
      advance_token: capability.advance_token,
      capability_id: capability.capability_id,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: nativeProfileHash(run),
      stage_cursor: "tasks",
      cursor_epoch: capability.state.issued_for!.cursor_epoch,
      checkpoint: "specification_phase_approval",
      checkpoint_id: "specification_phase_approval",
      checkpoint_kind: "specification_phase_approval",
    };
    const beforeDecisionState = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
    const statePath = join(run.root, ".work-state", "features", FEATURE_ID, "state.json");
    const statePreimage = readFileSync(statePath);
    const constitutionPath = join(run.root, "CONSTITUTION.md");
    const constitutionOriginal = readFileSync(constitutionPath, "utf8");
    const handoffDirectory = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff");
    const handoffDocument = join(run.root, "specs", FEATURE_ID, "handoff.md");
    let beforeCas = 0;
    try {
      setStateTransactionTestHooks({
        beforeCas: () => {
          beforeCas += 1;
          if (beforeCas === 1) writeFileSync(constitutionPath, constitutionOriginal + "\n## Drift injected after handoff writes\n", "utf8");
        },
      }, run.root);
      const rejected = await mountedSelectedAsk(run.root, askInput, "approve_continue");
      assert.equal(rejected.details.ok, false, rejected.details.ok ? "constitution drift must reject the checkpoint" : String(rejected.details.error));
      if (rejected.details.ok !== true) assert.match(String(rejected.details.error), /constitution|drift|stale/i);
    } finally {
      setStateTransactionTestHooks(null, run.root);
      writeFileSync(constitutionPath, constitutionOriginal, "utf8");
    }
    assert.equal(beforeCas, 1, "checkpoint drift regression must run at the outer state CAS");
    assert.deepEqual(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state, beforeDecisionState, "rejected checkpoint must preserve the pre-decision state and proof");
    assert.deepEqual(readFileSync(statePath), statePreimage, "rejected checkpoint must preserve state bytes");
    assert.equal(existsSync(handoffDocument), false, "rejected checkpoint must roll back the readable handoff");
    assert.deepEqual(existsSync(handoffDirectory) ? readdirSync(handoffDirectory) : [], [], "rejected checkpoint must leave no canonical handoff artifacts");
  } finally {
    setStateTransactionTestHooks(null, run.root);
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("native finalization rejects complete-manifest omissions, extras, paths, and bindings", () => {
  const run = setup();
  try {
    const prepared = materializeAndApproveNativePhases(run);
    assert.ok(prepared.state);
    if (!prepared.state) return;
    const beforeDigest = digestOf(prepared.state);
    const manifestOriginal = readFileSync(run.manifestPath, "utf8");
    const mutations: Array<[string, (manifest: Record<string, any>) => void]> = [
      ["omission", (manifest) => { manifest.documents = (manifest.documents as Array<Record<string, any>>).filter((document) => document.path !== "notes/design.md"); }],
      ["extra", (manifest) => { (manifest.documents as Array<Record<string, any>>).push({ path: "extra.md", sha256: sha256Hex("extra") }); }],
      ["path", (manifest) => {
        const documents = manifest.documents as Array<Record<string, any>>;
        const primary = documents.find((document) => document.path === "spec.md");
        if (primary) primary.path = "foreign.md";
      }],
      ["run binding", (manifest) => { (manifest.binding as Record<string, any>).run_key = "foreign-run"; }],
      ["worker binding", (manifest) => {
        const binding = manifest.binding as Record<string, any>;
        const worker = binding.worker as Record<string, any>;
        worker.work_identity = { ...(worker.work_identity as Record<string, any>), worker_id: "foreign-worker" };
      }],
    ];
    for (const [label, mutate] of mutations) {
      writeFileSync(run.manifestPath, manifestOriginal, "utf8");
      const manifest = JSON.parse(manifestOriginal) as Record<string, any>;
      mutate(manifest);
      writeFileSync(run.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const target = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.ok(target.state);
      if (!target.state) return;
      const pinnedRoot = PinnedProjectRoot.open(run.root);
      assert.ok(pinnedRoot);
      if (!pinnedRoot) return;
      const finalized = finalizeNativeImplementationHandoffMutation(target.state, target, pinnedRoot, RUN_KEY);
      pinnedRoot.close();
      assert.equal(finalized.ok, false, `${label} manifest tamper must fail closed`);
      if (!finalized.ok) assert.match(finalized.code, /^SPEC_HANDOFF|SPEC_PATH/);
      assert.equal(digestOf(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state), beforeDigest, `${label} rejection must not mutate workspace state`);
    }
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
test("rejected, stale, and revision-required Tasks never finalize a handoff", () => {
  for (const status of ["revision_required", "stale"] as const) {
    const run = setup();
    try {
      const prepared = materializeAndApproveNativePhases(run);
      assert.ok(prepared.state?.specification);
      const workspace = prepared.state!.specification!;
      const rejectedWorkspace: FeatureWorkspace = {
        ...workspace,
        handoff_ref: null,
        phases: workspace.phases.map((phase) => phase.phase === "tasks"
          ? {
              ...phase,
              status,
              approved_version: null,
              validation_ref: null,
              checkpoint_ref: null,
              stale_reason: status === "stale" ? "Specify or Plan changed after approval." : null,
              last_feedback: status === "revision_required" ? "Tasks need a safer failure path." : null,
            }
          : phase),
      };
      writeState(run.root, { ...prepared.state!, specification: rejectedWorkspace }, { target: prepared });
      const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      const pinnedRoot = PinnedProjectRoot.open(run.root);
      assert.ok(pinnedRoot);
      if (!pinnedRoot || !before.state) return;
      const result = finalizeNativeImplementationHandoffMutation(before.state, before, pinnedRoot, RUN_KEY);
      pinnedRoot.close();
      assert.equal(result.ok, false, `${status} Tasks must be rejected before handoff persistence`);
      assert.equal(existsSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff", "phase-durability.handoff.v1.json")), false);
      const after = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      assert.equal(after.state?.specification?.status, "in_progress");
      assert.equal(after.state?.specification?.handoff_ref, null);
      assert.equal(after.state?.specification?.phases.find((phase) => phase.phase === "tasks")?.status, status);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  }
});

test("mismatched native phase artifact blocks finalization without mutating workspace", () => {
  const run = setup();
  try {
    const prepared = materializeAndApproveNativePhases(run);
    assert.ok(prepared.state);
    const artifactPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    artifact.constitution_binding = { ...(artifact.constitution_binding as Record<string, unknown>), content_sha256: "f".repeat(64) };
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.ok(before.state);
    const beforeDigest = digestOf(before.state);
    const pinnedRoot = PinnedProjectRoot.open(run.root);
    assert.ok(pinnedRoot);
    if (!pinnedRoot || !before.state) return;
    const result = finalizeNativeImplementationHandoffMutation(before.state, before, pinnedRoot, RUN_KEY);
    pinnedRoot.close();
    assert.equal(result.ok, false, "a phase artifact with a mismatched constitution must fail closed");
    assert.equal(existsSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff", "phase-durability.handoff.v1.json")), false);
    const after = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(after.state?.specification?.status, "in_progress");
    assert.equal(after.state?.specification?.handoff_ref, null);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("native phase persistence returns an engine-complete map that completes the dispatch", async () => {
  const run = setup();
  try {
    alignNativeRuntimeProfile(run);
    let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const sessionManager = { getSessionId: () => "phase-durability-session", getCwd: () => run.root };
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
    registerTestWorkflowTools(run.root, {
      zod: { z: zod },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "session_start") sessionStart = handler; },
      registerTool(tool: unknown) {
        const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
        tools.set(mounted.name, mounted);
      },
    } as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd }, "phase-durability-gate");
    const persist = tools.get("workflow_persist_specification_phase");
    const complete = tools.get("workflow_complete");
    assert.ok(persist);
    assert.ok(complete);
    if (!persist || !complete) return;
    sessionStart?.({}, { mode: "rpc", hasUI: true, sessionManager, ui: { askDialog: async () => ({ kind: "submit", results: [] }) } });
    const persisted = await persist.execute("test", run.input, undefined, undefined, { cwd: run.root, sessionManager, hasUI: false });
    assert.equal(persisted.details.ok, true, JSON.stringify(persisted.details));
    const required = persisted.details.required_next_tool as { name: string; arguments: Record<string, unknown> } | undefined;
    assert.ok(required, "successful persistence must expose an engine-generated completion call");
    if (!required) return;
    assert.equal(required.name, "workflow_complete");
    assert.deepEqual(required.arguments.artifact_ids, ["specify_draft"]);
    assert.equal(required.arguments.outcome, "succeeded");
    assert.match(String(required.arguments.evidence), /specify\.v1.*specify_draft/u);
    assert.equal(required.arguments.token, run.input.token);
    assert.equal(required.arguments.capability_id, run.input.capability_id);
    assert.equal(required.arguments.dispatch_id, run.input.dispatch_id);
    assert.equal(required.arguments.stage_cursor, "specify");
    const completed = await complete.execute("test", required.arguments, undefined, undefined, { cwd: run.root, sessionManager, hasUI: false });
    assert.equal(completed.details.ok, true, JSON.stringify(completed.details));
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("native approve_stop resumes only through exact phase commands and rejects stale inputs", async () => {
  const run = setup();
  try {
    alignNativeRuntimeProfile(run);
    const persistedSpecify = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persistedSpecify.ok, true, persistedSpecify.ok ? "" : persistedSpecify.error);
    const specifyValidation = validateNativePhase(run, "specify", run.input);
    const specifyStop = await stopNativePhase(run, "specify", specifyValidation);
    const specifyAdvance = advanceStoppedPhase(run, "specify", specifyStop.advance_token);
    assert.equal(specifyAdvance.ok, true, specifyAdvance.ok ? "" : specifyAdvance.error);

    const specPath = join(run.root, "specs", FEATURE_ID, "spec.md");
    const originalSpec = readFileSync(specPath, "utf8");
    writeFileSync(specPath, originalSpec + "\nStale edit after approval.\n", "utf8");
    const stale = await specifyCommand({
      args: `--feature ${FEATURE_ID}`,
      cwd: run.root,
      ui: { notify: () => undefined },
    });
    assert.match(stale, /SPEC_STATE_INVALID|stale|changed|checkpoint|approval|spec-plan/i);
    writeFileSync(specPath, originalSpec, "utf8");

    const resumedSpecify = await specPlanCommand({
      args: `--feature ${FEATURE_ID}`,
      cwd: run.root,
      ui: { notify: () => undefined },
    });
    assert.match(resumedSpecify, /spec-plan|specify|Next action/i);
    let state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.equal(state.stage_cursor, "plan");
    assert.equal(state.stages.find((stage) => stage.id === "specify")?.status, "done");
    assert.equal(state.stages.find((stage) => stage.id === "plan")?.status, "pending");
    assert.equal(state.pause.kind, "none");

    const plan = beginTestPhase(run, "plan");
    assert.equal(
      persistSpecificationPhaseResult(run.root, phaseInputFor(run, "plan", plan.dispatch_id, plan.upstream, false, plan)).ok,
      true,
    );
    const planValidation = validateNativePhase(run, "plan", plan);
    const planStop = await stopNativePhase(run, "plan", planValidation);
    const planAdvance = advanceStoppedPhase(run, "plan", planStop.advance_token);
    assert.equal(planAdvance.ok, true, planAdvance.ok ? "" : planAdvance.error);

    const resumedPlan = await specTasksCommand({
      args: `--feature ${FEATURE_ID}`,
      cwd: run.root,
      ui: { notify: () => undefined },
    });
    assert.match(resumedPlan, /spec-tasks|spec-plan|Next action/i);
    state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.equal(state.stage_cursor, "tasks");
    assert.equal(state.stages.find((stage) => stage.id === "plan")?.status, "done");
    assert.equal(state.stages.find((stage) => stage.id === "tasks")?.status, "pending");
    assert.equal(state.pause.kind, "none");

    const tasks = beginTestPhase(run, "tasks");
    assert.equal(
      persistSpecificationPhaseResult(run.root, phaseInputFor(run, "tasks", tasks.dispatch_id, tasks.upstream, false, tasks)).ok,
      true,
    );
    const taskValidation = validateNativePhase(run, "tasks", tasks);
    const taskStop = await stopNativePhase(run, "tasks", taskValidation);
    const taskAdvance = advanceStoppedPhase(run, "tasks", taskStop.advance_token);
    assert.equal(taskAdvance.ok, true, taskAdvance.ok ? "" : taskAdvance.error);
    state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.equal(state.stage_cursor, "tasks");
    assert.equal(state.specification?.status, "implementation_ready");
    assert.equal(state.specification?.handoff_ref, `${FEATURE_ID}.handoff.v1`);
    assert.equal(state.pause.kind, "done");
    assert.equal(state.stages.find((stage) => stage.id === "tasks")?.status, "done");
    assert.equal(state.dispatch_capability, undefined);

    const passiveAdvance = advanceCursor(run.root, {
      feature_id: FEATURE_ID,
      token: taskStop.advance_token,
      capability_id: state.dispatch_capability?.capability_id ?? "",
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: nativeProfileHash(run),
      stage_cursor: "tasks",
      cursor_epoch: state.cursor_epoch,
      evidence: "passive advance after an explicit stop",
    });
    assert.equal(passiveAdvance.ok, false);
    if (!passiveAdvance.ok) assert.match(passiveAdvance.error, /capability invalidated|complete|unavailable|bounded|invalid/i);

    const tasksPath = join(run.root, "specs", FEATURE_ID, "tasks.md");
    const originalTasks = readFileSync(tasksPath, "utf8");
    writeFileSync(tasksPath, originalTasks + "\nStale task edit after approval.\n", "utf8");
    const staleTasks = await specTasksCommand({
      args: `--feature ${FEATURE_ID}`,
      cwd: run.root,
      ui: { notify: () => undefined },
    });
    assert.match(staleTasks, /SPEC_STATE_INVALID|stale|changed|do-work|implementation-ready/i);
    writeFileSync(tasksPath, originalTasks, "utf8");

    const resumedTasks = await specTasksCommand({
      args: `--feature ${FEATURE_ID}`,
      cwd: run.root,
      ui: { notify: () => undefined },
    });
    assert.match(resumedTasks, new RegExp(`/do-work --spec ${FEATURE_ID}`));
    state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.equal(state.specification?.status, "implementation_ready");
    assert.equal(state.specification?.handoff_ref, `${FEATURE_ID}.handoff.v1`);
    assert.equal(state.pause.kind, "done");
    assert.equal(state.stages.find((stage) => stage.id === "tasks")?.status, "done");
    assert.equal(state.dispatch_capability, undefined);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("mounted native checkpoint requires strict validation and invalidates stale ask subjects", async () => {
  const run = setup();
  try {
    alignNativeRuntimeProfile(run);
    const persistedSpecify = persistSpecificationPhaseResult(run.root, run.input);
    assert.equal(persistedSpecify.ok, true, persistedSpecify.ok ? "" : persistedSpecify.error);

    const armApproval = (): { token: string; advance_token: string; capability_id: string; cursor_epoch: string } => {
      const before = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
      const capability = createCapability({
        run_key: RUN_KEY,
        branch: BRANCH,
        workflow: "spec-preparation",
        profile_hash: nativeProfileHash(run),
        stage_cursor: "specify",
        kind: "single",
        expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }],
        dispatch_secret: "mounted-native-dispatch-secret",
        advance_secret: "mounted-native-advance-secret",
      });
      writeState(run.root, {
        ...before,
        stage_cursor: "specify",
        cursor_epoch: capability.state.issued_for!.cursor_epoch,
        dispatch_capability: { ...capability.state, status: "ready" },
        pause: { kind: "none", reason: "" },
      }, { featureSlug: FEATURE_ID });
      return {
        token: capability.dispatch_token,
        advance_token: capability.advance_token,
        capability_id: capability.capability_id,
        cursor_epoch: capability.state.issued_for!.cursor_epoch,
      };
    };

    let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const sessionManager = { getSessionId: () => "phase-durability-session", getCwd: () => run.root };
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
    registerTestWorkflowTools(run.root, {
      zod: { z: zod },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "session_start") sessionStart = handler; },
      registerTool(tool: unknown) {
        const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
        tools.set(mounted.name, mounted);
      },
    } as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd }, "phase-durability-gate");
    const ask = tools.get("workflow_checkpoint_ask_selected");
    const checkpoint = tools.get("workflow_checkpoint");
    assert.ok(ask);
    assert.ok(checkpoint);
    if (!ask || !checkpoint) return;

    const firstApproval = armApproval();
    const askInput = {
      feature_id: FEATURE_ID,
      advance_token: firstApproval.advance_token,
      capability_id: firstApproval.capability_id,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: nativeProfileHash(run),
      stage_cursor: "specify",
      cursor_epoch: firstApproval.cursor_epoch,
      checkpoint: "specification_phase_approval",
      checkpoint_id: "specification_phase_approval",
      checkpoint_kind: "specification_phase_approval",
      loop_iteration: 1,
    };
    let dialogInvoked = false;
    const host = {
      cwd: run.root,
      hasUI: true,
      sessionManager,
      ui: {
        askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
          dialogInvoked = true;
          return {
            kind: "submit" as const,
            results: [{
              id: questions[0]!.id,
              question: questions[0]!.question,
              options: questions[0]!.options.map((option) => option.label),
              multi: false,
              selectedOptions: ["approve_continue"],
            }],
          };
        },
      },
    };
    sessionStart?.({}, { mode: "rpc", hasUI: true, sessionManager, ui: host.ui });
    const premature = await ask.execute("premature", askInput, undefined, undefined, host);
    assert.equal(premature.details.ok, false, JSON.stringify(premature.details));
    assert.equal(dialogInvoked, false, "pre-validation Ask must not open a trusted UI");
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.typed_checkpoint_decisions?.length ?? 0, 0);

    const forgedCheckpointInput = {
      feature_id: FEATURE_ID,
      advance_token: firstApproval.advance_token,
      capability_id: firstApproval.capability_id,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation",
      profile_hash: nativeProfileHash(run),
      stage_cursor: "specify",
      cursor_epoch: firstApproval.cursor_epoch,
      checkpoint: "specification_phase_approval",
      checkpoint_id: "specification_phase_approval",
      checkpoint_kind: "specification_phase_approval",
      authorization: "human",
      actor_provenance: {
        kind: "user",
        ref: "terminal:forged-native-answer",
        proof: {
          answer_id: "forged-native-answer",
          nonce: "forged-native-nonce",
          channel: "terminal",
          reference: "terminal:forged-native-answer",
          binding: "forged-native-binding",
        },
      },
      decision: "approve_continue",
      rationale: "forged pre-validation answer",
    };
    const forgedBeforeValidation = await checkpoint.execute("forged-before", forgedCheckpointInput, undefined, undefined, host);
    assert.equal(forgedBeforeValidation.details.ok, false, JSON.stringify(forgedBeforeValidation.details));
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.typed_checkpoint_decisions?.length ?? 0, 0);

    const staleForgedAfterValidation = { ...forgedCheckpointInput };
    const validationCredentials = firstApproval;
    validateNativePhase(run, "specify", validationCredentials);
    const forgedAfterValidation = await checkpoint.execute("forged-after", staleForgedAfterValidation, undefined, undefined, host);
    assert.equal(forgedAfterValidation.details.ok, false, JSON.stringify(forgedAfterValidation.details));
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.typed_checkpoint_decisions?.length ?? 0, 0);

    const secondApproval = armApproval();
    const validated = JSON.parse(readFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "validation.specify.v1.json"), "utf8")) as Record<string, unknown>;
    const validationPath = join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "validation.specify.v1.json");
    const originalValidation = JSON.stringify(validated, null, 2) + "\n";
    const tamperedChecks = Array.isArray(validated.checks)
      ? validated.checks.map((check) => ({ ...(check as Record<string, unknown>), evidence: "tampered validation evidence" }))
      : [];
    dialogInvoked = false;
    writeFileSync(validationPath, JSON.stringify({ ...validated, checks: tamperedChecks }, null, 2) + "\n", "utf8");
    const preAskTamperedValidation = await ask.execute("pre-ask-validation-tamper", { ...askInput, advance_token: secondApproval.advance_token, capability_id: secondApproval.capability_id, cursor_epoch: secondApproval.cursor_epoch }, undefined, undefined, host);
    assert.equal(preAskTamperedValidation.details.ok, false, JSON.stringify(preAskTamperedValidation.details));
    assert.equal(dialogInvoked, false, "tampered validation must be rejected before opening the trusted UI");
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.typed_checkpoint_decisions?.length ?? 0, 0);
    writeFileSync(validationPath, originalValidation, "utf8");
    const restoreArtifact = tamperNativePhaseArtifactConsistently(run);
    dialogInvoked = false;
    const preAskTamperedArtifact = await ask.execute("pre-ask-artifact-tamper", { ...askInput, advance_token: secondApproval.advance_token, capability_id: secondApproval.capability_id, cursor_epoch: secondApproval.cursor_epoch }, undefined, undefined, host);
    assert.equal(preAskTamperedArtifact.details.ok, false, JSON.stringify(preAskTamperedArtifact.details));
    assert.equal(dialogInvoked, false, "self-consistent artifact tampering must be rejected before opening the trusted UI");
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.typed_checkpoint_decisions?.length ?? 0, 0);
    restoreArtifact();
    let mutateValidation = true;
    host.ui.askDialog = async (questions) => {
      dialogInvoked = true;
      if (mutateValidation) writeFileSync(validationPath, JSON.stringify({ ...validated, checks: tamperedChecks }, null, 2) + "\n", "utf8");
      return {
        kind: "submit" as const,
        results: [{
          id: questions[0]!.id,
          question: questions[0]!.question,
          options: questions[0]!.options.map((option) => option.label),
          multi: false,
          selectedOptions: ["approve_continue"],
        }],
      };
    };
    const staleAsk = await ask.execute("stale", { ...askInput, advance_token: secondApproval.advance_token, capability_id: secondApproval.capability_id, cursor_epoch: secondApproval.cursor_epoch }, undefined, undefined, host);
    assert.equal(staleAsk.details.ok, false, JSON.stringify(staleAsk.details));
    assert.match(String(staleAsk.details.error), /stale|validation|strict|current/i);
    assert.equal(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.typed_checkpoint_decisions?.length ?? 0, 0);
    writeFileSync(validationPath, originalValidation, "utf8");
    mutateValidation = false;
    const validAsk = await ask.execute("valid", { ...askInput, advance_token: secondApproval.advance_token, capability_id: secondApproval.capability_id, cursor_epoch: secondApproval.cursor_epoch }, undefined, undefined, host);
    assert.equal(validAsk.details.ok, true, JSON.stringify(validAsk.details));
    const persisted = validAsk.details.persisted_decision as {
      decision?: string;
      checkpoint_id?: string;
      artifact_id?: string;
      artifact_version?: number;
      validation_ref?: string;
      actor?: { kind?: string; proof?: { answer_id?: string } };
    };
    assert.equal(persisted.decision, "approve_continue");
    assert.equal(persisted.checkpoint_id, "specification_phase_approval");
    assert.equal(persisted.artifact_id, "specify.v1");
    assert.equal(persisted.artifact_version, 1);
    assert.equal(persisted.validation_ref, "validation.specify.v1");
    assert.equal(persisted.actor?.kind, "user");
    assert.ok(typeof persisted.actor?.proof?.answer_id === "string" && persisted.actor.proof.answer_id.length > 0);
    const state = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
    assert.deepEqual(state.pause, { kind: "none", reason: "" }, "selected Ask decision clears the open checkpoint pause");
    const decision = state.typed_checkpoint_decisions?.at(-1);
    assert.equal(state.typed_checkpoint_decisions?.length, 1, "atomic selected Ask persists exactly one typed decision");
    assert.equal(state.trusted_checkpoint_answers?.length, 1, "atomic selected Ask persists exactly one trusted answer");
    assert.equal(decision?.artifact_id, "specify.v1");
    assert.equal(decision?.artifact_version, 1);
    assert.equal(decision?.validation_ref, "validation.specify.v1");
    assert.match(decision?.subject_binding ?? "", /^[a-f0-9]{64}$/u, JSON.stringify({ decision, ask: validAsk.details }));
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
test("direct phase result bounds reject over-budget semantic sections before any write", () => {
  const run = setup();
  try {
    const stateDigest = () => digestOf(resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!);
    const before = stateDigest();
    assert.equal(existsSync(run.artifactPath), false);
    const maxKeyUnit = "я";
    const maxValueUnit = "я";
    const maxKey = maxKeyUnit.repeat(MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES / Buffer.byteLength(maxKeyUnit, "utf8"));
    const maxValue = maxValueUnit.repeat(MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES / Buffer.byteLength(maxValueUnit, "utf8"));
    assert.equal(Buffer.byteLength(maxKey, "utf8"), MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES);
    assert.equal(Buffer.byteLength(maxValue, "utf8"), MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES);
    const exact = persistSpecificationPhaseResult(run.root, {
      ...run.input,
      semantic_sections: { ...run.input.semantic_sections, [maxKey]: maxValue },
    });
    assert.equal(exact.ok, false);
    if (!exact.ok) assert.notEqual(exact.code, "SPEC_PHASE_REQUEST_INVALID", "exact semantic key/value bounds must pass request prevalidation");
    assert.equal(stateDigest(), before);
    assert.equal(existsSync(run.artifactPath), false);

    const overKey = persistSpecificationPhaseResult(run.root, {
      ...run.input,
      semantic_sections: { ...run.input.semantic_sections, [maxKeyUnit.repeat(MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES / Buffer.byteLength(maxKeyUnit, "utf8") + 1)]: "bounded" },
    });
    assert.equal(overKey.ok, false);
    if (!overKey.ok) assert.equal(overKey.code, "SPEC_PHASE_REQUEST_INVALID");
    assert.equal(stateDigest(), before);
    assert.equal(existsSync(run.artifactPath), false);

    const overValue = persistSpecificationPhaseResult(run.root, {
      ...run.input,
      semantic_sections: { ...run.input.semantic_sections, bounded: maxValueUnit.repeat(MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES / Buffer.byteLength(maxValueUnit, "utf8") + 1) },
    });
    assert.equal(overValue.ok, false);
    if (!overValue.ok) assert.equal(overValue.code, "SPEC_PHASE_REQUEST_INVALID");
    assert.equal(stateDigest(), before);
    assert.equal(existsSync(run.artifactPath), false);

    const belowAggregate = Object.fromEntries(Array.from({ length: 39 }, (_, index) => [`section-${index}`, "s".repeat(25_000)]));
    const withinAggregate = persistSpecificationPhaseResult(run.root, { ...run.input, semantic_sections: belowAggregate });
    assert.equal(withinAggregate.ok, false);
    if (!withinAggregate.ok) assert.notEqual(withinAggregate.code, "SPEC_PHASE_REQUEST_INVALID", "semantic section aggregate below the cap must pass request prevalidation");
    assert.equal(Object.entries(belowAggregate).reduce((total, [key, value]) => total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"), 0) < MAX_PHASE_SEMANTIC_SECTIONS_AGGREGATE_BYTES, true);
    assert.equal(stateDigest(), before);
    assert.equal(existsSync(run.artifactPath), false);

    const overAggregate = Object.fromEntries(Array.from({ length: 43 }, (_, index) => [`section-${index}`, "s".repeat(25_000)]));
    const aggregateOverflow = persistSpecificationPhaseResult(run.root, { ...run.input, semantic_sections: overAggregate });
    assert.equal(aggregateOverflow.ok, false);
    if (!aggregateOverflow.ok) assert.equal(aggregateOverflow.code, "SPEC_PHASE_REQUEST_INVALID");
    assert.equal(stateDigest(), before);
    assert.equal(existsSync(run.artifactPath), false);

    const oversizedDocuments = Array.from({ length: Math.ceil((MAX_PHASE_RESULT_BYTES + 1) / MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES) }, (_, index) => ({
      path: `oversized/${index}.md`,
      content: "d".repeat(MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES),
    }));
    const resultOverflow = persistSpecificationPhaseResult(run.root, { ...run.input, documents: oversizedDocuments });
    assert.equal(resultOverflow.ok, false);
    if (!resultOverflow.ok) assert.equal(resultOverflow.code, "SPEC_PHASE_REQUEST_INVALID");
    assert.equal(stateDigest(), before);
    assert.equal(existsSync(run.artifactPath), false);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("T075-sized native finalizer payload survives documents-aware clone bounds", () => {
  const run = setup();
  try {
    const model = structuredClone(run.input.source_artifact.semantic_model) as SpecificationSemanticModel;
    const sections = model.sections as Record<string, string>;
    for (const key of Object.keys(sections)) sections[key] = "T075-sized readable section " + key + ": " + "x".repeat(1_900);
    const content = renderDurabilityDocument("specify", model);
    const contentBytes = Buffer.byteLength(content, "utf8");
    assert.ok(contentBytes > 39_000 && contentBytes < 50_000, `fixture must match the T075 readable payload size, got ${contentBytes}`);
    assert.ok(contentBytes > MAX_PHASE_STRING_BYTES, "the regression must exceed the scalar 32 KiB bound");
    const input: SpecificationWorkerResultInput = {
      ...run.input,
      source_artifact: { ...run.input.source_artifact, semantic_model: model, document_sha256: sha256Hex(content) },
      documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content } : document),
      semantic_sections: model.sections,
    };
    const persisted = persistSpecificationPhaseResult(run.root, input);
    assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
    assert.equal(readFileSync(join(run.root, "specs", FEATURE_ID, "spec.md"), "utf8"), content);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("canonical readable phase bytes are bounded at the producer and reader boundary", () => {
  const buildInput = (run: PhaseDurabilityRun, oversized: boolean): { input: SpecificationWorkerResultInput; content: string } => {
    const model = structuredClone(run.input.source_artifact.semantic_model) as SpecificationSemanticModel;
    const rowFor = (index: number, statement: string): PhaseSemanticRequirement => ({
      requirement_id: `REQ-${index + 1}`,
      statement,
      acceptance_ids: [`AC-${index + 1}`],
      source_refs: [`spec.md#requirements-${index + 1}`],
      testable: true,
      untestable_reason: null,
    });
    const allRequirements = Array.from(
      { length: 4_096 },
      (_, index) => rowFor(index, `Requirement ${index + 1} ✓${"x".repeat(256)}`),
    );
    let firstOversizedCount = 0;
    let low = 1;
    let high = allRequirements.length;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      model.requirements = allRequirements.slice(0, middle);
      const content = renderDurabilityDocument("specify", model);
      if (Buffer.byteLength(content, "utf8") > MAX_PHASE_INPUT_BYTES) {
        firstOversizedCount = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    assert.ok(firstOversizedCount > 0, "fixture must be able to exceed the canonical document byte limit");
    const requirements = allRequirements.slice(0, firstOversizedCount);
    const minimalRow = requirements.at(-1);
    assert.ok(minimalRow);
    if (!minimalRow) throw new Error("canonical phase fixture did not cross the byte limit");
    model.requirements = requirements.slice(0, -1);
    const below = renderDurabilityDocument("specify", model);
    minimalRow.statement = `Requirement ${firstOversizedCount} ✓`;
    model.requirements = requirements;
    const baseline = renderDurabilityDocument("specify", model);
    const minimalStatementBytes = Buffer.byteLength(minimalRow.statement, "utf8");
    const rowOverheadBytes = Buffer.byteLength(baseline, "utf8") - Buffer.byteLength(below, "utf8") - minimalStatementBytes;
    const desiredStatementBytes = MAX_PHASE_INPUT_BYTES - Buffer.byteLength(below, "utf8") - rowOverheadBytes;
    assert.ok(desiredStatementBytes >= minimalStatementBytes, "fixture must leave room for a valid multibyte statement");
    assert.ok(desiredStatementBytes <= 32_768, "fixture statement must remain within the existing field bound");
    minimalRow.statement += "x".repeat(desiredStatementBytes - minimalStatementBytes);
    const exactContent = renderDurabilityDocument("specify", model);
    assert.equal(Buffer.byteLength(exactContent, "utf8"), MAX_PHASE_INPUT_BYTES);
    if (oversized) minimalRow.statement += "x";
    const content = renderDurabilityDocument("specify", model);
    const input: SpecificationWorkerResultInput = {
      ...run.input,
      source_artifact: { ...run.input.source_artifact, semantic_model: model, document_sha256: sha256Hex(content) },
      documents: run.input.documents.map((document) => document.path === "spec.md" ? { ...document, content } : document),
      semantic_sections: Object.fromEntries(Object.entries(model.sections)),
    };
    return { input, content };
  };

  const exactRun = setup();
  try {
    const exact = buildInput(exactRun, false);
    assert.equal(Buffer.byteLength(exact.content, "utf8"), MAX_PHASE_INPUT_BYTES);
    const rejectedAtInputBoundary = persistSpecificationPhaseResult(exactRun.root, exact.input);
    assert.equal(rejectedAtInputBoundary.ok, false);
    if (!rejectedAtInputBoundary.ok) assert.notEqual(rejectedAtInputBoundary.code, "SPEC_PHASE_REQUEST_INVALID", "an exact MAX_PHASE_INPUT_BYTES document passes request prevalidation");
    assert.equal(existsSync(exactRun.artifactPath), false);
  } finally {
    rmSync(exactRun.root, { recursive: true, force: true });
  }

  const oversizedRun = setup();
  try {
    const oversized = buildInput(oversizedRun, true);
    assert.equal(Buffer.byteLength(oversized.content, "utf8"), MAX_PHASE_INPUT_BYTES + 1);
    const statePath = join(oversizedRun.root, ".work-state", "features", FEATURE_ID, "state.json");
    const artifactDirectory = join(oversizedRun.root, ".work-state", "features", FEATURE_ID, "artifacts");
    const documentsDirectory = join(oversizedRun.root, "specs", FEATURE_ID);
    const beforeState = readFileSync(statePath);
    const beforeArtifacts = readdirSync(artifactDirectory).sort();
    const beforeDocuments = readdirSync(documentsDirectory).sort();
    const rejected = persistSpecificationPhaseResult(oversizedRun.root, oversized.input);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_PHASE_REQUEST_INVALID");
    assert.deepEqual(readFileSync(statePath), beforeState, "oversized canonical input must not update workflow state");
    assert.deepEqual(readdirSync(artifactDirectory).sort(), beforeArtifacts, "oversized canonical input must not publish artifacts or journals");
    assert.deepEqual(readdirSync(documentsDirectory).sort(), beforeDocuments, "oversized canonical input must not publish readable files");
    assert.equal(existsSync(oversizedRun.artifactPath), false);
    assert.equal(existsSync(oversizedRun.manifestPath), false);
  } finally {
    rmSync(oversizedRun.root, { recursive: true, force: true });
  }
});



function nativeRecoveryFixture(): { run: ReturnType<typeof setup>; advanceToken: string } {
  const run = setup();
  alignNativeRuntimeProfile(run);
  const persisted = persistSpecificationPhaseResult(run.root, run.input);
  assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
  writeFileSync(join(run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify_draft.json"), JSON.stringify(run.input.source_artifact.semantic_model, null, 2) + "\n", "utf8");
  const generation = completeDispatch(run.root, {
    ...run.input,
    stage_cursor: "specify",
    role: "specification-analyst",
    agent: "specification-worker",
    dispatch_id: run.input.dispatch_id,
    outcome: "succeeded",
    evidence: "native generation committed for specify.v1",
    artifact_ids: ["specify_draft"],
  });
  assert.equal(generation.ok, true, generation.ok ? "" : generation.error);
  const validationDispatchResult = validationDispatchForPhase(run, "specify", {
    token: run.input.token,
    capability_id: run.input.capability_id,
    cursor_epoch: run.input.cursor_epoch,
  });
  const validation = persistSpecificationPhaseValidation(run.root, {
    token: validationDispatchResult.token,
    capability_id: validationDispatchResult.capability_id,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: nativeProfileHash(run),
    phase: "specify",
    request_id: validationDispatchResult.request_id,
    cursor_epoch: validationDispatchResult.cursor_epoch,
    dispatch_id: validationDispatchResult.dispatch_id,
    validation: validationPayloadForNativePhase(run, "specify"),
  });
  assert.equal(validation.ok, true, validation.ok ? "" : validation.error);
  const postValidation = resolveState(run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
  assert.ok(postValidation?.preparation_start, "native recovery fixture must retain its composite marker");
  if (postValidation?.preparation_start) {
    writeState(run.root, {
      ...postValidation,
      preparation_start: {
        ...postValidation.preparation_start,
        start_postimage_digest: preparationStartPostimageDigest(postValidation),
      },
    }, { featureSlug: FEATURE_ID });
  }
  return { run, advanceToken: validationDispatchResult.advance_token };
}

test("native checkpoint reissue replays the authenticated composite and fails closed on forged markers", () => {
  const fixture = nativeRecoveryFixture();
  try {
    const current = resolveState(fixture.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
    assert.ok(current?.dispatch_capability, "native recovery capability must be available for reissue");
    if (!current?.dispatch_capability) throw new Error("native recovery capability missing before reissue");
    const input = {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      branch: BRANCH,
      workflow: "spec-preparation" as const,
      profile_hash: nativeProfileHash(fixture.run),
      phase: "specify" as const,
      version: 1,
      capability_id: current.dispatch_capability.capability_id,
      generation_dispatch_id: fixture.run.input.dispatch_id,
    };
    const first = reissueNativeSpecificationCheckpointCapability(fixture.run.root, input);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    const replay = reissueNativeSpecificationCheckpointCapability(fixture.run.root, input);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);

    const scenarios = [
      { name: "marker token", mutate: (state: any) => ({ ...state, preparation_start: { ...state.preparation_start, token: "forged-marker-token" } }) },
      { name: "marker request", mutate: (state: any) => ({ ...state, preparation_start: { ...state.preparation_start, request_id: "forged-request" } }) },
      { name: "marker postimage", mutate: (state: any) => ({ ...state, preparation_start: { ...state.preparation_start, start_postimage_digest: "0".repeat(64) } }) },
      { name: "missing generation dispatch", generation_dispatch_id: "missing-generation-dispatch", mutate: (state: any) => state },
      { name: "wrong generation dispatch", generation_dispatch_id: "wrong-generation-dispatch", mutate: (state: any) => state },
    ];
    for (const scenario of scenarios) {
      const isolated = nativeRecoveryFixture();
      try {
        const beforeState = resolveState(isolated.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
        assert.ok(beforeState?.preparation_start, `${scenario.name} fixture must have a composite marker`);
        const statePath = join(isolated.run.root, ".work-state", "features", FEATURE_ID, "state.json");
        writeState(isolated.run.root, scenario.mutate(beforeState), { featureSlug: FEATURE_ID });
        const beforeAttempt = readFileSync(statePath);
        const rejected = reissueNativeSpecificationCheckpointCapability(isolated.run.root, {
          ...input,
          capability_id: resolveState(isolated.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state?.dispatch_capability?.capability_id ?? "",
          generation_dispatch_id: scenario.generation_dispatch_id ?? isolated.run.input.dispatch_id,
        });
        assert.equal(rejected.ok, false, `${scenario.name} forgery must be rejected`);
        if (!rejected.ok) {
          assert.equal(rejected.code, "NATIVE_COMPOSITE_REQUIRED");
          assert.match(rejected.error, /NATIVE_COMPOSITE_REQUIRED/);
        }
        assert.deepEqual(readFileSync(statePath), beforeAttempt, `${scenario.name} rejection must not mutate state`);
      } finally {
        rmSync(isolated.run.root, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(fixture.run.root, { recursive: true, force: true });
  }
});

function nativeRecoveryAdvance(fixture: ReturnType<typeof nativeRecoveryFixture>): ReturnType<typeof advanceCursor> {
  const current = resolveState(fixture.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
  assert.ok(current?.dispatch_capability, "validator capability must remain available for advance");
  if (!current?.dispatch_capability) throw new Error("validator capability missing after native validation");
  const trustedMappingProof = issueCurrentTrustedMappingProof(fixture.run.root);
  return advanceCursor(fixture.run.root, {
    feature_id: FEATURE_ID,
    token: fixture.advanceToken,
    capability_id: current.dispatch_capability.capability_id,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: nativeProfileHash(fixture.run),
    stage_cursor: "specify",
    cursor_epoch: current.dispatch_capability.issued_for!.cursor_epoch,
    evidence: "canonical validator postimage was recovered",
  }, trustedMappingProof === undefined ? {} : { trustedMappingProof });
}

test("native advance recovers an empty validator completion only from the current canonical phase", () => {
  const fixture = nativeRecoveryFixture();
  try {
    const current = resolveState(fixture.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
    assert.equal(current?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "awaiting_approval");
    const validator = current?.dispatch_capability?.dispatches.find((record) => record.purpose === "validation");
    assert.ok(validator?.completion?.artifact_ids.length === 0);
    const advanced = nativeRecoveryAdvance(fixture);
    assert.equal(advanced.ok, false, "the unresolved checkpoint should be the only remaining advance blocker");
    if (!advanced.ok) assert.match(advanced.error, /checkpoint|consent|decision/i);
    if (!advanced.ok) assert.doesNotMatch(advanced.error, /missing.*stage\.produces|stage\.produces.*artifact/i);
  } finally {
    rmSync(fixture.run.root, { recursive: true, force: true });
  }
});



test("atomic selected Ask decisions advance a native phase exactly once", async () => {
  const decisions = [
    ["approve_continue", "approved", undefined] as const,
    ["approve_stop", "approved", "stopped"] as const,
    ["request_changes", "revision_required", "revision_required"] as const,
  ];
  for (const [decision, expectedStatus, expectedTransition] of decisions) {
    const fixture = nativeRecoveryFixture();
    try {
      const current = resolveState(fixture.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
      assert.ok(current?.dispatch_capability, "validator capability must remain available for Ask");
      if (!current?.dispatch_capability) throw new Error("validator capability missing before selected Ask");
      const askInput = {
        feature_id: FEATURE_ID,
        advance_token: fixture.advanceToken,
        capability_id: current.dispatch_capability.capability_id,
        run_key: RUN_KEY,
        branch: BRANCH,
        workflow: "spec-preparation",
        profile_hash: nativeProfileHash(fixture.run),
        stage_cursor: "specify",
        cursor_epoch: current.dispatch_capability.issued_for!.cursor_epoch,
        checkpoint: "specification_phase_approval",
        checkpoint_id: "specification_phase_approval",
        checkpoint_kind: "specification_phase_approval",
        loop_iteration: 1,
      };
      const preflight = validateCheckpointAskSelected(fixture.run.root, askInput);
      assert.equal(preflight.ok, true, preflight.ok ? "" : preflight.error);
      if (!preflight.ok) continue;
      const committed = await mountedSelectedAsk(fixture.run.root, askInput, decision, decision === "request_changes" ? "Revise the canonical phase evidence." : undefined);
      assert.equal(committed.details.ok, true, committed.details.ok ? "" : String(committed.details.error));
      if (committed.details.ok !== true) continue;
      const projected = resolveState(fixture.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state;
      const projectedPhase = projected?.specification?.phases.find((phase) => phase.phase === "specify");
      assert.equal(projectedPhase?.status, expectedStatus);
      if (decision === "request_changes") assert.equal(projectedPhase?.last_feedback, "Revise the canonical phase evidence.");
      const advanced = nativeRecoveryAdvance(fixture);
      assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.error);
      if (advanced.ok && expectedTransition !== undefined) assert.equal(advanced.transition, expectedTransition);
    } finally {
      rmSync(fixture.run.root, { recursive: true, force: true });
    }
  }
});

test("native empty validator recovery fails closed for stale sources and empty generation", () => {
  const scenarios = ["missing_artifact", "stale_validation", "cross_feature_artifact", "cross_feature_validation", "generation_empty"] as const;
  for (const scenario of scenarios) {
    const fixture = nativeRecoveryFixture();
    try {
      const artifactPath = join(fixture.run.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json");
      const validationPath = join(fixture.run.root, ".work-state", "features", FEATURE_ID, "artifacts", "validation.specify.v1.json");
      if (scenario === "missing_artifact") {
        unlinkSync(artifactPath);
      } else if (scenario === "stale_validation") {
        const validation = JSON.parse(readFileSync(validationPath, "utf8")) as Record<string, unknown>;
        validation.status = "fail";
        writeFileSync(validationPath, JSON.stringify(validation, null, 2) + "\n", "utf8");
      } else if (scenario === "cross_feature_artifact") {
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
        artifact.feature_id = "foreign-feature";
        writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
      } else if (scenario === "cross_feature_validation") {
        const validation = JSON.parse(readFileSync(validationPath, "utf8")) as Record<string, unknown>;
        validation.artifact_version = "foreign.v1";
        writeFileSync(validationPath, JSON.stringify(validation, null, 2) + "\n", "utf8");
      } else {
        const current = resolveState(fixture.run.root, BRANCH, { feature_id: FEATURE_ID, run_key: RUN_KEY }).state!;
        const capability = current.dispatch_capability!;
        writeState(fixture.run.root, {
          ...current,
          dispatch_capability: {
            ...capability,
            dispatches: capability.dispatches.map((record) => ({ ...record, purpose: "generation" as const })),
          },
        }, { featureSlug: FEATURE_ID });
      }
      const rejected = nativeRecoveryAdvance(fixture);
      assert.equal(rejected.ok, false, `${scenario} must reject advance`);
      if (!rejected.ok) assert.match(rejected.error, /missing.*stage\.produces|stage\.produces.*artifact/i);
    } finally {
      rmSync(fixture.run.root, { recursive: true, force: true });
    }
  }
});
