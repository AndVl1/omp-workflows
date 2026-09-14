import { test } from "node:test";
import { TEST_CONTEXT, TEST_ON } from "./fixtures/registrar-host.js";
import assert from "node:assert/strict";
import { existsSync as exists, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  bindFeatureWorkspaceToRoot,
  sha256,
  validFeatureWorkspace,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import { registerTestConstitutionTools } from "./fixtures/registry-activation.js";
import {
  parseConstitutionPrincipleIdentities,
  renderCanonicalPhaseDocument,
} from "../src/specification/phase.js";
import { materializeFeatureDocuments } from "../src/specification/materialize.js";
import { canonicalHandoffDigest } from "../src/specification/handoff.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { digestOf } from "../src/specification/validation.js";
import { resolveSpecificationLanguage } from "../src/specification/language.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS } from "../src/specification/templates.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { resolveState, writeState } from "../src/engine/state.js";
import { resolveFeatureWorkspace } from "../src/specification/workspace.js";
import type { ConstitutionBinding, ImplementationHandoff } from "../src/specification/types.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { acquireExecutionClaim, readCurrentExecutionClaim } from "../src/specification/claims.js";
import type { TeamState } from "../src/engine/types.js";
import { applyConstitutionImpactForFeature, assessConstitutionImpactForFeature, recordConstitutionImpactAnswer } from "../src/specification/constitution-impact-runtime.js";
const FEATURE_ID = "impact-runtime-feature";
const RUN_KEY = "impact-runtime-run";
const SECOND_FEATURE_ID = "impact-runtime-unaffected";
const SECOND_RUN_KEY = "impact-runtime-unaffected-run";
const ORIGIN = { origin_kind: "native_direct" as const, origin_run_key: RUN_KEY, origin_stage: "specify" as const };
const CONSTITUTION = "# Project Constitution\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
const IMPACT_LANGUAGE = resolveSpecificationLanguage({ requestLanguage: "en-US" });
const IMPACT_TEMPLATES = (() => {
  const resolved = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
})();
const IMPACT_SPECIFY_TEMPLATE = IMPACT_TEMPLATES.templates.find((template) => template.template_id === "specify");
assert.ok(IMPACT_SPECIFY_TEMPLATE, "missing shipped specify template");
if (!IMPACT_SPECIFY_TEMPLATE) throw new Error("missing shipped specify template");


type ImpactAskQuestion = { id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean };
function impactAskUi(decision?: string) {
  return {
    askDialog: async (questions: ImpactAskQuestion[]) => {
      if (decision === undefined) {
        return { kind: "cancel" as const, reason: "user_cancelled", results: [] };
      }
      const question = questions[0]!;
      return {
        kind: "submit" as const,
        results: [{
          id: question.id,
          question: question.question,
          header: question.header,
          options: question.options.map((option) => option.label),
          selectedOptions: [decision],
          multi: false,
        }],
      };
    },
  };
}

function project(): string {
  return mkdtempSync(join(tmpdir(), "constitution-impact-runtime-"));
}

function stateFor(root: string, featureId: string, runKey: string, binding: ConstitutionBinding): TeamState {
  const existing = resolveState(root, undefined, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const state = existing.state
    ? structuredClone(existing.state) as TeamState
    : {
      schema: 1,
      branch: "impact-runtime",
      run_key: RUN_KEY,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
      task: "constitution impact runtime test",
      workflow_override: false,
      checkpoint_policy: {
        default: "required_human",
        scope: "decision",
        hard_human: ["constitution_approval"],
        rules: {},
        source: "profile",
        policy_version: 1,
        rationale: "mounted constitution impact runtime test",
      },
      issue: null,
      stage_cursor: "specify",
      stages: [],
      artifacts: {},
      pause: { kind: "none", reason: "" },
      profile_hash: "",
      cursor_epoch: 0,
      specification: null,
      updated_at: new Date().toISOString(),
    } as TeamState;
  state.run_key = runKey;
  const workspace = validFeatureWorkspace({
    featureId,
    projectRoot: root,
    constitutionBinding: binding,
    withApprovedSpecify: true,
  });
  workspace.language = IMPACT_LANGUAGE;
  workspace.template_set = IMPACT_TEMPLATES.selection;
  state.specification = bindFeatureWorkspaceToRoot(workspace, root) as TeamState["specification"];
  state.specification.constitution_gate_ref = "constitution.gate.v1";
  return state;
}

function mount(root: string): Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }> {
  const tools = new Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>();
  registerTestConstitutionTools(root, {
    zod: z,
    on: TEST_ON,
    registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ details: unknown }> }) {
      tools.set(tool.name, tool);
    },
  } as never);
  return tools;
}

function artifact(
  root: string,
  featureId: string,
  runKey: string,
  binding: ConstitutionBinding,
): void {
  const directory = join(root, ".work-state", "features", featureId, "artifacts");
  const documentDirectory = join(root, "specs", featureId);
  mkdirSync(directory, { recursive: true });
  mkdirSync(documentDirectory, { recursive: true });
  const sections = {
    problem: "The constitution impact path must read canonical phase artifacts.",
    scope: "Assess one approved Specify artifact without trusting caller JSON.",
    non_goals: "No unrelated workflow state changes.",
    actors: "The worker and the engine-owned impact evaluator.",
    journeys: "A canonical artifact is validated before impact assessment.",
    requirements: "REQ-1 is deterministic and tamper-evident.",
    edge_cases: "Unknown artifact fields and digest changes are rejected.",
    assumptions: "The project root remains pinned.",
    dependencies: "The canonical phase envelope validator.",
    success_criteria: "Only a valid canonical artifact reaches the approval gate.",
  };
  const principles = parseConstitutionPrincipleIdentities(CONSTITUTION);
  const semanticModel = {
    schema_version: 1,
    feature_id: featureId,
    run_key: runKey,
    phase: "specify" as const,
    version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "impact-dispatch" },
    constitution_binding: binding,
    upstream_versions: [],
    sections,
    requirements: [{
      requirement_id: "REQ-1",
      statement: sections.requirements,
      acceptance_ids: ["AC-1"],
      source_refs: ["spec.md#requirements"],
      testable: true,
      untestable_reason: null,
    }],
    decisions: [],
    tasks: [],
    verification: [{
      verification_id: "VERIFY-1",
      requirement_ids: ["REQ-1"],
      acceptance_ids: ["AC-1"],
      task_ids: [],
      observable_behavior: true,
      expected_evidence: "focused impact runtime test",
    }],
    contradictions: [],
    constitution_principles: principles.map((principle) => ({
      principle_id: principle.principle_id,
      title: principle.title,
      applicability: "applicable" as const,
      status: "pass" as const,
      evidence: "Ship tested work.",
      binding,
    })),
  };
  const document = renderCanonicalPhaseDocument("specify", semanticModel as never, IMPACT_SPECIFY_TEMPLATE);
  const sourceArtifact = {
    schema_version: 1,
    feature_id: featureId,
    run_key: runKey,
    version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "impact-dispatch" },
    constitution_binding: binding,
    semantic_model: semanticModel,
    document_sha256: sha256(document),
    upstream_versions: [],
  };
  const requestDigest = digestOf({
    feature_id: featureId,
    run_key: runKey,
    phase: "specify",
    version: 1,
    request_id: "impact-request",
    dispatch_id: "impact-dispatch",
    source_artifact: sourceArtifact,
    documents: [{ path: "spec.md", content: document }],
    semantic_sections: sections,
    constitution_binding: binding,
    upstream_versions: [],
    template_hash: IMPACT_TEMPLATES.selection.content_hash,
    language_hash: IMPACT_LANGUAGE.selection_hash,
  });
  const artifact = {
    schema_version: 1,
    feature_id: featureId,
    run_key: runKey,
    request_id: "impact-request",
    request_digest: requestDigest,
    source_artifact_id: "specify_draft",
    source_artifact: sourceArtifact,
    artifact_id: "specify.v1",
    phase: "specify" as const,
    version: 1,
    dispatch_id: "impact-dispatch",
    work_identity: {
      run_id: runKey,
      wave_id: "impact-wave",
      slice_id: featureId,
      session_id: "impact-session",
      workflow: "spec-preparation",
      stage_id: "specify",
      stage_cursor: "specify",
      capability_id: "impact-capability",
      capability_epoch: "impact-epoch",
      slot_id: "analyst",
      task_id: "impact-task",
      dispatch_id: "impact-dispatch",
      attempt: 1,
      worker_id: "specification-worker",
    },
    capability_epoch: "impact-epoch",
    source_artifact_hash: digestOf(sourceArtifact),
    semantic_model: semanticModel,
    document_paths: ["spec.md"],
    document_hashes: { "spec.md": sha256(document) },
    semantic_section_hashes: Object.fromEntries(
      Object.entries(sections).sort(([left], [right]) => left.localeCompare(right)).map(([marker, content]) => [marker, sha256(content)]),
    ),
    template_hash: IMPACT_TEMPLATES.selection.content_hash,
    language_hash: IMPACT_LANGUAGE.selection_hash,
    upstream_versions: [],
    created_at: "2026-09-01T00:00:00.000Z",
    constitution_binding: binding,
  };
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("impact fixture root could not be pinned");
  let materialized: ReturnType<typeof materializeFeatureDocuments>;
  try {
    materialized = materializeFeatureDocuments(root, {
      feature_id: featureId,
    run_key: runKey,
    phase: "specify",
    version: 1,
    documents: [{ path: "spec.md", content: document }],
    binding: {
      artifact_id: artifact.artifact_id,
      dispatch_id: artifact.dispatch_id,
      work_identity: artifact.work_identity,
      constitution_binding: binding,
      upstream_versions: [],
      },
    }, {
      validateBeforeWrite: () => {
        const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, binding);
        if (!current.ok) throw new Error(current.error);
      },
    });
  } finally {
    pinnedRoot.close();
  }
  if (!materialized.ok) throw new Error(`impact fixture materialization failed: ${materialized.error}`);
  writeFileSync(join(directory, "specify.v1.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

async function assessArgs(tools: ReturnType<typeof mount>, context: { cwd: string; hasUI: boolean }, selector: { feature_id: string; run_key: string }): Promise<Record<string, unknown>> {
  const result = await tools.get("constitution_impact_assess")!.execute("test", selector, undefined, undefined, context);
  const details = result.details as { ok?: boolean; required_next_tool?: { name?: string; arguments?: Record<string, unknown> } };
  assert.equal(details.ok, true, JSON.stringify(result.details));
  assert.equal(details.required_next_tool?.name, "constitution_impact_ask_selected");
  return details.required_next_tool!.arguments!;
}

type PreparedImpact = {
  root: string;
  tools: ReturnType<typeof mount>;
  context: ReturnType<typeof TEST_CONTEXT>;
  applyArgs: Record<string, unknown>;
  originalSource: string;
  assessedSource: string;
  statePath: string;
  gatePath: string;
  transactionDirectory: string;
};

async function prepareApprovedImpact(): Promise<PreparedImpact> {
  const root = project();
  writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
  const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
  assert.ok(initial.ok && initial.value.binding);
  if (!initial.ok || !initial.value.binding) throw new Error("impact fixture constitution setup failed");
  mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
  writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
  artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
  const assessedSource = CONSTITUTION + "\n";
  writeFileSync(join(root, "CONSTITUTION.md"), assessedSource, "utf8");
  const tools = mount(root);
  const context = TEST_CONTEXT(root);
  const applyArgs = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const asked = await tools.get("constitution_impact_ask_selected")!.execute(
    "test",
    applyArgs,
    undefined,
    undefined,
    { ...context, ui: impactAskUi("approve") },
  );
  const details = asked.details as { ok?: boolean; required_next_tool?: { arguments?: Record<string, unknown> } };
  assert.equal(details.ok, true, JSON.stringify(asked.details));
  assert.ok(details.required_next_tool?.arguments);
  return {
    root,
    tools,
    context,
    applyArgs: details.required_next_tool!.arguments!,
    originalSource: CONSTITUTION,
    assessedSource,
    statePath: join(root, ".work-state", "features", FEATURE_ID, "state.json"),
    gatePath: join(root, ".work-state", "specification", "constitution", "gate.json"),
    transactionDirectory: join(root, ".work-state", "specification", "constitution"),
  };
}

test("mounted constitution impact flow commits no-impact retention and replays atomically", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    const seeded = stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    writeState(root, seeded, { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    const second = stateFor(root, SECOND_FEATURE_ID, SECOND_RUN_KEY, initial.value.binding);
    writeState(root, second, { featureSlug: SECOND_FEATURE_ID });
    artifact(root, SECOND_FEATURE_ID, SECOND_RUN_KEY, initial.value.binding);
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION + "\n", "utf8");

    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    const ensured = await tools.get("ensure_project_constitution")!.execute("test", {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      origin_kind: "native_direct",
      origin_run_key: RUN_KEY,
      origin_stage: "specify",
    }, undefined, undefined, context);
    const blocked = ensured.details as { value?: { status?: string }; required_next_tool?: { name?: string } };
    assert.equal(blocked.value?.status, "blocked");
    assert.equal(blocked.required_next_tool?.name, "constitution_impact_assess");

    const askArgs = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    let selected = "approve";
    const askContext = { ...context, ui: impactAskUi(selected) };
    const asked = await tools.get("constitution_impact_ask_selected")!.execute("test", askArgs, undefined, undefined, askContext);
    const answer = asked.details as { ok?: boolean; decision?: string; proof?: unknown; required_next_tool?: { name?: string; arguments?: Record<string, unknown> } };
    assert.equal(answer.ok, true);
    assert.equal(answer.decision, "approve");
    assert.equal(answer.required_next_tool?.name, "constitution_impact_apply");
    const askedReplay = await tools.get("constitution_impact_ask_selected")!.execute("test", askArgs, undefined, undefined, askContext);
    const replayAnswer = askedReplay.details as { ok?: boolean; proof?: unknown };
    assert.equal(replayAnswer.ok, true);
    assert.deepEqual(replayAnswer.proof, answer.proof);
    const applyArgs = answer.required_next_tool!.arguments!;
    const wrongRun = await tools.get("constitution_impact_apply")!.execute("test", {
      ...applyArgs,
      run_key: `${RUN_KEY}-other`,
    }, undefined, undefined, context);
    assert.ok(["SPEC_PROOF_INVALID", "SPEC_RUN_MISMATCH"].includes((wrongRun.details as { code?: string }).code ?? ""), JSON.stringify(wrongRun.details));
    const proof = applyArgs.proof as Record<string, unknown>;
    const proofPath = join(root, ".work-state", "specification", "constitution", `${String(proof.answer_id)}.json`);
    const originalProof = readFileSync(proofPath, "utf8");
    const beforeProofApplyState = readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8");
    const forge = (value: Record<string, unknown>): void => {
      const { binding: _binding, ...payload } = value;
      value.binding = digestOf(payload);
    };
    const forgedProofs: Array<{ name: string; mutate: (value: Record<string, unknown>) => void }> = [
      { name: "channel", mutate: (value) => { value.channel = "web"; forge(value); } },
      { name: "reference", mutate: (value) => { value.reference = "terminal:forged"; forge(value); } },
      { name: "issued_at", mutate: (value) => { value.issued_at = "2026-09-01T00:00:00.000Z"; forge(value); } },
      { name: "nonce", mutate: (value) => { value.nonce = "f".repeat(32); forge(value); } },
      { name: "config_hash", mutate: (value) => { value.config_hash = sha256("forged Ask config"); forge(value); } },
      { name: "actor_session_id", mutate: (value) => { value.actor_session_id = "foreign-session"; forge(value); } },
      { name: "constitution_hash", mutate: (value) => { value.constitution_hash = sha256("forged constitution"); forge(value); } },
      { name: "workspace_digest", mutate: (value) => { value.workspace_digest = sha256("forged workspace"); forge(value); } },
      { name: "extra field", mutate: (value) => { value.unrecognized = true; forge(value); } },
      { name: "answer_id", mutate: (value) => { value.answer_id = `constitution-impact-answer-${sha256("forged answer")}`; forge(value); } },
    ];
    for (const forged of forgedProofs) {
      const value = structuredClone(proof);
      forged.mutate(value);
      const forgedPath = join(root, ".work-state", "specification", "constitution", `${String(value.answer_id)}.json`);
      writeFileSync(forgedPath, JSON.stringify(value, null, 2) + "\n", "utf8");
      const forgedApply = await tools.get("constitution_impact_apply")!.execute("test", {
        ...applyArgs,
        proof: value,
      }, undefined, undefined, context);
      assert.equal((forgedApply.details as { code?: string }).code, "SPEC_PROOF_INVALID", `${forged.name}: ${JSON.stringify(forgedApply.details)}`);
      assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), beforeProofApplyState, forged.name);
      rmSync(forgedPath, { force: true });
      writeFileSync(proofPath, originalProof, "utf8");
    }
    const rootPrototype = PinnedProjectRoot.prototype;
    const injectFailure = async (method: "writeAtomicFilesWithReceipts" | "replaceFileIfMatchesWithReceipt" | "writeExclusiveWithReceipt"): Promise<void> => {
      let injected = false;
      const failOnce = (): void => {
        if (!injected) {
          injected = true;
          throw new Error(`injected constitution impact ${method} failure`);
        }
      };
      let restore: () => void;
      if (method === "writeAtomicFilesWithReceipts") {
        const original = rootPrototype.writeAtomicFilesWithReceipts;
        rootPrototype.writeAtomicFilesWithReceipts = function (
          this: PinnedProjectRoot,
          entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
        ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
          failOnce();
          return original.call(this, entries);
        };
        restore = () => { rootPrototype.writeAtomicFilesWithReceipts = original; };
      } else if (method === "replaceFileIfMatchesWithReceipt") {
        const original = rootPrototype.replaceFileIfMatchesWithReceipt;
        rootPrototype.replaceFileIfMatchesWithReceipt = function (
          this: PinnedProjectRoot,
          relativeFile: Parameters<PinnedProjectRoot["replaceFileIfMatchesWithReceipt"]>[0],
          expected: Parameters<PinnedProjectRoot["replaceFileIfMatchesWithReceipt"]>[1],
          content: Parameters<PinnedProjectRoot["replaceFileIfMatchesWithReceipt"]>[2],
          options: Parameters<PinnedProjectRoot["replaceFileIfMatchesWithReceipt"]>[3],
        ): ReturnType<PinnedProjectRoot["replaceFileIfMatchesWithReceipt"]> {
          failOnce();
          return original.call(this, relativeFile, expected, content, options);
        };
        restore = () => { rootPrototype.replaceFileIfMatchesWithReceipt = original; };
      } else {
        const original = rootPrototype.writeExclusiveWithReceipt;
        rootPrototype.writeExclusiveWithReceipt = function (
          this: PinnedProjectRoot,
          relativeFile: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[0],
          content: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[1],
        ): ReturnType<PinnedProjectRoot["writeExclusiveWithReceipt"]> {
          failOnce();
          return original.call(this, relativeFile, content);
        };
        restore = () => { rootPrototype.writeExclusiveWithReceipt = original; };
      }
      try {
        const failedApply = await tools.get("constitution_impact_apply")!.execute("test", applyArgs, undefined, undefined, context);
        assert.equal((failedApply.details as { ok?: boolean }).ok, false, `${method} failure unexpectedly committed`);
      } finally {
        restore();
      }
      const pendingTransaction = readdirSync(join(root, ".work-state", "specification", "constitution"))
        .some((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
      assert.equal(pendingTransaction, true, `${method} failure did not leave a recoverable intent`);
    };
    await injectFailure("writeAtomicFilesWithReceipts");
    const transactionDirectory = join(root, ".work-state", "specification", "constitution");
    const transactionFile = readdirSync(transactionDirectory).find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
    assert.ok(transactionFile);
    if (!transactionFile) return;
    const transactionPath = join(transactionDirectory, transactionFile);
    const originalTransaction = readFileSync(transactionPath, "utf8");
    const beforeForgedTransactionState = readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8");
    const beforeForgedTransactionGate = readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8");
    const forgedTransactionMutators: Array<(value: {
      application: Record<string, unknown>;
      workspace: Record<string, unknown>;
      current_binding: Record<string, unknown>;
      phase: string;
    }) => void> = [
      (value) => {
        value.application.gate_id = "constitution.gate.forged";
      },
      (value) => {
        value.application.assessment_id = "constitution-impact-assessment-forged";
      },
      (value) => {
        value.workspace.constitution_gate_ref = "constitution.gate.forged";
        value.application.workspace_digest = digestOf(value.workspace);
      },
      (value) => {
        const forgedBinding = { ...value.current_binding, content_sha256: sha256("forged transaction binding") };
        value.current_binding = forgedBinding;
        value.workspace.constitution_binding = forgedBinding;
        value.application.current_binding_hash = digestOf(forgedBinding);
        value.application.workspace_digest = digestOf(value.workspace);
      },
      (value) => {
        value.phase = "committed";
      },
    ];
    for (const mutate of forgedTransactionMutators) {
      const forged = JSON.parse(originalTransaction) as {
        application: Record<string, unknown>;
        workspace: Record<string, unknown>;
        current_binding: Record<string, unknown>;
        phase: string;
      };
      mutate(forged);
      writeFileSync(transactionPath, JSON.stringify(forged, null, 2) + "\n", "utf8");
      const forgedApply = await tools.get("constitution_impact_apply")!.execute("test", applyArgs, undefined, undefined, context);
      assert.equal((forgedApply.details as { code?: string }).code, "SPEC_IMPACT_EVIDENCE_INVALID", JSON.stringify(forgedApply.details));
      assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), beforeForgedTransactionState);
      assert.equal(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8"), beforeForgedTransactionGate);
      writeFileSync(transactionPath, originalTransaction, "utf8");
    }

    await injectFailure("replaceFileIfMatchesWithReceipt");
    await injectFailure("writeExclusiveWithReceipt");
    await injectFailure("replaceFileIfMatchesWithReceipt");

    const applied = await tools.get("constitution_impact_apply")!.execute("test", applyArgs, undefined, undefined, context);
    const appliedDetails = applied.details as { ok?: boolean; value?: { stale_artifacts?: string[] } };
    assert.equal(appliedDetails.ok, true, JSON.stringify(applied.details));
    assert.deepEqual(appliedDetails.value?.stale_artifacts, []);
    const rebound = resolveFeatureWorkspace(root, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.ok(rebound.ok && rebound.value.constitution_binding);
    if (rebound.ok && rebound.value.constitution_binding) assert.notEqual(rebound.value.constitution_binding.content_sha256, initial.value.binding.content_sha256);
    const untouched = resolveFeatureWorkspace(root, { feature_id: SECOND_FEATURE_ID, run_key: SECOND_RUN_KEY });
    assert.ok(untouched.ok && untouched.value.constitution_binding);
    if (untouched.ok && untouched.value.constitution_binding) assert.equal(untouched.value.constitution_binding.content_sha256, initial.value.binding.content_sha256);
    const replay = await tools.get("constitution_impact_apply")!.execute("test", applyArgs, undefined, undefined, context);
    assert.equal((replay.details as { ok?: boolean }).ok, true, JSON.stringify(replay.details));
    const applicationDirectory = join(root, ".work-state", "specification", "constitution");
    const applicationFile = readdirSync(applicationDirectory).find((name) => name.startsWith("constitution-impact-application-") && name.endsWith(".json"));
    assert.ok(applicationFile);
    if (!applicationFile) return;
    const applicationPath = join(applicationDirectory, applicationFile);
    const originalApplication = readFileSync(applicationPath, "utf8");
    const appliedState = readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8");
    for (const corrupt of [
      (value: Record<string, any>) => { value.current_binding_hash = sha256("wrong binding"); },
      undefined,
    ]) {
      if (corrupt) {
        const value = JSON.parse(originalApplication) as Record<string, any>;
        corrupt(value);
        writeFileSync(applicationPath, JSON.stringify(value, null, 2) + "\n", "utf8");
      } else {
        writeFileSync(applicationPath, "{not valid json\n", "utf8");
      }
      const corruptReplay = await tools.get("constitution_impact_apply")!.execute("test", applyArgs, undefined, undefined, context);
      assert.equal((corruptReplay.details as { code?: string }).code, "SPEC_IMPACT_EVIDENCE_INVALID", JSON.stringify(corruptReplay.details));
      assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), appliedState);
      writeFileSync(applicationPath, originalApplication, "utf8");
    }
    for (const forge of [
      (value: Record<string, unknown>) => { value.workspace_digest = sha256("foreign-workspace"); },
      (value: Record<string, unknown>) => { value.handoff_ref = "foreign-handoff"; },
    ]) {
      const value = JSON.parse(originalApplication) as Record<string, unknown>;
      forge(value);
      writeFileSync(applicationPath, JSON.stringify(value, null, 2) + "\n", "utf8");
      const forgedReplay = await tools.get("constitution_impact_apply")!.execute("test", applyArgs, undefined, undefined, context);
      assert.equal((forgedReplay.details as { code?: string }).code, "SPEC_IMPACT_EVIDENCE_INVALID", JSON.stringify(forgedReplay.details));
      assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), appliedState);
      writeFileSync(applicationPath, originalApplication, "utf8");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
type MountedImpactTools = Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>;
type ImpactApplyDetails = { ok?: boolean; code?: string };
type ImpactAskDetails = { ok?: boolean; required_next_tool?: { arguments?: Record<string, unknown> } };

test("constitution impact WAL stays readable near its UTF-8 bound and rejects oversized plans before mutation", async () => {
  const nearRoot = project();
  const oversizedRoot = project();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFiles = rootPrototype.writeAtomicFilesWithReceipts;
  try {
    const prepare = async (root: string, handoffEntryBytes: number): Promise<{
      tools: MountedImpactTools;
      context: { cwd: string; hasUI: boolean };
      applyArgs: Record<string, unknown>;
      statePath: string;
      gatePath: string;
    }> => {
      writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
      const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
      assert.ok(initial.ok && initial.value.binding);
      if (!initial.ok || !initial.value.binding) throw new Error("constitution fixture setup failed");
      mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
      writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
      artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
      const handoff = validImplementationHandoff({ featureId: FEATURE_ID }) as unknown as ImplementationHandoff;
      handoff.scope.in_scope = Array.from(
        { length: handoffEntryBytes === 0 ? 0 : 4096 },
        (_, index) => `scope-${index}-${"x".repeat(handoffEntryBytes)}`,
      );
      handoff.handoff_digest = canonicalHandoffDigest(handoff);
      const handoffDirectory = join(root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff");
      mkdirSync(handoffDirectory, { recursive: true });
      writeFileSync(join(handoffDirectory, `${handoff.handoff_id}.json`), JSON.stringify(handoff, null, 2) + "\n", "utf8");
      const statePath = join(root, ".work-state", "features", FEATURE_ID, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { specification: { display_name: string; profile_name: string; handoff_ref: string | null } };
      state.specification.handoff_ref = handoff.handoff_id;
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
      writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION + "\n", "utf8");
      const tools = mount(root);
      const context = TEST_CONTEXT(root);
      const askArgs = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
      const asked = await tools.get("constitution_impact_ask_selected")!.execute(
        "test",
        askArgs,
        undefined,
        undefined,
        { ...context, ui: impactAskUi("approve") },
      );
      const details = asked.details as ImpactAskDetails;
      assert.equal(details.ok, true, JSON.stringify(asked.details));
      assert.ok(details.required_next_tool?.arguments);
      return {
        tools,
        context,
        applyArgs: details.required_next_tool!.arguments!,
        statePath,
        gatePath: join(root, ".work-state", "specification", "constitution", "gate.json"),
      };
    };
    const near = await prepare(nearRoot, 90);
    let injected = false;
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: readonly { path: string; content: string | Uint8Array }[],
    ): void {
      if (!injected) {
        injected = true;
        throw new Error("injected near-bound WAL recovery failure");
      }
      return originalWriteAtomicFiles.call(this, entries);
    };
    try {
      const failed = await near.tools.get("constitution_impact_apply")!.execute(
        "test",
        near.applyArgs,
        undefined,
        undefined,
        near.context,
      );
      const failedDetails = failed.details as ImpactApplyDetails;
      assert.equal(failedDetails.ok, false, JSON.stringify(failed.details));
    } finally {
      rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
    }
    const nearTransactionDirectory = join(nearRoot, ".work-state", "specification", "constitution");
    const nearTransactionFile = readdirSync(nearTransactionDirectory)
      .find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
    assert.ok(nearTransactionFile);
    if (!nearTransactionFile) return;
    const nearTransactionBytes = readFileSync(join(nearTransactionDirectory, nearTransactionFile));
    assert.ok(nearTransactionBytes.byteLength > 450 * 1024);
    assert.ok(nearTransactionBytes.byteLength <= 512 * 1024);
    const nearTransaction = JSON.parse(nearTransactionBytes.toString("utf8")) as { phase?: string };
    assert.equal(nearTransaction.phase, "prepared");
    const recovered = await near.tools.get("constitution_impact_apply")!.execute(
      "test",
      near.applyArgs,
      undefined,
      undefined,
      near.context,
    );
    const recoveredDetails = recovered.details as ImpactApplyDetails;
    assert.equal(recoveredDetails.ok, true, JSON.stringify(recovered.details));
    assert.equal(
      readdirSync(nearTransactionDirectory).some((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json")),
      false,
    );

    const oversized = await prepare(oversizedRoot, 130);
    const beforeState = readFileSync(oversized.statePath);
    const beforeGate = readFileSync(oversized.gatePath);
    const rejected = await oversized.tools.get("constitution_impact_apply")!.execute(
      "test",
      oversized.applyArgs,
      undefined,
      undefined,
      oversized.context,
    );
    const rejectedDetails = rejected.details as ImpactApplyDetails;
    assert.equal(rejectedDetails.code, "SPEC_IMPACT_EVIDENCE_INVALID", JSON.stringify(rejected.details));
    const oversizedTransactionDirectory = join(oversizedRoot, ".work-state", "specification", "constitution");
    assert.equal(
      readdirSync(oversizedTransactionDirectory).some((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json")),
      false,
    );
    assert.deepEqual(readFileSync(oversized.statePath), beforeState);
    assert.deepEqual(readFileSync(oversized.gatePath), beforeGate);
  } finally {
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
    rmSync(nearRoot, { recursive: true, force: true });
    rmSync(oversizedRoot, { recursive: true, force: true });
  }
});
test("constitution impact assessment fails closed when root swaps between gate and current binding", async () => {
  const root = project();
  const moved = `${root}-moved`;
  const replacement = project();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalReadFile = rootPrototype.readFile;
  let swapped = false;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    rootPrototype.readFile = function (relativePath: string, options?: Parameters<PinnedProjectRoot["readFile"]>[1]) {
      const result = originalReadFile.call(this, relativePath, options);
      if (!swapped && relativePath.endsWith("constitution/gate.json")) {
        swapped = true;
        renameSync(root, moved);
        renameSync(replacement, root);
      }
      return result;
    };
    const result = await tools.get("constitution_impact_assess")!.execute("test", {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
    }, undefined, undefined, context);
    const details = result.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(details.ok, false, JSON.stringify(result.details));
    assert.equal(details.code, "REGISTRATION_FAILED", JSON.stringify(result.details));
    assert.match(details.error ?? "", /root identity|project root identity|registration context|activation_identity_changed/i);
    assert.equal(swapped, true);
  } finally {
    rootPrototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
  }
});
test("constitution impact assessment rejects tampered canonical phase envelopes before Ask", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    const artifactPath = join(root, ".work-state", "features", FEATURE_ID, "artifacts", "specify.v1.json");
    const original = readFileSync(artifactPath, "utf8");
    const tamperers: Array<(value: Record<string, any>) => void> = [
      (value) => { value.feature_id = `${FEATURE_ID}-foreign`; },
      (value) => { value.semantic_section_hashes.problem = sha256("tampered semantic section"); },
      (value) => { value.source_artifact.document_sha256 = sha256("tampered source document"); },
      (value) => { value.unrecognized_governance_field = "must be rejected"; },
    ];
    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    const baseline = await tools.get("constitution_impact_assess")!.execute("test", {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
    }, undefined, undefined, context);
    assert.equal((baseline.details as { ok?: boolean }).ok, true, JSON.stringify(baseline.details));
    const beforeState = readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8");
    for (const tamper of tamperers) {
      const value = JSON.parse(original) as Record<string, any>;
      tamper(value);
      writeFileSync(artifactPath, JSON.stringify(value, null, 2) + "\n", "utf8");
      const result = await tools.get("constitution_impact_assess")!.execute("test", {
        feature_id: FEATURE_ID,
        run_key: RUN_KEY,
      }, undefined, undefined, context);
      const details = result.details as { ok?: boolean; code?: string };
      assert.equal(details.ok, false, JSON.stringify(result.details));
      assert.equal(details.code, "SPEC_IMPACT_EVIDENCE_INVALID", JSON.stringify(result.details));
      assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), beforeState);
      writeFileSync(artifactPath, original, "utf8");
    }
    const valid = await tools.get("constitution_impact_assess")!.execute("test", {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
    }, undefined, undefined, context);
    assert.equal((valid.details as { ok?: boolean }).ok, true, JSON.stringify(valid.details));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("constitution impact answer fails closed when the pinned root swaps before proof persistence", async () => {
  const root = project();
  const moved = `${root}-moved`;
  const replacement = project();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalReadFile = rootPrototype.readFile;
  let swapped = false;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    const args = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    rootPrototype.readFile = function (relativePath: string, options?: Parameters<PinnedProjectRoot["readFile"]>[1]) {
      const result = originalReadFile.call(this, relativePath, options);
      if (!swapped && /constitution\/impact-[a-f0-9]{64}\.json$/u.test(relativePath)) {
        swapped = true;
        renameSync(root, moved);
        renameSync(replacement, root);
      }
      return result;
    };
    const result = await tools.get("constitution_impact_ask_selected")!.execute("test", args, undefined, undefined, {
      ...context,
      ui: impactAskUi("approve"),
    });
    const details = result.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(details.ok, false, JSON.stringify(result.details));
    assert.equal(details.code, "REGISTRATION_FAILED", JSON.stringify(result.details));
    assert.match(details.error ?? "", /root identity|project root identity|registration context|activation_identity_changed/i);
    assert.equal(swapped, true);
    assert.equal(readdirSync(join(moved, ".work-state", "specification", "constitution")).some((name) => name.startsWith("constitution-impact-answer-")), false);
  } finally {
    rootPrototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
  }
});
test("constitution impact prerequisite rejects foreign run, feature, empty, stale, and forged assessments", () => {
  const root = project();
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION + "\n\n", "utf8");
    const publication = assessConstitutionImpactForFeature(root, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(publication.ok, true, publication.ok ? "assessed" : publication.error);
    if (!publication.ok) return;
    const assessment = publication.value.assessment;
    assert.equal(assessment.feature_id, FEATURE_ID);
    assert.equal(assessment.run_key, RUN_KEY);
    assert.equal(assessment.inventory_digest, digestOf(assessment.approved_artifacts));
    const candidates = [
      ["foreign feature", { ...assessment, feature_id: `${FEATURE_ID}-foreign` }],
      ["foreign run", { ...assessment, run_key: `${RUN_KEY}-foreign` }],
      ["empty inventory", { ...assessment, approved_artifacts: [], artifact_results: [] }],
      ["unrelated inventory", { ...assessment, approved_artifacts: [{ ...assessment.approved_artifacts[0]!, artifact_id: "foreign.v1" }] }],
      ["stale inventory digest", { ...assessment, inventory_digest: sha256("stale-inventory") }],
      ["forged in-memory result", { ...assessment, artifact_results: assessment.artifact_results.map((row) => ({ ...row, verdict: "no_impact" as const })) }],
    ] as const;
    for (const [label, candidate] of candidates) {
      const rejected = ensureProjectConstitution(root, ORIGIN, {
        feature_id: FEATURE_ID,
        impact_assessment: candidate,
      });
      assert.equal(rejected.ok, true, `${label}: ${rejected.ok ? "blocked" : rejected.error}`);
      if (rejected.ok) assert.equal(rejected.value.status, "blocked", label);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted constitution impact Ask proof is stable for retries and distinct across feature/run selectors", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    writeState(root, stateFor(root, SECOND_FEATURE_ID, SECOND_RUN_KEY, initial.value.binding), { featureSlug: SECOND_FEATURE_ID });
    mkdirSync(join(root, "specs", SECOND_FEATURE_ID), { recursive: true });
    artifact(root, SECOND_FEATURE_ID, SECOND_RUN_KEY, initial.value.binding);

    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    const firstArgs = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    const secondArgs = await assessArgs(tools, context, { feature_id: SECOND_FEATURE_ID, run_key: SECOND_RUN_KEY });
    const ask = tools.get("constitution_impact_ask_selected")!;
    const askContext = { ...context, ui: impactAskUi("approve") };
    const [first, firstReplay] = await Promise.all([
      ask.execute("test", firstArgs, undefined, undefined, askContext),
      ask.execute("test", firstArgs, undefined, undefined, askContext),
    ]);
    const firstDetails = first.details as { ok?: boolean; proof?: { answer_id?: string; binding?: string } };
    const firstReplayDetails = firstReplay.details as { ok?: boolean; proof?: { answer_id?: string; binding?: string } };
    assert.equal(firstDetails.ok, true, JSON.stringify(first.details));
    assert.equal(firstReplayDetails.ok, true, JSON.stringify(firstReplay.details));
    assert.deepEqual(firstReplayDetails.proof, firstDetails.proof);
    const second = await ask.execute("test", secondArgs, undefined, undefined, askContext);
    const secondDetails = second.details as { ok?: boolean; proof?: { answer_id?: string; binding?: string } };
    assert.equal(secondDetails.ok, true, JSON.stringify(second.details));
    assert.notEqual(secondDetails.proof?.answer_id, firstDetails.proof?.answer_id);
    assert.notEqual(secondDetails.proof?.binding, firstDetails.proof?.binding);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("mounted constitution impact reject, unanswered Ask, and stale proof fail closed without mutation", async () => {
  const root = project();
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    const args = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    const before = readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8");
    const declined = await tools.get("constitution_impact_ask_selected")!.execute("test", args, undefined, undefined, { ...context, ui: impactAskUi() });
    assert.equal((declined.details as { ok?: boolean }).ok, false);
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
    const rejected = await tools.get("constitution_impact_ask_selected")!.execute("test", args, undefined, undefined, { ...context, ui: impactAskUi("reject") });
    const rejection = rejected.details as { ok?: boolean; decision?: string; required_next_tool?: { arguments?: Record<string, unknown> } };
    assert.equal(rejection.ok, true);
    assert.equal(rejection.decision, "reject");
    const rejectArguments = rejection.required_next_tool!.arguments!;
    const rejectedApply = await tools.get("constitution_impact_apply")!.execute("test", rejectArguments, undefined, undefined, context);
    assert.equal((rejectedApply.details as { code?: string }).code, "SPEC_CONSTITUTION_IMPACT_REJECTED");
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
    const bareReject = await tools.get("constitution_impact_apply")!.execute("test", {
      ...rejectArguments,
      proof: { decision: "reject" },
    }, undefined, undefined, context);
    assert.equal((bareReject.details as { code?: string }).code, "SPEC_PROOF_INVALID");
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
    const crossFeatureReject = await tools.get("constitution_impact_apply")!.execute("test", {
      ...rejectArguments,
      feature_id: SECOND_FEATURE_ID,
      run_key: SECOND_RUN_KEY,
    }, undefined, undefined, context);
    assert.equal((crossFeatureReject.details as { code?: string }).code, "SPEC_PROOF_INVALID");
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
    const staleReject = await tools.get("constitution_impact_apply")!.execute("test", {
      ...rejectArguments,
      assessment_hash: sha256("stale-reject-assessment"),
    }, undefined, undefined, context);
    assert.equal((staleReject.details as { code?: string }).code, "SPEC_PROOF_INVALID");
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION + "\n\n## II. Security\n\nChanged after reject proof.\n", "utf8");
    const staleCurrentReject = await tools.get("constitution_impact_apply")!.execute("test", rejectArguments, undefined, undefined, context);
    assert.equal((staleCurrentReject.details as { code?: string }).code, "SPEC_CONSTITUTION_IMPACT_PENDING");
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION + "\n\n", "utf8");
    const args2 = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    const approved = await tools.get("constitution_impact_ask_selected")!.execute("test", args2, undefined, undefined, { ...context, ui: impactAskUi("approve") });
    const approval = approved.details as { required_next_tool?: { arguments?: Record<string, unknown> } };
    assert.ok(approval.required_next_tool?.arguments);
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION + "\n\n## II. Security\n\nNew rule.\n", "utf8");
    const stale = await tools.get("constitution_impact_apply")!.execute("test", approval.required_next_tool!.arguments!, undefined, undefined, context);
    assert.equal((stale.details as { code?: string }).code, "SPEC_CONSTITUTION_IMPACT_PENDING");
    assert.equal(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("impact apply rejects a cross-session capability before mutation", async () => {
  const fixture = await prepareApprovedImpact();
  try {
    const before = readFileSync(fixture.statePath);
    const foreign = applyConstitutionImpactForFeature(fixture.root, fixture.applyArgs as never, {
      session_id: "foreign-session",
      session: {},
    });
    assert.equal(foreign.ok, false, JSON.stringify(foreign));
    if (!foreign.ok) assert.equal(foreign.code, "SPEC_PROOF_INVALID");
    assert.deepEqual(readFileSync(fixture.statePath), before, "foreign session must not mutate workspace state");
    const accepted = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal((accepted.details as { ok?: boolean }).ok, true, JSON.stringify(accepted.details));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("public constitution impact recorder cannot mint proof without host capability", () => {
  const root = project();
  try {
    const result = recordConstitutionImpactAnswer(root, {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      gate_id: "gate",
      checkpoint_id: "checkpoint",
      assessment_id: "assessment",
      assessment_hash: "0".repeat(64),
      workspace_digest: "0".repeat(64),
      decision: "approve",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_PROOF_INVALID");
    assert.deepEqual(readdirSync(root), [], "direct recorder calls must not create proof or state artifacts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constitution impact rejects reserved, traversal, and overlong run keys before locking", () => {
  const root = project();
  const before = Date.now();
  try {
    for (const runKey of ["__constitution__", "../escape", "a".repeat(129)]) {
      const assessment = assessConstitutionImpactForFeature(root, { feature_id: FEATURE_ID, run_key: runKey });
      assert.equal(assessment.ok, false, `assessment must reject invalid run key ${runKey}`);
      if (!assessment.ok) assert.equal(assessment.code, "SPEC_STATE_INVALID");
      const applied = applyConstitutionImpactForFeature(root, {
        feature_id: FEATURE_ID,
        run_key: runKey,
        gate_id: "gate",
        checkpoint_id: "checkpoint",
        assessment_id: "assessment",
        assessment_hash: "0".repeat(64),
        workspace_digest: "0".repeat(64),
        proof: {},
      } as never);
      assert.equal(applied.ok, false, `application must reject invalid run key ${runKey}`);
      if (!applied.ok) assert.equal(applied.code, "SPEC_STATE_INVALID");
    }
    assert.ok(Date.now() - before < 1000, "invalid selectors must fail before the 10 second lock timeout");
    assert.equal(readdirSync(root).length, 0, "invalid selectors must not create state or lock files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constitution impact pending probe rejects invalid UTF-8 before selected-feature filtering", () => {
  const root = project();
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    const transactionDirectory = join(root, ".work-state", "specification", "constitution");
    mkdirSync(transactionDirectory, { recursive: true });
    const transactionPath = join(transactionDirectory, `constitution-impact-transaction-${"a".repeat(64)}.json`);
    const invalidTransaction = Buffer.concat([
      Buffer.from('{"application":{"feature_id":"unrelated-feature"},"ignored":"', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('"}', "utf8"),
    ]);
    writeFileSync(transactionPath, invalidTransaction);
    const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
    const beforeGate = readFileSync(gatePath);
    const rejected = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_STATE_INVALID");
    assert.deepEqual(readFileSync(gatePath), beforeGate);
    assert.deepEqual(readFileSync(transactionPath), invalidTransaction);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("constitution impact evidence rollback preserves a concurrent same-content replacement", async () => {
  const fixture = await prepareApprovedImpact();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteExclusive = rootPrototype.writeExclusiveWithReceipt;
  const assessmentId = String(fixture.applyArgs.assessment_id);
  const evidencePath = join(fixture.transactionDirectory, `impact-${assessmentId.replace(/^constitution-impact-/u, "")}.json`);
  let replacementIno: number | null = null;
  let reached = false;
  try {
    rmSync(evidencePath, { force: true });
    rootPrototype.writeExclusiveWithReceipt = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[0],
      content: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[1],
    ): ReturnType<PinnedProjectRoot["writeExclusiveWithReceipt"]> {
      const receipt = originalWriteExclusive.call(this, relativePath, content);
      if (!reached && relativePath.endsWith(`impact-${assessmentId.replace(/^constitution-impact-/u, "")}.json`)) {
        reached = true;
        const replacementPath = join(fixture.root, "impact-evidence-replacement.json");
        writeFileSync(replacementPath, content);
        renameSync(replacementPath, join(fixture.root, relativePath));
        replacementIno = statSync(join(fixture.root, relativePath)).ino;
        writeFileSync(join(fixture.root, "CONSTITUTION.md"), fixture.assessedSource + "\n## II. Security\n\nEvidence source drift.\n", "utf8");
      }
      return receipt;
    };
    const result = assessConstitutionImpactForFeature(fixture.root, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.equal(reached, true, JSON.stringify(result));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal((result as { code?: string }).code, "SPEC_CONSTITUTION_IMPACT_PENDING", JSON.stringify(result));
    assert.notEqual(replacementIno, null);
    assert.equal(statSync(evidencePath).ino, replacementIno, "evidence rollback preserves a concurrent same-content replacement");
  } finally {
    rootPrototype.writeExclusiveWithReceipt = originalWriteExclusive;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("constitution impact pending recovery rejects source drift without postimage writes and resumes after exact restoration", async () => {
  const fixture = await prepareApprovedImpact();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFiles = rootPrototype.writeAtomicFilesWithReceipts;
  let injected = false;
  try {
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
    ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
      if (!injected) {
        injected = true;
        throw new Error("injected impact recovery write failure");
      }
      return originalWriteAtomicFiles.call(this, entries);
    };
    const failed = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal((failed.details as { ok?: boolean }).ok, false, JSON.stringify(failed.details));
    assert.equal(injected, true);
  } finally {
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
  }
  const transactionFile = readdirSync(fixture.transactionDirectory)
    .find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
  assert.ok(transactionFile, "failed recovery must leave a prepared transaction");
  if (!transactionFile) {
    rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  const transactionPath = join(fixture.transactionDirectory, transactionFile);
  const applicationPath = join(fixture.transactionDirectory, `constitution-impact-application-${String((fixture.applyArgs.proof as Record<string, unknown>).answer_id)}.json`);
  const handoffDirectory = join(fixture.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff");
  const claimDirectory = join(fixture.root, ".work-state", "features", FEATURE_ID, "artifacts", "execution_claim");
  const before = new Map<string, Buffer>([
    [fixture.statePath, readFileSync(fixture.statePath)],
    [fixture.gatePath, readFileSync(fixture.gatePath)],
    [transactionPath, readFileSync(transactionPath)],
  ]);
  const directoryEntries = (path: string): string[] | null => exists(path) ? readdirSync(path) : null;
  const beforeDirectoryEntries = new Map<string, string[] | null>([
    [handoffDirectory, directoryEntries(handoffDirectory)],
    [claimDirectory, directoryEntries(claimDirectory)],
  ]);
  try {
    writeFileSync(join(fixture.root, "CONSTITUTION.md"), fixture.assessedSource + "\n## II. Security\n\nSource drift before recovery.\n", "utf8");
    const stale = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    const staleDetails = stale.details as { ok?: boolean; code?: string };
    assert.ok(!staleDetails.ok, JSON.stringify(stale.details));
    assert.equal(staleDetails.code, "SPEC_CONSTITUTION_IMPACT_PENDING", JSON.stringify(stale.details));
    for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path);
    assert.equal(readdirSync(fixture.transactionDirectory).some((name) => name.startsWith("constitution-impact-application-")), false, "source drift must not create an application receipt");
    for (const [directory, entries] of beforeDirectoryEntries) assert.deepEqual(directoryEntries(directory), entries, directory);
    assert.equal(exists(applicationPath), false);
    writeFileSync(join(fixture.root, "CONSTITUTION.md"), fixture.assessedSource, "utf8");
    const resumed = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal((resumed.details as { ok?: boolean }).ok, true, JSON.stringify(resumed.details));
    assert.equal(readdirSync(fixture.transactionDirectory).some((name) => name.startsWith("constitution-impact-transaction-")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("constitution impact recovery preserves a WAL replacement after its exact read", async () => {
  const fixture = await prepareApprovedImpact();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFiles = rootPrototype.writeAtomicFilesWithReceipts;
  let prepared = false;
  try {
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
    ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
      if (!prepared) {
        prepared = true;
        throw new Error("injected WAL preparation failure");
      }
      return originalWriteAtomicFiles.call(this, entries);
    };
    const failed = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal((failed.details as { ok?: boolean }).ok, false, JSON.stringify(failed.details));
  } finally {
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
  }
  const transactionFile = readdirSync(fixture.transactionDirectory)
    .find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
  assert.ok(transactionFile);
  if (!transactionFile) {
    rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  const transactionPath = join(fixture.transactionDirectory, transactionFile);
  const transactionRelative = join(".work-state", "specification", "constitution", transactionFile);
  const beforeState = readFileSync(fixture.statePath);
  const beforeGate = readFileSync(fixture.gatePath);
  const beforeTransaction = readFileSync(transactionPath);
  const rootPrototypeReadFile = rootPrototype.readFile;
  const rootPrototypeIsStable = rootPrototype.isStable;
  let transactionRead = false;
  let stableChecksAfterRead = 0;
  let replaced = false;
  try {
    rootPrototype.readFile = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["readFile"]>[0],
      options?: Parameters<PinnedProjectRoot["readFile"]>[1],
    ): ReturnType<PinnedProjectRoot["readFile"]> {
      const result = rootPrototypeReadFile.call(this, relativePath, options);
      if (relativePath === transactionRelative) transactionRead = true;
      return result;
    };
    rootPrototype.isStable = function (this: PinnedProjectRoot): boolean {
      const stable = rootPrototypeIsStable.call(this);
      if (transactionRead && !replaced && ++stableChecksAfterRead === 2) {
        replaced = true;
        const replacementPath = `${transactionPath}.replacement`;
        writeFileSync(replacementPath, readFileSync(transactionPath));
        renameSync(replacementPath, transactionPath);
      }
      return stable;
    };
    const raced = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    const details = raced.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(replaced, true, JSON.stringify(raced.details));
    assert.equal(details.ok, false, JSON.stringify(raced.details));
    assert.equal(details.code, "SPEC_IMPACT_RECOVERY_REQUIRED", JSON.stringify(raced.details));
    assert.match(details.error ?? "", /descriptor changed after parse|recovery/u);
    assert.deepEqual(readFileSync(fixture.statePath), beforeState, "WAL replacement must not mutate workspace state");
    assert.deepEqual(readFileSync(fixture.gatePath), beforeGate, "WAL replacement must not mutate constitution gate");
    assert.deepEqual(readFileSync(transactionPath), beforeTransaction, "same-content WAL replacement remains durable");
    assert.equal(
      readdirSync(fixture.transactionDirectory).some((name) => name.startsWith("constitution-impact-application-")),
      false,
      "WAL replacement must not publish an application receipt",
    );
  } finally {
    rootPrototype.readFile = rootPrototypeReadFile;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("constitution impact gate CAS rejects source drift immediately before its write without mutation", async () => {
  const fixture = await prepareApprovedImpact();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFiles = rootPrototype.writeAtomicFilesWithReceipts;
  const originalWriteAtomicWithReceipt = rootPrototype.writeAtomicWithReceipt;
  let prepared = false;
  let gateCasReached = false;
  let gateReplacementIno: number | null = null;
  let gateReplacementBytes: Buffer | null = null;
  try {
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
    ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
      if (!prepared) {
        prepared = true;
        throw new Error("injected impact recovery write failure");
      }
      return originalWriteAtomicFiles.call(this, entries);
    };
    const failed = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal((failed.details as { ok?: boolean }).ok, false, JSON.stringify(failed.details));
  } finally {
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
  }
  const transactionFile = readdirSync(fixture.transactionDirectory)
    .find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
  assert.ok(transactionFile);
  if (!transactionFile) {
    rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  const transactionPath = join(fixture.transactionDirectory, transactionFile);
  const beforeGate = readFileSync(fixture.gatePath);
  const beforeState = readFileSync(fixture.statePath);
  const beforeTransaction = readFileSync(transactionPath);
  try {
    rootPrototype.writeAtomicWithReceipt = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["writeAtomicWithReceipt"]>[0],
      content: Parameters<PinnedProjectRoot["writeAtomicWithReceipt"]>[1],
      options: Parameters<PinnedProjectRoot["writeAtomicWithReceipt"]>[2],
    ): ReturnType<PinnedProjectRoot["writeAtomicWithReceipt"]> {
      const receipt = originalWriteAtomicWithReceipt.call(this, relativePath, content, options);
      if (!gateCasReached && relativePath.endsWith("constitution/gate.json")) {
        gateCasReached = true;
        const replacementPath = `${fixture.gatePath}.same-content-replacement`;
        gateReplacementBytes = readFileSync(fixture.gatePath);
        writeFileSync(replacementPath, gateReplacementBytes);
        renameSync(replacementPath, fixture.gatePath);
        gateReplacementIno = statSync(fixture.gatePath).ino;
        writeFileSync(join(fixture.root, "CONSTITUTION.md"), fixture.assessedSource + "\n## II. Security\n\nGate CAS source drift.\n", "utf8");
      }
      return receipt;
    };
    const stale = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    const details = stale.details as { ok?: boolean; code?: string };
    assert.equal(gateCasReached, true, JSON.stringify(stale.details));
    assert.equal(details.ok, false, JSON.stringify(stale.details));
    assert.equal(details.code, "SPEC_CONSTITUTION_IMPACT_PENDING", JSON.stringify(stale.details));
    assert.deepEqual(readFileSync(fixture.gatePath), gateReplacementBytes, "gate rollback preserves the concurrent replacement bytes");
    assert.notEqual(gateReplacementIno, null);
    assert.equal(statSync(fixture.gatePath).ino, gateReplacementIno, "gate rollback preserves a concurrent same-content replacement");
    assert.deepEqual(readFileSync(fixture.statePath), beforeState, "workspace must remain at its preimage");
    assert.deepEqual(readFileSync(transactionPath), beforeTransaction, "pending WAL must remain unchanged");
    // The concurrent same-content gate replacement remains the authority and
    // requires explicit restoration before replay; this test only proves that
    // rollback does not overwrite the concurrent winner.
  } finally {
    rootPrototype.writeAtomicWithReceipt = originalWriteAtomicWithReceipt;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("constitution impact recovery rolls back an application when postimage capture fails and preserves the WAL", async () => {
  const fixture = await prepareApprovedImpact();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFiles = rootPrototype.writeAtomicFilesWithReceipts;
  const originalWriteExclusive = rootPrototype.writeExclusiveWithReceipt;
  const originalReadFile = rootPrototype.readFile;
  let prepared = false;
  try {
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
    ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
      if (!prepared) {
        prepared = true;
        throw new Error("injected impact recovery write failure");
      }
      return originalWriteAtomicFiles.call(this, entries);
    };
    const failed = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal((failed.details as { ok?: boolean }).ok, false, JSON.stringify(failed.details));
    assert.equal(prepared, true, JSON.stringify(failed.details));
  } finally {
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
  }
  const transactionFile = readdirSync(fixture.transactionDirectory)
    .find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
  assert.ok(transactionFile);
  if (!transactionFile) {
    rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  const transactionPath = join(fixture.transactionDirectory, transactionFile);
  const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as { application?: { application_id?: string } };
  assert.ok(transaction.application?.application_id);
  if (!transaction.application?.application_id) {
    rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  rmSync(join(fixture.transactionDirectory, `${transaction.application.application_id}.json`), { force: true });
  const applicationDirectory = fixture.transactionDirectory;
  let applicationWritten = false;
  let captureFailed = false;
  try {
    rootPrototype.writeExclusiveWithReceipt = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[0],
      content: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[1],
    ): ReturnType<PinnedProjectRoot["writeExclusiveWithReceipt"]> {
      const result = originalWriteExclusive.call(this, relativePath, content);
      if (relativePath.includes("constitution-impact-application-") && relativePath.endsWith(".json")) applicationWritten = true;
      return result;
    };
    rootPrototype.readFile = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["readFile"]>[0],
      options?: Parameters<PinnedProjectRoot["readFile"]>[1],
    ): ReturnType<PinnedProjectRoot["readFile"]> {
      const result = originalReadFile.call(this, relativePath, options);
      if (applicationWritten && !captureFailed && relativePath.includes("constitution-impact-application-") && relativePath.endsWith(".json")) {
        captureFailed = true;
        throw new Error("injected postimage capture failure");
      }
      return result;
    };
    const rejected = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal(captureFailed, true, JSON.stringify(rejected.details));
    assert.equal((rejected.details as { ok?: boolean }).ok, false, JSON.stringify(rejected.details));
    assert.equal(readdirSync(applicationDirectory).some((name) => name.startsWith("constitution-impact-application-")), false, "capture failure removes only the attempt-owned application");
    assert.equal(readdirSync(fixture.transactionDirectory).some((name) => name.startsWith("constitution-impact-transaction-")), true, "pending WAL remains for replay");
  } finally {
    rootPrototype.writeExclusiveWithReceipt = originalWriteExclusive;
    rootPrototype.readFile = originalReadFile;
  }
  rmSync(fixture.root, { recursive: true, force: true });
});

test("constitution impact recovery rolls back claim journals after a post-block failure and preserves the WAL", async () => {
  const fixture = await prepareApprovedImpact();
  const gate = JSON.parse(readFileSync(fixture.gatePath, "utf8")) as { gate: { binding: ConstitutionBinding } };
  const state = JSON.parse(readFileSync(fixture.statePath, "utf8")) as Record<string, unknown>;
  const workspace = state.specification as Record<string, unknown>;
  const handoff = validImplementationHandoff({ featureId: FEATURE_ID }) as unknown as ImplementationHandoff;
  handoff.constitution_binding = gate.gate.binding;
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const handoffDirectory = join(fixture.root, ".work-state", "features", FEATURE_ID, "artifacts", "implementation_handoff");
  mkdirSync(handoffDirectory, { recursive: true });
  writeFileSync(join(handoffDirectory, `${handoff.handoff_id}.json`), JSON.stringify(handoff, null, 2) + "\n", "utf8");
  workspace.handoff_ref = handoff.handoff_id;
  workspace.status = "implementation_ready";
  workspace.execution_claim_prepare_ref = null;
  workspace.execution_claim_ref = null;
  workspace.implementation_conformance_ref = null;
  state.specification = workspace;
  writeState(fixture.root, state as never, { featureSlug: FEATURE_ID });
  writeFileSync(join(fixture.root, "CONSTITUTION.md"), fixture.originalSource, "utf8");
  const acquired = acquireExecutionClaim(fixture.root, FEATURE_ID, {
    handoff,
    run_key: RUN_KEY,
    owner_kind: "do_work",
    owner_run_id: "impact-claim-owner",
    acquired_at: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  fixture.assessedSource = CONSTITUTION.replace("Ship tested work.", "Ship tested work with security.");
  writeFileSync(join(fixture.root, "CONSTITUTION.md"), fixture.assessedSource, "utf8");
  const assessedArgs = await assessArgs(fixture.tools, fixture.context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  const asked = await fixture.tools.get("constitution_impact_ask_selected")!.execute(
    "test", assessedArgs, undefined, undefined, { ...fixture.context, ui: impactAskUi("approve") },
  );
  const askedDetails = asked.details as { ok?: boolean; required_next_tool?: { arguments?: Record<string, unknown> } };
  assert.equal(askedDetails.ok, true, JSON.stringify(asked.details));
  assert.ok(askedDetails.required_next_tool?.arguments);
  if (!askedDetails.required_next_tool?.arguments) {
    rmSync(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.applyArgs = askedDetails.required_next_tool.arguments;
  const beforeState = readFileSync(fixture.statePath);
  const beforeGate = readFileSync(fixture.gatePath);
  const handoffPath = join(handoffDirectory, `${handoff.handoff_id}.json`);
  const beforeHandoff = readFileSync(handoffPath);
  const claimDirectory = join(fixture.root, ".work-state", "features", FEATURE_ID, "artifacts", "execution_claim");
  const beforeClaimFiles = new Map<string, Buffer>();
  for (const name of ["root.json", "manifest.json"]) {
    const path = join(claimDirectory, name);
    if (exists(path)) beforeClaimFiles.set(path, readFileSync(path));
  }
  const nextDirectory = join(claimDirectory, "next");
  if (exists(nextDirectory)) for (const name of readdirSync(nextDirectory)) beforeClaimFiles.set(join(nextDirectory, name), readFileSync(join(nextDirectory, name)));
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFiles = rootPrototype.writeAtomicFilesWithReceipts;
  const originalWriteExclusive = rootPrototype.writeExclusiveWithReceipt;
  const originalReadFile = rootPrototype.readFile;
  let prepared = false;
  let firstFailureDetails: unknown = null;
  let claimTarget: string | null = null;
  let claimWritten = false;
  let targetReads = 0;
  let captureFailed = false;
  try {
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
    ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
      if (!prepared) {
        prepared = true;
        throw new Error("injected claim recovery state failure");
      }
      return originalWriteAtomicFiles.call(this, entries);
    };
    const failed = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    firstFailureDetails = failed.details;
    assert.equal((failed.details as { ok?: boolean }).ok, false, JSON.stringify(failed.details));
  } finally {
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
  }
  // Normalize the first injected boundary back to the exact prepared preimage;
  // the second invocation then exercises the post-block cleanup boundary.
  writeFileSync(fixture.statePath, beforeState);
  writeFileSync(fixture.gatePath, beforeGate);
  writeFileSync(handoffPath, beforeHandoff);
  for (const name of ["root.json", "manifest.json"]) {
    const path = join(claimDirectory, name);
    if (!beforeClaimFiles.has(path)) rmSync(path, { force: true });
  }
  if (exists(nextDirectory)) {
    for (const name of readdirSync(nextDirectory)) {
      const path = join(nextDirectory, name);
      if (!beforeClaimFiles.has(path)) rmSync(path, { force: true });
    }
  } else {
    mkdirSync(nextDirectory, { recursive: true });
  }
  for (const [path, bytes] of beforeClaimFiles) writeFileSync(path, bytes);
  for (const name of readdirSync(fixture.transactionDirectory)) {
    if (name.startsWith("constitution-impact-application-")) rmSync(join(fixture.transactionDirectory, name), { force: true });
  }
  // The first failure only prepares a replayable WAL. The second invocation
  // reaches blockExecutionClaim and fails immediately after its journal write.
  const restoredClaim = readCurrentExecutionClaim(fixture.root, FEATURE_ID);
  assert.ok(restoredClaim.ok && restoredClaim.value?.status === "active", JSON.stringify(restoredClaim));
  try {
    const transactionFile = readdirSync(fixture.transactionDirectory).find((name) => name.startsWith("constitution-impact-transaction-") && name.endsWith(".json"));
    assert.ok(transactionFile, JSON.stringify(firstFailureDetails));
    if (!transactionFile) return;
    const transaction = JSON.parse(readFileSync(join(fixture.transactionDirectory, transactionFile), "utf8")) as { claim?: { claim_id?: string; status?: string; release_reason?: string | null } };
    assert.ok(transaction.claim?.claim_id);
    assert.equal(transaction.claim?.claim_id, restoredClaim.ok ? restoredClaim.value?.claim_id : null, JSON.stringify({ transactionClaim: transaction.claim, restoredClaim }));
    assert.equal(transaction.claim?.status, "blocked", JSON.stringify({ transactionClaim: transaction.claim, restoredClaim }));
    rootPrototype.writeExclusiveWithReceipt = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[0],
      content: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[1],
    ): ReturnType<PinnedProjectRoot["writeExclusiveWithReceipt"]> {
      const result = originalWriteExclusive.call(this, relativePath, content);
      if (relativePath.includes("/execution_claim/") && (relativePath.endsWith("/root.json") || relativePath.includes("/next/"))) {
        claimTarget = relativePath;
        claimWritten = true;
      }
      return result;
    };
    rootPrototype.readFile = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["readFile"]>[0],
      options?: Parameters<PinnedProjectRoot["readFile"]>[1],
    ): ReturnType<PinnedProjectRoot["readFile"]> {
      const result = originalReadFile.call(this, relativePath, options);
      if (claimWritten && claimTarget === relativePath && ++targetReads >= 2 && !captureFailed) {
        captureFailed = true;
        throw new Error("injected failure immediately after claim journal visibility");
      }
      return result;
    };
    const rejected = await fixture.tools.get("constitution_impact_apply")!.execute(
      "test", fixture.applyArgs, undefined, undefined, fixture.context,
    );
    assert.equal(captureFailed, true, JSON.stringify(rejected.details));
    assert.equal((rejected.details as { ok?: boolean }).ok, false, JSON.stringify(rejected.details));
    assert.deepEqual(readFileSync(fixture.statePath), beforeState, "claim failure restores the workspace state preimage");
    for (const [path, bytes] of beforeClaimFiles) assert.deepEqual(readFileSync(path), bytes, path);
    if (claimTarget) assert.equal(exists(claimTarget), false, "attempt-created claim journal target is removed");
    assert.equal(readdirSync(fixture.transactionDirectory).some((name) => name.startsWith("constitution-impact-transaction-")), true, "pending impact WAL remains for replay");
  } finally {
    rootPrototype.writeExclusiveWithReceipt = originalWriteExclusive;
    rootPrototype.readFile = originalReadFile;
  }
  const resumed = await fixture.tools.get("constitution_impact_apply")!.execute(
    "test", fixture.applyArgs, undefined, undefined, fixture.context,
  );
  assert.equal((resumed.details as { ok?: boolean }).ok, true, JSON.stringify(resumed.details));
  rmSync(fixture.root, { recursive: true, force: true });
});

test("constitution impact answer proof rejects source drift immediately before proof write", async () => {
  const root = project();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteExclusive = rootPrototype.writeExclusiveWithReceipt;
  let proofWriteReached = false;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const initial = ensureProjectConstitution(root, ORIGIN, { feature_id: FEATURE_ID });
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeState(root, stateFor(root, FEATURE_ID, RUN_KEY, initial.value.binding), { featureSlug: FEATURE_ID });
    artifact(root, FEATURE_ID, RUN_KEY, initial.value.binding);
    const assessedSource = CONSTITUTION + "\n";
    writeFileSync(join(root, "CONSTITUTION.md"), assessedSource, "utf8");
    const tools = mount(root);
    const context = TEST_CONTEXT(root);
    const args = await assessArgs(tools, context, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    rootPrototype.writeExclusiveWithReceipt = function (
      this: PinnedProjectRoot,
      relativePath: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[0],
      content: Parameters<PinnedProjectRoot["writeExclusiveWithReceipt"]>[1],
    ): ReturnType<PinnedProjectRoot["writeExclusiveWithReceipt"]> {
      if (!proofWriteReached && /constitution-impact-answer-[a-f0-9]{64}\.json$/u.test(relativePath)) {
        proofWriteReached = true;
        writeFileSync(join(root, "CONSTITUTION.md"), assessedSource + "\n## II. Security\n\nProof write source drift.\n", "utf8");
      }
      return originalWriteExclusive.call(this, relativePath, content);
    };
    const result = await tools.get("constitution_impact_ask_selected")!.execute(
      "test", args, undefined, undefined, { ...context, ui: impactAskUi("approve") },
    );
    const details = result.details as { ok?: boolean; code?: string };
    assert.equal(proofWriteReached, true, JSON.stringify(result.details));
    assert.equal(details.ok, false, JSON.stringify(result.details));
    assert.equal(details.code, "SPEC_CONSTITUTION_IMPACT_PENDING", JSON.stringify(result.details));
  } finally {
    rootPrototype.writeExclusiveWithReceipt = originalWriteExclusive;
    rmSync(root, { recursive: true, force: true });
  }
});
