import { test } from "node:test";
import assert from "node:assert/strict";
import { z as zod } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { authorizeDispatchTrusted, createCapability, issueCurrentTrustedMappingProof, validateCheckpointAskSelected } from "../src/engine/durable.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { buildDispatchMarker, dispatchGate, dispatchTaskId, nativeGenerationBinding, nativeWorkerName } from "../src/gates/dispatch.js";
import {
  nativeSpecificationGenerationActive,
  nativeSpecificationTaskGate,
  NATIVE_SPECIFICATION_TASK_CONTEXT,
  NATIVE_SPECIFICATION_TASK_INTENT,
} from "../src/gates/native-specification.js";
import { TEST_CONTEXT, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import { registerTeamWorkflow } from "../src/index.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { registerTestWorkflowTools, registerTestTeamWorkflow } from "./fixtures/host-tool-activation.js";
import { workflowOwnerFor } from "../src/registry/owner.js";
import { specificationPhaseSchemaForConstitution } from "../src/engine/artifact-contract.js";
import { PinnedProjectRoot, type PinnedRootWriteHooks } from "../src/specification/pinned-root.js";
import { readPinnedConstitutionPrincipleIdentities } from "../src/specification/constitution-identities.js";
import { dispatchSpecificationPhase, hydrateNativeSpecificationWorkerPrompt, MAX_PHASE_INPUT_BYTES, nativeWorkerTaskEnvelope, startNativeSpecificationPhase, finalizeNativeSpecificationPhase, setSpecificationPhaseFailureInjector, type NativeSpecificationGenerationHandoff } from "../src/specification/phase.js";
import {
  bindWorkspaceConstitution,
  createFeatureWorkspace,
} from "../src/specification/workspace.js";
import type { TeamState } from "../src/engine/types.js";
import type { FeatureWorkspace } from "../src/specification/types.js";
import { validConstitutionBinding, sha256 } from "./fixtures/specification-fixtures.js";
import { createPreparationHandoff, preparationHandoffDigest, preparationHandoffUnsigned, preparationStateDigest } from "../src/engine/preparation.js";
import { digestOf } from "../src/specification/validation.js";
import { buildCtoSliceMarker } from "../src/cto/slice-gate.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";

const profile = loadProfile("spec-preparation");
assert.ok(profile);
const stage = profile.stages.find((candidate) => candidate.id === "specify");
assert.ok(stage);
const CAPABILITY_POLICY_HASH = digestOf(stage?.roster_policy ?? {});
const constitution = "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n\n## II. Safety\n\nKeep changes reviewable.\n";

interface NativeGateFixture {
  root: string;
  state: TeamState;
  workspace: FeatureWorkspace;
  item: Record<string, unknown>;
  schema: Record<string, unknown>;
}

function fixture(language = "en-US"): NativeGateFixture {
  const root = mkdtempSync(join(tmpdir(), "native-gate-"));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
  writeFileSync(join(root, "CONSTITUTION.md"), constitution);
  mkdirSync(join(root, ".work-state"), { recursive: true });
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "specification-analyst": "specification-worker" } }) + "\n");
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
  const runKey = "native-gate-run";
  const featureId = "native-gate-feature";
  const created = createFeatureWorkspace(root, {
    feature_id: featureId,
    display_name: "Native gate fixture",
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: profileHash(profile),
    source_kind: "native",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.error);
  const gate = ensureProjectConstitution(root, {
    origin_kind: "native_direct",
    origin_run_key: runKey,
    origin_stage: "specify",
  }, { feature_id: featureId });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  assert.ok(gate.ok && gate.value.binding, "native gate fixture must establish an approved current constitution binding");
  if (!gate.ok || !gate.value.binding) throw new Error("native gate fixture constitution gate unavailable");
  const binding = gate.value.binding;
  // The constitution prerequisite may rewrite durable state; publish the
  // exact current config-bound mapping once more before capability issuance.
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
  const bound = bindWorkspaceConstitution(created.value, binding, gate.value.gate_id);
  const selectedLanguage = language === "en-US"
    ? bound.language
    : { language, source: "project_default" as const, selection_hash: sha256(`language=${language}\nsource=project_default`) };
  const workspace: FeatureWorkspace = {
    ...bound,
    language: selectedLanguage,
    phases: bound.phases.map((candidate) => candidate.phase === "specify"
      ? { ...candidate, status: "generating" as const }
      : candidate),
  };

  const issued = createCapability({
    run_key: runKey,
    branch: "main",
    workflow: "spec-preparation",
    profile_hash: profileHash(profile),
    stage_cursor: "specify",
    kind: "single",
    expected_roster: [{ role: "specification-analyst", agent: "specification-worker" }],
    policy_hash: CAPABILITY_POLICY_HASH,
    dispatch_secret: "native-task-secret",
    advance_secret: "native-advance-secret",
  });
  const cursorEpoch = issued.state.issued_for!.cursor_epoch;
  const state: TeamState = {
    schema: 1,
    branch: "main",
    run_key: runKey,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: "native gate fixture",
    workflow_override: false,
    issue: null,
    stage_cursor: "specify",
    stages: profile.stages.map((candidate) => ({ id: candidate.id, status: candidate.id === "specify" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-09-08T00:00:00.000Z",
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    config_hash: config.config_hash,
    cursor_epoch: cursorEpoch,
    dispatch_capability: issued.state,
    specification: workspace,
  };
  writeState(root, state, { featureSlug: featureId });

  const capabilityId = issued.state.capability_id!;
  const authProof = issueCurrentTrustedMappingProof(root);
  const auth = authorizeDispatchTrusted(root, {
    capability_id: capabilityId,
    run_key: runKey,
    branch: "main",
    workflow: "spec-preparation",
    profile_hash: profileHash(profile),
    stage_cursor: "specify",
    cursor_epoch: cursorEpoch,
    role: "specification-analyst",
    slot_id: "specification-analyst",
    task_id: dispatchTaskId(capabilityId, runKey, "main", "spec-preparation", "specify", "specification-analyst"),
    agent: "specification-worker",
    tool_call_id: "native-task-call",
    expected_count: 1,
  }, authProof === undefined ? {} : { trustedMappingProof: authProof });
  assert.equal(auth.ok, true);
  if (!auth.ok) throw new Error(auth.error);
  const persisted = resolveState(root, "main").state;
  assert.ok(persisted);

  const taskId = dispatchTaskId(capabilityId, runKey, "main", "spec-preparation", "specify", "specification-analyst");
  const marker = buildDispatchMarker(runKey, stage, ["specification-analyst"], "specification-analyst", cursorEpoch, capabilityId, "specification-analyst", taskId, featureId);
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  const identities = readPinnedConstitutionPrincipleIdentities(pinned, binding);
  pinned.close();
  assert.equal(identities.ok, true);
  if (!identities.ok) throw new Error(identities.error);
  const dispatchId = persisted.dispatch_capability!.dispatches[0]!.id;
  const dispatchRecord = persisted.dispatch_capability!.dispatches[0]!;
  assert.ok(dispatchRecord.work_identity);
  if (!dispatchRecord.work_identity) throw new Error("fixture dispatch identity missing");
  const generation = nativeGenerationBinding({
    feature_id: featureId,
    run_key: runKey,
    phase: "specify",
    version: 1,
    request_id: "native-task-call",
    dispatch_id: dispatchId,
    capability_id: dispatchRecord.work_identity.capability_id,
    capability_epoch: dispatchRecord.work_identity.capability_epoch,
    run_id: dispatchRecord.work_identity.run_id,
    workflow: dispatchRecord.work_identity.workflow,
    task_id: dispatchRecord.work_identity.task_id,
    worker_id: dispatchRecord.work_identity.worker_id,
  });
  const schema = specificationPhaseSchemaForConstitution(identities.value, binding, "specify", generation);
  assert.ok(schema);
  const item = {
    name: nativeWorkerName("specify", dispatchId),
    agent: "specification-worker",
    task: [
      marker,
      `NATIVE_WORKER_INPUT_REF schema=1 ref=spec-native:${featureId}:${runKey}:specify:${dispatchId} digest=${"0".repeat(64)}`,
      "The engine will inject the authoritative NATIVE_WORKER_INPUT in the child system prompt. Treat it as complete context. Author all prose and document body content in the selected language from NATIVE_WORKER_INPUT.language; preserve the selected template literal headings, markers, and placeholders exactly, even when they are in another language. Do not call any tool, read any source, delegate, or emit commentary; return exactly one strict structured worker_result object via yield. Copy engine_binding.input_ref and engine_binding.input_digest exactly into worker_result.input_ref and worker_result.input_digest. Yield once.",
    ].join("\n\n"),
    outputSchema: schema,
    schemaMode: "strict",
  };
  return { root, state: persisted, workspace, item, schema };
}

function envelope(item: Record<string, unknown>): Record<string, unknown> {
  return {
    i: NATIVE_SPECIFICATION_TASK_INTENT,
    context: "Engine-authorized native specification phase assignment.",
    tasks: [item],
  };
}

function workerResultFromSemanticModel(model: Record<string, any>, handoff: NativeSpecificationGenerationHandoff): Record<string, unknown> {
  return {
    input_ref: handoff.input_ref,
    input_digest: handoff.input_digest,
    sections: model.sections,
    requirements: model.requirements,
    decisions: model.decisions,
    tasks: model.tasks,
    verification: model.verification,
    contradictions: model.contradictions,
    constitution_principles: model.constitution_principles.map(({ principle_id, applicability, status, evidence }: Record<string, unknown>) => ({ principle_id, applicability, status, evidence })),
  };
}
function finalizeInput(handoff: NativeSpecificationGenerationHandoff, workerResult: unknown): { feature_id: string; run_key: string; worker_result: never } {
  return { feature_id: handoff.feature_id, run_key: handoff.run_key, worker_result: workerResult as never };
}

function finalizerSemanticModel(f: NativeGateFixture, handoff: NativeSpecificationGenerationHandoff): Record<string, any> {
  const pinned = PinnedProjectRoot.open(f.root);
  assert.ok(pinned);
  if (!pinned) throw new Error("native finalizer fixture root cannot be pinned");
  const identities = readPinnedConstitutionPrincipleIdentities(pinned, f.workspace.constitution_binding!);
  pinned.close();
  assert.equal(identities.ok, true, identities.ok ? "" : identities.error);
  if (!identities.ok) throw new Error(identities.error);
  return {
    schema_version: 1,
    feature_id: handoff.feature_id,
    run_key: handoff.run_key,
    phase: handoff.phase,
    version: handoff.version,
    worker: { role: handoff.role, agent: handoff.agent, dispatch_id: handoff.dispatch_id },
    constitution_binding: f.workspace.constitution_binding,
    upstream_versions: [],
    sections: {
      problem: "The native phase must produce a durable typed specification.",
      scope: "Persist one immutable specification artifact.",
      non_goals: "No application files are changed.",
      actors: "The engine and one analyst worker.",
      journeys: "The worker result is validated before a human checkpoint.",
      requirements: "REQ-1 is observable.",
      edge_cases: "Stale or malformed child data is rejected.",
      assumptions: "The approved constitution remains current.",
      dependencies: "The durable state and artifact store.",
      success_criteria: "A passing validation opens the checkpoint.",
    },
    requirements: [{ requirement_id: "REQ-1", statement: "The phase is durable.", acceptance_ids: ["AC-1"], source_refs: ["request"], testable: true, untestable_reason: null }],
    decisions: [],
    tasks: [],
    verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "Focused composite test" }],
    contradictions: [],
    constitution_principles: identities.value.map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable", status: "pass", evidence: "Ship tested work.", binding: f.workspace.constitution_binding })),
  };
}
function event(toolName: string, input: unknown): { toolName: string; input: unknown } {
  return { toolName, input };
}

function addPendingNativeFeature(root: string, source: TeamState, index: number): { featureId: string; workerName: string } {
  const featureId = `native-gate-feature-${index}`;
  const runKey = source.run_key!;
  const capability = source.dispatch_capability;
  assert.ok(capability?.capability_id && capability.issued_for && capability.dispatches?.length);
  const sourceRecord = capability.dispatches.find((candidate) => (candidate.purpose ?? "generation") === "generation");
  assert.ok(sourceRecord?.work_identity);
  if (!sourceRecord?.work_identity || !capability.capability_id || !capability.issued_for) throw new Error("fixture dispatch identity missing");
  const capabilityId = capability.capability_id;
  const dispatchId = `${sourceRecord.id}-wait-${index}`;
  const workIdentity = {
    ...sourceRecord.work_identity,
    dispatch_id: dispatchId,
  };
  const record = { ...sourceRecord, id: dispatchId, work_identity: workIdentity };
  const nextCapability = {
    ...capability,
    dispatches: [record],
  };
  const nextState: TeamState = {
    ...source,
    run_key: runKey,
    specification: source.specification ? {
      ...source.specification,
      feature_id: featureId,
      path_binding: source.specification.path_binding ? {
        ...source.specification.path_binding,
        specs: { ...source.specification.path_binding.specs, relative_path: `specs/${featureId}` },
        feature_state: { ...source.specification.path_binding.feature_state, relative_path: `.work-state/features/${featureId}` },
        artifacts: { ...source.specification.path_binding.artifacts, relative_path: `.work-state/features/${featureId}/artifacts` },
      } : source.specification.path_binding,
      workspace_path: `specs/${featureId}`,
      state_path: `.work-state/features/${featureId}/state.json`,
    } : source.specification,
    dispatch_capability: nextCapability,
    ...(source.preparation_start ? {
      preparation_start: { ...source.preparation_start, capability_id: capabilityId, dispatch_id: dispatchId },
    } : {}),
  };
  const featureDir = join(root, ".work-state", "features", featureId);
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(nextState) + "\n");
  return { featureId, workerName: nativeWorkerName("specify", dispatchId) };
}


function registeredTaskLifecycleHandlers(root: string, rebindSessions = false): Map<string, (event: unknown, ctx: unknown) => unknown> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  registerTestTeamWorkflow(root, {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (["session_start", "session_shutdown", "tool_call", "tool_result"].includes(name)) handlers.set(name, handler);
    },
  } as never, { observability: false, rebindSessions });
  return handlers;
}

function registeredToolCallHandler(root: string): (event: unknown, ctx: unknown) => unknown {
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  registerTestTeamWorkflow(root, {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (name === "tool_call") handlers.push(handler);
    },
  } as never, { observability: false });
  assert.equal(handlers.length, 1);
  return handlers[0]!;
}


test("featureless generic dispatch marker cannot fall through native gate", () => {
  const f = fixture();
  try {
    const marker = buildDispatchMarker(
      f.state.run_key!,
      stage,
      ["specification-analyst"],
      "specification-analyst",
      f.state.cursor_epoch!,
      f.state.dispatch_capability!.capability_id,
      "specification-analyst",
      dispatchTaskId(f.state.dispatch_capability!.capability_id!, f.state.run_key!, "main", "spec-preparation", "specify", "specification-analyst"),
    );
    const input = { ...f.item, task: marker };
    const genericEvent = { toolName: "task", input: { tasks: [input] } };
    const generic = dispatchGate(genericEvent, { cwd: f.root });
    assert.equal(generic, undefined, "the generic gate accepts optional feature_id, proving fall-through is permissive");
    const native = nativeSpecificationTaskGate(genericEvent, { cwd: f.root });
    assert.equal(native?.block, true, "native gate must classify a featureless marker before generic routing");
    assert.match(native?.reason ?? "", /marker_feature/u);

    const featurefulMarker = buildDispatchMarker(
      f.state.run_key!,
      stage,
      ["specification-analyst"],
      "specification-analyst",
      f.state.cursor_epoch!,
      f.state.dispatch_capability!.capability_id,
      "specification-analyst",
      dispatchTaskId(f.state.dispatch_capability!.capability_id!, f.state.run_key!, "main", "spec-preparation", "specify", "specification-analyst"),
      f.workspace.feature_id,
    );
    const malformedFeature = featurefulMarker.replace(/\sfeature_id=[^ ]+/u, " feature_id=../foreign");
    assert.notEqual(malformedFeature, marker, "malformed-feature case must not reuse the featureless marker");
    const malformed = nativeSpecificationTaskGate(event("task", { tasks: [{ ...input, task: malformedFeature }] }), { cwd: f.root });
    assert.equal(malformed?.block, true, "malformed feature binding must remain in the native gate");
    assert.match(malformed?.reason ?? "", /^native specification task: marker/u);

    const unrelatedMarker = buildDispatchMarker(
      "unrelated-run",
      stage,
      ["specification-analyst"],
      "specification-analyst",
      f.state.cursor_epoch!,
      f.state.dispatch_capability!.capability_id,
      "specification-analyst",
      dispatchTaskId(f.state.dispatch_capability!.capability_id!, "unrelated-run", "main", "spec-preparation", "specify", "specification-analyst"),
    );
    const unrelated = nativeSpecificationTaskGate(event("task", { tasks: [{ ...input, task: unrelatedMarker }] }), { cwd: f.root });
    assert.equal(unrelated, undefined, "a marker for an unrelated run must not activate the native gate");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate allows exactly the engine-authorized task and exact worker result read", () => {
  const f = fixture();
  try {
    assert.equal(nativeSpecificationGenerationActive(f.root), true);
    assert.equal(nativeSpecificationTaskGate(event("task", envelope(f.item)), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("task", { ...envelope(f.item), intent: NATIVE_SPECIFICATION_TASK_INTENT }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("task", { ...envelope(f.item), intent: "forged" }), { cwd: f.root })?.block, true);
    assert.equal(
      nativeSpecificationTaskGate(event("read", { path: `agent://${f.item.name}` }), { cwd: f.root }),
      undefined,
    );
    assert.equal(nativeSpecificationTaskGate(event("read", { path: `agent://${f.item.name}?q=.data` }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("eval", { code: "agent(...)" }), { cwd: f.root })?.block, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native task marker must be one byte-exact canonical descriptor", () => {
  const f = fixture();
  try {
    const variants = [
      ["leading prefix", "prefix " + f.item.task],
      ["trailing suffix", f.item.task.replace("\n\n", " suffix\n\n")],
      ["duplicate marker", f.item.task.replace("\n\n", "\n\n" + f.item.task.slice(0, f.item.task.indexOf("\n\n")) + "\n\n")],
    ] as const;
    for (const [label, task] of variants) {
      const result = nativeSpecificationTaskGate(
        event("task", envelope({ ...f.item, task })),
        { cwd: f.root },
      );
      assert.equal(result?.block, true, label + " must be rejected before child spawn");
      assert.match(result?.reason ?? "", /^native specification task: marker/u, label);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("bounded native context scans fail closed without blocking exact feature-bound dispatch", () => {
  const f = fixture();
  try {
    const features = join(f.root, ".work-state", "features");
    for (let index = 0; index < 1024; index += 1) mkdirSync(join(features, "overflow-" + String(index).padStart(4, "0")));

    assert.equal(nativeSpecificationGenerationActive(f.root), true, "overflow keeps native generation active fail-closed");
    assert.equal(nativeSpecificationTaskGate(event("task", envelope(f.item)), { cwd: f.root }), undefined, "exact feature-bound dispatch bypasses broad enumeration");

    const featureless = nativeSpecificationTaskGate(event("task", { tasks: [{ ...f.item, task: f.item.task.replace(/ feature_id=[^ ]+/u, "") }] }), { cwd: f.root });
    assert.equal(featureless?.block, true);
    assert.match(featureless?.reason ?? "", /context scan exceeded/iu);

    const unrelated = nativeSpecificationTaskGate(event("task", { tasks: [{ name: "other", agent: "other-agent", task: "unrelated" }] }), { cwd: f.root });
    assert.equal(unrelated?.block, true, "unrelated tasks cannot fall through an overflowing native scan");
    const evalBlocked = nativeSpecificationTaskGate(event("eval", { code: "agent(...)" }), { cwd: f.root });
    assert.equal(evalBlocked?.block, true, "non-task events remain blocked while native context enumeration is unsafe");
    assert.match(evalBlocked?.reason ?? "", /context scan exceeded/iu);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("malformed native feature directories fail closed for every broad event", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".work-state", "features", "malformed-feature"));
    assert.equal(nativeSpecificationTaskGate(event("task", envelope(f.item)), { cwd: f.root }), undefined, "exact feature dispatch remains directly resolvable");
    const blocked = nativeSpecificationTaskGate(event("eval", { code: "agent(...)" }), { cwd: f.root });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /context scan failed/iu);
    const readBlocked = nativeSpecificationTaskGate(event("read", { path: "README.md" }), { cwd: f.root });
    assert.equal(readBlocked?.block, true);
    assert.match(readBlocked?.reason ?? "", /context scan failed/iu);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native context scans ignore only strict observability-only feature buckets", () => {
  const f = fixture();
  try {
    const state = {
      ...f.state,
      specification: f.state.specification && {
        ...f.state.specification,
        phases: f.state.specification.phases.map((phase) => ({ ...phase, status: "not_started" as const })),
      },
    };
    writeState(f.root, state, { featureSlug: f.workspace.feature_id });
    for (const featureId of ["default", "legacy-feature"]) {
      const observability = join(f.root, ".work-state", "features", featureId, "observability");
      mkdirSync(observability, { recursive: true });
      writeFileSync(join(observability, "events.jsonl"), "{\"kind\":\"session_start\"}\n");
    }

    assert.equal(nativeSpecificationGenerationActive(f.root), false, "auxiliary observability buckets are not native feature contexts");
    assert.equal(nativeSpecificationTaskGate(event("read", { path: "README.md" }), { cwd: f.root }), undefined);

    writeFileSync(join(f.root, ".work-state", "features", "default", "partial-workspace.json"), "{}\n");
    const blocked = nativeSpecificationTaskGate(event("read", { path: "README.md" }), { cwd: f.root });
    assert.equal(blocked?.block, true, "an observability bucket with any workspace-shaped sibling remains fail-closed");
    assert.match(blocked?.reason ?? "", /context scan failed/iu);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("bounded context scan stays inactive when all entries are non-generating", () => {
  const f = fixture();
  try {
    const state = {
      ...f.state,
      specification: f.state.specification && {
        ...f.state.specification,
        phases: f.state.specification.phases.map((phase) => ({ ...phase, status: "not_started" as const })),
      },
    };
    writeState(f.root, state, { featureSlug: f.workspace.feature_id });
    assert.equal(nativeSpecificationGenerationActive(f.root), false);
    assert.equal(nativeSpecificationTaskGate(event("eval", { code: "agent(...)" }), { cwd: f.root }), undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("registered native hook binds gates and auth to the authoritative session cwd", () => {
  const f = fixture();
  try {
    const mounted = registeredToolCallHandler(f.root);
    const manager = { getCwd: () => f.root };
    const exact = { type: "tool_call", toolCallId: "manager-cwd-exact", toolName: "task", input: envelope(f.item) };
    assert.equal(
      mounted(exact, { sessionManager: manager }),
      undefined,
      "a missing raw cwd must use the authoritative session manager cwd",
    );
    assert.equal(
      mounted({ ...exact, toolCallId: "manager-cwd-stale", }, { cwd: join(tmpdir(), "stale-context"), sessionManager: manager }),
      undefined,
      "a stale raw cwd must not override the authoritative session manager cwd",
    );
    const statePath = join(f.root, ".work-state", "features", f.workspace.feature_id, "state.json");
    const before = JSON.parse(readFileSync(statePath, "utf8")) as { stage_cursor?: string };
    const blocked = mounted(
      { ...exact, toolCallId: "manager-cwd-throws" },
      { cwd: f.root, sessionManager: { getCwd: () => { throw new Error("manager unavailable"); } } },
    ) as { block?: boolean; reason?: string } | undefined;
    assert.equal(blocked?.block, true, "an unavailable authoritative session manager must fail closed");
    const after = JSON.parse(readFileSync(statePath, "utf8")) as { stage_cursor?: string };
    assert.equal(after.stage_cursor, before.stage_cursor, "an unavailable session must not redirect the authenticated transition to another root");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate allows only exact result reads and bounded coordinator waits", () => {
  const f = fixture();
  try {
    symlinkSync("CONSTITUTION.md", join(f.root, "constitution-link.md"));
    assert.equal(nativeSpecificationTaskGate(event("read", { path: "skill://systematic-planning" }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("read", { path: "CONSTITUTION.md" }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("read", { path: "constitution-link.md" }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("read", { path: "." }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("read", { path: "CONSTITUTION.md:1-2" }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait" }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", timeoutMs: 60_000 }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("hub", { i: "wait for worker", op: "wait", timeoutMs: 120_000, ids: [f.item.name] }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("hub", { i: "wait for worker", op: "wait", timeoutMs: 120_000, from: f.item.name }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", from: "Main" }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", ids: ["foreign-worker"] }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", ids: [f.item.name, f.item.name] }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", ids: [f.item.name], from: f.item.name }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { i: "x".repeat(513), op: "wait" }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { i: "line\nfeed", op: "wait" }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", timeoutMs: 0 }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "wait", timeoutMs: 630_001 }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { op: "jobs" }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("hub", { i: "line\nfeed", op: "wait" }), { cwd: f.root })?.block, true);
    const workerSession = { cwd: f.root, sessionFile: join(f.root, `${f.item.name}.jsonl`), sessionBasename: `${f.item.name}.jsonl` };
    assert.equal(nativeSpecificationTaskGate(event("yield", { data: { worker_result: { requirements: [] } } }), workerSession), undefined);
    assert.equal(nativeSpecificationTaskGate(event("yield", { data: { worker_result: { requirements: [] } } }), { cwd: f.root })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("yield", {}), { ...workerSession, sessionFile: join(f.root, "timestamp_uuid.jsonl"), sessionBasename: "timestamp_uuid.jsonl" })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("yield", {}), { ...workerSession, sessionFile: join(f.root, "foreign.jsonl"), sessionBasename: "foreign.jsonl" })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("yield", {}), { ...workerSession, sessionFile: `${f.root}/../${f.item.name}.jsonl`, sessionBasename: `${f.item.name}.jsonl` })?.block, true);
    assert.equal(nativeSpecificationTaskGate(event("return", { data: { worker_result: { requirements: [] } } }), workerSession)?.block, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native coordinator waits validate every pending context and exact worker identifiers", () => {
  const f = fixture();
  try {
    const second = addPendingNativeFeature(f.root, f.state, 2);
    const third = addPendingNativeFeature(f.root, f.state, 3);
    const workers = [f.item.name, second.workerName, third.workerName];
    const allPending = (input: Record<string, unknown>) => nativeSpecificationTaskGate(event("hub", input), { cwd: f.root });

    assert.equal(allPending({ op: "wait", ids: workers, timeoutMs: 60_000 }), undefined, "all pending workers must be accepted");
    assert.equal(allPending({ op: "wait", ids: [workers[0]] }), undefined, "one exact pending worker must be accepted");
    assert.equal(allPending({ op: "wait", ids: workers.slice(0, 2) }), undefined, "an exact pending-worker subset must be accepted");
    assert.equal(allPending({ op: "wait", from: second.workerName }), undefined, "from must target one exact pending worker");
    assert.equal(allPending({ op: "wait" })?.block, true, "bare wait must not broaden to all pending workers");
    assert.equal(allPending({ op: "wait", ids: [...workers, "foreign-worker"] })?.block, true, "an unknown worker superset must be rejected");
    assert.equal(allPending({ op: "wait", ids: [workers[0], workers[0], workers[1]] })?.block, true, "duplicate worker IDs must be rejected");
    assert.equal(allPending({ op: "wait", from: "foreign-worker" })?.block, true, "an unknown from worker must be rejected");

    const primaryPath = join(f.root, ".work-state", "features", f.workspace.feature_id, "state.json");
    const primary = JSON.parse(readFileSync(primaryPath, "utf8")) as TeamState;
    assert.ok(primary.specification);
    if (!primary.specification) return;
    writeFileSync(primaryPath, JSON.stringify({
      ...primary,
      specification: {
        ...primary.specification,
        phases: primary.specification.phases.map((phase) => phase.phase === "specify" ? { ...phase, status: "not_started" as const } : phase),
      },
    }) + "\n");
    assert.equal(allPending({ op: "wait", ids: [second.workerName, third.workerName] }), undefined, "the exact pending-worker set must remain accepted after completion");
    assert.equal(allPending({ op: "wait", ids: [second.workerName] }), undefined, "an exact pending subset must remain accepted after completion");
    assert.equal(allPending({ op: "wait", ids: [workers[0]] })?.block, true, "a completed worker must not be accepted");
    assert.equal(allPending({ op: "wait" })?.block, true, "bare wait must remain blocked with two pending workers");

    for (const featureId of [second.featureId, third.featureId]) {
      const statePath = join(f.root, ".work-state", "features", featureId, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
      writeFileSync(statePath, JSON.stringify({
        ...state,
        dispatch_capability: state.dispatch_capability ? {
          ...state.dispatch_capability,
          dispatches: (state.dispatch_capability.dispatches ?? []).map((record) => ({ ...record, status: "succeeded" as const })),
        } : state.dispatch_capability,
      }) + "\n");
    }
    assert.equal(allPending({ op: "wait" })?.block, true, "wait must be blocked when no native generation remains pending");
    assert.equal(allPending({ op: "wait", ids: [second.workerName] })?.block, true, "a nonpending worker must not be accepted");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate reports bounded non-secret validation codes", () => {
  const f = fixture();
  try {
    const cases: Array<{ label: string; input: unknown; reason: string; secret?: string }> = [
      {
        label: "top key set",
        input: { ...envelope(f.item), extra: "top-secret" },
        reason: 'native specification task: top_keys; top_keys=["context","extra","i","tasks"]',
        secret: "top-secret",
      },
      { label: "i", input: { ...envelope(f.item), i: "forged-i" }, reason: "native specification task: i", secret: "forged-i" },

      {
        label: "optional intent",
        input: { ...envelope(f.item), intent: "forged-intent" },
        reason: "native specification task: optional_intent",
        secret: "forged-intent",
      },
      { label: "context", input: { ...envelope(f.item), context: "   " }, reason: "native specification task: context" },
      { label: "tasks type", input: { ...envelope(f.item), tasks: "tasks-secret" }, reason: "native specification task: marker", secret: "tasks-secret" },
      {
        label: "tasks count",
        input: { ...envelope(f.item), tasks: [f.item, f.item] },
        reason: "native specification task: marker",
      },
      { label: "item object", input: { ...envelope(f.item), tasks: [["item-secret"]] }, reason: "native specification task: marker", secret: "item-secret" },
      {
        label: "item key set",
        input: { ...envelope(f.item), tasks: [{ ...f.item, extra: "item-secret" }] },
        reason: 'native specification task: item_keys; item_keys=["agent","extra","name","outputSchema","schemaMode","task"]',
        secret: "item-secret",
      },
      { label: "agent", input: { ...envelope({ ...f.item, agent: "agent-secret" }) }, reason: "native specification task: agent", secret: "agent-secret" },
      { label: "task type", input: { ...envelope({ ...f.item, task: 42 }) }, reason: "native specification task: marker" },
      { label: "marker", input: { ...envelope({ ...f.item, task: "marker-secret" }) }, reason: "native specification task: marker", secret: "marker-secret" },
      {
        label: "digest",
        input: { ...envelope({ ...f.item, task: String(f.item.task).replace(/task=[^\s]+/u, "task=forged-digest") }) },
        reason: "native specification task: digest",
        secret: "forged-digest",
      },
      { label: "schema mode", input: { ...envelope({ ...f.item, schemaMode: "schema-mode-secret" }) }, reason: "native specification task: schema_mode", secret: "schema-mode-secret" },
      {
        label: "canonical schema",
        input: { ...envelope({ ...f.item, outputSchema: { ...(f.item.outputSchema as Record<string, unknown>), title: "schema-secret" } }) },
        reason: "native specification task: canonical_schema",
        secret: "schema-secret",
      },
    ];
    for (const candidate of cases) {
      const result = nativeSpecificationTaskGate(event("task", candidate.input), { cwd: f.root });
      assert.equal(result?.block, true, `${candidate.label} must be rejected`);
      assert.equal(result?.reason, candidate.reason, `${candidate.label} reason code`);
      if (candidate.secret) assert.doesNotMatch(result?.reason ?? "", new RegExp(candidate.secret, "u"), `${candidate.label} must not echo input text`);
    }
    const normalized = { context: NATIVE_SPECIFICATION_TASK_CONTEXT, tasks: [f.item] };
    assert.equal(nativeSpecificationTaskGate(event("task", normalized), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("task", { ...normalized, i: NATIVE_SPECIFICATION_TASK_INTENT }), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("task", { ...normalized, i: "forged-i" }), { cwd: f.root })?.reason, "native specification task: i");
    assert.equal(nativeSpecificationTaskGate(event("task", { ...normalized, intent: "forged-intent" }), { cwd: f.root })?.reason, "native specification task: optional_intent");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate reports typed exact-marker diagnostics without exposing state or marker data", () => {
  const f = fixture();
  try {
    const statePath = join(f.root, ".work-state", "features", f.workspace.feature_id, "state.json");
    const originalState = readFileSync(statePath, "utf8");
    const marker = String(f.item.task);
    const run = (input: unknown, cwd = f.root): string | undefined => nativeSpecificationTaskGate(event("task", input), { cwd })?.reason;
    const expectMarker = (text: string, code: string): void => {
      const reason = run(envelope({ ...f.item, task: text }));
      assert.equal(reason, `native specification task: marker_${code}`);
      assert.doesNotMatch(reason ?? "", /native-task-secret|forged|native-gate-run|native-gate-feature/u);
    };

    {
      const missingRoot = join(f.root, "missing-root");
      assert.equal(run(envelope(f.item), missingRoot), "native specification task: marker_root_pin");
    }
    unlinkSync(statePath);
    assert.equal(run(envelope(f.item)), "native specification task: marker_state_read");
    writeFileSync(statePath, "{\n");
    assert.equal(run(envelope(f.item)), "native specification task: marker_state_parse");
    writeFileSync(statePath, JSON.stringify({ ...f.state, run_key: "forged-run" }) + "\n");
    assert.equal(run(envelope(f.item)), "native specification task: marker_run_mismatch");
    writeFileSync(statePath, JSON.stringify({ ...f.state, specification: { ...f.state.specification!, workspace_path: "forged-workspace" } }) + "\n");
    assert.equal(run(envelope(f.item)), "native specification task: marker_state_invalid");
    writeFileSync(statePath, JSON.stringify({ ...f.state, specification: { ...f.state.specification!, phases: f.state.specification!.phases.map((phase) => phase.phase === "specify" ? { ...phase, status: "not_started" } : phase) } }) + "\n");
    assert.equal(run(envelope(f.item)), "native specification task: marker_phase_context");
    writeFileSync(statePath, originalState);

    expectMarker(marker.replace("stage=specify", "stage=plan"), "stage");
    expectMarker(marker.replace("kind=single", "kind=consilium"), "kind");
    expectMarker(marker.replace(/cursor=[^ ]+/u, "cursor=forged-cursor"), "cursor");
    expectMarker(marker.replace(/capability=[^ ]+/u, "capability=forged-capability"), "capability");
    expectMarker(marker.replace(/ role=[^ ]+/u, " role=forged-role"), "role");
    expectMarker(marker.replace(/ slot=[^ ]+/u, " slot=forged-slot"), "slot");
    expectMarker(marker.replace(/roles=[^ ]+/u, "roles=forged-role"), "roles");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate admits only engine-owned workflow devices and re-evaluates native entry and exit", () => {
  const f = fixture();
  try {
    const engineDevices = [
      "workflow_prepare",
      "workflow_begin",
      "workflow_status",
      "workflow_instructions",
      "workflow_dispatch_specification_phase",
      "workflow_persist_specification_phase",
      "workflow_complete",
      "workflow_start_native_specification_phase",
      "workflow_finalize_native_specification_phase",
      "workflow_begin_phase_validation",
      "workflow_validate_phase",
      "workflow_checkpoint",
      "workflow_checkpoint_ask_selected",
      "workflow_advance",
    ];
    for (const device of engineDevices) {
      assert.equal(nativeSpecificationTaskGate(event("write", { path: `xd://${device}`, content: "{}" }), { cwd: f.root }), undefined, device + " must remain available to native recovery");
    }
    const mounted = registeredToolCallHandler(f.root);
    for (const device of engineDevices) {
      const mountedEvent = {
        type: "tool_call",
        toolCallId: `mounted-${device}`,
        toolName: device,
        input: {},
      };
      assert.equal(mounted(mountedEvent, { cwd: f.root }), undefined, device + " must remain available after host mounting");
    }
    for (const spoof of [
      "workflow_prepare_extra",
      "workflow_finalize_native_specification_phase_extra",
      "xd://workflow_prepare",
    ]) {
      assert.equal(nativeSpecificationTaskGate(event(spoof, {}), { cwd: f.root })?.block, true, spoof + " must not be admitted as a mounted workflow tool");
    }
    assert.equal(nativeSpecificationTaskGate(event("workflow_finalize_native_specification_phase", []), { cwd: f.root })?.block, true, "mounted workflow tools require object input");
    const unknown = mounted({ type: "tool_call", toolCallId: "unknown-device", toolName: "write", input: { path: "xd://workflow_third_party", content: "{}" } }, { cwd: f.root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(unknown?.block, true, "unknown mounted workflow devices must be denied");

    const malformedTask = { type: "tool_call", toolCallId: "native-race", toolName: "task", input: { ...envelope(f.item), tasks: [] } };
    const active = mounted(malformedTask, { cwd: f.root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(active?.block, true);
    assert.match(active?.reason ?? "", /native specification/iu);

    const current = resolveState(f.root, "main").state;
    assert.ok(current?.specification);
    if (!current?.specification) return;
    writeState(f.root, {
      ...current,
      specification: {
        ...current.specification,
        phases: current.specification.phases.map((phase) => phase.phase === "specify" ? { ...phase, status: "not_started" as const } : phase),
      },
    }, { featureSlug: current.specification.feature_id });
    assert.equal(nativeSpecificationGenerationActive(f.root), false, "gate must leave native mode when the phase is no longer generating");
    const exited = mounted(malformedTask, { cwd: f.root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(exited?.block, true, "closed native envelope must remain blocked after native mode exits");
    assert.match(exited?.reason ?? "", /native specification/iu);

    const exitedState = resolveState(f.root, "main").state;
    assert.ok(exitedState?.specification);
    if (!exitedState?.specification) return;
    writeState(f.root, {
      ...exitedState,
      specification: {
        ...exitedState.specification,
        phases: exitedState.specification.phases.map((phase) => phase.phase === "specify" ? { ...phase, status: "generating" as const } : phase),
      },
    }, { featureSlug: exitedState.specification.feature_id });
    assert.equal(nativeSpecificationGenerationActive(f.root), true, "gate must re-enter native mode from current state");
    const reentered = mounted(malformedTask, { cwd: f.root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(reentered?.block, true);
    assert.match(reentered?.reason ?? "", /native specification/iu);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("registered native hook uses the exact task payload shape and rejects count or forged items", () => {
  const f = fixture();
  const handler = registeredToolCallHandler(f.root);
  try {
    const context = { cwd: f.root };
    const exactEvent = {
      type: "tool_call",
      toolCallId: "native-task-call",
      toolName: "task",
      input: envelope(f.item),
    };
    assert.equal(handler(exactEvent, context), undefined);

    for (const input of [
      { ...envelope(f.item), extra: "forged" },
      { ...envelope(f.item), tasks: [] },
      { ...envelope(f.item), tasks: [f.item, f.item] },
      { ...envelope(f.item), tasks: [f.item, "schemaModeRequirement???", "schemaModeRequirement"] },
      { ...envelope(f.item), tasks: [{ ...f.item, name: "forged-worker" }] },
    ]) {
      const result = handler({ ...exactEvent, input }, context) as { block?: boolean } | undefined;
      assert.equal(result?.block, true);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate rejects count, identity, marker, schema, stale, and bypass mutations", () => {
  const cases: Array<[string, (item: Record<string, unknown>, fixture: NativeGateFixture) => Record<string, unknown>]> = [
    ["count", (item) => ({ ...envelope(item), tasks: [item, item] })],
    ["name", (item) => envelope({ ...item, name: "wrong-worker" })],
    ["agent", (item) => envelope({ ...item, agent: "developer" })],
    ["schema", (item) => envelope({ ...item, outputSchema: { ...(item.outputSchema as Record<string, unknown>), title: "forged" } })],
    ["malformed schema", (item) => envelope({ ...item, outputSchema: { type: "object", additionalProperties: true } })],
    ["marker", (item) => envelope({ ...item, task: String(item.task).replace("run=native-gate-run", "run=stale-run") })],
  ];
  for (const [label, mutate] of cases) {
    const f = fixture();
    try {
      assert.equal(nativeSpecificationTaskGate(event("task", mutate(f.item, f)), { cwd: f.root })?.block, true, label);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }

  const stale = fixture();
  try {
    const staleState: TeamState = {
      ...stale.state,
      profile_hash: "0".repeat(64),
    };
    writeState(stale.root, staleState, { featureSlug: "native-gate-feature" });
    assert.equal(nativeSpecificationTaskGate(event("task", envelope(stale.item)), { cwd: stale.root })?.block, true, "stale capability/profile");
  } finally {
    rmSync(stale.root, { recursive: true, force: true });
  }
});

test("native gate compares schemas as bounded canonical JSON trees", () => {
  const f = fixture();
  try {
    const roundTripped = JSON.parse(JSON.stringify(f.schema)) as Record<string, unknown>;
    assert.equal(
      nativeSpecificationTaskGate(event("task", envelope({ ...f.item, outputSchema: roundTripped })), { cwd: f.root }),
      undefined,
      "a JSON round-trip must not be rejected because shared schema aliases were flattened",
    );

    const reorderKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorderKeys);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reorderKeys(item)]));
      }
      return value;
    };
    const reordered = reorderKeys(f.schema) as Record<string, unknown>;
    assert.equal(
      nativeSpecificationTaskGate(event("task", envelope({ ...f.item, outputSchema: reordered })), { cwd: f.root }),
      undefined,
      "object key insertion order must not affect the schema identity",
    );

    const mutations: Array<[string, (schema: Record<string, unknown>) => void]> = [
      ["const", (schema) => {
        const properties = schema.properties as Record<string, unknown>;
        const principles = properties.constitution_principles as Record<string, unknown>;
        const item = principles.items as Record<string, unknown>;
        const principleProperties = item.properties as Record<string, unknown>;
        (principleProperties.principle_id as Record<string, unknown>).const = "forged";
      }],
      ["required", (schema) => {
        schema.required = (schema.required as unknown[]).slice(1);
      }],
      ["additionalProperties", (schema) => {
        schema.additionalProperties = true;
      }],
    ];
    for (const [label, mutate] of mutations) {
      const forged = JSON.parse(JSON.stringify(f.schema)) as Record<string, unknown>;
      mutate(forged);
      const result = nativeSpecificationTaskGate(event("task", envelope({ ...f.item, outputSchema: forged })), { cwd: f.root });
      assert.equal(result?.block, true, `${label} schema mutation must be rejected`);
      assert.equal(result?.reason, "native specification task: canonical_schema");
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native gate treats an identical task replay as idempotent, not a second spawn", () => {
  const f = fixture();
  try {
    const input = envelope(f.item);
    assert.equal(nativeSpecificationTaskGate(event("task", input), { cwd: f.root }), undefined);
    assert.equal(nativeSpecificationTaskGate(event("task", input), { cwd: f.root }), undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});


function testOnForRoot(root: string): (event: string, handler: (event: unknown, context: unknown) => void) => void {
  return (event, handler) => {
    if (event === "session_start") handler({}, TEST_CONTEXT(root));
  };
}

async function selectedHostAsk(
  root: string,
  input: Parameters<typeof validateCheckpointAskSelected>[1],
  decision: string,
): Promise<Record<string, unknown>> {
  const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
  registerTestWorkflowTools(root, {
    zod: { z: zod },
    on: testOnForRoot(root),
    registerTool(tool: unknown) {
      const mounted = tool as { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
      tools.set(mounted.name, mounted);
    },
  } as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd });
  const ask = tools.get("workflow_checkpoint_ask_selected");
  assert.ok(ask, "selected Ask tool must be mounted");
  const response = await ask.execute("native-finalizer-host-ask", input, undefined, undefined, {
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
            selectedOptions: [decision],
          }],
        };
      },
    },
  });
  return response.details;
}

function attachPreparationHandoff(root: string, state: TeamState): TeamState {
  const stateRevision = state.state_revision ?? 0;
  assert.ok(stateRevision > 0, "fixture state must have a committed revision before issuing preparation authority");
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  if (!pinned) throw new Error("fixture root could not be pinned");
  const preparation_handoff = createPreparationHandoff({
    feature_id: state.specification!.feature_id,
    run_key: state.run_key!,
    branch: state.branch,
    task: state.task,
    classification: state.classification,
    state_revision: stateRevision,
    state_digest: preparationStateDigest(state, stateRevision),
    root_identity: { canonical_path: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino },
    source_kind: state.specification!.source_kind,
    constitution_binding: state.specification!.constitution_binding,
    constitution_gate_ref: state.specification!.constitution_gate_ref,
    capacity: 1,
    authentication: {
      source_kind: state.specification!.source_kind,
      constitution_binding: state.specification!.constitution_binding,
      constitution_gate_ref: state.specification!.constitution_gate_ref,
      capacity: 1,
      pinned_root: pinned,
    },
  });
  pinned.close();
  writeState(root, { ...state, preparation_handoff }, { featureSlug: state.specification!.feature_id });
  const persisted = resolveState(root, "main", { feature_id: state.specification!.feature_id, run_key: state.run_key! }).state;
  assert.ok(persisted?.preparation_handoff);
  return persisted!;
}


test("native start rejects missing, blocked, or pending-impact gate before begin and retries cleanly", () => {
  for (const mode of ["missing", "blocked", "impact"] as const) {
    const f = fixture();
    const gatePath = join(f.root, ".work-state", "specification", "constitution", "gate.json");
    let gateBytes: Buffer;
    try {
      const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
      const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
      const before = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! });
      gateBytes = readFileSync(gatePath);
      if (mode === "missing") {
        unlinkSync(gatePath);
      } else if (mode === "blocked") {
        const gate = JSON.parse(gateBytes.toString("utf8")) as { gate: { status: string; checkpoint_ref: string | null } };
        gate.gate.status = "blocked";
        gate.gate.checkpoint_ref = null;
        writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
      } else {
        writeFileSync(join(f.root, ".work-state", "specification", "constitution", "constitution-impact-transaction-" + "0".repeat(64) + ".json"), "{}\n", "utf8");
      }
      const rejected = startNativeSpecificationPhase(f.root, {
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        preparation_handoff: prepared.preparation_handoff!,
      });
      assert.equal(rejected.ok, false, mode + " gate state must fail closed before beginCapability");
      const after = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! });
      assert.equal(digestOf(after.state), digestOf(before.state), mode + " rejection must not mutate capability or phase state");
      writeFileSync(gatePath, gateBytes);
      if (mode === "impact") {
        rmSync(join(f.root, ".work-state", "specification", "constitution", "constitution-impact-transaction-" + "0".repeat(64) + ".json"), { force: true });
      }
      const retried = startNativeSpecificationPhase(f.root, {
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        preparation_handoff: prepared.preparation_handoff!,
      });
      assert.equal(retried.ok, true, mode + " corrected retry must issue exactly one worker start");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("native start rolls back begin and dispatch when constitution drifts at each final CAS", () => {
  for (const boundary of ["dispatch", "marker"] as const) {
    const f = fixture();
    let beforeCas = 0;
    try {
      const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
      const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
      const before = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      const originalConstitution = readFileSync(join(f.root, "CONSTITUTION.md"), "utf8");
      setStateTransactionTestHooks({
        beforeCas: () => {
          beforeCas += 1;
          const expectedBoundary = boundary === "dispatch" ? 2 : 3;
          if (beforeCas === expectedBoundary) writeFileSync(join(f.root, "CONSTITUTION.md"), originalConstitution + "\nCAS drift\n", "utf8");
        },
      }, f.root);
      const rejected = startNativeSpecificationPhase(f.root, {
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        preparation_handoff: prepared.preparation_handoff!,
      });
      assert.equal(rejected.ok, false, boundary + " constitution drift must reject the native start");
      assert.ok(beforeCas >= (boundary === "dispatch" ? 2 : 3), boundary + " hook must run at its intended CAS boundary");
      const after = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      const comparable = (candidate: TeamState) => { const copy = structuredClone(candidate) as TeamState; delete copy.updated_at; delete copy.state_revision; return copy; };
      assert.equal(digestOf(comparable(after)), digestOf(comparable(before)), boundary + " rejection must leave no orphan capability, dispatch, marker, or workspace transition");
      assert.equal(after.preparation_start, undefined, boundary + " rejection must not leave a preparation marker");
      assert.equal(after.dispatch_capability?.dispatches?.length ?? 0, 0, boundary + " rejection must not leave an orphan dispatch");
      setStateTransactionTestHooks(null, f.root);
      writeFileSync(join(f.root, "CONSTITUTION.md"), originalConstitution, "utf8");
      const retryState = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      const retryPrepared = attachPreparationHandoff(f.root, retryState);
      const retried = startNativeSpecificationPhase(f.root, {
        feature_id: retryPrepared.specification!.feature_id,
        run_key: retryPrepared.run_key!,
        preparation_handoff: retryPrepared.preparation_handoff!,
      });
      assert.equal(retried.ok, true, boundary + " corrected retry must issue one native start: " + (retried.ok ? "" : retried.error));
    } finally {
      setStateTransactionTestHooks(null, f.root);
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
test("native start composes begin, instructions, and dispatch into one exact task envelope", () => {
  const f = fixture();
  try {
    // Start is the first dispatch on a fresh native capability; the shared
    // gate fixture already contains an authorized record for its gate tests.
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const result = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    assert.equal(result.value.required_next_tool.name, "task");
    assert.deepEqual(Object.keys(result.value.required_next_tool.arguments).sort(), ["context", "i", "tasks"]);
    const taskArgs = result.value.required_next_tool.arguments;
    assert.equal(taskArgs.i, "Dispatching specification phase worker");
    assert.equal(taskArgs.context, "Engine-authorized native specification phase assignment.");
    assert.equal(taskArgs.tasks.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(taskArgs), "utf8") <= 8 * 1024, `serialized native task arguments must stay within 8 KiB (got ${Buffer.byteLength(JSON.stringify(taskArgs), "utf8")} bytes)`);
    assert.ok(Buffer.byteLength(JSON.stringify(result.value), "utf8") <= 45 * 1024, `serialized native start result must stay within 45 KiB (got ${Buffer.byteLength(JSON.stringify(result.value), "utf8")} bytes)`);
    assert.deepEqual(Object.keys(taskArgs.tasks[0]).sort(), ["agent", "name", "outputSchema", "schemaMode", "task"]);
    assert.equal(taskArgs.tasks[0].schemaMode, "strict");
    assert.equal(taskArgs.tasks[0].agent, "specification-worker");
    assert.match(taskArgs.tasks[0].name, /^spec-specify-/);
    assert.match(taskArgs.tasks[0].task, /^<!-- omp-dispatch /);
    const replayState = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
    assert.match(taskArgs.tasks[0].task, /NATIVE_WORKER_INPUT_REF schema=1 ref=spec-native:[^ ]+ digest=[a-f0-9]{64}/u);
    assert.match(taskArgs.tasks[0].task, /engine will inject the authoritative NATIVE_WORKER_INPUT/iu);
    assert.doesNotMatch(taskArgs.tasks[0].task, /document_text|Project Constitution v1\.0\.0|requester_context|upstream_artifact_refs/u);
    assert.doesNotMatch(JSON.stringify(result.value.handoff), /document_text|authoritative_input|NATIVE_WORKER_INPUT/u);
    assert.doesNotMatch(JSON.stringify(result.value), /document_text|authoritative_input/u);
    assert.match(taskArgs.tasks[0].task, /return exactly one strict structured worker_result object via yield/iu);
    assert.match(result.value.next_action, /hub \{op:"wait",ids:\["<exact-child-id>"\]\}/u);
    assert.match(result.value.next_action, /never a bare wait when multiple native contexts are active/u);
    assert.doesNotMatch(taskArgs.tasks[0].task, /agent:\/\/|\bhub\b|\bworkflow\b|report_issue|task spawning|schema\/test\/repo exploration/iu);
    const replay = startNativeSpecificationPhase(f.root, {
      feature_id: replayState.specification!.feature_id,
      run_key: replayState.run_key!,
      preparation_handoff: replayState.preparation_handoff!,
    });
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (replay.ok) {
      assert.equal(replay.replayed, true);
      assert.equal(replay.value.handoff.capability_id, result.value.handoff.capability_id, "replay must retain the authenticated capability lineage");
      assert.equal(replay.value.handoff.dispatch_id, result.value.handoff.dispatch_id, "replay must retain the authenticated dispatch lineage");
      assert.deepEqual(replay.value.required_next_tool, result.value.required_next_tool);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});


test("native start consumes one trusted proof and recovers an interrupted begin", () => {
  const run = (crash: boolean): void => {
    const f = fixture();
    try {
      const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
      const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
      const proof = issueCurrentTrustedMappingProof(f.root);
      assert.ok(proof, "native start fixture must expose a current trusted mapping proof");
      let injected = false;
      if (crash) {
        setSpecificationPhaseFailureInjector((point) => {
          if (!injected && point === "after_capability_begin") {
            injected = true;
            throw new Error("injected after_capability_begin");
          }
        });
      }
      let started: ReturnType<typeof startNativeSpecificationPhase> | undefined;
      if (crash) {
        assert.throws(() => startNativeSpecificationPhase(f.root, {
          feature_id: prepared.specification!.feature_id,
          run_key: prepared.run_key!,
          preparation_handoff: prepared.preparation_handoff!,
        }, { trustedMappingProof: proof }), /injected after_capability_begin/u, "an interrupted begin must surface the lost response");
      } else {
        started = startNativeSpecificationPhase(f.root, {
          feature_id: prepared.specification!.feature_id,
          run_key: prepared.run_key!,
          preparation_handoff: prepared.preparation_handoff!,
        }, { trustedMappingProof: proof });
      }
      if (crash) {
        assert.equal(injected, true);
        setSpecificationPhaseFailureInjector(null);
        const interrupted = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
        assert.equal(interrupted.preparation_start?.status, "begun");
        assert.equal(interrupted.dispatch_capability?.dispatches?.length ?? 0, 0);
        const resumed = startNativeSpecificationPhase(f.root, {
          feature_id: prepared.specification!.feature_id,
          run_key: prepared.run_key!,
          preparation_handoff: prepared.preparation_handoff!,
        }, { trustedMappingProof: proof });
        assert.equal(resumed.ok, true, resumed.ok ? "" : resumed.error);
        if (!resumed.ok) return;
        assert.equal(resumed.replayed, true, "begin recovery must report replay");
        const recovered = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
        assert.equal(recovered.preparation_start?.status, "started");
        assert.equal(recovered.dispatch_capability?.dispatches?.length ?? 0, 1, "begin recovery must dispatch once");
        const forgedMarker = recovered.preparation_start;
        assert.ok(forgedMarker);
        if (!forgedMarker) return;
        writeState(f.root, { ...recovered, preparation_start: { ...forgedMarker, profile_hash: "0".repeat(64) } }, { featureSlug: prepared.specification!.feature_id });
        const forged = startNativeSpecificationPhase(f.root, {
          feature_id: prepared.specification!.feature_id,
          run_key: prepared.run_key!,
          preparation_handoff: prepared.preparation_handoff!,
        }, { trustedMappingProof: proof });
        assert.equal(forged.ok, false, "a forged near-match marker must fail closed");
        assert.equal(resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state?.dispatch_capability?.dispatches?.length ?? 0, 1, "forged retry must not duplicate the dispatch");
        return;
      }
      assert.ok(started, "normal start must return a result");
      if (!started) return;
      assert.equal(started.ok, true, started.ok ? "" : started.error);
      if (!started.ok) return;
      const afterStart = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      assert.equal(afterStart.preparation_start?.status, "started");
      assert.equal(afterStart.dispatch_capability?.dispatches?.length ?? 0, 1);
      const replay = startNativeSpecificationPhase(f.root, {
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        preparation_handoff: prepared.preparation_handoff!,
      }, { trustedMappingProof: proof });
      assert.equal(replay.ok, false, "a consumed proof cannot replay an already-dispatched start");
      assert.equal(resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state?.dispatch_capability?.dispatches?.length ?? 0, 1);
    } finally {
      setSpecificationPhaseFailureInjector(null);
      rmSync(f.root, { recursive: true, force: true });
    }
  };
  run(false);
  run(true);
});

test("native start repairs a committed dispatch after marker receipt crashes", () => {
  const f = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const proof = issueCurrentTrustedMappingProof(f.root);
    assert.ok(proof);
    let injected = false;
    setSpecificationPhaseFailureInjector((point) => {
      if (!injected && point === "after_start_dispatch") {
        injected = true;
        throw new Error("injected after_start_dispatch");
      }
    });
    assert.throws(() => startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    }, { trustedMappingProof: proof }), /injected after_start_dispatch/u);
    setSpecificationPhaseFailureInjector(null);
    const interrupted = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
    assert.equal(interrupted.preparation_start?.status, "begun");
    assert.equal(interrupted.dispatch_capability?.dispatches?.length ?? 0, 1);
    const repaired = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    }, { trustedMappingProof: proof });
    assert.equal(repaired.ok, true, repaired.ok ? "" : repaired.error);
    if (!repaired.ok) return;
    assert.equal(repaired.replayed, true);
    const after = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
    assert.equal(after.preparation_start?.status, "started");
    assert.equal(after.dispatch_capability?.dispatches?.length ?? 0, 1);
    assert.equal(after.preparation_start?.dispatch_id, after.dispatch_capability?.dispatches?.[0]?.id);
  } finally {
    setSpecificationPhaseFailureInjector(null);
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("native worker hydration authenticates the child session and reconstructs the pinned input", () => {
  const f = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const started = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const task = started.value.required_next_tool.arguments.tasks[0]!.task;
    const sessionDir = join(f.root, ".omp", "agent", "native");
    mkdirSync(sessionDir, { recursive: true });
    const sessionId = "01native-session-id";
    const sessionFile = join(sessionDir, started.value.handoff.worker_name + ".jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "title", v: 1 }) + "\n" + JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: f.root }) + "\n", "utf8");
    const prompt = "Complete assignment thoroughly:\n\n" + task;
    const hydrated = hydrateNativeSpecificationWorkerPrompt(f.root, {
      prompt,
      session_id: sessionId,
      session_file: sessionFile,
      session_dir: sessionDir,
    });
    assert.equal(hydrated.ok, true, hydrated.ok ? "" : hydrated.error);
    if (!hydrated.ok) return;
    assert.equal(hydrated.worker_name, started.value.handoff.worker_name);
    assert.match(hydrated.system_prompt, /^NATIVE_WORKER_INPUT \{/u);
    const payload = JSON.parse(hydrated.system_prompt.slice("NATIVE_WORKER_INPUT ".length)) as Record<string, unknown>;
    assert.equal((payload.constitution as Record<string, unknown>).document_text, constitution);
    assert.deepEqual(payload.language, f.workspace.language, "default en-US language selection must be bound exactly");
    assert.equal((payload.language as Record<string, unknown>).language, "en-US");
    assert.equal((payload.language as Record<string, unknown>).source, "project_default");
    assert.equal((payload.language as Record<string, unknown>).selection_hash, f.workspace.language.selection_hash);
    assert.equal(payload.requester_context, prepared.task);
    assert.ok(payload.engine_binding, "the hydrated prompt binds the dispatch identity");
    const engineBinding = payload.engine_binding as Record<string, unknown>;
    assert.equal(engineBinding.input_ref, started.value.handoff.input_ref);
    assert.equal(engineBinding.input_digest, started.value.handoff.input_digest);
    assert.equal((engineBinding.work_identity as Record<string, unknown>).run_id, started.value.handoff.work_identity.run_id);
    assert.equal((engineBinding.work_identity as Record<string, unknown>).workflow, started.value.handoff.work_identity.workflow);
    assert.equal(hydrated.digest, task.match(/digest=([a-f0-9]{64})/u)?.[1]);

    const unverifiableReference = prompt.replace(/ capability=[^ ]+/u, " capability=forged-capability");
    const rejectedUnverifiable = hydrateNativeSpecificationWorkerPrompt(f.root, { prompt: unverifiableReference, session_id: "forged-session-id", session_file: sessionFile, session_dir: sessionDir });
    assert.equal(rejectedUnverifiable.ok, false);
    if (!rejectedUnverifiable.ok) assert.equal(rejectedUnverifiable.provenance, "unauthenticated");

    const alteredDigest = prompt.replace(/digest=[a-f0-9]{64}/u, "digest=" + "0".repeat(64));
    const rejectedDigest = hydrateNativeSpecificationWorkerPrompt(f.root, { prompt: alteredDigest, session_id: sessionId, session_file: sessionFile, session_dir: sessionDir });
    assert.equal(rejectedDigest.ok, false);
    if (!rejectedDigest.ok) assert.equal(rejectedDigest.provenance, "authenticated_assignment");
    assert.doesNotMatch(JSON.stringify(rejectedDigest), /Project Constitution|document_text|native-gate-run/u);
    const rejectedSession = hydrateNativeSpecificationWorkerPrompt(f.root, { prompt, session_id: "forged-session-id", session_file: sessionFile, session_dir: sessionDir });
    assert.equal(rejectedSession.ok, false);
    if (!rejectedSession.ok) assert.equal(rejectedSession.provenance, "authenticated_assignment");
    const rejectedPath = hydrateNativeSpecificationWorkerPrompt(f.root, { prompt, session_id: sessionId, session_file: join(sessionDir, "..", "other.jsonl"), session_dir: sessionDir });
    assert.equal(rejectedPath.ok, false);
    if (!rejectedPath.ok) assert.equal(rejectedPath.provenance, "authenticated_assignment");
    const sameDirTarget = join(sessionDir, "session-target.jsonl");
    writeFileSync(sameDirTarget, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: f.root }) + "\n", "utf8");
    unlinkSync(sessionFile);
    symlinkSync(sameDirTarget, sessionFile);
    const rejectedSymlink = hydrateNativeSpecificationWorkerPrompt(f.root, { prompt, session_id: sessionId, session_file: sessionFile, session_dir: sessionDir });
    assert.equal(rejectedSymlink.ok, false, "session identity must reject a symlink even when its target remains inside the authenticated directory");
    if (!rejectedSymlink.ok) assert.equal(rejectedSymlink.provenance, "authenticated_assignment");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});


test("native worker hydration rejects state transition and root replacement between reads", () => {
  const runCase = (mode: "transition" | "replacement") => {
    const f = fixture();
    const originalOpen = PinnedProjectRoot.open;
    let openCount = 0;
    let interleaved = false;
    let movedRoot: string | undefined;
    try {
      const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
      const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
      const started = startNativeSpecificationPhase(f.root, {
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        preparation_handoff: prepared.preparation_handoff!,
      });
      assert.equal(started.ok, true, started.ok ? "" : started.error);
      if (!started.ok) return;
      const task = started.value.required_next_tool.arguments.tasks[0]!.task;
      const sessionDir = join(f.root, ".omp", "agent", "native");
      mkdirSync(sessionDir, { recursive: true });
      const sessionId = "01native-hydration-race-session";
      const sessionFile = join(sessionDir, started.value.handoff.worker_name + ".jsonl");
      writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: f.root }) + "\n", "utf8");
      const prompt = "Complete assignment thoroughly:\n\n" + task;
      const statePath = join(f.root, ".work-state", "features", prepared.specification!.feature_id, "state.json");
      const stateBefore = readFileSync(statePath, "utf8");
      const state = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      PinnedProjectRoot.open = ((projectRoot: unknown, hooks: PinnedRootWriteHooks = {}) => {
        const pinned = originalOpen(projectRoot, hooks);
        openCount += 1;
        // resolveState() owns the first short-lived pin; the second pin is the
        // authoritative hydration pin. Interleave only at that exact seam.
        if (openCount === 2 && pinned) {
          interleaved = true;
          if (mode === "transition") {
            writeFileSync(statePath, JSON.stringify({ ...state, state_revision: (state.state_revision ?? 0) + 1 }, null, 2) + "\n", "utf8");
          } else {
            movedRoot = f.root + "-replaced";
            renameSync(f.root, movedRoot);
            mkdirSync(f.root, { recursive: true });
          }
        }
        return pinned;
      }) as typeof originalOpen;
      const rejected = hydrateNativeSpecificationWorkerPrompt(f.root, {
        prompt,
        session_id: sessionId,
        session_file: sessionFile,
        session_dir: sessionDir,
      });
      assert.equal(interleaved, true, "" + mode + " interleave hook must execute");
      assert.equal(rejected.ok, false, "" + mode + " during hydration must fail closed");
      if (!rejected.ok) assert.equal(rejected.provenance, "authenticated_assignment", "" + mode + " failure is post-authentication");
      if (mode === "transition") {
        PinnedProjectRoot.open = originalOpen;
        writeFileSync(statePath, stateBefore, "utf8");
        const stable = hydrateNativeSpecificationWorkerPrompt(f.root, {
          prompt,
          session_id: sessionId,
          session_file: sessionFile,
          session_dir: sessionDir,
        });
        assert.equal(stable.ok, true, "the unchanged pinned state must hydrate successfully");
      }
    } finally {
      PinnedProjectRoot.open = originalOpen;
      rmSync(f.root, { recursive: true, force: true });
      if (movedRoot) rmSync(movedRoot, { recursive: true, force: true });
    }
  };
  runCase("transition");
  runCase("replacement");
});


test("native worker hydration rejects transplanted run and workflow identities", () => {
  const f = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const started = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const task = started.value.required_next_tool.arguments.tasks[0]!.task;
    const sessionDir = join(f.root, ".omp", "agent", "native");
    mkdirSync(sessionDir, { recursive: true });
    const sessionId = "01native-cross-binding-session";
    const sessionFile = join(sessionDir, started.value.handoff.worker_name + ".jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: f.root }) + "\n", "utf8");
    const prompt = "Complete assignment thoroughly:\n\n" + task;
    const baseline = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
    for (const [field, value] of [["run_id", "foreign-run"], ["workflow", "foreign-workflow"]] as const) {
      const mutated = {
        ...baseline,
        dispatch_capability: {
          ...baseline.dispatch_capability!,
          dispatches: baseline.dispatch_capability!.dispatches.map((record) => record.id === started.value.handoff.dispatch_id
            ? { ...record, work_identity: { ...record.work_identity!, [field]: value } }
            : record),
        },
      };
      writeState(f.root, mutated, { featureSlug: prepared.specification!.feature_id });
      const rejected = hydrateNativeSpecificationWorkerPrompt(f.root, {
        prompt,
        session_id: sessionId,
        session_file: sessionFile,
        session_dir: sessionDir,
      });
      assert.equal(rejected.ok, false, "transplanted work identity " + field + " must be rejected before input hydration");
      if (!rejected.ok) assert.equal(rejected.provenance, "unauthenticated", "transplanted work identity " + field + " fails before assignment authentication");
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});


test("native worker hydration binds the selected project language", () => {
  const f = fixture("ru-RU");
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const started = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const task = started.value.required_next_tool.arguments.tasks[0]!.task;
    assert.match(task, /Author all prose and document body content in the selected language from NATIVE_WORKER_INPUT\.language/iu);
    assert.match(task, /preserve the selected template literal headings, markers, and placeholders exactly/iu);
    const sessionDir = join(f.root, ".omp", "agent", "native");
    mkdirSync(sessionDir, { recursive: true });
    const sessionId = "01native-ru-session-id";
    const sessionFile = join(sessionDir, started.value.handoff.worker_name + ".jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: f.root }) + "\n", "utf8");
    const hydrated = hydrateNativeSpecificationWorkerPrompt(f.root, {
      prompt: "Complete assignment thoroughly:\n\n" + task,
      session_id: sessionId,
      session_file: sessionFile,
      session_dir: sessionDir,
    });
    assert.equal(hydrated.ok, true, hydrated.ok ? "" : hydrated.error);
    if (!hydrated.ok) return;
    const payload = JSON.parse(hydrated.system_prompt.slice("NATIVE_WORKER_INPUT ".length)) as Record<string, unknown>;
    assert.deepEqual(payload.language, { language: "ru-RU", source: "project_default", selection_hash: sha256("language=ru-RU\nsource=project_default") });
    assert.equal((payload.language as Record<string, unknown>).language, "ru-RU");
    assert.equal((payload.language as Record<string, unknown>).source, "project_default");
    assert.equal((payload.language as Record<string, unknown>).selection_hash, sha256("language=ru-RU\nsource=project_default"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native start carries the exact engine CTO marker through task and replay", () => {
  const f = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const marker = buildCtoSliceMarker("cto-preparation-run", "cto-writer-feature-a");
    const started = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    }, { ctoSliceMarker: marker });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    assert.equal(started.value.cto_slice_marker, marker);
    const task = started.value.required_next_tool.arguments.tasks[0]!.task;
    assert.ok(task.endsWith("\n\n" + marker), "the engine marker is the final task bytes");
    const persisted = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state;
    assert.equal(persisted?.preparation_start?.cto_slice_marker, marker);
    const replay = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    });
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (!replay.ok) return;
    assert.equal(replay.value.cto_slice_marker, marker);
    assert.equal(replay.value.required_next_tool.arguments.tasks[0]!.task, task);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native start rejects forged and stale preparation authorities before capability writes", () => {
  const f = fixture();
  const f2 = fixture();
  try {
    const prepared = attachPreparationHandoff(f.root, f.state);

    const baseline = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
    const handoff = prepared.preparation_handoff!;
    const invoke = (feature_id: string, run_key: string, preparation_handoff: typeof handoff) => startNativeSpecificationPhase(f.root, { feature_id, run_key, preparation_handoff });
    const wrongFeature = invoke("native-gate-foreign", prepared.run_key!, handoff);
    assert.equal(wrongFeature.ok, false);
    assert.deepEqual(resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state, baseline);
    const wrongRun = invoke(prepared.specification!.feature_id, "native-gate-run-foreign", handoff);
    assert.equal(wrongRun.ok, false);
    assert.deepEqual(resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state, baseline);
    const wrongBranch = createPreparationHandoff({ ...handoff, branch: "foreign-branch" });
    const branchResult = invoke(prepared.specification!.feature_id, prepared.run_key!, wrongBranch);
    assert.equal(branchResult.ok, false);
    const wrongToken = createPreparationHandoff({ ...handoff, token: "forged-preparation-token" });
    const tokenResult = invoke(prepared.specification!.feature_id, prepared.run_key!, wrongToken);
    assert.equal(tokenResult.ok, false);
    const prepared2 = attachPreparationHandoff(f2.root, f2.state);
    const crossRoot = createPreparationHandoff({ ...prepared2.preparation_handoff!, token: handoff.token });
    const crossRootResult = startNativeSpecificationPhase(f2.root, {
      feature_id: prepared2.specification!.feature_id,
      run_key: prepared2.run_key!,
      preparation_handoff: crossRoot,
    });
    assert.equal(crossRootResult.ok, false);
    const staleRevisionState = { ...prepared, state_revision: (prepared.state_revision ?? 0) + 1 };
    writeState(f.root, staleRevisionState, { featureSlug: prepared.specification!.feature_id });
    const stale = invoke(prepared.specification!.feature_id, prepared.run_key!, handoff);
    assert.equal(stale.ok, false);
    assert.deepEqual(resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state?.dispatch_capability, baseline.dispatch_capability);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f2.root, { recursive: true, force: true });
  }
});

test("native start rejects a state mutation despite a recomputed plain handoff digest", () => {
  const f = fixture();
  try {
    const prepared = attachPreparationHandoff(f.root, f.state);
    const preparedHandoff = prepared.preparation_handoff!;
    const mutated = structuredClone(prepared) as TeamState;
    mutated.specification = { ...mutated.specification!, display_name: "Attacker-modified workspace" };
    const stateRevision = mutated.state_revision!;
    const forgedUnsigned = preparationHandoffUnsigned({
      ...preparedHandoff,
      state_digest: preparationStateDigest(mutated, stateRevision),
    });
    mutated.preparation_handoff = { ...forgedUnsigned, digest: preparationHandoffDigest(forgedUnsigned) };
    writeState(f.root, mutated, { featureSlug: mutated.specification!.feature_id });
    const beforeAttempt = resolveState(f.root, "main", { feature_id: mutated.specification!.feature_id, run_key: mutated.run_key! }).state!;
    const result = startNativeSpecificationPhase(f.root, {
      feature_id: mutated.specification!.feature_id,
      run_key: mutated.run_key!,
      preparation_handoff: mutated.preparation_handoff,
    });
    assert.equal(result.ok, false);
    const afterAttempt = resolveState(f.root, "main", { feature_id: mutated.specification!.feature_id, run_key: mutated.run_key! }).state!;
    assert.deepEqual(afterAttempt, beforeAttempt);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native preparation authority verifies across a fresh node process", () => {
  const f = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const featureId = prepared.specification!.feature_id;
    const runKey = prepared.run_key!;
    const script = [
      "import { PinnedProjectRoot } from \"./src/specification/pinned-root.ts\";",
      "import { resolveState } from \"./src/engine/state.ts\";",
      "import { verifyPreparationHandoffAuth } from \"./src/engine/preparation.ts\";",
      "const root = process.env.NATIVE_AUTH_ROOT;",
      "const featureId = process.env.NATIVE_AUTH_FEATURE;",
      "const runKey = process.env.NATIVE_AUTH_RUN;",
      "if (!root || !featureId || !runKey) throw new Error(\"native authentication child environment is incomplete\");",
      "const pinned = PinnedProjectRoot.open(root);",
      "if (!pinned) throw new Error(\"native authentication child could not pin root\");",
      "const selected = resolveState(root, \"main\", { feature_id: featureId, run_key: runKey });",
      "const ok = !selected.invalid && !!selected.state?.preparation_handoff && verifyPreparationHandoffAuth(pinned, selected.state.preparation_handoff);",
      "pinned.close();",
      "process.stdout.write(JSON.stringify({ ok }));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, NATIVE_AUTH_ROOT: f.root, NATIVE_AUTH_FEATURE: featureId, NATIVE_AUTH_RUN: runKey },
      encoding: "utf8",
    });
    const childResult = JSON.parse(output) as { ok?: boolean; error?: string };
    assert.equal(childResult.ok, true, childResult.error ?? "fresh native authentication process rejected a valid handoff");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native start fails closed on stale, symlinked, or oversized authority before task envelope", () => {
  for (const mode of ["stale", "symlink", "oversized"] as const) {
    const f = fixture();
    try {
      const { dispatch_capability: _dispatchCapability, completion_envelope: _completionEnvelope, ...stateWithoutWork } = f.state;
      const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
      const baseline = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      if (mode === "stale") writeFileSync(join(f.root, "CONSTITUTION.md"), `${constitution}\nTampered after binding.\n`);
      if (mode === "symlink") {
        writeFileSync(join(f.root, "outside.md"), constitution);
        rmSync(join(f.root, "CONSTITUTION.md"));
        symlinkSync("outside.md", join(f.root, "CONSTITUTION.md"));
      }
      if (mode === "oversized") writeFileSync(join(f.root, "CONSTITUTION.md"), "x".repeat(MAX_PHASE_INPUT_BYTES + 1));
      const result = startNativeSpecificationPhase(f.root, {
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        preparation_handoff: prepared.preparation_handoff!,
      });
      assert.equal(result.ok, false, mode);
      const after = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
      assert.deepEqual(after.dispatch_capability?.dispatches ?? [], baseline.dispatch_capability?.dispatches ?? [], mode);
      assert.equal(after.preparation_start, baseline.preparation_start, mode);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
test("plan dispatch embeds verified upstream artifact and projection content", () => {
  const buildPlanReady = (): { fixture: NativeGateFixture; dispatchInput: Parameters<typeof dispatchSpecificationPhase>[1]; artifactPath: string } => {
    const f = fixture();
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const started = startNativeSpecificationPhase(f.root, {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) throw new Error(started.error);
    const pinned = PinnedProjectRoot.open(f.root);
    assert.ok(pinned);
    if (!pinned) throw new Error("fixture root could not be pinned");
    const identities = readPinnedConstitutionPrincipleIdentities(pinned, f.workspace.constitution_binding!);
    pinned.close();
    assert.equal(identities.ok, true);
    if (!identities.ok) throw new Error(identities.error);
    const binding = f.workspace.constitution_binding!;
    const semanticModel = {
      schema_version: 1,
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key,
      phase: "specify" as const,
      version: 1,
      worker: { role: started.value.handoff.role, agent: started.value.handoff.agent, dispatch_id: started.value.handoff.dispatch_id },
      constitution_binding: binding,
      upstream_versions: [],
      sections: {
        problem: "The native phase must produce a durable typed specification.",
        scope: "Persist one immutable specification artifact.",
        non_goals: "No application files are changed.",
        actors: "The engine and one analyst worker.",
        journeys: "The worker result is validated before a human checkpoint.",
        requirements: "REQ-1 is observable.",
        edge_cases: "Stale or malformed child data is rejected.",
        assumptions: "The approved constitution remains current.",
        dependencies: "The durable state and artifact store.",
        success_criteria: "A passing validation opens the checkpoint.",
      },
      requirements: [{ requirement_id: "REQ-1", statement: "The phase is durable.", acceptance_ids: ["AC-1"], source_refs: ["request"], testable: true, untestable_reason: null }],
      decisions: [],
      tasks: [],
      verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "Focused composite test" }],
      contradictions: [],
      constitution_principles: identities.value.map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable" as const, status: "pass" as const, evidence: "Ship tested work.", binding })),
    };
    const finalized = finalizeNativeSpecificationPhase(f.root, finalizeInput(started.value.handoff, workerResultFromSemanticModel(semanticModel, started.value.handoff)));
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) throw new Error(finalized.error);
    const current = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state!;
    const workspace = current.specification!;
    const planWorkspace = {
      ...workspace,
      phases: workspace.phases.map((phase) => phase.phase === "specify"
        ? { ...phase, status: "approved" as const, approved_version: 1, checkpoint_ref: "checkpoint.specify.v1" }
        : phase.phase === "plan" ? { ...phase, status: "not_started" as const, current_version: null, approved_version: null } : phase),
    };
    const issued = createCapability({
      run_key: prepared.run_key!,
      branch: "main",
      workflow: "spec-preparation",
      profile_hash: profileHash(profile),
      stage_cursor: "plan",
      kind: "single",
      expected_roster: [{ role: "specification-architect", agent: "specification-worker" }],
      dispatch_secret: "plan-dispatch-secret",
      advance_secret: "plan-advance-secret",
      policy_hash: digestOf(profile.stages.find((candidate) => candidate.id === "plan")?.roster_policy ?? {}),
    });
    writeState(f.root, { ...current, stage_cursor: "plan", cursor_epoch: issued.state.issued_for!.cursor_epoch, dispatch_capability: issued.state, specification: planWorkspace }, { featureSlug: prepared.specification!.feature_id });
    const capabilityId = issued.capability_id;
    const taskId = dispatchTaskId(capabilityId, prepared.run_key!, "main", "spec-preparation", "plan", "specification-architect");
    const planProof = issueCurrentTrustedMappingProof(f.root);
    const authorized = authorizeDispatchTrusted(f.root, {
      capability_id: capabilityId,
      run_key: prepared.run_key!,
      branch: "main",
      workflow: "spec-preparation",
      profile_hash: profileHash(profile),
      stage_cursor: "plan",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "specification-architect",
      slot_id: "specification-architect",
      task_id: taskId,
      agent: "specification-worker",
      tool_call_id: "plan-task-call",
      expected_count: 1,
    }, planProof === undefined ? {} : { trustedMappingProof: planProof });
    assert.equal(authorized.ok, true, authorized.ok ? "" : authorized.error);
    if (!authorized.ok) throw new Error(authorized.error);
    return {
      fixture: f,
      dispatchInput: {
        token: issued.dispatch_token,
        capability_id: capabilityId,
        feature_id: prepared.specification!.feature_id,
        run_key: prepared.run_key!,
        branch: "main",
        workflow: "spec-preparation",
        profile_hash: profileHash(profile),
        phase: "plan",
        cursor_epoch: issued.state.issued_for!.cursor_epoch,
        request_id: "plan-task-call",
        role: "specification-architect",
        slot_id: "specification-architect",
        agent: "specification-worker",
        task_id: taskId,
      },
      artifactPath: join(f.root, ".work-state", "features", prepared.specification!.feature_id, "artifacts", "specify.v1.json"),
    };
  };
  const ready = buildPlanReady();
  try {
    const dispatched = dispatchSpecificationPhase(ready.fixture.root, ready.dispatchInput);
    assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.error);
    if (dispatched.ok) {
      const upstream = dispatched.value.authoritative_input?.upstream_artifact_refs ?? [];
      assert.ok(upstream.length > 0, "plan dispatch must carry its approved semantic upstream");
      assert.ok(upstream.every((entry) => Object.keys(entry).sort().join(",") === "artifact_id,hash,semantic_model,version"), "upstream hydration refs must be compact binding+semantic slices");
      const task = nativeWorkerTaskEnvelope(dispatched.value, "plan requester").arguments.tasks[0]!.task;
      assert.match(task, /NATIVE_WORKER_INPUT_REF schema=1 ref=spec-native:[^ ]+ digest=[a-f0-9]{64}/u);
      assert.match(task, /engine will inject the authoritative NATIVE_WORKER_INPUT/iu);
      assert.doesNotMatch(task, /document_text|projection_content|The native phase must produce a durable typed specification/u);
    }
  } finally {
    rmSync(ready.fixture.root, { recursive: true, force: true });
  }
  const tampered = buildPlanReady();
  try {
    const before = resolveState(tampered.fixture.root, "main", { feature_id: tampered.dispatchInput.feature_id, run_key: tampered.dispatchInput.run_key }).state!;
    const artifact = JSON.parse(readFileSync(tampered.artifactPath, "utf8")) as Record<string, unknown>;
    artifact.created_at = "tampered-upstream-bytes";
    writeFileSync(tampered.artifactPath, JSON.stringify(artifact, null, 2) + "\n");
    const rejected = dispatchSpecificationPhase(tampered.fixture.root, tampered.dispatchInput);
    assert.equal(rejected.ok, false);
    assert.match(rejected.ok ? "" : rejected.error, /stale|hash|upstream/i);
    const state = resolveState(tampered.fixture.root, "main", { feature_id: tampered.dispatchInput.feature_id, run_key: tampered.dispatchInput.run_key }).state!;
    assert.deepEqual(state.dispatch_capability?.dispatches ?? [], before.dispatch_capability?.dispatches ?? []);
  } finally {
    rmSync(tampered.fixture.root, { recursive: true, force: true });
  }
});

test("native start recovery rotates lost bearers without duplicating work and finalizes with the fresh handoff", () => {
  const f = fixture();
  const forged = fixture();
  const arbitrary = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const startInput = {
      feature_id: prepared.specification!.feature_id,
      run_key: prepared.run_key!,
      preparation_handoff: prepared.preparation_handoff!,
    };
    const first = startNativeSpecificationPhase(f.root, startInput);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    if (!first.ok) return;
    const firstHandoff = first.value.handoff;
    const beforeReplay = resolveState(f.root, "main", { feature_id: startInput.feature_id, run_key: startInput.run_key }).state;
    assert.ok(beforeReplay?.preparation_start, "a successful start must persist its replay marker");
    const marker = beforeReplay?.preparation_start;

    // The model-facing response is discarded. Repeating the exact preparation
    // request must recover the durable dispatch while minting fresh bearers.
    const replay = startNativeSpecificationPhase(f.root, startInput);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (!replay.ok) return;
    assert.equal(replay.replayed, true);
    assert.notEqual(replay.value.handoff.token, firstHandoff.token, "recovery must rotate the dispatch bearer");
    assert.notEqual(replay.value.handoff.advance_token, firstHandoff.advance_token, "recovery must rotate the advance bearer");
    assert.equal(replay.value.handoff.capability_id, firstHandoff.capability_id, "recovery must retain one capability identity");
    assert.equal(replay.value.handoff.dispatch_id, firstHandoff.dispatch_id, "recovery must reuse one generation dispatch");
    assert.equal(replay.value.handoff.dispatch_marker, firstHandoff.dispatch_marker, "recovery must preserve the semantic dispatch marker");
    const afterReplay = resolveState(f.root, "main", { feature_id: startInput.feature_id, run_key: startInput.run_key }).state;
    assert.deepEqual(afterReplay?.preparation_start, marker, "recovery must not rewrite the preparation marker");
    const generationDispatches = afterReplay?.dispatch_capability?.dispatches.filter((candidate) => (candidate.purpose ?? "generation") === "generation") ?? [];
    assert.equal(generationDispatches.length, 1, "recovery must not authorize duplicate generation work");
    assert.equal(generationDispatches[0]?.id, replay.value.handoff.dispatch_id);

    const pinned = PinnedProjectRoot.open(f.root);
    assert.ok(pinned);
    if (!pinned) return;
    const identities = readPinnedConstitutionPrincipleIdentities(pinned, f.workspace.constitution_binding!);
    pinned.close();
    assert.equal(identities.ok, true);
    if (!identities.ok) return;
    const binding = f.workspace.constitution_binding!;
    const record = generationDispatches[0]!;
    const semanticModel = {
      schema_version: 1,
      feature_id: f.state.specification!.feature_id,
      run_key: f.state.run_key,
      phase: "specify" as const,
      version: 1,
      worker: { role: replay.value.handoff.role, agent: replay.value.handoff.agent, dispatch_id: record.id },
      constitution_binding: binding,
      upstream_versions: [],
      sections: {
        problem: "The native phase must produce a durable typed specification.",
        scope: "Persist one immutable specification artifact.",
        non_goals: "No application files are changed.",
        actors: "The engine and one analyst worker.",
        journeys: "The worker result is validated before a human checkpoint.",
        requirements: "REQ-1 is observable.",
        edge_cases: "Stale or malformed child data is rejected.",
        assumptions: "The approved constitution remains current.",
        dependencies: "The durable state and artifact store.",
        success_criteria: "A passing validation opens the checkpoint.",
      },
      requirements: [{ requirement_id: "REQ-1", statement: "The phase is durable.", acceptance_ids: ["AC-1"], source_refs: ["request"], testable: true, untestable_reason: null }],
      decisions: [],
      tasks: [],
      verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "Focused composite test" }],
      contradictions: [],
      constitution_principles: identities.value.map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable" as const, status: "pass" as const, evidence: "Ship tested work.", binding })),
    };
    const artifactPath = join(f.root, ".work-state", "features", f.state.specification!.feature_id, "artifacts", "specify.v1.json");
    const callerAuthorityAttempt = {
      ...finalizeInput(replay.value.handoff, workerResultFromSemanticModel(semanticModel, replay.value.handoff)),
      handoff: { ...firstHandoff, token: "forged-caller-token" },
    };
    const finalized = finalizeNativeSpecificationPhase(f.root, callerAuthorityAttempt as never);
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) return;
    assert.equal((finalized.value.required_next_tool.arguments as Record<string, unknown>).checkpoint, "specification_phase_approval");
    assert.ok(existsSync(artifactPath), "the fresh bearer must persist the canonical phase artifact");
    assert.ok(existsSync(join(f.root, ".work-state", "features", f.state.specification!.feature_id, "artifacts", "specify_draft.json")), "the canonical source projection must persist");
    assert.ok(existsSync(join(f.root, ".work-state", "features", f.state.specification!.feature_id, "artifacts", "validation.specify.v1.json")), "the validator evidence must persist");
    assert.ok(existsSync(join(f.root, "specs", f.state.specification!.feature_id, "spec.md")), "the readable phase projection must persist");
    const finalizedState = resolveState(f.root, "main", { feature_id: startInput.feature_id, run_key: startInput.run_key }).state;
    assert.equal(finalizedState?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "awaiting_approval");
    assert.equal(finalizedState?.dispatch_capability?.dispatches.filter((candidate) => candidate.purpose === "validation").length, 1);
    assert.equal(finalized.value.persisted_version.dispatch_id, replay.value.handoff.dispatch_id);
    assert.deepEqual(finalizedState?.preparation_start, marker, "finalization must retain the original semantic marker");

    // A forged marker and an unrelated active capability cannot turn the
    // recovery path into a capability reissuer.
    const { work_identity: _forgedWorkIdentity, completion_envelope: _forgedCompletionEnvelope, dispatch_capability: _forgedDispatchCapability, ...forgedStateWithoutWork } = forged.state;
    const forgedBase = attachPreparationHandoff(forged.root, forgedStateWithoutWork);
    const forgedStart = startNativeSpecificationPhase(forged.root, {
      feature_id: forgedBase.specification!.feature_id,
      run_key: forgedBase.run_key!,
      preparation_handoff: forgedBase.preparation_handoff!,
    });
    assert.equal(forgedStart.ok, true, forgedStart.ok ? "" : forgedStart.error);
    if (!forgedStart.ok) return;
    const forgedState = resolveState(forged.root, "main", { feature_id: forgedBase.specification!.feature_id, run_key: forgedBase.run_key! }).state!;
    const forgedMarker = forgedState.preparation_start!;
    writeState(forged.root, { ...forgedState, preparation_start: { ...forgedMarker, dispatch_id: forgedMarker.dispatch_id + "-forged" } }, { featureSlug: forgedBase.specification!.feature_id });
    const forgedRetry = startNativeSpecificationPhase(forged.root, {
      feature_id: forgedBase.specification!.feature_id,
      run_key: forgedBase.run_key!,
      preparation_handoff: forgedBase.preparation_handoff!,
    });
    assert.equal(forgedRetry.ok, false, "a forged preparation marker must not reissue capability bearers");
    const arbitraryPrepared = attachPreparationHandoff(arbitrary.root, arbitrary.state);
    const arbitraryBefore = resolveState(arbitrary.root, "main", { feature_id: arbitraryPrepared.specification!.feature_id, run_key: arbitraryPrepared.run_key! }).state!;
    const arbitraryRetry = startNativeSpecificationPhase(arbitrary.root, {
      feature_id: arbitraryPrepared.specification!.feature_id,
      run_key: arbitraryPrepared.run_key!,
      preparation_handoff: arbitraryPrepared.preparation_handoff!,
    });
    assert.equal(arbitraryRetry.ok, false, "an arbitrary active capability must not reissue native start");
    const arbitraryAfter = resolveState(arbitrary.root, "main", { feature_id: arbitraryPrepared.specification!.feature_id, run_key: arbitraryPrepared.run_key! }).state!;
    assert.deepEqual(arbitraryAfter.dispatch_capability, arbitraryBefore.dispatch_capability, "rejected arbitrary recovery must not mutate capability state");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(forged.root, { recursive: true, force: true });
    rmSync(arbitrary.root, { recursive: true, force: true });
  }
});
test("native finalizer composes persistence, generation completion, validation, and the separate Ask descriptor", async () => {
  const f = fixture();
  try {
    const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...stateWithoutWork } = f.state;
    const prepared = attachPreparationHandoff(f.root, stateWithoutWork);
    const started = startNativeSpecificationPhase(f.root, { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key!, preparation_handoff: prepared.preparation_handoff! });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const currentState = resolveState(f.root, "main", { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key! }).state;
    assert.ok(currentState?.dispatch_capability?.dispatches[0]);
    if (!currentState?.dispatch_capability?.dispatches[0]) return;
    const record = currentState.dispatch_capability.dispatches[0];
    const pinned = PinnedProjectRoot.open(f.root);
    assert.ok(pinned);
    if (!pinned) return;
    const identities = readPinnedConstitutionPrincipleIdentities(pinned, f.workspace.constitution_binding!);
    pinned.close();
    assert.equal(identities.ok, true);
    if (!identities.ok) return;
    const binding = f.workspace.constitution_binding!;
    const semanticModel = {
      schema_version: 1,
      feature_id: f.state.specification!.feature_id,
      run_key: f.state.run_key,
      phase: "specify" as const,
      version: 1,
      worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: record.id },
      constitution_binding: binding,
      upstream_versions: [],
      sections: {
        problem: "The native phase must produce a durable typed specification.",
        scope: "Persist one immutable specification artifact.",
        non_goals: "No application files are changed.",
        actors: "The engine and one analyst worker.",
        journeys: "The worker result is validated before a human checkpoint.",
        requirements: "REQ-1 is observable.",
        edge_cases: "Stale or malformed child data is rejected.",
        assumptions: "The approved constitution remains current.",
        dependencies: "The durable state and artifact store.",
        success_criteria: "A passing validation opens the checkpoint.",
      },
      requirements: [{ requirement_id: "REQ-1", statement: "The phase is durable.", acceptance_ids: ["AC-1"], source_refs: ["request"], testable: true, untestable_reason: null }],
      decisions: [],
      tasks: [],
      verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "Focused composite test" }],
      contradictions: [],
      constitution_principles: identities.value.map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable" as const, status: "pass" as const, evidence: "Ship tested work.", binding })),
    };
    const handoff = started.value.handoff;
    const rejected = finalizeNativeSpecificationPhase(f.root, finalizeInput(handoff, {}));
    assert.equal(rejected.ok, false);
    assert.equal("required_next_tool" in rejected, false, "a failed finalization must never emit the human Ask envelope");
    assert.equal(resolveState(f.root, "main").state?.specification?.phases.find((phase) => phase.phase === "specify")?.status, "generating");

    // Canonical constitution identity checks happen before the persistence
    // journal, immutable artifact, or dispatch projection can be written.
    const beforeRejectedState = resolveState(f.root, "main").state;
    assert.ok(beforeRejectedState);
    const artifactPath = join(f.root, ".work-state", "features", f.state.specification!.feature_id, "artifacts", "specify.v1.json");
    const rejectedModels = [
      ["altered identity", (model: any) => { model.constitution_principles[0] = { ...model.constitution_principles[0], principle_id: "constitution:1:forged", title: "Forged" }; }],
      ["missing identity", (model: any) => { model.constitution_principles = model.constitution_principles.slice(0, -1); }],
      ["reordered/duplicate identities", (model: any) => { model.constitution_principles = [model.constitution_principles[0], model.constitution_principles[0]]; }],
      ["malformed observation", (model: any) => { model.constitution_principles[0] = { ...model.constitution_principles[0], evidence: "" }; }],
    ] as const;
    for (const [label, mutate] of rejectedModels) {
      const candidate = structuredClone(semanticModel);
      mutate(candidate);
      const invalid = finalizeNativeSpecificationPhase(f.root, finalizeInput(handoff, workerResultFromSemanticModel(candidate, handoff)));
      assert.equal(invalid.ok, false, label + " must be rejected");
      assert.deepEqual(resolveState(f.root, "main").state, beforeRejectedState, label + " must not mutate durable state");
      assert.equal(existsSync(artifactPath), false, label + " must not write an immutable artifact");
    }
    const engineFieldAttempt = { ...workerResultFromSemanticModel(semanticModel, handoff), feature_id: "forged" };
    const engineFieldRejected = finalizeNativeSpecificationPhase(f.root, finalizeInput(handoff, engineFieldAttempt));
    assert.equal(engineFieldRejected.ok, false, "worker_result cannot supply engine-owned fields");
    const result = finalizeNativeSpecificationPhase(f.root, finalizeInput(handoff, workerResultFromSemanticModel(semanticModel, started.value.handoff)));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    assert.equal(result.value.required_next_tool.name, "workflow_checkpoint_ask_selected");
    const askArguments = result.value.required_next_tool.arguments as Record<string, unknown>;
    assert.equal(askArguments.checkpoint, "specification_phase_approval");
    const selectedAsk = validateCheckpointAskSelected(f.root, askArguments as never);
    assert.equal(selectedAsk.ok, true, selectedAsk.ok ? "" : selectedAsk.error);
    const replay = finalizeNativeSpecificationPhase(f.root, finalizeInput(handoff, workerResultFromSemanticModel(semanticModel, started.value.handoff)));
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    const replayArguments = replay.ok ? replay.value.required_next_tool.arguments as Record<string, unknown> : askArguments;
    const answered = await selectedHostAsk(f.root, replayArguments as never, "approve_continue");
    assert.equal(answered.ok, true, answered.ok ? "" : String(answered.error));
    const answeredRejects = validateCheckpointAskSelected(f.root, replayArguments as never);
    assert.equal(answeredRejects.ok, false, "a prior trusted answer must not be selected again");
    const approvedState = resolveState(f.root, "main").state;
    assert.ok(approvedState?.specification, "finalizer must leave a specification workspace");
    if (approvedState?.specification) {
      const approved = structuredClone(approvedState);
      approved.specification!.phases = approved.specification!.phases.map((phase) => phase.phase === "specify"
        ? { ...phase, status: "approved" as const, approved_version: phase.current_version, checkpoint_ref: `checkpoint.specify.v${phase.current_version}` }
        : phase);
      writeState(f.root, approved, { featureSlug: f.state.specification!.feature_id });
    }
    const approvedRejects = validateCheckpointAskSelected(f.root, askArguments as never);
    assert.equal(approvedRejects.ok, false, "an approved candidate must not be selected again");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});


test("native finalizer resumes each durable boundary without duplicating dispatches", () => {
  const boundaries = ["after_materialize", "after_generation_complete", "after_validation_dispatch", "after_validation_observe", "after_checkpoint_presentation"] as const;
  for (const boundary of boundaries) {
    const f = fixture();
    try {
      const { work_identity: _workIdentity, completion_envelope: _completionEnvelope, dispatch_capability: _dispatchCapability, ...withoutWork } = f.state;
      const prepared = attachPreparationHandoff(f.root, withoutWork);
      const started = startNativeSpecificationPhase(f.root, { feature_id: prepared.specification!.feature_id, run_key: prepared.run_key!, preparation_handoff: prepared.preparation_handoff! });
      assert.equal(started.ok, true, started.ok ? "" : started.error);
      if (!started.ok) continue;
      const model = finalizerSemanticModel(f, started.value.handoff);
      const workerResult = workerResultFromSemanticModel(model, started.value.handoff);
      let injected = false;
      setSpecificationPhaseFailureInjector((point) => {
        if (!injected && point === boundary) {
          injected = true;
          throw new Error(`injected ${boundary}`);
        }
      });
      assert.throws(() => finalizeNativeSpecificationPhase(f.root, finalizeInput(started.value.handoff, workerResult)), new RegExp(`injected ${boundary}`));
      assert.equal(injected, true, `${boundary} seam must run`);
      setSpecificationPhaseFailureInjector(null);
      if (boundary === "after_materialize") {
        const beforeRejected = resolveState(f.root, "main", { feature_id: f.workspace.feature_id, run_key: prepared.run_key! }).state;
        const forged = structuredClone(workerResult) as Record<string, any>;
        forged.sections = { ...(forged.sections as Record<string, unknown>), problem: "forged result" };
        const rejected = finalizeNativeSpecificationPhase(f.root, finalizeInput(started.value.handoff, forged));
        assert.equal(rejected.ok, false, "a changed worker result must be rejected after materialization");
        assert.deepEqual(resolveState(f.root, "main", { feature_id: f.workspace.feature_id, run_key: prepared.run_key! }).state, beforeRejected, "a mismatched retry must not mutate durable state");
      }
      const resumed = finalizeNativeSpecificationPhase(f.root, finalizeInput(started.value.handoff, workerResult));
      assert.equal(resumed.ok, true, `${boundary} retry must converge: ${resumed.ok ? "" : resumed.error}`);
      if (!resumed.ok) continue;
      assert.equal(resumed.replayed, true, `${boundary} retry must report replay`);
      const current = resolveState(f.root, "main", { feature_id: f.workspace.feature_id, run_key: prepared.run_key! }).state;
      const record = current?.specification?.phases.find((phase) => phase.phase === "specify");
      assert.equal(record?.status, "awaiting_approval", `${boundary} retry must reopen the checkpoint`);
      const dispatches = current?.dispatch_capability?.dispatches ?? [];
      assert.equal(dispatches.filter((dispatch) => (dispatch.purpose ?? "generation") === "generation").length, 1, `${boundary} must retain one generation dispatch`);
      assert.equal(dispatches.filter((dispatch) => dispatch.purpose === "validation").length, 1, `${boundary} must retain one validator dispatch`);
      assert.equal(dispatches.find((dispatch) => (dispatch.purpose ?? "generation") === "generation")?.status, "succeeded", `${boundary} generation must complete once`);
      assert.equal(dispatches.find((dispatch) => dispatch.purpose === "validation")?.status, "succeeded", `${boundary} validator must complete once`);
    } finally {
      setSpecificationPhaseFailureInjector(null);
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("native task result selector requires the authorization root and session identity", () => {
  const f = fixture();
  const foreign = fixture();
  try {
    const handlers = registeredTaskLifecycleHandlers(f.root, true);
    const manager = {
      getCwd: () => f.root,
      getSessionId: () => "native-session-a",
      getSessionFile: () => join(f.root, "native-session-a.jsonl"),
      getSessionGeneration: () => "generation-a",
    };
    const context = { sessionManager: manager };
    const call = { type: "tool_call", toolCallId: "native-task-call", toolName: "task", input: envelope(f.item) };
    assert.equal(handlers.get("tool_call")?.(call, context), undefined, "same-session native dispatch remains admitted");
    const statePath = join(f.root, ".work-state", "features", f.workspace.feature_id, "state.json");
    const beforeForeignRoot = readFileSync(statePath, "utf8");
    const foreignRoot = { sessionManager: { getCwd: () => foreign.root, getSessionId: () => "native-session-a", getSessionFile: () => join(foreign.root, "native-session-a.jsonl"), getSessionGeneration: () => "generation-a" } };
    handlers.get("tool_result")?.({ toolName: "task", toolCallId: "native-task-call", content: [{ type: "text", text: "late foreign root" }], isError: false }, foreignRoot);
    assert.equal(readFileSync(statePath, "utf8"), beforeForeignRoot, "a foreign-root late result must not mutate the authorized state");
    const beforeForeignSession = readFileSync(statePath, "utf8");
    const foreignSession = { sessionManager: { getCwd: () => f.root, getSessionId: () => "native-session-b", getSessionFile: () => join(f.root, "native-session-b.jsonl"), getSessionGeneration: () => "generation-b" } };
    handlers.get("tool_result")?.({ toolName: "task", toolCallId: "native-task-call", content: [{ type: "text", text: "late foreign session" }], isError: false }, foreignSession);
    assert.equal(readFileSync(statePath, "utf8"), beforeForeignSession, "a foreign-session late result must not mutate the authorized state");
    assert.equal(handlers.get("tool_call")?.(call, context), undefined, "the same id can be authorized again under the current session");
    assert.equal(handlers.get("tool_result")?.({ toolName: "task", toolCallId: "native-task-call", content: [{ type: "text", text: "same session" }], isError: false }, context), undefined, "same-session result remains accepted");
    const completed = JSON.parse(readFileSync(statePath, "utf8")) as { dispatch_capability?: { dispatches?: Array<{ status?: string }> } };
    assert.equal(completed.dispatch_capability?.dispatches?.[0]?.status, "pending", "same-session result enters the existing artifact-deferred reconciliation path");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(foreign.root, { recursive: true, force: true });
  }
});

test("failed session rebind releases its activation before retrying beyond the lease cap", () => {
  const f = fixture();
  const blockers: Array<ReturnType<typeof openTestRegistry>> = [];
  try {
    const handlers = registeredTaskLifecycleHandlers(f.root, true);
    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart);
    if (!sessionStart) return;
    const managerA = {
      getCwd: () => f.root,
      getSessionId: () => "native-session-initial",
      getSessionFile: () => join(f.root, "native-session-initial.jsonl"),
      getSessionGeneration: () => "generation-initial",
    };
    sessionStart({}, { sessionManager: managerA });

    // Force beginRegistryRegistration to fail after openOwnerActivation has
    // already issued the replacement session lease.
    for (let index = 0; index < 8; index += 1) {
      blockers.push(openTestRegistry(f.root, ["constitution_gate"], "core-test-team-workflow", ["workflow_registration", "config_writer"]));
    }
    const blockedManager = {
      getCwd: () => f.root,
      getSessionId: () => "native-session-blocked",
      getSessionFile: () => join(f.root, "native-session-blocked.jsonl"),
      getSessionGeneration: () => "generation-blocked",
    };
    assert.throws(
      () => sessionStart({}, { sessionManager: blockedManager }),
      /open registry tokens per physical root are bounded at 8/,
    );

    for (const blocker of blockers) blocker.finish(false);
    blockers.length = 0;
    for (let index = 0; index < 65; index += 1) {
      const manager = {
        getCwd: () => f.root,
        getSessionId: () => `native-session-retry-${index}`,
        getSessionFile: () => join(f.root, `native-session-retry-${index}.jsonl`),
        getSessionGeneration: () => `generation-retry-${index}`,
      };
      assert.doesNotThrow(() => sessionStart({}, { sessionManager: manager }));
    }
  } finally {
    for (const blocker of blockers) {
      try { blocker.finish(false); } catch { /* preserve the test failure */ }
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("team shutdown ignores stale session generations and closes each exact rebind", () => {
  const f = fixture();
  try {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        if (["session_start", "session_shutdown"].includes(name)) handlers.set(name, handler);
      },
    };
    writeTestRegistryMarker(f.root);
    const seed = openTestRegistry(f.root, ["workflow_profiles", "constitution_gate", "runtime_config"], "dynamic-shutdown", ["workflow_registration", "config_writer"]);
    const owner = seed.owner;
    seed.finish(false);
    registerTeamWorkflow(pi as never, {
      owner: () => owner,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      rebindSessions: true,
      observability: false,
    });
    const initialSessionStart = handlers.get("session_start");
    assert.ok(initialSessionStart);
    if (!initialSessionStart) return;
    const manager = (id: string) => ({
      getCwd: () => f.root,
      getSessionId: () => id,
      getSessionFile: () => join(f.root, `${id}.jsonl`),
      getSessionGeneration: () => `generation-${id}`,
    });
    const contextA = { cwd: f.root, sessionManager: manager("shutdown-a") };
    const contextB = { cwd: f.root, sessionManager: manager("shutdown-b") };
    const contextC = { cwd: f.root, sessionManager: manager("shutdown-c") };
    initialSessionStart({}, contextA);
    assert.ok(workflowOwnerFor(f.root, "workflow_registration"), "initial A binds an owner claim");
    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");
    assert.ok(sessionStart && sessionShutdown);
    if (!sessionStart || !sessionShutdown) return;
    sessionStart({}, contextB);
    assert.ok(workflowOwnerFor(f.root, "workflow_registration"), "replacement B binds an owner claim");

    // The initial handler must not tear down the replacement B activation.
    sessionShutdown({}, contextA);
    assert.ok(workflowOwnerFor(f.root, "workflow_registration"), "stale A shutdown preserves B owner claim");
    const call = { type: "tool_call", toolCallId: "shutdown-call-b", toolName: "task", input: envelope(f.item) };
    assert.equal(handlers.get("tool_call")?.(call, contextB), undefined, "stale A shutdown leaves B active");

    // The exact B shutdown closes B immediately and remains idempotent.
    sessionShutdown({}, contextB);
    assert.equal(workflowOwnerFor(f.root, "workflow_registration"), undefined, "exact B shutdown releases its owner claim immediately");
    sessionShutdown({}, contextB);

    // The mounted handler is reusable for a later exact generation. A stale
    // B event cannot close C, while the exact C event can close it.
    sessionStart({}, contextC);
    assert.ok(workflowOwnerFor(f.root, "workflow_registration"), "C rebind restores a live owner claim");
    const callC = { ...call, toolCallId: "shutdown-call-c" };
    assert.equal(handlers.get("tool_call")?.(callC, contextC), undefined, "C activation is live after B shutdown");
    sessionShutdown({}, contextB);
    assert.equal(handlers.get("tool_call")?.({ ...callC, toolCallId: "shutdown-call-c-after-stale" }, contextC), undefined, "stale B shutdown leaves C active");
    sessionShutdown({}, contextC);
    assert.equal(workflowOwnerFor(f.root, "workflow_registration"), undefined, "exact C shutdown releases its owner claim immediately");
    sessionShutdown({}, contextC);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native task selectors clear on session rebind and reject stale reused ids", () => {
  const f = fixture();
  try {
    const handlers = registeredTaskLifecycleHandlers(f.root, true);
    const managerA = {
      getCwd: () => f.root,
      getSessionId: () => "native-session-a",
      getSessionFile: () => join(f.root, "native-session-a.jsonl"),
      getSessionGeneration: () => "generation-a",
    };
    const managerB = {
      getCwd: () => f.root,
      getSessionId: () => "native-session-b",
      getSessionFile: () => join(f.root, "native-session-b.jsonl"),
      getSessionGeneration: () => "generation-b",
    };
    const contextA = { sessionManager: managerA };
    const contextB = { sessionManager: managerB };
    const call = { type: "tool_call", toolCallId: "native-task-call", toolName: "task", input: envelope(f.item) };
    assert.equal(handlers.get("tool_call")?.(call, contextA), undefined);
    const statePath = join(f.root, ".work-state", "features", f.workspace.feature_id, "state.json");
    const beforeRebind = readFileSync(statePath, "utf8");
    handlers.get("session_start")?.({}, contextB);
    const beforeLate = readFileSync(statePath, "utf8");
    assert.equal(beforeLate, beforeRebind, "session rebind does not mutate workflow state");
    handlers.get("tool_result")?.({ toolName: "task", toolCallId: "native-task-call", content: [{ type: "text", text: "late old session" }], isError: false }, contextA);
    assert.equal(readFileSync(statePath, "utf8"), beforeLate, "late old-session result after rebind is dropped");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
