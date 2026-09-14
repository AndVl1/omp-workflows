import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { z as zod } from "zod";
import { registerTestConstitutionGate } from "./fixtures/registry-activation.js";
import { registerTestWorkflowTools } from "./fixtures/host-tool-activation.js";
import { validFeatureWorkspace } from "./fixtures/specification-fixtures.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { resolveSpecificationLanguage } from "../src/specification/language.js";
import { parseConstitutionPrincipleIdentities, renderCanonicalPhaseDocument } from "../src/specification/phase.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS, shippedSpecificationTemplateDir } from "../src/specification/templates.js";
import { sha256Hex } from "../src/specification/validation.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { createCapability } from "../src/engine/durable.js";
import { createPreparationHandoff, preparationStateDigest } from "../src/engine/preparation.js";
import { writeState } from "../src/engine/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { TeamState, WorkIdentity } from "../src/engine/types.js";
import type { FeatureWorkspace, SpecificationSemanticModel } from "../src/specification/types.js";
import type { SpecificationWorkerResultInput } from "../src/specification/phase.js";

type ToolResult = { details: Record<string, unknown> };
type TestTool = { execute: (...args: unknown[]) => Promise<ToolResult> };
type AdapterInput = SpecificationWorkerResultInput;

const FEATURE_ID = "public-phase-adapter";
const RUN_KEY = "public-phase-adapter-run";
const BRANCH = "public-phase-adapter-branch";

function setup(custom: boolean): { root: string; workspace: FeatureWorkspace; tool: (name: string) => TestTool; sessionManager: { getSessionId: () => string } } {
  const root = mkdtempSync(join(tmpdir(), "spec-phase-adapter-"));
  const canonicalRoot = realpathSync(root);
  const featureRoot = join(root, "specs", FEATURE_ID);
  mkdirSync(featureRoot, { recursive: true });
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  registerTestConstitutionGate(root, "public-phase-adapter-gate");
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "specification-analyst": "specification-worker" } }) + "\n", "utf8");
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
  const constitution = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: "specify" }, { feature_id: FEATURE_ID });
  assert.ok(constitution.ok && constitution.value.binding, constitution.ok ? "constitution binding must exist" : constitution.error);
  if (!constitution.ok || !constitution.value.binding) throw new Error("constitution binding unavailable");
  const profile = loadProfile("spec-preparation");
  assert.ok(profile, "shipped specification profile must exist");
  if (!profile) throw new Error("specification profile unavailable");
  const templates = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(templates.ok, true, templates.ok ? "" : templates.error);
  if (!templates.ok) throw new Error(templates.error);

  let templateSet = templates.value;
  if (custom) {
    const shippedDir = shippedSpecificationTemplateDir();
    const customDir = join(root, "custom-templates");
    mkdirSync(customDir, { recursive: true });
    const paths: Record<string, string> = {};
    const contents: Record<string, string> = {};
    for (const templateId of SHIPPED_SPECIFICATION_TEMPLATE_IDS) {
      const relativePath = `custom-templates/${templateId}.md`;
      const content = readFileSync(join(shippedDir, `${templateId}.md`), "utf8") + (templateId === "specify" ? "\nCustom selected presentation.\n" : "");
      writeFileSync(join(root, relativePath), content, "utf8");
      paths[templateId] = relativePath;
      contents[templateId] = content;
    }
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "specification.json"), JSON.stringify({ templates: paths }) + "\n", "utf8");
    const customSet = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS, project_defaults: contents });
    assert.equal(customSet.ok, true, customSet.ok ? "" : customSet.error);
    if (!customSet.ok) throw new Error(customSet.error);
    templateSet = customSet.value;
  }

  const base = validFeatureWorkspace({ featureId: FEATURE_ID, constitutionBinding: constitution.value.binding }) as unknown as FeatureWorkspace;
  const workspace: FeatureWorkspace = {
    ...base,
    schema_version: 2,
    project_root: canonicalRoot,
    project_root_identity: { canonical_path: canonicalRoot, dev: statSync(root).dev, ino: statSync(root).ino },
    profile_hash: profileHash(profile),
    language: resolveSpecificationLanguage({ requestLanguage: "en-US" }),
    template_set: templateSet.selection,
    phases: base.phases.map((phase) => phase.phase === "specify" ? { ...phase, status: "generating" as const, current_version: null, approved_version: null, validation_ref: null, checkpoint_ref: null } : phase),
    next_action: { kind: "none", command: null, reason: "Specify worker is active." },
  };
  const issued = createCapability({ run_key: RUN_KEY, branch: BRANCH, workflow: "spec-preparation", profile_hash: profileHash(profile), stage_cursor: "specify", kind: "single", expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }], dispatch_secret: "phase-adapter-dispatch-secret", advance_secret: "phase-adapter-advance-secret" });
  const state: TeamState = {
    schema: 1,
    branch: BRANCH,
    run_key: RUN_KEY,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: "public phase adapter regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "specify",
    stages: [{ id: "specify", status: "in_progress" }, { id: "plan", status: "pending" }, { id: "tasks", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    profile_hash: profileHash(profile),
    specification: workspace,
  };
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  if (!pinnedRoot) throw new Error("project root unavailable");
  const preparedState = { ...state, state_revision: 1 };
  const preparationHandoff = createPreparationHandoff({
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    task: preparedState.task,
    classification: preparedState.classification,
    state_revision: 1,
    state_digest: preparationStateDigest(preparedState, 1),
    root_identity: { canonical_path: canonicalRoot, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    source_kind: "native",
    constitution_binding: workspace.constitution_binding,
    constitution_gate_ref: workspace.constitution_gate_ref,
    capacity: 1,
    authentication: {
      source_kind: "native",
      constitution_binding: workspace.constitution_binding,
      constitution_gate_ref: workspace.constitution_gate_ref,
      capacity: 1,
      pinned_root: pinnedRoot,
    },
  });
  writeState(root, { ...preparedState, preparation_handoff: preparationHandoff }, { featureSlug: FEATURE_ID, pinnedRoot });
  const persistedPreparationState = JSON.parse(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8")) as TeamState;
  assert.equal(preparationHandoff.state_digest, preparationStateDigest(persistedPreparationState, 1), "adapter preparation handoff must bind the persisted state postimage");
  pinnedRoot.close();

  const registered = new Map<string, TestTool>();
  let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const sessionManager = { cwd: root, getSessionId: () => "public-phase-adapter-session", getCwd: () => root };
  registerTestWorkflowTools(root, {
    zod: { z: zod },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "session_start") sessionStart = handler; },
    registerTool(tool: unknown) {
      const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };
      registered.set(mounted.name, mounted);
    },
  } as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd }, "public-phase-adapter-gate");
  const tool = (name: string) => {
    const found = registered.get(name);
    assert.ok(found, `workflow tool ${name} is registered`);
    return found!;
  };
  sessionStart?.({}, { cwd: root, mode: "rpc", hasUI: true, sessionManager, ui: { askDialog: async () => ({ kind: "submit", results: [] }) } });
  return { root, workspace, tool, sessionManager };
}

async function prepare(custom: boolean): Promise<{ root: string; input: AdapterInput; tool: (name: string) => TestTool; context: Record<string, unknown>; document: string }> {
  const fixture = setup(custom);
  const context: Record<string, unknown> = { cwd: fixture.root, mode: "rpc", sessionManager: fixture.sessionManager, hasUI: true, ui: { askDialog: async () => ({ kind: "submit", results: [] }) } };
  const profile = loadProfile("spec-preparation");
  if (!profile) throw new Error("specification profile unavailable");
  const dispatchInput: Record<string, unknown> = {
    token: "phase-adapter-dispatch-secret",
    capability_id: undefined,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: profileHash(profile),
    stage_cursor: "specify",
    cursor_epoch: undefined,
    feature_id: FEATURE_ID,
    phase: "specify",
    request_id: "phase-adapter-request",
    role: "specification-analyst",
    slot_id: "specification-analyst",
    agent: "specification-worker",
  };
  const state = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8")) as TeamState;
  dispatchInput.capability_id = "direct-bypass-capability";
  dispatchInput.cursor_epoch = "direct-bypass-epoch";
  const direct = await fixture.tool("workflow_dispatch_specification_phase").execute("test", dispatchInput, undefined, undefined, context);
  assert.equal(direct.details.ok, false, "the low-level native dispatch must not bypass the composite preparation marker");
  assert.match(String(direct.details.error), /dispatch capability|composite preparation marker|preparation marker|preparation_handoff/iu);
  const preparationHandoff = state.preparation_handoff;
  assert.ok(preparationHandoff, "adapter fixture must persist the authenticated preparation handoff");
  if (!preparationHandoff) throw new Error("adapter preparation handoff unavailable");
  const started = await fixture.tool("workflow_start_native_specification_phase").execute("test", {
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    preparation_handoff: preparationHandoff,
  }, undefined, undefined, context);
  assert.equal(started.details.ok, true, JSON.stringify(started.details));
  const dispatch = started.details.handoff as { dispatch_id: string; work_identity: WorkIdentity };
  const workspace = fixture.workspace;
  const constitutionBinding = workspace.constitution_binding;
  assert.ok(constitutionBinding, "workspace constitution binding must exist");
  if (!constitutionBinding) throw new Error("workspace constitution binding unavailable");
  const model = {
    schema_version: 1,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: "specify" as const,
    version: 1,
    worker: { role: dispatch.work_identity.slot_id, agent: dispatch.work_identity.worker_id, dispatch_id: dispatch.dispatch_id },
    constitution_binding: constitutionBinding,
    upstream_versions: [],
    sections: {
      problem: "The public adapter must preserve exact readable worker documents.",
      scope: "Persist one selected-template phase document.",
      non_goals: "No generic renderer fallback for current artifacts.",
      actors: "A worker and the durable phase engine.",
      journeys: "A supplied custom document is persisted byte-exactly.",
      requirements: "REQ-1 is deterministic and observable.",
      edge_cases: "Tampered and stale bindings fail closed.",
      assumptions: "The project root remains pinned.",
      dependencies: "The workspace and template selection.",
      success_criteria: "The primary readable document hash is authenticated.",
    },
    requirements: [{ requirement_id: "REQ-1", statement: "REQ-1 is deterministic and observable.", acceptance_ids: ["AC-1"], source_refs: ["spec.md#requirements"], testable: true, untestable_reason: null }],
    decisions: [],
    tasks: [],
    verification: [{ verification_id: "VERIFY-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "public adapter regression" }],
    contradictions: [],
    constitution_principles: parseConstitutionPrincipleIdentities("# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n").map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable" as const, status: "pass" as const, evidence: "Ship tested work.", binding: constitutionBinding })),
  };
  const customConfigPath = join(fixture.root, ".omp", "specification.json");
  const configured = existsSync(customConfigPath)
    ? JSON.parse(readFileSync(customConfigPath, "utf8")) as { templates?: Record<string, string> }
    : { templates: {} };
  const selectedSet = resolveSpecificationTemplateSet({
    template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS,
    project_defaults: Object.fromEntries(Object.entries(configured.templates ?? {}).map(([id, templatePath]) => [id, readFileSync(join(fixture.root, templatePath), "utf8")])),
  });
  assert.equal(selectedSet.ok, true, selectedSet.ok ? "" : selectedSet.error);
  if (!selectedSet.ok) throw new Error(selectedSet.error);
  const selected = selectedSet.value.templates.find((candidate) => candidate.template_id === "specify");
  assert.ok(selected);
  if (!selected) throw new Error("specify template missing");
  const document = renderCanonicalPhaseDocument("specify", model as unknown as SpecificationSemanticModel, selected);
  const input = {
    token: "phase-adapter-dispatch-secret",
    capability_id: state.dispatch_capability?.capability_id,
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    branch: BRANCH,
    workflow: "spec-preparation",
    profile_hash: profileHash(profile),
    phase: "specify",
    request_id: "phase-adapter-request",
    cursor_epoch: state.cursor_epoch,
    dispatch_id: dispatch.dispatch_id,
    version: 1,
    source_artifact: { schema_version: 1, feature_id: FEATURE_ID, run_key: RUN_KEY, version: 1, worker: model.worker, constitution_binding: constitutionBinding, semantic_model: model, document_sha256: sha256Hex(document), upstream_versions: [] },
    documents: [{ path: "spec.md", content: document }],
    semantic_sections: model.sections,
    constitution_binding: constitutionBinding,
    upstream_versions: [],
    template_hash: workspace.template_set.content_hash,
    language_hash: workspace.language.selection_hash,
  };
  return { root: fixture.root, input, tool: fixture.tool, context, document };
}

test("public phase adapter preserves exact selected-template documents and bound hashes", async () => {
  const prepared = await prepare(true);
  try {
    const persisted = await prepared.tool("workflow_persist_specification_phase").execute("test", prepared.input, undefined, undefined, prepared.context);
    assert.equal(persisted.details.ok, true, JSON.stringify(persisted.details));
    const artifact = JSON.parse(readFileSync(join(prepared.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json"), "utf8")) as { source_artifact: { document_sha256: string } };
    const primaryReadableDocument = readFileSync(join(prepared.root, "specs", FEATURE_ID, "spec.md"), "utf8");
    assert.equal(artifact.source_artifact.document_sha256, sha256Hex(primaryReadableDocument));
    assert.equal(primaryReadableDocument, prepared.document);

    const tamperedHash = structuredClone(prepared.input);
    tamperedHash.source_artifact.document_sha256 = "0".repeat(64);
    const hashRejected = await prepared.tool("workflow_persist_specification_phase").execute("test", tamperedHash, undefined, undefined, prepared.context);
    assert.equal(hashRejected.details.ok, false, JSON.stringify(hashRejected.details));

    const tamperedDocument = structuredClone(prepared.input);
    tamperedDocument.documents[0]!.content += "\nTampered after worker output.\n";
    const documentRejected = await prepared.tool("workflow_persist_specification_phase").execute("test", tamperedDocument, undefined, undefined, prepared.context);
    assert.equal(documentRejected.details.ok, false, JSON.stringify(documentRejected.details));

    const staleSelection = structuredClone(prepared.input);
    staleSelection.template_hash = "f".repeat(64);
    const staleRejected = await prepared.tool("workflow_persist_specification_phase").execute("test", staleSelection, undefined, undefined, prepared.context);
    assert.equal(staleRejected.details.ok, false, JSON.stringify(staleRejected.details));
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
});


test("public phase adapter derives current shipped documents from the exact selection", async () => {
  const prepared = await prepare(false);
  try {
    const omitted = { ...prepared.input, documents: [], semantic_sections: {} };
    const persisted = await prepared.tool("workflow_persist_specification_phase").execute("test", omitted, undefined, undefined, prepared.context);
    assert.equal(persisted.details.ok, true, JSON.stringify(persisted.details));
    const primaryReadableDocument = readFileSync(join(prepared.root, "specs", FEATURE_ID, "spec.md"), "utf8");
    assert.equal(primaryReadableDocument, prepared.document);
    const artifact = JSON.parse(readFileSync(join(prepared.root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json"), "utf8")) as { source_artifact: { document_sha256: string } };
    assert.equal(artifact.source_artifact.document_sha256, sha256Hex(primaryReadableDocument));
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
});
