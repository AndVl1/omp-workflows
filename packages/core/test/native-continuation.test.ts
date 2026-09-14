import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { advanceCursor, commitCheckpointAnswerSelected, issueCurrentTrustedMappingProof, validateCheckpointAskSelected } from "../src/engine/durable.js";
import { prepareWorkflowState } from "../src/engine/run.js";
import { resolveState } from "../src/engine/state.js";
import { createFeatureWorkspace } from "../src/specification/workspace.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { readPinnedConstitutionPrincipleIdentities } from "../src/specification/constitution-identities.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { finalizeNativeSpecificationPhase, startNativeSpecificationPhase, type NativeSpecificationGenerationHandoff } from "../src/specification/phase.js";
import { registerTestConstitutionGate } from "./fixtures/registry-activation.js";
import type { FeatureWorkspace } from "../src/specification/types.js";

const profile = loadProfile("spec-preparation");
assert.ok(profile);
const constitution = "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n";

type NativeBinding = NonNullable<FeatureWorkspace["constitution_binding"]>;
interface ConstitutionIdentity { principle_id: string; title: string }
interface SemanticModel { schema_version: number; feature_id: string; run_key: string; phase: "specify"; version: number; worker: { role: string; agent: string; dispatch_id: string }; constitution_binding: NativeBinding; upstream_versions: unknown[]; sections: Record<string, string>; requirements: unknown[]; decisions: unknown[]; tasks: unknown[]; verification: unknown[]; contradictions: unknown[]; constitution_principles: Array<{ principle_id: string; title: string; applicability: "applicable"; status: "pass"; evidence: string; binding: NativeBinding }> }

function workerResultFromSemanticModel(model: SemanticModel, handoff: NativeSpecificationGenerationHandoff): Record<string, unknown> {
  return { input_ref: handoff.input_ref, input_digest: handoff.input_digest, sections: model.sections, requirements: model.requirements, decisions: model.decisions, tasks: model.tasks, verification: model.verification, contradictions: model.contradictions, constitution_principles: model.constitution_principles.map(({ principle_id, applicability, status, evidence }) => ({ principle_id, applicability, status, evidence })) };
}

function modelFor(handoff: NativeSpecificationGenerationHandoff, binding: NativeBinding, identities: ConstitutionIdentity[]): SemanticModel {
  return {
    schema_version: 1,
    feature_id: handoff.feature_id,
    run_key: handoff.run_key,
    phase: "specify",
    version: 1,
    worker: { role: handoff.role, agent: handoff.agent, dispatch_id: handoff.dispatch_id },
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
    verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: [], observable_behavior: true, expected_evidence: "Focused continuation regression" }],
    contradictions: [],
    constitution_principles: identities.map((identity) => ({ principle_id: identity.principle_id, title: identity.title, applicability: "applicable", status: "pass", evidence: "Ship tested work.", binding })),
  };
}

function workerResultForHandoff(root: string, featureId: string, runKey: string, handoff: NativeSpecificationGenerationHandoff): Record<string, unknown> {
  const state = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state!;
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  if (!pinned) throw new Error("project root could not be pinned");
  const identities = readPinnedConstitutionPrincipleIdentities(pinned, state.specification!.constitution_binding!);
  pinned.close();
  assert.equal(identities.ok, true, identities.ok ? "" : identities.error);
  if (!identities.ok) throw new Error(identities.error);
  return workerResultFromSemanticModel(modelFor(handoff, state.specification!.constitution_binding!, identities.value), handoff);
}

function setup(): { root: string; featureId: string; runKey: string } {
  const root = mkdtempSync(join(tmpdir(), "native-continuation-"));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
  writeFileSync(join(root, "CONSTITUTION.md"), constitution);
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "specification-analyst": "specification-worker" } }) + "\n");
  const config = resolveConfig(root);
  const publishAgentMapping = () => writeAgentMapping(root, buildAgentMapping({
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
  publishAgentMapping();
  const featureId = "native-continuation-feature";
  const runKey = "native-continuation-run";
  registerTestConstitutionGate(root, "native-continuation-gate");
  const created = createFeatureWorkspace(root, { feature_id: featureId, display_name: featureId, run_key: runKey, profile_name: "spec-preparation", profile_hash: profileHash(profile!), source_kind: "native" });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: runKey, origin_stage: "specify" }, { feature_id: featureId });
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  assert.ok(gate.ok && gate.value.binding, "continuation fixture must establish an approved current constitution binding");
  publishAgentMapping();
  return { root, featureId, runKey };
}

function advanceWithCurrentProof(root: string, input: Parameters<typeof advanceCursor>[1]): ReturnType<typeof advanceCursor> {
  const trustedMappingProof = issueCurrentTrustedMappingProof(root);
  return advanceCursor(root, input, trustedMappingProof === undefined ? undefined : { trustedMappingProof });
}

function readFileSnapshot(root: string, featureId: string): string {
  return readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8");
}

function prepare(root: string, featureId: string, runKey: string) {
  return prepareWorkflowState({
    task: "Draft native specification",
    cwd: root,
    branch: "main",
    autonomous: false,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    feature_id: featureId,
    run_key: runKey,
  });
}

function finalizeWithModel(root: string, featureId: string, runKey: string, started: { handoff: NativeSpecificationGenerationHandoff }) {
  const state = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state!;
  const record = state.dispatch_capability!.dispatches.find((candidate) => (candidate.purpose ?? "generation") === "generation")!;
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  const identities = readPinnedConstitutionPrincipleIdentities(pinned!, state.specification!.constitution_binding!);
  pinned!.close();
  assert.equal(identities.ok, true, identities.ok ? "" : identities.error);
  if (!identities.ok) throw new Error(identities.error);
  const result = finalizeNativeSpecificationPhase(root, {
    feature_id: featureId,
    run_key: runKey,
    worker_result: workerResultFromSemanticModel(modelFor({ ...started.handoff, dispatch_id: record.id }, state.specification!.constitution_binding, identities.value), started.handoff) as never,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error(result.error);
  return result.value.required_next_tool.arguments as Record<string, unknown>;
}

test("native request_changes continuation mints v2 authority and preserves v1 history", () => {
  const { root, featureId, runKey } = setup();
  try {
    const v1 = prepare(root, featureId, runKey);
    const v1Handoff = v1.preparation_handoff!;
    const startedV1 = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: v1Handoff });
    assert.equal(startedV1.ok, true, startedV1.ok ? "" : startedV1.error);
    if (!startedV1.ok) return;
    const askV1 = finalizeWithModel(root, featureId, runKey, startedV1.value);
    const selectedV1 = validateCheckpointAskSelected(root, askV1 as never);
    assert.equal(selectedV1.ok, true, selectedV1.ok ? "" : selectedV1.error);
    const answeredV1 = commitCheckpointAnswerSelected(root, { ...askV1, decision: "request_changes", feedback: "Revise the specification evidence." } as never, { apply_decision: true });
    assert.equal(answeredV1.ok, true, answeredV1.ok ? "" : answeredV1.error);
    const advancedV1 = advanceWithCurrentProof(root, { ...askV1, token: askV1.advance_token, evidence: "request changes accepted" } as never);
    assert.equal(advancedV1.ok, true, advancedV1.ok ? "" : advancedV1.error);
    const afterRevision = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state!;
    assert.equal(afterRevision.preparation_handoff, undefined, "request_changes must stale v1 preparation authority");
    assert.equal(afterRevision.preparation_start, undefined, "request_changes must clear v1 start receipt");
    assert.equal(afterRevision.typed_checkpoint_decisions?.at(-1)?.decision, "request_changes");
    assert.ok(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "specify.v1.json")), "immutable v1 artifact must remain available");
    const staleAdvance = advanceWithCurrentProof(root, { ...askV1, token: askV1.advance_token, evidence: "stale retry" } as never);
    assert.equal(staleAdvance.ok, false, "the old capability cannot authorize the revised phase");
    const staleStart = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: v1Handoff });
    assert.equal(staleStart.ok, false, "the original preparation handoff cannot authorize v2");

    const feedback = "Tighten the scope while preserving the initial request";
    const v2 = prepareWorkflowState({ task: afterRevision.task, cwd: root, branch: "main", autonomous: false, continuation: { feedback, stageId: "specify" }, feature_id: featureId, run_key: runKey });
    assert.ok(v2.preparation_handoff);
    assert.equal(v2.preparation_handoff!.task, v2.state.task);
    assert.notEqual(v2.preparation_handoff!.token, v1Handoff.token);
    assert.notEqual(v2.preparation_handoff!.digest, v1Handoff.digest);
    assert.equal(v2.state.history?.at(-1)?.feedback, feedback);
    const replay = prepareWorkflowState({ task: afterRevision.task, cwd: root, branch: "main", autonomous: false, continuation: { feedback, stageId: "specify" }, feature_id: featureId, run_key: runKey });
    assert.equal(replay.preparation_handoff?.token, v2.preparation_handoff!.token, "an exact continuation replay must not mint another authority");
    assert.equal(replay.state.state_revision, v2.state.state_revision);
    assert.throws(() => prepareWorkflowState({ task: "tampered request", cwd: root, branch: "main", autonomous: false, continuation: { feedback, stageId: "specify" }, feature_id: featureId, run_key: runKey }), /immutable initial request/);

    const marker = "<!-- omp-cto-slice run=continuation-cto slice=native-v2 -->";
    const startedV2 = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: v2.preparation_handoff! }, { ctoSliceMarker: marker });
    assert.equal(startedV2.ok, true, startedV2.ok ? "" : startedV2.error);
    if (!startedV2.ok) return;
    const task = startedV2.value.required_next_tool.arguments.tasks[0]!.task;
    assert.ok(task.endsWith("\n\n" + marker), "v2 task descriptor must carry the exact CTO marker");
    const askV2 = finalizeWithModel(root, featureId, runKey, startedV2.value);
    assert.equal(askV2.checkpoint, "specification_phase_approval");
    const selectedV2 = validateCheckpointAskSelected(root, askV2 as never);
    assert.equal(selectedV2.ok, true, selectedV2.ok ? "" : selectedV2.error);
    const answeredV2 = commitCheckpointAnswerSelected(root, { ...askV2, decision: "approve_continue" } as never, { apply_decision: true });
    assert.equal(answeredV2.ok, true, answeredV2.ok ? "" : answeredV2.error);
    const terminal = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state!;
    assert.equal(terminal.history?.at(-1)?.feedback, feedback);
    assert.equal(terminal.typed_checkpoint_decisions?.filter((entry) => entry.stage_id === "specify").length, 2);
    assert.ok(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "specify.v1.json")), "v1 artifact history must survive v2 finalization");
    assert.ok(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "specify.v2.json")), "v2 artifact must be distinct from v1");
    const advancedV2 = advanceWithCurrentProof(root, { ...askV2, token: askV2.advance_token, evidence: "approve continue accepted" } as never);
    assert.equal(advancedV2.ok, true, advancedV2.ok ? "" : advancedV2.error);
    if (advancedV2.ok) assert.equal(advancedV2.state.stage_cursor, "plan", "the exact v2 advance descriptor must reach the next phase");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("native preparation refresh replaces stale authority without resetting the workspace", () => {
  const { root, featureId, runKey } = setup();
  try {
    const first = prepare(root, featureId, runKey);
    const oldHandoff = first.preparation_handoff!;
    const before = readFileSnapshot(root, featureId);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const changed = JSON.parse(before) as Record<string, unknown>;
    changed.artifacts = { ...(changed.artifacts as Record<string, string>), "retained.phase": "artifact-v1" };
    writeFileSync(statePath, JSON.stringify(changed, null, 2) + "\n", "utf8");

    const refreshed = prepare(root, featureId, runKey);
    assert.notEqual(refreshed.preparation_handoff!.token, oldHandoff.token, "a stale authority must be replaced with a single-use token");
    assert.notEqual(refreshed.preparation_handoff!.digest, oldHandoff.digest);
    assert.equal(refreshed.state.artifacts["retained.phase"], "artifact-v1", "refresh must preserve completed artifact references");
    assert.equal(refreshed.state.stage_cursor, first.state.stage_cursor, "refresh must preserve the phase cursor");
    assert.deepEqual(refreshed.state.stages, first.state.stages, "refresh must preserve phase statuses");

    const changedClassification = { ...refreshed.classification, complexity: "COMPLEX" as const };
    const beforeDrift = readFileSnapshot(root, featureId);
    assert.throws(
      () => prepareWorkflowState({
        task: "Draft native specification",
        cwd: root,
        branch: "main",
        autonomous: false,
        classification: changedClassification,
        feature_id: featureId,
        run_key: runKey,
      }),
      /workflow state already exists|state_conflict/,
      "classification drift must fail closed rather than minting another authority",
    );
    assert.equal(readFileSnapshot(root, featureId), beforeDrift, "classification drift must not mutate the state");
    assert.throws(
      () => prepareWorkflowState({
        task: "Draft native specification",
        cwd: root,
        branch: "main",
        autonomous: false,
        classification: refreshed.classification,
        feature_id: featureId,
        run_key: runKey + "-drift",
      }),
      /workflow state is invalid or unsafe/,
      "run selector drift must fail closed rather than targeting another workspace",
    );

    const staleStart = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: oldHandoff });
    assert.equal(staleStart.ok, false, "the retired handoff must not authorize native start");
    if (!staleStart.ok) assert.match(staleStart.error, /exact persisted authority|preparation_handoff/);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native checkpoint transitions re-mint current phase preparation authority", () => {
  const cases = [
    { decision: "approve_continue" as const },
    { decision: "approve_stop" as const },
    { decision: "request_changes" as const, feedback: "Revise the specification evidence." },
  ];
  for (const selected of cases) {
    const { root, featureId, runKey } = setup();
    try {
      const prepared = prepare(root, featureId, runKey);
      const started = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: prepared.preparation_handoff! });
      assert.equal(started.ok, true, started.ok ? "" : started.error);
      if (!started.ok) continue;
      const ask = finalizeWithModel(root, featureId, runKey, started.value);
      const answered = commitCheckpointAnswerSelected(root, {
        ...ask,
        decision: selected.decision,
        ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }),
      } as never, { apply_decision: true });
      assert.equal(answered.ok, true, answered.ok ? "" : answered.error);
      if (!answered.ok) continue;
      const advanced = advanceWithCurrentProof(root, {
        ...ask,
        token: ask.advance_token,
        evidence: "durable native checkpoint transition",
      } as never);
      assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.error);
      if (!advanced.ok) continue;
      const transitioned = resolveState(root, "main", { feature_id: featureId, run_key: runKey }).state!;
      assert.equal(transitioned.preparation_handoff, undefined, "advance must retire the prior preparation authority");
      assert.equal(transitioned.preparation_start, undefined, "advance must retire the prior native start marker");
      const retainedArtifacts = { ...transitioned.artifacts };
      const refreshed = prepare(root, featureId, runKey);
      assert.ok(refreshed.preparation_handoff, "an authenticated native transition must mint the current phase authority");
      assert.equal(refreshed.preparation_handoff!.state_revision, refreshed.state.state_revision);
      assert.deepEqual(refreshed.state.artifacts, retainedArtifacts, "phase transition refresh must preserve completed artifacts");
      assert.equal(refreshed.state.stage_cursor, transitioned.stage_cursor, "phase transition refresh must preserve the current cursor");
      if (selected.decision === "request_changes") {
        const forged = JSON.parse(readFileSnapshot(root, featureId)) as Record<string, unknown>;
        delete forged.preparation_handoff;
        const capability = forged.dispatch_capability as Record<string, unknown>;
        capability.status = "dispatched";
        writeFileSync(join(root, ".work-state", "features", featureId, "state.json"), JSON.stringify(forged, null, 2) + "\n", "utf8");
        assert.throws(
          () => prepare(root, featureId, runKey),
          /workflow state already exists|state_conflict/,
          "an active or forged dispatch state must not be refreshed without a safe post-transition image",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native worker generation bindings reject retry, missing, and tampered results", () => {
  const { root, featureId, runKey } = setup();
  try {
    const preparedV1 = prepare(root, featureId, runKey);
    const startedV1 = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: preparedV1.preparation_handoff! });
    assert.equal(startedV1.ok, true, startedV1.ok ? "" : startedV1.error);
    if (!startedV1.ok) return;
    const v1Result = workerResultForHandoff(root, featureId, runKey, startedV1.value.handoff);
    const askV1Result = finalizeNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, worker_result: v1Result as never });
    assert.equal(askV1Result.ok, true, askV1Result.ok ? "" : askV1Result.error);
    if (!askV1Result.ok) return;
    const askV1 = askV1Result.value.required_next_tool.arguments as Record<string, unknown>;
    const selectedV1 = validateCheckpointAskSelected(root, askV1 as never);
    assert.equal(selectedV1.ok, true, selectedV1.ok ? "" : selectedV1.error);
    const answeredV1 = commitCheckpointAnswerSelected(root, { ...askV1, decision: "request_changes", feedback: "Revise the generation binding." } as never, { apply_decision: true });
    assert.equal(answeredV1.ok, true, answeredV1.ok ? "" : answeredV1.error);
    const advancedV1 = advanceWithCurrentProof(root, { ...askV1, token: askV1.advance_token, evidence: "request changes accepted" } as never);
    assert.equal(advancedV1.ok, true, advancedV1.ok ? "" : advancedV1.error);
    const preparedV2 = prepareWorkflowState({ task: preparedV1.state.task, cwd: root, branch: "main", autonomous: false, continuation: { feedback: "Revise the generation binding.", stageId: "specify" }, feature_id: featureId, run_key: runKey });
    const startedV2 = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: preparedV2.preparation_handoff! });
    assert.equal(startedV2.ok, true, startedV2.ok ? "" : startedV2.error);
    if (!startedV2.ok) return;
    const beforeStale = readFileSnapshot(root, featureId);
    const stale = finalizeNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, worker_result: v1Result as never });
    assert.equal(stale.ok, false, "a worker result from the retired generation must be rejected");
    assert.equal(readFileSnapshot(root, featureId), beforeStale, "retired generation rejection must not mutate durable state");

    const v2Result = workerResultForHandoff(root, featureId, runKey, startedV2.value.handoff);
    for (const candidate of [
      (() => { const value = { ...v2Result }; delete value.input_ref; return value; })(),
      (() => { const value = { ...v2Result }; value.input_digest = "0".repeat(64); return value; })(),
    ]) {
      const beforeInvalid = readFileSnapshot(root, featureId);
      const invalid = finalizeNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, worker_result: candidate as never });
      assert.equal(invalid.ok, false, "missing or tampered generation binding must be rejected");
      assert.equal(readFileSnapshot(root, featureId), beforeInvalid, "invalid generation binding must not mutate durable state");
    }
    const finalized = finalizeNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, worker_result: v2Result as never });
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) return;
    const artifactPath = join(root, ".work-state", "features", featureId, "artifacts", "specify.v2.json");
    const beforeReplayArtifact = readFileSync(artifactPath, "utf8");
    const replay = finalizeNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, worker_result: v2Result as never });
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    assert.equal(replay.replayed, true, "exact completed generation replay must report replayed");
    assert.equal(readFileSync(artifactPath, "utf8"), beforeReplayArtifact, "exact completed generation replay must not rewrite the immutable artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("native selected Ask exact applied replay is idempotent for every decision", () => {
  const cases = [
    { decision: "approve_continue" },
    { decision: "approve_stop" },
    { decision: "request_changes", feedback: "Revise the specification evidence." },
  ] as const;
  for (const selected of cases) {
    const { root, featureId, runKey } = setup();
    try {
      const prepared = prepare(root, featureId, runKey);
      assert.ok(prepared.preparation_handoff);
      const started = startNativeSpecificationPhase(root, { feature_id: featureId, run_key: runKey, preparation_handoff: prepared.preparation_handoff! });
      assert.equal(started.ok, true, started.ok ? "" : started.error);
      if (!started.ok) continue;
      const ask = finalizeWithModel(root, featureId, runKey, started.value);
      const first = commitCheckpointAnswerSelected(root, { ...ask, decision: selected.decision, ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }) } as never, { apply_decision: true });
      assert.equal(first.ok, true, first.ok ? "" : first.error);
      if (!first.ok) continue;
      const statePath = join(root, ".work-state", "features", featureId, "state.json");
      const beforeRetry = readFileSync(statePath, "utf8");
      const retry = commitCheckpointAnswerSelected(root, { ...ask, decision: selected.decision, ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }) } as never, { apply_decision: true });
      assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
      if (retry.ok) assert.equal(retry.outcome, "already_recorded");
      assert.equal(readFileSync(statePath, "utf8"), beforeRetry, "exact replay must not mutate durable state");

      const restartReplay = commitCheckpointAnswerSelected(root, { ...ask, decision: selected.decision, ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }) } as never, { apply_decision: true });
      assert.equal(restartReplay.ok, true, restartReplay.ok ? "" : restartReplay.error);
      if (restartReplay.ok) assert.equal(restartReplay.outcome, "already_recorded");
      assert.equal(readFileSync(statePath, "utf8"), beforeRetry, "restart replay must not mutate durable state");

      const conflictingDecision = selected.decision === "request_changes" ? "approve_continue" : "request_changes";
      const conflicting = commitCheckpointAnswerSelected(root, {
        ...ask,
        decision: conflictingDecision,
        ...(conflictingDecision === "request_changes" ? { feedback: "A different answer" } : {}),
      } as never, { apply_decision: true });
      assert.equal(conflicting.ok, false, "a different selected answer must remain invalid");
      assert.equal(readFileSync(statePath, "utf8"), beforeRetry, "conflicting replay must not mutate durable state");
      const staleCursor = commitCheckpointAnswerSelected(root, { ...ask, cursor_epoch: `${ask.cursor_epoch}-stale`, decision: selected.decision, ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }) } as never, { apply_decision: true });
      assert.equal(staleCursor.ok, false, "a stale cursor retry must remain invalid");
      assert.equal(readFileSync(statePath, "utf8"), beforeRetry, "stale cursor replay must not mutate durable state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
