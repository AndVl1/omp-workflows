/** Failing public-contract tests for CTO execution of ready specifications (T092).
 *
 * Explicit feature/run selectors are resolved from the authorized project root;
 * handoffs and claims are loaded from canonical state, frozen into one mapping,
 * confirmed through trusted user proof, then dispatched only when safe.
 *
 * Public seams (T096/T097):
 * preflightCtoSpecificationExecution(root, { cto_run_id, selections })
 * confirmCtoSpecificationMapping(root, { cto_run_id, mapping_id,
 *   mapping_hash, answer_id })
 * await dispatchCtoSpecificationMapping(root, { cto_run_id, mapping_id,
 *   expected_mapping_hash })
 */

import { after, afterEach, test } from "node:test";
import { TEST_CONTEXT, TEST_ON, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as publicCore from "../src/index.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { registerTestWorkflowTools, registerTestCtoTools, registerTestTeamWorkflow } from "./fixtures/host-tool-activation.js";
import { resolveCtoRuntimeAccessForRoot, type CtoRuntimeAccessFacade } from "../src/cto/runtime-access.js";
import {
  closeCtoSpecificationExecutionWave as closeCtoSpecificationExecutionWaveImpl,
  registerCtoTools,
  confirmCtoSpecificationMapping,
  dispatchCtoSpecificationMapping as dispatchCtoSpecificationMappingImpl,
  preflightCtoSpecificationExecution,
  admitImplementationWorkflowBegin,
} from "../src/index.js";
import type { CtoSpecificationMappingDispatchOptions, CtoSpecificationExecutionWaveCloseOptions } from "../src/commands/cto.js";
import {
  buildCtoPrompt,
  deriveCtoSpecificationMappingAskInput,
  parseEnvelope,
  prepareCtoSpecificationMappingAsk,
  recordCtoSpecificationMappingAsk,
  resumeCtoSpecificationMapping,
  setCtoSpecificationExecutionTestHooks,
  setCtoSpecificationMappingFailureInjector,
} from "../src/commands/cto.js";
import { completeSpecificationExecution, createCapability, MAX_ADVANCE_FIELD_BYTES, MAX_ADVANCE_EVIDENCE_BYTES, readTrustedTaskResultReceipt, verifyTrustedTaskResultReceipt } from "../src/engine/durable.js";
import { ctoMappingConfirmationProofRelativePath } from "../src/engine/cto-mapping-proof.js";
import { MAX_PREPARATION_HANDOFF_TASK_BYTES } from "../src/engine/preparation.js";
import { writeArtifactWithReference } from "../src/engine/artifacts.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { activeWave, ctoRuntimeRunInitialIdentityDigest, ctoSpecificationConformanceReceiptRelativePath, isSafeCtoExecutionId, mintCtoRuntimeRunOrigin, newCtoState, readCtoState, readCtoStatePinned, writeCtoRuntimeStateProof, writeCtoState } from "../src/cto/state.js";
import { buildCtoSliceMarker } from "../src/cto/slice-marker.js";
import { classificationToolGate } from "../src/gates/classification.js";
import { preflightCtoSpecificationExecution as preflightCtoSpecificationExecutionGate, setCtoGateHandoffReadTestHooks } from "../src/cto/gates.js";
import { dispatchGate } from "../src/gates/dispatch.js";
import { ctoSliceTaskGate } from "../src/cto/slice-gate.js";
import { resolveState, setStateTransactionTestHooks, updateStateAtomically, writeState } from "../src/engine/state.js";
import { acquireExecutionClaim, readCurrentExecutionClaim, readExecutionClaimStore, releaseExecutionClaim, setExecutionClaimCompletionTestHooks } from "../src/specification/claims.js";
import { setImplementationWorkflowBeginTestHooks } from "../src/engine/run.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { authorizeCtoSpecificationExecutionTask, prepareCtoSpecificationExecution as prepareCtoSpecificationExecutionImpl, reconcileCtoSpecificationExecutionTeams, setCtoSpecificationPreparationTestHooks, type PrepareCtoSpecificationExecutionOptions } from "../src/cto/specification-execution.js";
import { z as zod } from "zod";
import { canonicalJson, digestOf, implementationConformanceMatrixDigest, sha256Hex } from "../src/specification/validation.js";
import { MAX_CONFORMANCE_EVIDENCE_ENTRIES, MAX_CONFORMANCE_FIELD_BYTES, persistCtoSpecificationConformance } from "../src/specification/conformance.js";
import { CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS, withCtoRunLockAsync } from "../src/cto/transaction-lock.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { captureWorkspacePathBinding } from "../src/specification/workspace.js";

import type { TeamState } from "../src/engine/types.js";
import type { CtoState } from "../src/cto/types.js";

import {
  MAX_CTO_SPECIFICATION_AGGREGATE_BYTES,
  MAX_CTO_SPECIFICATION_ID_BYTES,
  MAX_CTO_SPECIFICATION_REQUESTS,
  MAX_CTO_SPECIFICATION_TEXT_BYTES,
} from "../src/cto/types.js";
import { buildCtoSpecificationMapping, buildTeamPlan, ctoSpecificationTeamId, validateDecompositionDepth } from "../src/cto/plan.js";
import {
  validExecutionClaim,
  validFeatureWorkspace,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";

type Json = Record<string, unknown>;
type Result = Json & { status: string; mapping?: Json; findings?: unknown; blocking_findings?: unknown; dispatched?: boolean };
const RUN_ID = "CTO-SPEC-EXECUTION-1";
/**
 * The contention fixture has 29 bounded Darwin descriptor-helper startups after
 * timing begins (three for lock admission, then the confirmed mapping WAL/state
 * transaction and cleanup). The full-core security run observed 9,409ms for the
 * prior 33-startup path, or under 300ms per startup; round that observed
 * worst-case up and retain 300ms for scheduling. This yields 9,000ms, one
 * second below the 10,000ms production run-lock deadline.
 */
const CONTENTION_DESCRIPTOR_HELPER_STARTUPS = 29;
const DARWIN_HELPER_WORST_CASE_MS = 300;
const CONTENTION_SCHEDULING_MARGIN_MS = 300;
const CONTENTION_BUDGET_MS = Math.min(
  CONTENTION_DESCRIPTOR_HELPER_STARTUPS * DARWIN_HELPER_WORST_CASE_MS + CONTENTION_SCHEDULING_MARGIN_MS,
  CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS - 1_000,
);
const AUTHORITY_PROFILE = loadProfile("constitution");
if (!AUTHORITY_PROFILE) throw new Error("constitution profile is required for trusted mapping fixture");
const AUTHORITY_POLICY = AUTHORITY_PROFILE.checkpoint_policy;
if (!AUTHORITY_POLICY) throw new Error("constitution checkpoint policy is required");
const AUTHORITY_STAGE = AUTHORITY_PROFILE.stages.find((stage) => stage.id === "constitution_validate");
if (!AUTHORITY_STAGE?.checkpoint) throw new Error("constitution validation checkpoint is required");
const STAGE_ID = AUTHORITY_STAGE.id;
const CHECKPOINT_ID = AUTHORITY_STAGE.checkpoint;
const CONFIRMATION_DECISION = AUTHORITY_POLICY.rules[CHECKPOINT_ID]?.allowed_decisions.find((decision) => decision === "approve_continue");
if (!CONFIRMATION_DECISION) throw new Error("constitution approval decision is required");
const PROFILE_HASH = profileHash(AUTHORITY_PROFILE);
const projectFeatures = new Map<string, Set<string>>();
const executionContexts = new Map<string, { feature_id: string; run_key: string; capability_id: string; capability_epoch: string }>();

function sliceId(featureId: string, taskId: string): string { return "slice-" + digestOf({ kind: "cto-slice", feature_id: featureId, task_id: taskId }).slice(0, 32); }
function teamId(featureId: string, runKey: string, handoffDigest: string, taskId?: string): string { return ctoSpecificationTeamId(featureId, runKey, handoffDigest, taskId); }

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "cto-specification-execution-"));
}

type TestRuntimeFixture = { access: CtoRuntimeAccessFacade };
const testRuntimeFixtures = new Map<string, TestRuntimeFixture & { close: () => void }>();
const DEFAULT_TEST_SESSION_ID = "registrar-test-session";

function testRuntimeAccess(root: string, sessionId: string, ownerId = `core-test-runtime-${digestOf({ root, sessionId }).slice(0, 16)}`) {
  const key = `${root}\0${sessionId}`;
  const existing = testRuntimeFixtures.get(key);
  if (existing) return existing.access;
  const opened = openTestCtoRuntime(root, sessionId, ownerId);
  const fixture = { access: opened.access, close: opened.close } as TestRuntimeFixture & { close: () => void };
  testRuntimeFixtures.set(key, fixture as TestRuntimeFixture);
  return fixture.access;
}
function closeTestRuntime(root: string, sessionId: string): void {
  const key = `${root}\0${sessionId}`;
  const fixture = testRuntimeFixtures.get(key);
  if (!fixture) return;
  fixture.close();
  testRuntimeFixtures.delete(key);
}

afterEach(() => {
  for (const [key, fixture] of [...testRuntimeFixtures]) {
    fixture.close();
    testRuntimeFixtures.delete(key);
  }
});

after(() => {
  for (const fixture of testRuntimeFixtures.values()) fixture.close();
  testRuntimeFixtures.clear();
});

type TestPreparationOptions = Omit<PrepareCtoSpecificationExecutionOptions, "runtimeAccess" | "sessionId"> & { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string };
function preparationRuntimeOptions(root: string, sessionId = DEFAULT_TEST_SESSION_ID): { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string } {
  return { runtimeAccess: testRuntimeAccess(root, sessionId), sessionId };
}
function prepareCtoSpecificationExecution(root: string, input: Parameters<typeof prepareCtoSpecificationExecutionImpl>[1], options: TestPreparationOptions): ReturnType<typeof prepareCtoSpecificationExecutionImpl> {
  return prepareCtoSpecificationExecutionImpl(root, input, options);
}

type TestDispatchOptions = Omit<CtoSpecificationMappingDispatchOptions, "runtimeAccess" | "sessionId"> & { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string };
function dispatchCtoSpecificationMapping(root: string, input: Parameters<typeof dispatchCtoSpecificationMappingImpl>[1], options: TestDispatchOptions) {
  return dispatchCtoSpecificationMappingImpl(root, input, options);
}

type TestCloseOptions = Omit<CtoSpecificationExecutionWaveCloseOptions, "runtimeAccess" | "sessionId"> & { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string };
function closeCtoSpecificationExecutionWave(root: string, input: Parameters<typeof closeCtoSpecificationExecutionWaveImpl>[1], options: TestCloseOptions) {
  return closeCtoSpecificationExecutionWaveImpl(root, input, options);
}

/** Persist the same state envelope and immutable artifacts consumed by execution. */
function writeFeature(root: string, featureId: string, runKey = `run-${featureId}-1`, options: { stale?: boolean; claim?: Json } = {}): { handoff: Json; handoffPath: string } {
  const constitutionPath = join(root, "CONSTITUTION.md");
  if (!existsSync(constitutionPath)) {
    writeFileSync(constitutionPath, "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  }
  const constitution = ensureProjectConstitution(root, {
    origin_kind: "cto_preparation",
    origin_run_key: runKey,
    origin_stage: "cto",
  });
  if (!constitution.ok || !constitution.value.binding) {
    throw new Error(`fixture constitution prerequisite failed: ${constitution.ok ? "binding unavailable" : constitution.error}`);
  }
  const constitutionBinding = constitution.value.binding as unknown as Json;
  const handoff = validImplementationHandoff({ featureId }) as unknown as Json;
  handoff.constitution_binding = constitutionBinding;
  handoff.execution_choices = options.claim?.owner_kind === "do_work" ? ["cto", "do-work"] : ["cto"];
  if (options.stale) handoff.status = "stale";
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...digestBody } = handoff;
  handoff.handoff_digest = digestOf(digestBody);
  const handoffRef = String(handoff.handoff_id);
  const handoffPath = `.work-state/features/${featureId}/artifacts/implementation_handoff/${handoffRef}.json`;
  const statePath = `.work-state/features/${featureId}/state.json`;
  const workspace = validFeatureWorkspace({ featureId, status: "implementation_ready", withApprovedSpecify: true, constitutionBinding: constitutionBinding as never }) as unknown as Json;
  workspace.constitution_gate_ref = String(constitution.value.gate_id);
  workspace.schema_version = 3;
  workspace.project_root = root;
  const fixtureRoot = PinnedProjectRoot.open(root);
  if (!fixtureRoot) throw new Error("fixture project root cannot be pinned");
  workspace.project_root_identity = { canonical_path: fixtureRoot.canonical_root, dev: fixtureRoot.dev, ino: fixtureRoot.ino };
  fixtureRoot.close();
  workspace.workspace_path = `specs/${featureId}`;
  workspace.state_path = statePath;
  workspace.handoff_ref = handoffRef;
  workspace.execution_claim_ref = null;
  workspace.execution_claim_prepare_ref = null;
  const upstreamHash = (phase: string) => digestOf({ feature_id: featureId, phase, version: 1 });
  workspace.phases = (workspace.phases as Json[]).map((phase) => {
    const phaseId = String((phase as Json).phase);
    const upstream_versions = phaseId === "specify"
      ? []
      : phaseId === "plan"
        ? [{ phase: "specify", version: 1, hash: upstreamHash("specify") }]
        : [
          { phase: "specify", version: 1, hash: upstreamHash("specify") },
          { phase: "plan", version: 1, hash: upstreamHash("plan") },
        ];
    return {
      ...phase,
      status: "approved",
      current_version: 1,
      approved_version: 1,
      validation_ref: `validation.${phaseId}.v1`,
      checkpoint_ref: `checkpoint.${phaseId}.v1`,
      upstream_versions,
    };
  });
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  mkdirSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff"), { recursive: true });
  mkdirSync(join(root, ".work-state", "features", featureId, "artifacts", "execution_claim", "next"), { recursive: true });
  const bindingRoot = PinnedProjectRoot.open(root);
  if (!bindingRoot) throw new Error("fixture project root cannot be pinned for path binding");
  workspace.path_binding = captureWorkspacePathBinding(bindingRoot, featureId);
  bindingRoot.close();
  writeFileSync(join(root, statePath), JSON.stringify({ schema: 1, run_key: runKey, state_revision: 1, specification: workspace }));
  const features = projectFeatures.get(root) ?? new Set<string>();
  features.add(featureId);
  projectFeatures.set(root, features);
  writeFileSync(join(root, handoffPath), JSON.stringify(handoff));
  if (options.claim) {
    const acquired = acquireExecutionClaim(root, featureId, {
      handoff: handoff as never,
      run_key: runKey,
      owner_kind: String(options.claim.owner_kind) as "cto" | "do_work",
      owner_run_id: String(options.claim.owner_run_id),
    });
    if (!acquired.ok) throw new Error(`fixture active claim acquisition failed: ${acquired.error}`);
    if (acquired.value.status !== "active") throw new Error("fixture active claim acquisition did not produce an active claim");
  }
  return { handoff, handoffPath };
}

function selection(featureId: string, runKey = `run-${featureId}-1`): Json {
  return { feature_id: featureId, run_key: runKey };
}

function rewriteHandoff(root: string, featureId: string, mutate: (handoff: Json) => void): void {
  const state = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8")) as Json;
  const workspace = state.specification as Json;
  const file = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`);
  const handoff = JSON.parse(readFileSync(file, "utf8")) as Json;
  mutate(handoff);
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...digestBody } = handoff;
  handoff.handoff_digest = digestOf(digestBody);
  writeFileSync(file, JSON.stringify(handoff));
}

function writeParallelFeatures(root: string, featureIds: readonly string[]): void {
  for (const featureId of featureIds) writeFeature(root, featureId);
  for (const featureId of featureIds) rewriteHandoff(root, featureId, (handoff) => {
    (handoff.tasks as Json[])[0]!.parallel_safe = true;
    (handoff.tasks as Json[])[0]!.affected_scope = [`src/${featureId}.ts`];
    handoff.scope = { ...(handoff.scope as Json), constraints: [] };
  });
}
function migrateFeatureWorkspaceToSchema3(root: string, featureId: string, runKey: string): void {
  const state = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8")) as Json;
  const workspace = state.specification as Json;
  const handoff = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`), "utf8")) as Json;
  handoff.execution_choices = ["cto", "do-work"];
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...digestBody } = handoff;
  handoff.handoff_digest = digestOf(digestBody);
  writeFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`), JSON.stringify(handoff));
  const acquired = acquireExecutionClaim(root, featureId, {
    handoff: handoff as never,
    run_key: runKey,
    owner_kind: "do_work",
    owner_run_id: `schema3-${featureId}`,
  });
  if (!acquired.ok) throw new Error(acquired.error);
  const released = releaseExecutionClaim(root, featureId, {
    claim_id: acquired.value.claim_id,
    handoff_digest: acquired.value.handoff_digest,
    owner_kind: acquired.value.owner_kind,
    owner_run_id: acquired.value.owner_run_id,
    reason: "schema3 fixture migration",
  });
  if (!released.ok) throw new Error(released.error);
}

function ensureExecutionContext(root: string, options: { featureStateOnly?: boolean } = {}): void {
  if (executionContexts.has(root)) return;
  const features = [...(projectFeatures.get(root) ?? [])].sort();
  if (features.length === 0) throw new Error("execution fixture requires one feature");
  const firstFeature = features[0]!;
  const firstEnvelope = JSON.parse(readFileSync(join(root, ".work-state", "features", firstFeature, "state.json"), "utf8")) as Json;
  const firstWorkspace = firstEnvelope.specification as Json;
  const runKey = String(firstEnvelope.run_key);
  const issued = createCapability({ run_key: runKey, branch: "test", workflow: "constitution", profile_hash: PROFILE_HASH, stage_cursor: STAGE_ID, kind: "none" });
  const featureState: TeamState = {
    schema: 1, branch: "test", run_key: runKey,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "constitution" },
    task: "confirm CTO specification mapping", workflow_override: false,
    checkpoint_policy: AUTHORITY_POLICY,
    issue: null, stage_cursor: STAGE_ID, stages: [{ id: STAGE_ID, status: "in_progress" }], artifacts: {}, pause: { kind: "none", reason: "" }, profile_hash: PROFILE_HASH,
    cursor_epoch: issued.state.issued_for!.cursor_epoch, dispatch_capability: issued.state,
    specification: firstWorkspace as TeamState["specification"], updated_at: new Date().toISOString(),
  };
  writeState(root, featureState, { featureSlug: firstFeature });
  if (options.featureStateOnly) return;
  const capabilityId = issued.state.capability_id!;
  const capabilityEpoch = issued.state.issued_for!.cursor_epoch;
  const slices: Array<{ feature_id: string; task_id: string; slice_id: string; team_id: string; depends_on: string[] }> = [];
  for (const featureId of features) {
    const envelope = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8")) as Json;
    const workspace = envelope.specification as Json;
    const handoff = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`), "utf8")) as Json;
    for (const task of handoff.tasks as Json[]) slices.push({ feature_id: featureId, task_id: String(task.task_id), slice_id: sliceId(featureId, String(task.task_id)), team_id: teamId(featureId, String(envelope.run_key), String(handoff.handoff_digest), String(task.task_id)), depends_on: Array.isArray(task.depends_on) ? task.depends_on.map(String) : [] });
  }
  const now = new Date().toISOString();
  const waveId = "WAVE-SPECIFICATION-EXECUTION-1";
  const workIdentity = (slice: string, worker: string, taskId = "T-1") => ({ run_id: RUN_ID, wave_id: waveId, slice_id: slice, session_id: DEFAULT_TEST_SESSION_ID, workflow: "standard" as const, stage_id: "execution", stage_cursor: "execution", capability_id: capabilityId, capability_epoch: capabilityEpoch, slot_id: worker, task_id: taskId, dispatch_id: `dispatch-${slice}`, attempt: 1, worker_id: worker });
  const teams = slices.map((slice) => {
    const dodPath = `.work-state/cto/${RUN_ID}/artifacts/${slice.team_id}`;
    mkdirSync(join(root, dodPath), { recursive: true });
    const dod = { items: [{ id: "d1", source: "test", criterion: "execute", verify_method: "claim", status: "pending", evidence: "" }], type_requirements_met: true, updated_at: now };
    writeFileSync(join(root, dodPath, "dod.json"), JSON.stringify(dod));
    const dodDigest = digestOf({ items: dod.items, type_requirements_met: dod.type_requirements_met });
    return { id: slice.team_id, status: "pending" as const, escalations: {}, slice_id: slice.slice_id, feature_id: slice.feature_id, run_key: `run-${slice.feature_id}-1`, task_id: slice.task_id, team_def_id: "team-standard", classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, dod_path: dodPath, dod_digest: dodDigest, work_identity: workIdentity(slice.slice_id, slice.slice_id, slice.task_id) };
  });
  const executionTeamByTask = new Map(slices.map((slice) => [`${slice.feature_id}\0${slice.task_id}`, slice.team_id]));
  const plan = {
    id: RUN_ID,
    task: "execute specifications",
    teams: teams.map((team) => {
      const slice = slices.find((candidate) => candidate.team_id === team.id)!;
      const depends_on = [...new Set(slice.depends_on.map((dependency) => executionTeamByTask.get(`${slice.feature_id}\0${dependency}`)).filter((id): id is string => typeof id === "string" && id !== team.id))].sort();
      return {
        team: team.id,
        team_def_id: "team-standard",
        scope: [`src/${String(team.feature_id)}.ts`],
        slice: team.slice_id,
        profile: "standard",
        worktree: "same_branch" as const,
        depends_on,
      };
    }),
    created_at: now,
  };
  const ctoState: CtoState = newCtoState({
    id: RUN_ID,
    task: "execute specifications",
    branch: "test",
    autonomous: true,
    owner_session: DEFAULT_TEST_SESSION_ID,
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true },
    plan,
  });
  ctoState.teams = teams;
  ctoState.specification_execution_anchor = { feature_id: firstFeature, run_key: runKey };
  ctoState.specification_execution_requested_selections = features.map((featureId) => ({ feature_id: featureId, run_key: `run-${featureId}-1` }));
  ctoState.active_wave_id = waveId;
  ctoState.wave_history = [{
    id: waveId,
    source: "specification-execution",
    source_id: "test-execution",
    task: "execute",
    slice_ids: slices.map((slice) => slice.slice_id),
    status: "active",
    started_at: now,
    work_identity: workIdentity(slices[0]!.slice_id, slices[0]!.slice_id, slices[0]!.task_id),
  }];
  const firstIdentity = teams[0]?.work_identity;
  assert.ok(firstIdentity, "completion fixture must create one execution identity");
  if (!firstIdentity) throw new Error("completion fixture execution identity is unavailable");
  ctoState.work_identity = firstIdentity;
  ctoState.pending = { identity: firstIdentity, status: "authorized", terminal_signal: null, updated_at: now };
  ctoState.completion_envelope = { schema_version: 1, identity: firstIdentity, outcome: "pending", terminal_signal: null, artifact_refs: [], evidence_ref: null, conflict_ref: null, completed_by: "engine_task_caller", emitted_at: now };
  ctoState.control_plane_provenance = { completion_intent: "none", checkpoint_policy: "none", roster_policy: "none", roster_selection: "none", work_identity: "state", pending: "state", child_join: "none", completion_envelope: "state", legacy_inputs: [], warnings: [], status: "typed" };
  writeCtoState(ctoState, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
  const runtime = testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID);
  const runtimeRoot = PinnedProjectRoot.open(root);
  assert.ok(runtimeRoot, "completion fixture root must be pinnable for runtime proof");
  if (!runtimeRoot) throw new Error("completion fixture root cannot be pinned for runtime proof");
  try {
    assert.equal(mintCtoRuntimeRunOrigin(runtimeRoot, ctoState, DEFAULT_TEST_SESSION_ID), true, "completion fixture runtime origin must be minted");
    const persisted = readCtoState(RUN_ID, root);
    assert.ok(persisted, "completion fixture CTO state must remain readable");
    if (!persisted) throw new Error("completion fixture CTO state disappeared before runtime proof");
    assert.equal(writeCtoRuntimeStateProof(runtimeRoot, persisted), true, "completion fixture runtime state proof must be written");
  } finally {
    runtimeRoot.close();
  }
  assert.ok(runtime.readState(RUN_ID), "completion fixture runtime must authenticate its CTO state");
  executionContexts.set(root, { feature_id: firstFeature, run_key: runKey, capability_id: capabilityId, capability_epoch: capabilityEpoch });
}
function persistCtoFixtureState(root: string, state: CtoState): void {
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot, "CTO fixture state root must remain pinnable");
  if (!pinnedRoot) throw new Error("CTO fixture state root is unavailable");
  try {
    const statePath = join(".work-state", "cto", state.id, "state.json");
    const current = pinnedRoot.readFile(statePath);
    pinnedRoot.replaceFileIfMatches(statePath, {
      dev: current.dev,
      ino: current.ino,
      sha256: sha256Hex(current.bytes),
    }, `${JSON.stringify(state, null, 2)}\n`);
    assert.equal(writeCtoRuntimeStateProof(pinnedRoot, state), true, "CTO fixture state proof must follow direct mutation");
  } finally {
    pinnedRoot.close();
  }
}


async function preflight(root: string, selections: Json[]): Promise<Result> {
  ensureExecutionContext(root);
  const sessionId = DEFAULT_TEST_SESSION_ID;
  const invoke = preflightCtoSpecificationExecution as unknown as (projectRoot: string, input: Json, options: { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string }) => unknown;
  const result = await invoke(root, { cto_run_id: RUN_ID, selections }, { runtimeAccess: testRuntimeAccess(root, sessionId), sessionId }) as Result;
  return result;
}

function detail(result: Result): string {
  return JSON.stringify(result.findings ?? result.blocking_findings ?? result);
}


function schemaObject(value: unknown, label: string): Json {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Json;
}

function schemaKeys(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value) && value.every((entry) => typeof entry === "string"), `${label} must be a string array`);
  return [...(value as string[])];
}

function schemaDefinition(definitions: Json, id: string): Json {
  return schemaObject(definitions[id], `artifacts-schema definition '${id}'`);
}

function schemaRequired(definition: Json, label: string): string[] {
  return schemaKeys(definition.required, `${label}.required`);
}

function schemaAllowed(definition: Json, label: string): string[] {
  return Object.keys(schemaObject(definition.properties, `${label}.properties`));
}
function schemaEnum(definition: Json, key: string, label: string): string[] {
  const properties = schemaObject(definition.properties, `${label}.properties`);
  return schemaKeys(schemaObject(properties[key], `${label}.${key}`).enum, `${label}.${key}.enum`);
}

function assertLeadContractSchemaDrift(contract: Json): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "artifacts-schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Json;
  const definitions = schemaObject(schema.definitions, "artifacts-schema definitions");
  const conformanceDefinition = schemaDefinition(definitions, "conformance_evidence");
  const qualityDefinition = schemaDefinition(definitions, "quality_gate_evidence");
  const conformanceProperties = schemaObject(conformanceDefinition.properties, "conformance_evidence.properties");
  const qualityProperties = schemaObject(qualityDefinition.properties, "quality_gate_evidence.properties");
  const conformanceEntries = schemaObject(conformanceProperties.entries, "conformance_evidence.entries");
  const conformanceEntry = schemaObject(conformanceEntries.items, "conformance entry");
  const conformanceEntryProperties = schemaObject(conformanceEntry.properties, "conformance entry.properties");
  const conformanceTest = schemaObject(conformanceEntryProperties.test, "conformance test");
  const conformanceTestProperties = schemaObject(conformanceTest.properties, "conformance test.properties");
  const evidenceRef = schemaObject(conformanceTestProperties.evidence_ref, "evidence reference");
  const reviewVerdictValues = schemaEnum(conformanceEntry, "review_verdict", "conformance entry");
  const qualityGates = schemaObject(qualityProperties.gates, "quality_gate_evidence.gates");
  const qualityGate = schemaObject(qualityGates.items, "quality gate");
  const withRuntimeRequired = (definition: Json, label: string, runtimeKey: string): string[] => [...new Set([...schemaRequired(definition, label), runtimeKey])];
  const safeIdSchema = (value: unknown, label: string): void => {
    const field = schemaObject(value, label);
    assert.equal(field.type, "string");
    assert.equal(field.minLength, 1);
    assert.equal(field.maxLength, 128);
    assert.equal(field.pattern, "^[A-Za-z0-9._-]+$");
  };
  safeIdSchema(conformanceProperties.artifact_id, "conformance artifact_id");
  safeIdSchema(conformanceEntryProperties.evidence_id, "conformance evidence_id");
  safeIdSchema(conformanceEntryProperties.subject_id, "conformance subject_id");
  safeIdSchema(conformanceEntryProperties.execution_claim_id, "conformance execution_claim_id");
  assert.equal(conformanceEntries.minItems, 1);
  assert.equal(conformanceEntries.maxItems, 256);
  assert.equal(conformanceEntryProperties.handoff_digest.pattern, "^[a-f0-9]{64}$");
  assert.equal(schemaObject(conformanceEntryProperties.recorded_at, "recorded_at").pattern, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
  safeIdSchema(qualityProperties.artifact_id, "quality artifact_id");
  safeIdSchema(schemaObject(qualityGate.properties, "quality gate properties").gate_id, "quality gate_id");
  assert.equal(qualityGates.minItems, 1);
  assert.equal(qualityGates.maxItems, 64);
  assert.equal(schemaObject(qualityGate.properties, "quality gate properties").evaluated_at.pattern, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
  const artifactContract = schemaObject(contract.artifact_contract, "lead_contract.artifact_contract");
  const conformanceContract = schemaObject(artifactContract.conformance, "lead_contract.artifact_contract.conformance");
  const qualityContract = schemaObject(artifactContract.quality_gate, "lead_contract.artifact_contract.quality_gate");
  const keyArray = (value: unknown, label: string): string[] => schemaKeys(value, label);
  assert.deepEqual(keyArray(conformanceContract.envelope_required_keys, "conformance envelope required").sort(), schemaRequired(conformanceDefinition, "conformance_evidence").sort());
  assert.deepEqual(keyArray(conformanceContract.envelope_allowed_keys, "conformance envelope allowed").sort(), schemaAllowed(conformanceDefinition, "conformance_evidence").sort());
  assert.deepEqual(keyArray(conformanceContract.entry_required_keys, "conformance entry required").sort(), schemaRequired(conformanceEntry, "conformance entry").sort());
  assert.deepEqual(keyArray(conformanceContract.entry_allowed_keys, "conformance entry allowed").sort(), schemaAllowed(conformanceEntry, "conformance entry").sort());
  assert.deepEqual(keyArray(conformanceContract.test_required_keys, "conformance test required").sort(), schemaRequired(conformanceTest, "conformance test").sort());
  assert.deepEqual(keyArray(conformanceContract.test_allowed_keys, "conformance test allowed").sort(), schemaAllowed(conformanceTest, "conformance test").sort());
  assert.deepEqual(keyArray(conformanceContract.review_verdict_values, "review verdict values").sort(), reviewVerdictValues.sort());
  assert.equal(conformanceContract.evidence_id_pattern, "^[A-Za-z0-9._-]+$");
  assert.equal(conformanceContract.artifact_id_pattern, "^[A-Za-z0-9._-]+$");
  assert.equal(conformanceContract.identifier_max_bytes, 128);
  assert.deepEqual(keyArray(conformanceContract.evidence_ref_required_keys, "evidence reference required").sort(), schemaRequired(evidenceRef, "evidence reference").sort());
  assert.deepEqual(keyArray(conformanceContract.evidence_ref_allowed_keys, "evidence reference allowed").sort(), schemaAllowed(evidenceRef, "evidence reference").sort());
  assert.deepEqual(keyArray(qualityContract.envelope_required_keys, "quality envelope required").sort(), schemaRequired(qualityDefinition, "quality_gate_evidence").sort());
  assert.deepEqual(keyArray(qualityContract.envelope_allowed_keys, "quality envelope allowed").sort(), schemaAllowed(qualityDefinition, "quality_gate_evidence").sort());
  assert.deepEqual(keyArray(qualityContract.gate_required_keys, "quality gate required").sort(), withRuntimeRequired(qualityGate, "quality gate", "evaluated_at").sort());
  const schemaStatusValues = schemaEnum(evidenceRef, "schema_status", "evidence reference");
  const qualityGateStatusValues = schemaEnum(evidenceRef, "quality_gate_status", "evidence reference");
  for (const [label, candidate] of [["conformance", conformanceContract], ["quality_gate", qualityContract]] as const) {
    assert.deepEqual(keyArray(candidate.schema_status_values, `${label} schema_status values`).sort(), schemaStatusValues.sort());
    assert.deepEqual(keyArray(candidate.quality_gate_status_values, `${label} quality_gate_status values`).sort(), qualityGateStatusValues.sort());
    assert.equal(candidate.sha256_pattern, "^[a-f0-9]{64}$", `${label} sha256 must be lowercase 64-hex`);
    assert.equal(candidate.path_template, ".work-state/features/<feature_id>/artifacts/<artifact_id>.json", `${label} path must stay feature-local`);
  }
  assert.deepEqual(keyArray(qualityContract.gate_allowed_keys, "quality gate allowed").sort(), schemaAllowed(qualityGate, "quality gate").sort());
}
function assertLeadEvidenceContract(outcome: Json, featureId: string, handoffDigest: string, claimId: string, profileHashValue: string): void {
  const contract = outcome.lead_contract;
  assert.ok(contract && typeof contract === "object" && !Array.isArray(contract), "claimed outcome must expose a typed lead contract");
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return;
  const lead = contract as Json;
  assert.deepEqual(Object.keys(lead).sort(), ["artifact_contract", "max_internal_repairs", "subjects", "terminal_intent_conflict"].sort());
  assert.equal(lead.max_internal_repairs, 1);
  const artifactContract = lead.artifact_contract as Json;
  assert.deepEqual(Object.keys(artifactContract).sort(), ["bindings", "bounds", "conformance", "quality_gate", "schema_version", "schema_version_values", "timestamp_contract", "topology"].sort());
  assert.equal(artifactContract.schema_version, 1);
  assert.deepEqual(artifactContract.schema_version_values, [1]);
  assert.deepEqual(artifactContract.bounds, {
    evidence_entries_min_items: 1,
    evidence_entries_max_items: 256,
    quality_gates_min_items: 1,
    quality_gates_max_items: 64,
    gate_evidence_refs_max_items: 64,
    gate_findings_max_items: 128,
    finding_evidence_refs_max_items: 64,
    field_max_bytes: 16384,
    aggregate_max_bytes: 2097152,
    nesting_max_depth: 4,
  });
  assert.deepEqual(artifactContract.timestamp_contract, {
    regex: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    valid_example: "2026-01-01T00:00:00.000Z",
    invalid_examples: ["2026-01-01T00:00:00.30503000Z", "2026-01-01T00:00:00.818575000Z"],
    generation_rule: "Use ECMAScript new Date().toISOString() or trim deterministically to exactly 3 fractional digits; never shell date or %N.",
  });
  const bindings = artifactContract.bindings as Json;
  assert.deepEqual(bindings, {
    feature_id: featureId,
    handoff_digest: handoffDigest,
    execution_claim_id: claimId,
    execution_profile_gate_id: `execution-profile.${profileHashValue}`,
  });
  const conformance = artifactContract.conformance as Json;
  assert.deepEqual(Object.keys(conformance).sort(), ["allowed_kinds", "artifact_id", "artifact_id_pattern", "entry_allowed_keys", "entry_required_keys", "envelope_allowed_keys", "envelope_required_keys", "evidence_id_pattern", "evidence_ref_allowed_keys", "evidence_ref_required_keys", "evidence_execution_claim_id_binding", "evidence_handoff_digest_binding", "handoff_digest_pattern", "identifier_max_bytes", "kind_requirements", "path", "path_template", "quality_gate_status_values", "review_verdict_values", "schema_status_values", "sha256_pattern", "status_values", "test_allowed_keys", "test_kind_values", "test_required_keys"].sort());
  const qualityGate = artifactContract.quality_gate as Json;
  assert.deepEqual(Object.keys(qualityGate).sort(), ["artifact_id", "envelope_allowed_keys", "envelope_required_keys", "evidence_ref_allowed_keys", "evidence_ref_required_keys", "finding_allowed_keys", "finding_evidence_refs_type", "finding_required_keys", "gate_allowed_keys", "gate_required_keys", "path", "path_template", "quality_gate_status_values", "schema_status_values", "sha256_pattern", "source_values", "status_values"].sort());
  const artifactRefKeys = ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"];
  assert.deepEqual(conformance, {
    ...conformance,
    artifact_id: `conformance_evidence-${featureId}`,
    path: `.work-state/features/${featureId}/artifacts/conformance_evidence-${featureId}.json`,
    envelope_required_keys: ["schema_version", "artifact_id", "entries"],
    envelope_allowed_keys: ["schema_version", "artifact_id", "entries"],
    entry_required_keys: ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "recorded_at"],
    entry_allowed_keys: ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "review_verdict", "test", "intent_message", "recorded_at"],
    allowed_kinds: ["implementation", "review", "executed_test", "intent_conflict"],
    kind_requirements: { review: ["review_verdict"], executed_test: ["test"], intent_conflict: ["intent_message"] },
    review_verdict_values: ["pass", "fail"],
    evidence_id_pattern: "^[A-Za-z0-9._-]+$",
    artifact_id_pattern: "^[A-Za-z0-9._-]+$",
    identifier_max_bytes: 128,
    test_required_keys: ["evidence_ref", "test_kind", "status", "executed_at"],
    test_allowed_keys: ["evidence_ref", "test_kind", "status", "executed_at"],
    test_kind_values: ["unit", "integration", "e2e", "runtime"],
    status_values: ["pass", "fail"],
    evidence_ref_required_keys: artifactRefKeys,
    evidence_ref_allowed_keys: artifactRefKeys,
    schema_status_values: ["met", "failed"],
    quality_gate_status_values: ["met", "pending", "failed"],
    sha256_pattern: "^[a-f0-9]{64}$",
    handoff_digest_pattern: "^[a-f0-9]{64}$",
    evidence_handoff_digest_binding: "artifact_contract.bindings.handoff_digest",
    evidence_execution_claim_id_binding: "artifact_contract.bindings.execution_claim_id",
    path_template: ".work-state/features/<feature_id>/artifacts/<artifact_id>.json",
  });
  assert.deepEqual(qualityGate, {
    ...qualityGate,
    artifact_id: `quality_gate_evidence-${featureId}`,
    path: `.work-state/features/${featureId}/artifacts/quality_gate_evidence-${featureId}.json`,
    envelope_required_keys: ["schema_version", "artifact_id", "gates"],
    envelope_allowed_keys: ["schema_version", "artifact_id", "gates"],
    gate_required_keys: ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"],
    gate_allowed_keys: ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"],
    finding_required_keys: ["code", "subject_id", "message", "evidence_refs"],
    finding_allowed_keys: ["code", "subject_id", "message", "evidence_refs"],
    finding_evidence_refs_type: "string[]",
    source_values: ["project_constitution", "execution_profile"],
    status_values: ["pass", "fail"],
    evidence_ref_required_keys: artifactRefKeys,
    evidence_ref_allowed_keys: artifactRefKeys,
    schema_status_values: ["met", "failed"],
    quality_gate_status_values: ["met", "pending", "failed"],
    sha256_pattern: "^[a-f0-9]{64}$",
    path_template: ".work-state/features/<feature_id>/artifacts/<artifact_id>.json",
  });
  assert.deepEqual(qualityGate.finding_required_keys, ["code", "subject_id", "message", "evidence_refs"]);
  assert.deepEqual(qualityGate.finding_allowed_keys, ["code", "subject_id", "message", "evidence_refs"]);
  const topology = artifactContract.topology as Json;
  assert.deepEqual(topology, {
    quality_gate_must_be_written_first: true,
    quality_gate_persisted_gate_evidence_refs: [],
    supporting_runtime_artifact_id_prefix: "runtime_test_evidence-",
    supporting_runtime_artifact_path_template: ".work-state/features/<feature_id>/artifacts/runtime_test_evidence-<feature_id>.json",
    supporting_runtime_artifact_envelope: "conformance_evidence",
    supporting_runtime_envelope_must_contain_executed_tests: true,
    supporting_runtime_inner_test_evidence_ref_must_equal_quality_gate_ref: true,
    supporting_runtime_rows_exact_multiset: true,
    supporting_runtime_row_key_fields: ["evidence_id", "kind", "subject_id", "requirement_id", "test_kind", "status", "executed_at", "handoff_digest", "execution_claim_id"],
    contradictory_review_or_test_statuses_block: true,
    intent_conflict_status: "changed_intent",
    conformance_must_be_written_after_supporting_runtime: true,
    outer_executed_test_evidence_ref_must_equal_supporting_runtime_ref: true,
    outer_executed_test_evidence_ref_envelope: "conformance_evidence",
    quality_gate_must_not_be_rewritten_after_conformance: true,
    forbidden_standalone_nested_artifact_id_prefixes: ["implementation_evidence-", "runtime_test_evidence-"],
  });
  assert.equal(qualityGate.finding_evidence_refs_type, "string[]");
  assertLeadContractSchemaDrift(lead);
  assert.ok(!((conformance.entry_allowed_keys as string[]).includes("artifact")), "worker-persisted conformance entries must not contain the engine-only artifact wrapper");
}
function prepareCtoCompletionEnvelope(
  root: string,
  featureId: string,
  runKey: string,
  mapping: Json,
  mappingDigest: string,
): Json {
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
  if (!selected.state || !selected.state.specification) throw new Error(`completion feature '${featureId}' state is unavailable`);
  const workspace = selected.state.specification as unknown as Json;
  const handoff = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`), "utf8")) as Json;
  const conformanceId = workspace.implementation_conformance_ref;
  if (typeof conformanceId !== "string" || conformanceId.length === 0) {
    throw new Error(`completion feature '${featureId}' conformance is unavailable`);
  }
  const execution = mapping.execution as Json;
  return {
    owner_kind: "cto",
    owner_run_key: RUN_ID,
    wave_id: String(execution.wave_id),
    mapping_id: String(mapping.mapping_id),
    mapping_digest: mappingDigest,
    feature_id: featureId,
    run_key: runKey,
    handoff_digest: String(handoff.handoff_digest),
    conformance_id: conformanceId,
  };
}
function completeCtoSpecificationExecutionForTest(root: string, input: Json): ReturnType<typeof completeSpecificationExecution> {
  return completeSpecificationExecution(root, input as never, {
    runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID),
    sessionId: DEFAULT_TEST_SESSION_ID,
  });
}
function cleanupMountedConformanceTest(root: string): void {
  closeTestRuntime(root, DEFAULT_TEST_SESSION_ID);
  executionContexts.delete(root);
  projectFeatures.delete(root);
  rmSync(root, { recursive: true, force: true });
}

function completeMountedCtoExecutionTeams(root: string, options: { concurrent?: boolean; featureIds?: readonly string[]; failedFeatureIds?: readonly string[] } = {}): void {
  const state = readCtoState(RUN_ID, root);
  assert.ok(state, "completion fixture CTO state must be readable before host worker completion");
  if (!state) throw new Error("completion fixture CTO state unavailable before host worker completion");
  const hooks = mountedTaskHooks(root, DEFAULT_TEST_SESSION_ID);
  const context = { cwd: root, mode: "rpc", hasUI: true, sessionManager: TEST_SESSION_MANAGER } as never;
  TEST_SESSION_MANAGER.cwd = root;
  const calls: Array<{ toolCallId: string; failed: boolean }> = [];
  const selectedFeatureIds = options.featureIds ? new Set(options.featureIds) : null;
  const failedFeatureIds = options.failedFeatureIds ? new Set(options.failedFeatureIds) : null;
  for (const team of state.teams) {
    if (selectedFeatureIds && !selectedFeatureIds.has(team.feature_id ?? "")) continue;
    if (team.status === "done" || team.status === "failed") continue;
    assert.ok(team.slice_id && team.work_identity, "completion fixture team must carry its authenticated slice identity");
    if (!team.slice_id || !team.work_identity) continue;
    const toolCallId = `completion-host-${team.slice_id}`;
    const marker = buildCtoSliceMarker(RUN_ID, team.slice_id);
    const call = hooks.toolCall({ toolName: "task", toolCallId, input: { task: marker } }, context);
    assert.equal((call as Json | undefined)?.block, undefined, `completion fixture host marker must be admitted: ${JSON.stringify(call)}`);
    calls.push({ toolCallId, failed: failedFeatureIds?.has(team.feature_id ?? "") ?? false });
    if (!options.concurrent) {
      hooks.toolResult({ toolName: "task", toolCallId, isError: failedFeatureIds?.has(team.feature_id ?? "") ?? false, content: [{ type: "text", text: "worker completed" }] }, context);
    }
  }
  if (options.concurrent) {
    for (const { toolCallId, failed } of [...calls].reverse()) {
      hooks.toolResult({ toolName: "task", toolCallId, isError: failed, content: [{ type: "text", text: "worker completed" }] }, context);
    }
  }
  const terminal = readCtoState(RUN_ID, root);
  const terminalTeams = terminal?.teams.filter((team) => !selectedFeatureIds || selectedFeatureIds.has(team.feature_id ?? "")) ?? [];
  assert.ok(terminalTeams.length > 0, "completion fixture host results must target at least one mapped team");
  assert.ok(terminalTeams.every((team) => (failedFeatureIds?.has(team.feature_id ?? "") ? team.status === "failed" : team.status === "done")), "completion fixture host results must terminalize every selected mapped team");
}

async function produceCtoCompletionConformance(root: string, mapping: Json, binding: Json): Promise<void> {
  const tool = publicCtoTools(root).get("cto_specification_conformance");
  if (!tool) throw new Error("CTO conformance producer tool is unavailable");
  const featureIds = mapping.feature_ids as string[];
  const payload = mountedConformancePayload(root, mapping, binding, featureIds);
  const produced = mountedDetails(await tool.execute("completion-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
  if (produced.status !== "ready") throw new Error(`CTO conformance producer blocked: ${detail(produced)}`);
}

type RegisteredWorkflowTool = {
  name: string;
  parameters?: { safeParse(value: unknown): { success: boolean } };
  execute: (...args: unknown[]) => Promise<{ details: Result }>;
};

function testOnForRoot(root: string): typeof TEST_ON {
  return (event, handler) => {
    if (event === "session_start") handler({}, TEST_CONTEXT(root));
  };
}
function publicWorkflowBeginTool(root: string = mkdtempSync(join(tmpdir(), "cto-workflow-tool-"))): RegisteredWorkflowTool {
  const registered: RegisteredWorkflowTool[] = [];
  const pi = {
    zod: { z: zod },
    on: testOnForRoot(root),
    registerTool: (tool: unknown) => registered.push(tool as RegisteredWorkflowTool),
  };
  registerTestWorkflowTools(root, pi as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
  const tool = registered.find((candidate) => candidate.name === "workflow_begin");
  assert.ok(tool, "public workflow_begin tool is registered");
  return tool!;
}
function publicWorkflowTool(name: string, root: string = mkdtempSync(join(tmpdir(), "cto-workflow-tool-"))): RegisteredWorkflowTool {
  const registered: RegisteredWorkflowTool[] = [];
  const pi = {
    zod: { z: zod },
    on: testOnForRoot(root),
    setLabel: (_label: string) => undefined,
    registerTool: (tool: unknown) => registered.push(tool as RegisteredWorkflowTool),
  };
  registerTestWorkflowTools(root, pi as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
  if (name !== "workflow_prepare") registerTestTeamWorkflow(root, pi as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd, rebindSessions: true }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
  const tool = registered.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} tool is registered`);
  return tool!;
}
function publicDoWorkClaimTool(root: string = mkdtempSync(join(tmpdir(), "cto-claim-tool-"))): RegisteredWorkflowTool {
  const registered: RegisteredWorkflowTool[] = [];
  const pi = {
    zod: { z: zod },
    on: testOnForRoot(root),
    registerTool: (tool: unknown) => registered.push(tool as RegisteredWorkflowTool),
  };
  registerTestWorkflowTools(root, pi as never, { resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
  const tool = registered.find((candidate) => candidate.name === "do_work_claim");
  assert.ok(tool, "public do_work_claim tool is registered");
  return tool!;
}
type MountedCtoTool = {
  name: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
};

function publicCtoTools(rootOrOptions: string | Parameters<typeof registerCtoTools>[1] = mkdtempSync(join(tmpdir(), "cto-public-tools-")), maybeOptions: Parameters<typeof registerCtoTools>[1] = {}, registerTeamWorkflow = true): Map<string, MountedCtoTool> {
  const root = typeof rootOrOptions === "string" ? rootOrOptions : mkdtempSync(join(tmpdir(), "cto-public-tools-"));
  const options = typeof rootOrOptions === "string" ? maybeOptions : rootOrOptions;
  const registered: MountedCtoTool[] = [];
  const pi = {
    zod: { z: zod },
    on: testOnForRoot(root),
    setLabel: (_label: string) => undefined,
    registerTool: (tool: unknown) => registered.push(tool as MountedCtoTool),
  };
  if (registerTeamWorkflow) registerTestTeamWorkflow(root, pi as never, { resolveCwd: options.resolveCwd, rebindSessions: true }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
  registerTestCtoTools(root, pi as never, options, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
  return new Map(registered.map((tool) => [tool.name, tool]));
}

function mountedDetails(value: { details: unknown }): Json {
  assert.ok(value.details && typeof value.details === "object");
  return value.details as Json;
}

type MountedTaskHook = (event: unknown, ctx: unknown) => unknown;
function mountedTaskHooks(root: string, sessionId: string = DEFAULT_TEST_SESSION_ID): { toolCall: MountedTaskHook; toolResult: MountedTaskHook } {
  const hooks = new Map<string, MountedTaskHook>();
  const pi = {
    zod: { z: zod },
    on: (event: string, handler: MountedTaskHook) => { hooks.set(event, handler); if (event === "session_start") handler({}, TEST_CONTEXT(root)); },
    setLabel: (_label: string) => undefined,
    registerTool: (_tool: unknown) => undefined,
  };
  registerTestTeamWorkflow(root, pi as never, { observability: false, rebindSessions: true, resolveCwd: (ctx) => (ctx as { cwd?: string }).cwd }, `core-test-runtime-${digestOf({ root, sessionId }).slice(0, 16)}`);
  const toolCall = hooks.get("tool_call");
  const toolResult = hooks.get("tool_result");
  assert.ok(toolCall && toolResult, "workflow host task hooks must be mounted");
  return { toolCall: toolCall!, toolResult: toolResult! };
}

async function mountedCtoHostAsk(root: string, input: Json, decision: string, feedback?: string): Promise<Json> {
  const askTool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_checkpoint_ask_selected");
  if (!askTool) throw new Error("mounted CTO host Ask tool is unavailable");
  const asked = await askTool.execute("fixture-host-ask", input, undefined, undefined, {
    cwd: root,
    sessionManager: TEST_SESSION_MANAGER,
    hasUI: true,
    ui: {
      askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
        const question = questions[0];
        if (!question) return undefined;
        return { kind: "submit" as const, results: [{ id: question.id, question: question.question, header: question.header, options: question.options.map((option) => option.label), multi: false, selectedOptions: [decision], ...(feedback !== undefined ? { note: feedback } : {}) }] };
      },
    },
  });
  return mountedDetails(asked);
}

function mountedToolPayloads(): Record<string, Json> {
  return {
    cto_prepare: {
      cto_run_id: "mounted-tools-run",
      task: "prepare mounted tools",
      branch: "main",
      selections: [{ feature_id: "feature-one", run_key: "run-feature-one-1" }],
    },
    cto_preflight: { cto_run_id: "mounted-tools-run", selections: [{ feature_id: "feature-one", run_key: "run-feature-one-1" }] },
    cto_checkpoint_ask_selected: {
      cto_run_id: "mounted-tools-run", mapping_id: "mapping-1", mapping_hash: "0".repeat(64), mapping_version: 1,
      feature_id: "feature-one", run_key: "run-feature-one-1", stage_id: "execution",
    },
    cto_mapping_resume: { cto_run_id: "mounted-tools-run", mapping_id: "mapping-1", mapping_hash: "0".repeat(64), mapping_version: 1 },
    cto_confirm: {
      cto_run_id: "mounted-tools-run", mapping_id: "mapping-1", mapping_hash: "0".repeat(64), answer_id: "answer-1",
    },
    cto_dispatch: { cto_run_id: "mounted-tools-run", mapping_id: "mapping-1", expected_mapping_hash: "0".repeat(64) },
    cto_specification_conformance: {
      cto_run_id: "mounted-tools-run",
      mapping_id: "mapping-1",
      mapping_hash: "0".repeat(64),
      wave_id: "wave-1",
    },
    cto_close_specification_execution_wave: {
      cto_run_id: "mounted-tools-run",
      wave_id: "wave-1",
      mapping_id: "mapping-1",
      mapping_digest: "0".repeat(64),
      completions: [{
        feature_id: "feature-one",
        run_key: "run-feature-one-1",
        handoff_digest: "1".repeat(64),
        conformance_id: `implementation-conformance.${"2".repeat(64)}`,
      }],
    },
  };
}
function writeMountedPreparationFixture(root: string, featureId: string, runKey: string, runId: string): Json {
  const prepared = writeFeature(root, featureId, runKey);
  const firstTask = (prepared.handoff.tasks as Json[])[0];
  const affectedScope = Array.isArray(firstTask?.affected_scope) ? firstTask.affected_scope : [];
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify([{
    id: "team-standard",
    name: "Standard",
    scope: affectedScope,
    profile: "standard",
    lead: "developer",
    roster: ["developer"],
  }]), "utf8");
  const payload = mountedToolPayloads().cto_prepare;
  payload.cto_run_id = runId;
  payload.wave_id = `${runId}-WAVE`;
  payload.source_id = `${runId}-SOURCE`;
  payload.selections = [{ feature_id: featureId, run_key: runKey }];
  return payload;
}
test("direct CTO preparation rejects expanded and cross-task scopes without artifacts", () => {
  const cases = [
    { name: "expanded", scope: ["src/expanded.ts"], addSecondTask: false },
    { name: "cross-task", scope: ["src/other.ts"], addSecondTask: true },
  ] as const;
  for (const testCase of cases) {
    const root = makeProject();
    const featureId = "scope-boundary-" + testCase.name;
    const runKey = "run-" + featureId + "-1";
    const runId = "CTO-SCOPE-BOUNDARY-" + testCase.name.toUpperCase();
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    try {
      writeFeature(root, featureId, runKey);
      if (testCase.addSecondTask) rewriteHandoff(root, featureId, (handoff) => {
        const tasks = handoff.tasks as Json[];
        tasks.push({ task_id: "T-2", title: "Verify", requirement_ids: ["FR-1"], depends_on: ["T-1"], expected_outcome: "Verified", affected_scope: ["src/other.ts"], completion_evidence: ["test"], parallel_safe: true });
        const verification = (handoff.verification as Json[])[0]!;
        verification.task_ids = [...(verification.task_ids as string[]), "T-2"];
      });
      const taskCount = testCase.addSecondTask ? 2 : 1;
      const teams = Array.from({ length: taskCount }, (_, index) => ({
        team: teamDef.id, task_ref: { feature_id: featureId, task_id: index === 0 ? "T-1" : "T-2" },
        classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true, workflow: "standard" as const },
        scope: testCase.scope, profile: "standard", worktree: "same_branch" as const, depends_on: index === 0 ? [] : ["team-standard"],
        dod: { items: [{ id: "dod-1-" + index, source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true },
      }));
      const result = prepareCtoSpecificationExecution(root, { cto_run_id: runId, task: "scope boundary", branch: "main", classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "standard" }, selections: [{ feature_id: featureId, run_key: runKey }], teams }, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.match(JSON.stringify(result), /scope|affected|authenticated/i);
      assert.equal(existsSync(join(root, ".work-state", "cto", runId, "state.json")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("cto_prepare preserves heterogeneous authenticated TeamDef profiles and rejects profile tampering", async () => {
  const root = makeProject();
  const featureIds = ["profile-full", "profile-standard"] as const;
  const runKeys = featureIds.map((featureId) => `run-${featureId}-1`);
  const defs = [
    { id: "team-full", name: "Full feature", scope: ["src/profile-full.ts"], profile: "full-feature", lead: "developer", roster: ["developer"] },
    { id: "team-standard", name: "Standard", scope: ["src/profile-standard.ts"], profile: "standard", lead: "developer", roster: ["developer"] },
  ] as const;
  const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true, workflow: "standard" as const };
  const dod = { items: [{ id: "dod-profile", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
  try {
    for (const [index, featureId] of featureIds.entries()) {
      writeFeature(root, featureId, runKeys[index]!);
      rewriteHandoff(root, featureId, (handoff) => {
        (handoff.tasks as Json[])[0]!.affected_scope = [`src/${featureId}.ts`];
        handoff.scope = { ...(handoff.scope as Json), constraints: [] };
      });
    }
    mkdirSync(join(root, ".omp"), { recursive: true });
    const teamsPath = join(root, ".omp", "teams.json");
    writeFileSync(teamsPath, JSON.stringify(defs), "utf8");
    const directRuntime = { access: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID) };
    const tampered = prepareCtoSpecificationExecution(root, {
      cto_run_id: "CTO-PROFILE-TAMPER",
      task: "reject profile tampering",
      branch: "main",
      classification,
      selections: featureIds.map((feature_id, index) => ({ feature_id, run_key: runKeys[index]! })),
      teams: defs.map((def, index) => ({
        team: def.id,
        task_ref: { feature_id: featureIds[index]!, task_id: "T-1" },
        classification,
        workflow: "standard",
        scope: [...def.scope],
        profile: "standard",
        worktree: "same_branch" as const,
        depends_on: [],
        dod,
      })),
    }, { defs, runtimeAccess: directRuntime.access, sessionId: DEFAULT_TEST_SESSION_ID });
    assert.equal(tampered.status, "blocked", JSON.stringify(tampered));
    assert.match(JSON.stringify(tampered), /authenticated TeamDef|profile/i);
    assert.equal(existsSync(join(root, ".work-state", "cto", "CTO-PROFILE-TAMPER", "state.json")), false);
    assert.equal(existsSync(join(root, ".work-state", "cto", "CTO-PROFILE-TAMPER", "artifacts")), false);
    const payload = {
      cto_run_id: "CTO-PROFILE-MIXED",
      task: "prepare heterogeneous registered profiles",
      branch: "main",
      selections: featureIds.map((feature_id, index) => ({ feature_id, run_key: runKeys[index]! })),
    };
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const prepared = mountedDetails(await tool.execute("mixed-profiles", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    const state = readCtoState("CTO-PROFILE-MIXED", root);
    assert.deepEqual(state?.plan?.teams.map((team) => team.profile).sort(), ["full-feature", "standard"]);

    writeFileSync(teamsPath, JSON.stringify(defs.map((def) => def.id === "team-full" ? { ...def, profile: "standard" } : def)), "utf8");
    const aba = mountedDetails(await tool.execute("mixed-profiles-aba", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(aba.status, "blocked", JSON.stringify(aba));
    assert.match(JSON.stringify(aba), /profile|preparation identity|changed/i);
  } finally {
    closeTestRuntime(root, DEFAULT_TEST_SESSION_ID);
    rmSync(root, { recursive: true, force: true });
    projectFeatures.delete(root);
  }
});

test("mounted cto_prepare closes the registrar guard and handler-owned root pins", async () => {
  const root = makeProject();
  const featureId = "mounted-pin-ownership";
  const runKey = `run-${featureId}-1`;
  const originalOpen = PinnedProjectRoot.open;
  const originalClose = PinnedProjectRoot.prototype.close;
  let opened = 0;
  let closed = 0;
  try {
    const payload = writeMountedPreparationFixture(root, featureId, runKey, "CTO-MOUNTED-PIN-OWNERSHIP");
    PinnedProjectRoot.open = ((projectRoot: unknown, hooks = {}) => {
      const pinned = originalOpen(projectRoot, hooks);
      if (pinned) opened += 1;
      return pinned;
    }) as typeof originalOpen;
    PinnedProjectRoot.prototype.close = function (this: PinnedProjectRoot): void {
      closed += 1;
      originalClose.call(this);
    };
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    opened = 0;
    closed = 0;
    const result = mountedDetails(await tool.execute("pin-ownership", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.ok(opened >= 2, "registrar guard and mounted preparation must each open a project pin");
    assert.equal(closed, opened, "registrar guard and mounted preparation must close every owned project pin");
  } finally {
    PinnedProjectRoot.prototype.close = originalClose;
    PinnedProjectRoot.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
    projectFeatures.delete(root);
  }
});

test("mounted cto_prepare rejects root and ancestor replacements after pin opens", async () => {
  for (const variant of ["root", "ancestor"] as const) {
    const originalOpen = PinnedProjectRoot.open;
    const replacement = makeProject();
    const container = variant === "root" ? makeProject() : makeProject();
    const root = variant === "root" ? container : join(container, "workspace");
    const moved = `${container}.opened`;
    let swapped = false;
    let armed = false;
    let openCalls = 0;
    try {
      if (variant === "ancestor") mkdirSync(root, { recursive: true });
      const featureId = `mounted-${variant}-swap`;
      const runKey = `run-${featureId}-1`;
      const payload = writeMountedPreparationFixture(root, featureId, runKey, `CTO-MOUNTED-${variant.toUpperCase()}-SWAP`);
      let replacementTarget = replacement;
      if (variant === "ancestor") {
        mkdirSync(join(replacement, "workspace"), { recursive: true });
        replacementTarget = join(replacement, "workspace");
      }
      PinnedProjectRoot.open = ((projectRoot: unknown, hooks = {}) => {
        const pinned = originalOpen(projectRoot, hooks);
        if (pinned) openCalls += 1;
        if (pinned && armed && openCalls === 2 && !swapped) {
          swapped = true;
          renameSync(container, moved);
          symlinkSync(replacement, container, "dir");
        }
        return pinned;
      }) as typeof originalOpen;
      const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
      openCalls = 0;
      armed = true;
      const result = mountedDetails(await tool.execute(`${variant}-swap`, payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.equal(openCalls, 2, `${variant} registrar guard and cto_prepare must open in that order`);
      assert.equal(swapped, true, `${variant} swap must occur on cto_prepare's second pin open`);
      assert.deepEqual(readdirSync(replacementTarget), [], `${variant} replacement must remain untouched`);
    } finally {
      PinnedProjectRoot.open = originalOpen;
      if (swapped) {
        rmSync(container, { recursive: true, force: true });
        renameSync(moved, container);
      }
      rmSync(container, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
      rmSync(replacement, { recursive: true, force: true });
      projectFeatures.delete(root);
    }
  }
});

test("mounted cto_prepare rejects a TeamDef leaf replacement between load and preparation", async () => {
  const root = makeProject();
  const originalReadFile = PinnedProjectRoot.prototype.readFile;
  let swapped = false;
  try {
    const featureId = "mounted-teams-leaf-swap";
    const runKey = `run-${featureId}-1`;
    const payload = writeMountedPreparationFixture(root, featureId, runKey, "CTO-MOUNTED-TEAMS-LEAF-SWAP");
    PinnedProjectRoot.prototype.readFile = function (relativeFile, options): ReturnType<typeof originalReadFile> {
      const result = originalReadFile.call(this, relativeFile, options);
      if (relativeFile === ".omp/teams.json" && !swapped) {
        swapped = true;
        const replacementPath = join(root, ".omp", "teams.json.replacement");
        writeFileSync(replacementPath, JSON.stringify([{
          id: "team-replacement",
          name: "Replacement",
          scope: ["src"],
          profile: "standard",
          lead: "developer",
          roster: ["developer"],
        }]), "utf8");
        renameSync(replacementPath, join(root, ".omp", "teams.json"));
      }
      return result;
    };
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const result = mountedDetails(await tool.execute("teams-leaf-swap", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(swapped, true, "TeamDef leaf must be replaced after the pinned read");
    assert.equal(existsSync(join(root, ".work-state", "cto", "CTO-MOUNTED-TEAMS-LEAF-SWAP")), false, "rejected preparation must not create CTO state");
  } finally {
    PinnedProjectRoot.prototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
    projectFeatures.delete(root);
  }
});
test("mounted cto_prepare keeps one borrowed pin through a root swap during pinned path read", async () => {
  const root = makeProject();
  const replacement = makeProject();
  const moved = `${root}.opened`;
  const originalOpen = PinnedProjectRoot.open;
  const originalReadFile = PinnedProjectRoot.prototype.readFile;
  const originalClose = PinnedProjectRoot.prototype.close;
  let opened = 0;
  let closed = 0;
  let openCalls = 0;
  let swapped = false;
  try {
    const featureId = "mounted-path-root-swap";
    const runKey = `run-${featureId}-1`;
    const payload = writeMountedPreparationFixture(root, featureId, runKey, "CTO-MOUNTED-PATH-ROOT-SWAP");
    PinnedProjectRoot.open = ((projectRoot: unknown, hooks = {}) => {
      const pinned = originalOpen(projectRoot, hooks);
      if (pinned) {
        opened += 1;
        openCalls += 1;
      }
      return pinned;
    }) as typeof originalOpen;
    PinnedProjectRoot.prototype.close = function (this: PinnedProjectRoot): void {
      closed += 1;
      originalClose.call(this);
    };
    PinnedProjectRoot.prototype.readFile = function (relativeFile, options): ReturnType<typeof originalReadFile> {
      const result = originalReadFile.call(this, relativeFile, options);
      if (relativeFile === ".omp/teams.json" && !swapped) {
        swapped = true;
        renameSync(root, moved);
        symlinkSync(replacement, root, "dir");
      }
      return result;
    };
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    opened = 0;
    closed = 0;
    openCalls = 0;
    const result = mountedDetails(await tool.execute("path-root-swap", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(swapped, true, "pinned TeamDef path read must reach the swap seam");
    assert.ok(openCalls >= 2, "registrar guard and mounted handler must each open a project pin");
    assert.equal(opened, closed, "every registrar or handler-owned project pin must close");
    assert.deepEqual(readdirSync(replacement), [], "replacement root must remain untouched");
  } finally {
    PinnedProjectRoot.prototype.readFile = originalReadFile;
    PinnedProjectRoot.prototype.close = originalClose;
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
    projectFeatures.delete(root);
  }
});

test("mounted CTO conformance accepts only immutable selectors", () => {
  const payload = mountedToolPayloads().cto_specification_conformance;
  const schema = publicCtoTools().get("cto_specification_conformance")!.parameters;
  assert.equal(schema.safeParse(payload).success, true);
  for (const field of ["binding", "mapping", "handoffs", "claims", "evidence", "quality_gates", "handoff_id", "handoff_digest", "routing"]) {
    assert.equal(schema.safeParse({ ...structuredClone(payload), [field]: {} }).success, false, `selector schema must reject model-owned ${field}`);
  }
});

test("root export surface hides internal preparation sink while mounted selector tool remains available", () => {
  for (const internalExport of [
    "prepareCtoSpecificationExecution",
    "evaluateCtoSpecificationConformance",
    "persistCtoSpecificationConformance",
    "evaluateCtoSpecificationConformanceFanIn",
  ]) assert.equal(Object.hasOwn(publicCore, internalExport), false, `${internalExport} must remain internal`);
  const tool = publicCtoTools().get("cto_prepare");
  assert.ok(tool, "selector-only mounted cto_prepare must remain available");
  assert.equal(Object.hasOwn(publicCore, "CtoSpecificationExecutionPreparationInput"), false);
  assert.equal(Object.hasOwn(publicCore, "PrepareCtoSpecificationExecutionOptions"), false);
});

test("mounted CTO tools expose strict schemas without state override fields", () => {
  const tools = publicCtoTools();
  assert.deepEqual([...tools.keys()], ["cto_prepare", "cto_preflight", "cto_checkpoint_ask_selected", "cto_mapping_resume", "cto_confirm", "cto_dispatch", "cto_specification_conformance", "cto_close_specification_execution_wave", "cto_specification_prepare", "cto_specification_review", "cto_specification_decide", "cto_specification_advance"]);
  for (const [name, payload] of Object.entries(mountedToolPayloads())) {
    const tool = tools.get(name)!;
    assert.equal(tool.parameters.safeParse(payload).success, true, `${name} baseline payload should parse`);
    for (const field of ["cwd", "path", "token", "actor", "unknown"]) {
      assert.equal(tool.parameters.safeParse({ ...payload, [field]: "override" }).success, false, `${name} must reject ${field}`);
    }
  }
});

test("execution prompt cto_prepare template round-trips through the public parser", () => {
  const root = makeProject();
  try {
    const envelope = parseEnvelope("Execute selected handoffs --spec feature-one --run-key run-feature-one-1", root);
    const prompt = buildCtoPrompt(envelope, root, { sessionId: "prompt-roundtrip-session" });
    const match = /### Complete route-specific `cto_prepare` JSON template\n```json\n([\s\S]*?)\n```/u.exec(prompt);
    assert.ok(match?.[1], "execution prompt must render one complete cto_prepare JSON object");
    if (!match?.[1]) throw new Error("missing cto_prepare template");
    const rendered = JSON.parse(match[1]) as Json;
    const prepare = publicCtoTools(root).get("cto_prepare")!;
    assert.equal(prepare.parameters.safeParse(rendered).success, true, "rendered cto_prepare template must satisfy the public parser");
    assert.equal("classification" in rendered, false, "canonical execution classification remains engine-owned");
    assert.equal("teams" in rendered, false, "engine derives task ownership instead of accepting caller teams");
    assert.equal("dod" in rendered, false, "engine derives DoD from frozen handoffs");
    assert.equal(String(rendered.cto_run_id).includes("T-1"), false, "template must not hardcode a task id");
    const before = existsSync(join(root, ".work-state", "cto"));
    const malformedTeams = structuredClone(rendered) as Json;
    malformedTeams.teams = [];
    assert.equal(prepare.parameters.safeParse(malformedTeams).success, false, "caller team rows must be rejected");
    const malformedHandoff = structuredClone(rendered) as Json;
    malformedHandoff.handoff_id = "forged";
    assert.equal(prepare.parameters.safeParse(malformedHandoff).success, false, "caller handoff fields must be rejected");
    assert.equal(existsSync(join(root, ".work-state", "cto")), before, "public schema rejection must not write CTO state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution prepare rejects caller-authored classification before state write", () => {
  const root = makeProject();
  try {
    const tool = publicCtoTools(root).get("cto_prepare")!;
    const payload = mountedToolPayloads().cto_prepare;
    const rejected = tool.parameters.safeParse({ ...payload, classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" } });
    assert.equal(rejected.success, false, "execution route must derive its canonical classification instead of accepting a caller-authored one");
    assert.equal(existsSync(join(root, ".work-state", "cto")), false, "schema rejection must not create execution state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO wave and mapping schemas share uppercase SAFE_ID semantics", () => {
  const tools = publicCtoTools();
  const payloads = mountedToolPayloads();
  const uppercase: Record<string, Json> = Object.fromEntries(
    Object.entries(payloads).map(([name, payload]) => {
      const next = JSON.parse(JSON.stringify(payload)) as Json;
      if ("cto_run_id" in next) next.cto_run_id = "CTO-MOUNTED-RUN";
      if (name === "cto_prepare" || name === "cto_specification_prepare") {
        next.wave_id = "WAVE-MOUNTED-1";
        next.source_id = "SOURCE-MOUNTED-1";
      }
      if ("wave_id" in next) next.wave_id = "WAVE-MOUNTED-1";
      if ("mapping_id" in next && name !== "cto_specification_conformance") next.mapping_id = "MAPPING-MOUNTED-1";
      return [name, next];
    }),
  );
  for (const name of ["cto_prepare", "cto_preflight", "cto_checkpoint_ask_selected", "cto_mapping_resume", "cto_confirm", "cto_dispatch", "cto_close_specification_execution_wave"]) {
    assert.equal(tools.get(name)!.parameters.safeParse(uppercase[name]).success, true, `${name} should accept uppercase CTO identities`);
  }
  const close = tools.get("cto_close_specification_execution_wave")!;
  for (const unsafe of ["../escape", "foo∕bar", "foo\u2028bar"]) {
    assert.equal(close.parameters.safeParse({ ...uppercase.cto_close_specification_execution_wave, wave_id: unsafe }).success, false, `wave_id ${JSON.stringify(unsafe)} must be rejected`);
    assert.equal(close.parameters.safeParse({ ...uppercase.cto_close_specification_execution_wave, mapping_id: unsafe }).success, false, `mapping_id ${JSON.stringify(unsafe)} must be rejected`);
  }
});
test("mounted CTO schemas enforce exact hashes, bounded proofs, and authoritative completion counts", () => {
  const tools = publicCtoTools();
  const payloads = mountedToolPayloads();
  const confirm = tools.get("cto_confirm")!;
  const dispatch = tools.get("cto_dispatch")!;
  const close = tools.get("cto_close_specification_execution_wave")!;
  const advance = tools.get("cto_specification_advance")!;
  const conformance = tools.get("cto_specification_conformance")!;

  assert.equal(confirm.parameters.safeParse(payloads.cto_confirm).success, true);
  assert.equal(confirm.parameters.safeParse({ ...payloads.cto_confirm, mapping_hash: "a".repeat(65) }).success, false);
  const oversizedAnswer = structuredClone(payloads.cto_confirm) as Json;
  oversizedAnswer.answer_id = "a".repeat(MAX_CONFORMANCE_FIELD_BYTES + 1);
  assert.equal(confirm.parameters.safeParse(oversizedAnswer).success, false);
  assert.equal(confirm.parameters.safeParse({ ...payloads.cto_confirm, feature_id: "feature-one" }).success, false);
  assert.equal(confirm.parameters.safeParse({ ...payloads.cto_confirm, trusted_proof: {} }).success, false);

  assert.equal(dispatch.parameters.safeParse(payloads.cto_dispatch).success, true);
  assert.equal(dispatch.parameters.safeParse({ ...payloads.cto_dispatch, expected_mapping_hash: "a".repeat(65) }).success, false);
  assert.equal(dispatch.parameters.safeParse({ ...payloads.cto_dispatch, expected_mapping_hash: "not-a-digest" }).success, false);

  assert.equal(close.parameters.safeParse(payloads.cto_close_specification_execution_wave).success, true);
  const completion = (payloads.cto_close_specification_execution_wave.completions as Json[])[0]!;
  const sixtyFourCompletions = Array.from({ length: MAX_CTO_SPECIFICATION_REQUESTS }, () => structuredClone(completion));
  assert.equal(close.parameters.safeParse({ ...payloads.cto_close_specification_execution_wave, completions: sixtyFourCompletions }).success, true);
  assert.equal(close.parameters.safeParse({
    ...payloads.cto_close_specification_execution_wave,
    completions: [...sixtyFourCompletions, structuredClone(completion)],
  }).success, false);
  assert.equal(close.parameters.safeParse({
    ...payloads.cto_close_specification_execution_wave,
    completions: [{ ...completion, run_key: "r".repeat(129) }],
  }).success, false);

  assert.equal(advance.parameters.safeParse({ cto_run_id: "safe-run" }).success, true);
  assert.equal(advance.parameters.safeParse({ cto_run_id: "r".repeat(MAX_CTO_SPECIFICATION_ID_BYTES + 1) }).success, false);
  assert.equal(advance.parameters.safeParse({ cto_run_id: "../escape" }).success, false);

  assert.equal(conformance.parameters.safeParse(payloads.cto_specification_conformance).success, true);
  assert.equal(conformance.parameters.safeParse({ ...payloads.cto_specification_conformance, mapping_hash: "a".repeat(65) }).success, false);
  for (const field of ["binding", "mapping", "handoffs", "claims", "evidence", "quality_gates", "handoff_id", "handoff_digest", "routing"]) {
    assert.equal(conformance.parameters.safeParse({ ...structuredClone(payloads.cto_specification_conformance), [field]: {} }).success, false, `conformance rejects model-owned ${field}`);
  }
});
test("mounted CTO checkpoint Ask records a trusted proof and returns an exact confirmation descriptor", async () => {
  const root = makeProject();
  const featureId = "mounted-ask-feature";
  const runKey = `run-${featureId}-1`;
  try {
    writeFeature(root, featureId, runKey);
    ensureExecutionContext(root);
    const fixtureState = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
    assert.ok(fixtureState.state && fixtureState.statePath);
    if (!fixtureState.state || !fixtureState.statePath) throw new Error("execution fixture state unavailable");
    const dispatchCapability = fixtureState.state.dispatch_capability;
    assert.ok(dispatchCapability?.issued_for);
    if (!dispatchCapability?.issued_for) throw new Error("execution fixture capability unavailable");
    writeState(root, {
      ...fixtureState.state,
      dispatch_capability: {
        ...dispatchCapability,
        issued_for: { ...dispatchCapability.issued_for, stage_cursor: "execution" },
      },
    }, { target: fixtureState });
    const frozen = mapping(await preflight(root, [selection(featureId, runKey)]));
    const selected = (frozen.selections as Json[]).find((candidate) => candidate.feature_id === featureId);
    assert.ok(selected);
    const registered: MountedCtoTool[] = [];
    const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const sessionManager = TEST_SESSION_MANAGER;
    TEST_SESSION_MANAGER.cwd = root;
    const pi = {
      zod: { z: zod },
      setLabel: (_label: string) => undefined,
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "session_start") sessionStarts.push(handler);
      },
      registerTool: (tool: unknown) => registered.push(tool as MountedCtoTool),
    };
    registerTestTeamWorkflow(root, pi as never, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd, rebindSessions: true }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
    registerTestCtoTools(root, pi as never, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
    const tools = new Map(registered.map((tool) => [tool.name, tool]));
    let askInvoked = false;
    for (const sessionStart of sessionStarts) sessionStart({}, {
      cwd: root,
      mode: "tui",
      hasUI: true,
      sessionManager,
      ui: {
        askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
          askInvoked = true;
          assert.equal(questions.length, 1);
          assert.deepEqual(questions[0]!.options, [{ label: "approve_continue" }, { label: "request_changes" }, { label: "approve_stop" }]);
          return {
            kind: "submit" as const,
            results: [{
              id: questions[0]!.id,
              question: questions[0]!.question,
              header: questions[0]!.header,
              options: questions[0]!.options.map((option) => option.label),
              multi: false,
              selectedOptions: ["approve_continue"],
            }],
          };
        },
      },
    });
    const mountedPreflight = mountedDetails(await tools.get("cto_preflight")!.execute("preflight", {
      cto_run_id: RUN_ID,
      selections: [selection(featureId, runKey)],
    }, undefined, undefined, { cwd: root, sessionManager }));
    assert.equal(mountedPreflight.status, "ready", detail(mountedPreflight));
    assert.equal((mountedPreflight.required_next_tool as Json).name, "cto_checkpoint_ask_selected");
    const askArgs = (mountedPreflight.required_next_tool as Json).arguments as Json;
    assert.equal(askArgs.stage_id, "execution");
    const staleStage = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask-stale-stage", { ...askArgs, stage_id: STAGE_ID }, undefined, undefined, { cwd: root, sessionManager }));
    assert.equal(staleStage.status, "blocked", detail(staleStage));
    assert.match(String((staleStage.findings as string[])[0]), /stage selector/i);
    assert.equal(askInvoked, false);
    const asked = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask", askArgs, undefined, undefined, { cwd: root, sessionManager }));
    assert.equal(askInvoked, true, detail(asked));
    assert.equal(asked.status, "answered", detail(asked));
    assert.equal((asked.required_next_tool as Json).name, "cto_confirm");
    const confirmArgs = (asked.required_next_tool as Json).arguments as Json;
    assert.deepEqual(confirmArgs, {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      answer_id: asked.trusted_answer_ref,
    });
    const replayAsked = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask-replay", askArgs, undefined, undefined, { cwd: root, sessionManager }));
    assert.equal(replayAsked.status, "answered", detail(replayAsked));
    assert.equal(replayAsked.checkpoint_ref, asked.checkpoint_ref);
    assert.equal(replayAsked.trusted_answer_ref, asked.trusted_answer_ref);
    assert.deepEqual(replayAsked.trusted_proof, asked.trusted_proof);
    const canceled = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask-canceled", askArgs, AbortSignal.abort(), undefined, { cwd: root, sessionManager }));
    assert.equal(canceled.status, "blocked", detail(canceled));
    assert.match(String((canceled.findings as string[])[0]), /canceled|cancel/i);
    assert.equal(canceled.checkpoint_ref, undefined);
    assert.equal(canceled.trusted_answer_ref, undefined);
    const confirmed = mountedDetails(await tools.get("cto_confirm")!.execute("confirm", confirmArgs, undefined, undefined, { cwd: root, sessionManager }));
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    assert.equal((confirmed.required_next_tool as Json).name, "cto_dispatch");
    assert.deepEqual((confirmed.required_next_tool as Json).arguments, {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      expected_mapping_hash: frozen.mapping_hash,
    });
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("forged answer WAL cannot overwrite canonical bytes without a live trusted Ask proof", async () => {
  const root = makeProject();
  const featureId = "mapping-answer-wal-security";
  const runKey = `run-${featureId}-1`;
  try {
    writeFeature(root, featureId, runKey);
    ensureExecutionContext(root);
    const fixtureState = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
    assert.ok(fixtureState.state && fixtureState.statePath);
    if (!fixtureState.state || !fixtureState.statePath) return;
    const dispatchCapability = fixtureState.state.dispatch_capability;
    assert.ok(dispatchCapability?.issued_for);
    if (!dispatchCapability?.issued_for) return;
    writeState(root, {
      ...fixtureState.state,
      dispatch_capability: {
        ...dispatchCapability,
        issued_for: { ...dispatchCapability.issued_for, stage_cursor: "execution" },
      },
    }, { target: fixtureState });

    const frozen = mapping(await preflight(root, [selection(featureId, runKey)]));
    const ask = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
    });
    assert.equal(ask.status, "ready", detail(ask));
    if (ask.status !== "ready") return;
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const beforeState = readFileSync(statePath, "utf8");

    // Leave a structurally valid answer WAL on disk at the crash seam. Once
    // the process is gone, this JSON is untrusted, even though it resembles a
    // response that the terminal Ask would have produced.
    let injected = false;
    setCtoSpecificationMappingFailureInjector((point) => {
      if (!injected && point === "after_prepare") {
        injected = true;
        throw new Error("simulated crash after answer WAL publication");
      }
    }, root);
    const interrupted = await mountedCtoHostAsk(root, ask as Json, "approve_continue");
    assert.equal(interrupted.status, "blocked", detail(interrupted));
    assert.equal(injected, true);
    setCtoSpecificationMappingFailureInjector(null, root);

    const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
    const transactionFiles = readdirSync(transactionDir).filter((name) => name.endsWith(".json"));
    assert.equal(transactionFiles.length, 1);
    const transaction = JSON.parse(readFileSync(join(transactionDir, transactionFiles[0]!), "utf8")) as Json;
    assert.equal(transaction.operation, "answer");
    assert.equal(transaction.status, "pending");

    const forged = transaction;
    const maliciousPreimage = JSON.stringify({ forged: "mapping preimage supplied by attacker" });
    const stagedRecord = JSON.parse(String(forged.mapping_content)) as Json;
    const stagedMapping = stagedRecord.mapping as Json;
    stagedMapping.updated_at = "forged mapping postimage";
    const maliciousPostimage = `${JSON.stringify(stagedRecord, null, 2)}\r\n`;
    forged.mapping_before_content = maliciousPreimage;
    forged.mapping_before_digest = sha256Hex(maliciousPreimage);
    forged.mapping_content = maliciousPostimage;
    forged.mapping_after_digest = sha256Hex(maliciousPostimage);
    (forged.staged_mapping_identity as Json).content_digest = forged.mapping_after_digest;
    writeFileSync(join(transactionDir, transactionFiles[0]!), `${JSON.stringify(forged, null, 2)}\r\n`);
    writeFileSync(mappingPath, maliciousPostimage);
    const forgedMapping = readFileSync(mappingPath, "utf8");
    assert.notEqual(forgedMapping, beforeMapping);
    const txPath = join(transactionDir, transactionFiles[0]!);
    const forgedWal = readFileSync(txPath, "utf8");
    const replacementWal = `${forgedWal} `;
    let replacedAfterRead = false;
    setCtoSpecificationMappingFailureInjector((point, transactionId) => {
      if (point === "after_recovery_read" && !replacedAfterRead && transactionId === transaction.transaction_id) {
        replacedAfterRead = true;
        writeFileSync(txPath, replacementWal);
      }
    }, root);
    const raced = resumeCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
      mapping_version: 1,
    });
    assert.equal(raced.status, "blocked", detail(raced));
    assert.match(detail(raced), /CTO_SPEC_MAPPING_RECOVERY_REQUIRED/);
    assert.equal(replacedAfterRead, true);
    assert.equal(readFileSync(mappingPath, "utf8"), forgedMapping, "receipt mismatch must preserve canonical mapping bytes");
    assert.notEqual(readFileSync(mappingPath, "utf8"), maliciousPreimage, "answer recovery must not restore a WAL-supplied preimage");
    assert.equal(readFileSync(statePath, "utf8"), beforeState, "answer recovery must not publish the on-disk answer state");
    assert.equal(readFileSync(txPath, "utf8"), replacementWal, "receipt mismatch must preserve the replacement WAL");
    const quarantineDirectory = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-quarantine");
    assert.equal(existsSync(quarantineDirectory), false, "receipt mismatch must not archive the replacement WAL");

    setCtoSpecificationMappingFailureInjector(null, root);
    const resumed = resumeCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
      mapping_version: 1,
    });
    assert.equal(resumed.status, "blocked", detail(resumed));
    assert.match(detail(resumed), /CTO_SPEC_MAPPING_ANSWER_RECOVERY_REQUIRED/);
    assert.equal(readFileSync(mappingPath, "utf8"), forgedMapping, "answer recovery must preserve the canonical postimage bytes");
    assert.notEqual(readFileSync(mappingPath, "utf8"), maliciousPreimage, "answer recovery must not restore a WAL-supplied preimage");
    assert.equal(readFileSync(statePath, "utf8"), beforeState, "answer recovery must not publish the on-disk answer state");
    assert.equal(existsSync(txPath), false, "recovery must remove only the quarantined WAL descriptor");
    const quarantinePath = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-quarantine", `${String(transaction.transaction_id)}-${String(transaction.mapping_id)}-answer.json`);
    assert.equal(readFileSync(quarantinePath, "utf8"), replacementWal, "quarantine must retain exact replacement WAL bytes");


  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO mapping Ask binds request_changes and approve_stop without confirmation or dispatch", async () => {
  for (const decision of ["request_changes", "approve_stop"] as const) {
    const root = makeProject();
    const featureId = `mounted-${decision}-feature`;
    const runKey = `run-${featureId}-1`;
    try {
      writeFeature(root, featureId, runKey);
      ensureExecutionContext(root);
      const fixtureState = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
      assert.ok(fixtureState.state && fixtureState.statePath);
      if (!fixtureState.state || !fixtureState.statePath) throw new Error("execution fixture state unavailable");
      const dispatchCapability = fixtureState.state.dispatch_capability;
      assert.ok(dispatchCapability?.issued_for);
      if (!dispatchCapability?.issued_for) throw new Error("execution fixture capability unavailable");
      writeState(root, {
        ...fixtureState.state,
        dispatch_capability: {
          ...dispatchCapability,
          issued_for: { ...dispatchCapability.issued_for, stage_cursor: "execution" },
        },
      }, { target: fixtureState });
      const frozen = mapping(await preflight(root, [selection(featureId, runKey)]));
      const registered: MountedCtoTool[] = [];
      const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
      const sessionManager = TEST_SESSION_MANAGER;
      TEST_SESSION_MANAGER.cwd = root;
      const pi = {
        zod: { z: zod },
        setLabel: (_label: string) => undefined,
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          if (event === "session_start") sessionStarts.push(handler);
        },
        registerTool: (tool: unknown) => registered.push(tool as MountedCtoTool),
      };
      registerTestTeamWorkflow(root, pi as never, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd, rebindSessions: true }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
      registerTestCtoTools(root, pi as never, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }, `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
      const tools = new Map(registered.map((tool) => [tool.name, tool]));
      let nextDecision = decision;
      for (const sessionStart of sessionStarts) sessionStart({}, {
        cwd: root,
        mode: "tui",
        hasUI: true,
        sessionManager,
        ui: {
          askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
            const question = questions[0]?.question ?? "";
            assert.ok(question.includes(`feature_id=${featureId}`), question);
            assert.ok(question.includes(`run_key=${runKey}`), question);
            assert.ok(question.includes("stage_id=execution"), question);
            assert.ok(question.includes("checkpoint_id=cto_mapping_confirmation"), question);
            assert.ok(question.includes("semantic_identity=cto_mapping_confirmation"), question);
            return {
              kind: "submit" as const,
              results: [{
                id: questions[0]!.id,
                question: questions[0]!.question,
                header: questions[0]!.header,
                options: questions[0]!.options.map((option) => option.label),
                selectedOptions: [nextDecision],
                ...(nextDecision === "request_changes" ? { note: "Review mapping dependencies before approval." } : {}),
                multi: false,
              }],
            };
          },
        },
      });
      const mountedPreflight = mountedDetails(await tools.get("cto_preflight")!.execute("preflight", {
        cto_run_id: RUN_ID,
        selections: [selection(featureId, runKey)],
      }, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(mountedPreflight.status, "ready", detail(mountedPreflight));
      const askArgs = (mountedPreflight.required_next_tool as Json).arguments as Json;
      const asked = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask", askArgs, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(asked.status, "answered", detail(asked));
      assert.equal(asked.decision, decision);
      assert.equal((asked.required_next_tool as Json).name, "cto_mapping_resume");
      assert.equal((asked.required_next_tool as Json).arguments.mapping_version, 1);
      const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
      const stored = JSON.parse(readFileSync(mappingPath, "utf8")) as Json;
      assert.equal((stored.mapping as Json).status, decision === "request_changes" ? "revision_required" : "stopped");
      assert.equal((stored as Json).checkpoint_ref, null);
      assert.equal((stored as Json).trusted_answer_ref, null);
      const selectedAfterAsk = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
      const storedAnswer = selectedAfterAsk.state?.trusted_checkpoint_answers?.find((answer) => answer.answer_id === asked.trusted_answer_ref);
      assert.equal(storedAnswer?.feedback, decision === "request_changes" ? "Review mapping dependencies before approval." : undefined);
      assert.equal((stored.review as Json | undefined)?.feedback, decision === "request_changes" ? "Review mapping dependencies before approval." : undefined);
      const replay = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask-replay", askArgs, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(replay.status, "blocked", detail(replay));
      assert.match(detail(replay), /not awaiting confirmation|revision_required|stopped/i);
      const recordInput = { ...askArgs, decision, ...(asked.feedback !== undefined ? { feedback: asked.feedback } : {}) } as Parameters<typeof recordCtoSpecificationMappingAsk>[1];
      if (decision === "request_changes") {
        const substituted = recordCtoSpecificationMappingAsk(root, { ...recordInput, feedback: "model-substituted feedback" });
        assert.equal(substituted.status, "blocked", detail(substituted));
      }
      const crossDecision = decision === "request_changes" ? "approve_stop" : "request_changes";
      const crossed = recordCtoSpecificationMappingAsk(root, { ...recordInput, decision: crossDecision });
      const stale = recordCtoSpecificationMappingAsk(root, { ...recordInput, mapping_hash: "f".repeat(64) });
      assert.equal(stale.status, "blocked", detail(stale));
      assert.equal(crossed.status, "blocked", detail(crossed));
      const dispatched = mountedDetails(await tools.get("cto_dispatch")!.execute("dispatch", {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        expected_mapping_hash: frozen.mapping_hash,
      }, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(dispatched.status, "blocked", detail(dispatched));
      const rejectedConfirm = mountedDetails(await tools.get("cto_confirm")!.execute("confirm-noncontinue", {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
        answer_id: asked.trusted_answer_ref,
      }, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(rejectedConfirm.status, "blocked", detail(rejectedConfirm));
      const resumed = mountedDetails(await tools.get("cto_mapping_resume")!.execute("resume", {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
        mapping_version: 1,
      }, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(resumed.status, "resumed", detail(resumed));
      assert.equal((resumed.required_next_tool as Json).name, "cto_checkpoint_ask_selected");
      const oldProofAfterResume = mountedDetails(await tools.get("cto_confirm")!.execute("confirm-old-proof", {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
        answer_id: asked.trusted_answer_ref,
      }, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(oldProofAfterResume.status, "blocked", detail(oldProofAfterResume));
      const reopened = JSON.parse(readFileSync(mappingPath, "utf8")) as Json;
      assert.equal((reopened.mapping as Json).status, "awaiting_confirmation");
      assert.equal((reopened as Json).checkpoint_ref, null);
      assert.equal((reopened as Json).trusted_answer_ref, null);
      nextDecision = "approve_continue";
      const resumedAskArgs = (resumed.required_next_tool as Json).arguments as Json;
      const resumedAsk = mountedDetails(await tools.get("cto_checkpoint_ask_selected")!.execute("ask-after-resume", resumedAskArgs, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(resumedAsk.status, "answered", detail(resumedAsk));
      assert.equal(resumedAsk.decision, "approve_continue");
      assert.notEqual(resumedAsk.trusted_answer_ref, asked.trusted_answer_ref, "resume must mint a fresh proof");
      const resumedConfirm = mountedDetails(await tools.get("cto_confirm")!.execute("confirm-after-resume", (resumedAsk.required_next_tool as Json).arguments, undefined, undefined, { cwd: root, sessionManager }));
      assert.equal(resumedConfirm.status, "confirmed", detail(resumedConfirm));
    } finally {
      executionContexts.delete(root);
      projectFeatures.delete(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});



function mountedConformanceFixture(
  root: string,
  mapping: Json,
  binding: Json,
  featureIds: readonly string[],
  omitEvidenceFor: string | null = null,
  changedIntentFor: string | readonly string[] | null = null,
  noEvidenceFor: string | null = null,
): Json {
  // Conformance evidence is meaningful only after every mapped CTO team has a terminal runtime postimage.
  completeMountedCtoExecutionTeams(root);
  const handoffs: Json[] = [];
  const claims: Json[] = [];
  const evidence: Json[] = [];
  const qualityGates: Json[] = [];
  for (const featureId of featureIds) {
    const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
    assert.ok(selected.state?.specification, `workspace for ${featureId} must be readable`);
    const workspace = selected.state!.specification as unknown as Json;
    const handoff = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`), "utf8")) as Json;
    const currentClaim = readCurrentExecutionClaim(root, featureId);
    assert.equal(currentClaim.ok, true, currentClaim.ok ? "" : currentClaim.error);
    assert.ok(currentClaim.ok && currentClaim.value, `active claim for ${featureId} must be readable`);
    if (!currentClaim.ok || !currentClaim.value) continue;
    const handoffEntry: Json = { feature_id: featureId, run_key: `run-${featureId}-1`, handoff, quality_gates: [] };
    handoffs.push(handoffEntry);
    claims.push({
      feature_id: featureId,
      claim_id: currentClaim.value.claim_id,
      handoff_digest: currentClaim.value.handoff_digest,
      owner_kind: currentClaim.value.owner_kind,
      owner_run_id: currentClaim.value.owner_run_id,
      status: currentClaim.value.status,
    });
    const conformanceEvidenceId = `conformance_evidence-${featureId}`;
    const testEvidenceId = "Worker-Proof-" + featureId;
    const testEvidenceRef = writeArtifactWithReference(
      root,
      join(root, ".work-state", "features", featureId, "artifacts"),
      testEvidenceId,
      {
        schema_version: 1,
        artifact_id: testEvidenceId,
        entries: [{
          evidence_id: `${featureId}-executed-test-artifact`,
          kind: "implementation",
          subject_id: `${featureId}-runtime`,
          requirement_id: "FR-1",
          handoff_digest: handoff.handoff_digest,
          execution_claim_id: currentClaim.value!.claim_id,
          recorded_at: new Date().toISOString(),
        }],
      },
      { schema_status: "met", quality_gate_status: "met" },
    );
    const subjectEvidence = featureId === noEvidenceFor
      ? []
      : ["FR-1", "AC-1"].flatMap((subjectId) => {
      const implementation = {
        evidence_id: `${featureId}-implementation-${subjectId}`,
        kind: "implementation",
        subject_id: subjectId,
        requirement_id: "FR-1",
        handoff_digest: handoff.handoff_digest,
        execution_claim_id: currentClaim.value!.claim_id,
        recorded_at: new Date().toISOString(),
      };
      if (featureId === omitEvidenceFor) return [implementation];
      const review = {
        evidence_id: `${featureId}-review-${subjectId}`,
        kind: "review",
        subject_id: subjectId,
        requirement_id: "FR-1",
        handoff_digest: handoff.handoff_digest,
          execution_claim_id: currentClaim.value!.claim_id,
        review_verdict: "pass",
        recorded_at: new Date().toISOString(),
      };
      const changedIntent = Array.isArray(changedIntentFor)
        ? changedIntentFor.includes(featureId)
        : featureId === changedIntentFor;
      if (changedIntent) {
        return [
          implementation,
          review,
          {
            evidence_id: `${featureId}-intent-${subjectId}`,
            kind: "intent_conflict",
            subject_id: subjectId,
            requirement_id: "FR-1",
            handoff_digest: handoff.handoff_digest,
            execution_claim_id: currentClaim.value!.claim_id,
            intent_message: "Implementation changed the approved behavior.",
            recorded_at: new Date().toISOString(),
          },
        ];
      }
      return [
        implementation,
        review,
        {
          evidence_id: `${featureId}-test-${subjectId}`,
          kind: "executed_test",
          subject_id: subjectId,
          requirement_id: "FR-1",
          handoff_digest: handoff.handoff_digest,
          execution_claim_id: currentClaim.value!.claim_id,
          test: { evidence_ref: testEvidenceRef, test_kind: "runtime", status: "pass", executed_at: new Date().toISOString() },
          recorded_at: new Date().toISOString(),
        },
      ];
    });
    const envelope = { schema_version: 1, artifact_id: conformanceEvidenceId, entries: subjectEvidence };
    const reference = writeArtifactWithReference(
      root,
      join(root, ".work-state", "features", featureId, "artifacts"),
      conformanceEvidenceId,
      envelope,
      { schema_status: "met", quality_gate_status: "met" },
    );
    for (const entry of subjectEvidence) evidence.push({ ...entry, artifact: reference });
    const profileGateId = `execution-profile.${String(workspace.profile_hash)}`;
    const profileGateArtifactId = `quality_gate_evidence-${featureId}`;
    const profileGateRef = writeArtifactWithReference(
      root,
      join(root, ".work-state", "features", featureId, "artifacts"),
      profileGateArtifactId,
      {
        schema_version: 1,
        artifact_id: profileGateArtifactId,
        gates: [{
          gate_id: profileGateId,
          source: "execution_profile",
          status: "pass",
          evidence_refs: [],
          findings: [],
          evaluated_at: new Date().toISOString(),
        }],
      },
      { schema_status: "met", quality_gate_status: "met" },
    );
    const profileGate = {
      gate_id: profileGateId,
      source: "execution_profile",
      status: "pass",
      evidence_refs: [profileGateRef],
      findings: [],
    };
    qualityGates.push(profileGate);
    handoffEntry.quality_gates = [profileGate];
    const runtimeArtifactId = `runtime_test_evidence-${featureId}`;
    const runtimeEntries = subjectEvidence
      .filter((entry) => entry.kind === "executed_test")
      .map((entry) => ({ ...entry, test: { ...(entry.test as Json), evidence_ref: profileGateRef } }));
    let canonicalConformanceRef = reference;
    let canonicalOuterEntries = subjectEvidence;
    if (runtimeEntries.length > 0) {
      const runtimeRef = writeArtifactWithReference(
        root,
        join(root, ".work-state", "features", featureId, "artifacts"),
        runtimeArtifactId,
        { schema_version: 1, artifact_id: runtimeArtifactId, entries: runtimeEntries },
        { schema_status: "met", quality_gate_status: "met" },
      );
      const outerEntries = subjectEvidence.map((entry) => entry.kind === "executed_test"
        ? { ...entry, test: { ...(entry.test as Json), evidence_ref: runtimeRef } }
        : entry);
      canonicalOuterEntries = outerEntries;
      canonicalConformanceRef = writeArtifactWithReference(
        root,
        join(root, ".work-state", "features", featureId, "artifacts"),
        conformanceEvidenceId,
        { schema_version: 1, artifact_id: conformanceEvidenceId, entries: outerEntries },
        { schema_status: "met", quality_gate_status: "met" },
      );
    }
    const firstFeatureEvidence = evidence.length - subjectEvidence.length;
    for (let index = 0; index < subjectEvidence.length; index += 1) {
      const item = canonicalOuterEntries[index]!;
      evidence[firstFeatureEvidence + index] = { ...item, artifact: canonicalConformanceRef };
    }
    unlinkSync(join(root, ".work-state", "features", featureId, "artifacts", `${testEvidenceId}.json`));
  }
  return { binding, mapping, handoffs, claims, evidence, quality_gates: [] };
}
function rewriteMountedConformanceThreeLevel(root: string, featureId: string): void {
  const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
  const qualityArtifactId = `quality_gate_evidence-${featureId}`;
  const qualityPath = join(artifactsDir, `${qualityArtifactId}.json`);
  const qualityBody = JSON.parse(readFileSync(qualityPath, "utf8")) as Json;
  for (const gate of (qualityBody.gates as Json[])) gate.evidence_refs = [];
  const qualityRef = writeArtifactWithReference(root, artifactsDir, qualityArtifactId, qualityBody, { schema_status: "met", quality_gate_status: "met" });
  const runtimeArtifactId = `runtime_test_evidence-${featureId}`;
  const conformanceArtifactId = `conformance_evidence-${featureId}`;
  const conformancePath = join(artifactsDir, `${conformanceArtifactId}.json`);
  const conformanceBody = JSON.parse(readFileSync(conformancePath, "utf8")) as Json;
  const runtimeEntries = (conformanceBody.entries as Json[])
    .filter((entry) => entry.kind === "executed_test")
    .map((entry) => ({ ...entry, test: { ...(entry.test as Json), evidence_ref: qualityRef } }));
  const runtimeRef = writeArtifactWithReference(
    root,
    artifactsDir,
    runtimeArtifactId,
    { schema_version: 1, artifact_id: runtimeArtifactId, entries: runtimeEntries },
    { schema_status: "met", quality_gate_status: "met" },
  );
  const outerEntries = (conformanceBody.entries as Json[]).map((entry) => entry.kind === "executed_test"
    ? { ...entry, test: { ...(entry.test as Json), evidence_ref: runtimeRef } }
    : entry);
  writeArtifactWithReference(
    root,
    artifactsDir,
    conformanceArtifactId,
    { ...conformanceBody, entries: outerEntries },
    { schema_status: "met", quality_gate_status: "met" },
  );
}
function mountedConformancePayload(
  root: string,
  mapping: Json,
  binding: Json,
  featureIds: readonly string[],
  omitEvidenceFor: string | null = null,
  changedIntentFor: string | readonly string[] | null = null,
  noEvidenceFor: string | null = null,
): Json {
  mountedConformanceFixture(root, mapping, binding, featureIds, omitEvidenceFor, changedIntentFor, noEvidenceFor);
  const execution = mapping.execution as Json;
  return {
    cto_run_id: String(mapping.cto_run_id ?? RUN_ID),
    mapping_id: String(mapping.mapping_id),
    mapping_hash: String(mapping.mapping_hash),
    wave_id: String(execution.wave_id),
  };
}
function producedCompletionEnvelope(root: string, mapping: Json, mappingDigest: string, featureId: string): Json {
  const runKey = `run-${featureId}-1`;
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
  assert.ok(selected.state?.specification, `workspace for ${featureId} must be readable`);
  const workspace = selected.state!.specification as unknown as Json;
  const claimRead = readCurrentExecutionClaim(root, featureId);
  assert.ok(claimRead.ok && claimRead.value, `active claim for ${featureId} must be readable`);
  if (!claimRead.ok || !claimRead.value) return {};
  const handoff = JSON.parse(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", `${String(workspace.handoff_ref)}.json`), "utf8")) as Json;
  const execution = mapping.execution as Json;
  return {
    owner_kind: "cto",
    owner_run_key: RUN_ID,
    wave_id: String(execution.wave_id),
    mapping_id: String(mapping.mapping_id),
    mapping_digest: mappingDigest,
    feature_id: featureId,
    run_key: runKey,
    handoff_digest: String(handoff.handoff_digest),
    conformance_id: String(workspace.implementation_conformance_ref),
  };
}


test("mounted CTO dispatch blocks a fresh-v3 migration when its state CAS preimage changes", async () => {
  const root = makeProject();
  const featureId = "anchor-fresh-v3-cas-race";
  let injected = false;
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    const workspace = state.specification as Json;
    const binding = workspace.path_binding as Json;
    binding.execution_claim = null;
    binding.execution_claim_next = null;
    writeFileSync(statePath, JSON.stringify(state) + "\n", "utf8");
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        if (injected) return;
        injected = true;
        const raced = JSON.parse(readFileSync(sourcePath, "utf8")) as Json;
        raced.state_revision = Number(raced.state_revision ?? 0) + 1;
        writeFileSync(sourcePath, JSON.stringify(raced) + "\n", "utf8");
      },
    }, root);
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(injected, true, "the migration CAS seam must run");
    assert.equal(dispatched.status, "blocked", detail(dispatched));
    const after = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    const afterBinding = (after.specification as Json).path_binding as Json;
    assert.equal(afterBinding.execution_claim, null, "a changed migration preimage must not publish claim paths");
    const current = readCurrentExecutionClaim(root, featureId);
    assert.equal(current.ok, true, current.ok ? "" : current.error);
    if (current.ok) assert.equal(current.value, null, "a blocked migration must not publish claim authority");
  } finally {
    setStateTransactionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO dispatch lazily initializes fresh-v3 claim paths for the confirmation anchor", async () => {
  const root = makeProject();
  const featureId = "anchor-fresh-v3-null-path";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const before = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    const beforeRevision = Number(before.state_revision);
    const workspace = before.specification as Json;
    const binding = workspace.path_binding as Json;
    binding.execution_claim = null;
    binding.execution_claim_next = null;
    writeFileSync(statePath, JSON.stringify(before) + "\n", "utf8");

    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const current = readCurrentExecutionClaim(root, featureId);
    assert.equal(current.ok, true, current.ok ? "" : current.error);
    assert.ok(current.ok && current.value, "fresh-v3 anchor dispatch must persist an active claim");
    if (!current.ok || !current.value) return;
    assert.equal(current.value.admission_binding?.confirmation_state_revision, beforeRevision + 1, "claim binds the migration postimage, not the stale anchor preimage");
    const after = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    const afterBinding = (after.specification as Json).path_binding as Json;
    assert.ok(afterBinding.execution_claim && afterBinding.execution_claim_next, "claim path identities are lazily initialized");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO dispatch keeps a non-anchor migration bound to the anchor and replays exactly", async () => {
  const root = makeProject();
  const featureIds = ["anchor-non-anchor-a", "anchor-non-anchor-b"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const anchorStatePath = join(root, ".work-state", "features", featureIds[0]!, "state.json");
    const anchorBefore = JSON.parse(readFileSync(anchorStatePath, "utf8")) as Json;
    const anchorRevision = Number(anchorBefore.state_revision);
    const secondaryStatePath = join(root, ".work-state", "features", featureIds[1]!, "state.json");
    const secondary = JSON.parse(readFileSync(secondaryStatePath, "utf8")) as Json;
    const secondaryBinding = (secondary.specification as Json).path_binding as Json;
    secondaryBinding.execution_claim = null;
    secondaryBinding.execution_claim_next = null;
    writeFileSync(secondaryStatePath, JSON.stringify(secondary) + "\n", "utf8");

    const dispatchInput = {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    };
    const first = await dispatchCtoSpecificationMapping(root, dispatchInput, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(first.status, "dispatched", detail(first));
    const anchorAfterFirst = JSON.parse(readFileSync(anchorStatePath, "utf8")) as Json;
    const anchorAfterFirstRevision = Number(anchorAfterFirst.state_revision);
    const secondaryClaim = readCurrentExecutionClaim(root, featureIds[1]!);
    assert.equal(secondaryClaim.ok, true, secondaryClaim.ok ? "" : secondaryClaim.error);
    assert.ok(secondaryClaim.ok && secondaryClaim.value, "non-anchor migration must admit its exact feature claim");
    if (!secondaryClaim.ok || !secondaryClaim.value) return;
    assert.equal(secondaryClaim.value.admission_binding?.confirmation_state_revision, anchorAfterFirstRevision, "non-anchor migration must keep the confirmed anchor revision");
    assert.notEqual(anchorRevision, anchorAfterFirstRevision, "the anchor claim should advance the anchor feature state before the non-anchor claim");
    const beforeReplay = readExecutionClaimStore(root, featureIds[1]!);
    assert.equal(beforeReplay.ok, true, beforeReplay.ok ? "" : beforeReplay.error);
    const replay = await dispatchCtoSpecificationMapping(root, dispatchInput, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(replay.status, "dispatched", detail(replay));
    assert.deepEqual((replay.outcomes as Json[]).map((outcome) => outcome.disposition), ["replayed", "replayed"]);
    const afterReplay = readExecutionClaimStore(root, featureIds[1]!);
    assert.equal(afterReplay.ok, true, afterReplay.ok ? "" : afterReplay.error);
    if (beforeReplay.ok && afterReplay.ok) assert.equal(afterReplay.value.length, beforeReplay.value.length, "exact replay must not append claim authority");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO dispatch admits the confirmation anchor with an exact post-prepare snapshot", async () => {
  const root = makeProject();
  const featureId = "anchor-first-admission";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    assert.deepEqual((dispatched.outcomes as Json[]).map((outcome) => outcome.status), ["claimed"]);
    const current = readCurrentExecutionClaim(root, featureId);
    assert.equal(current.ok, true, current.ok ? "" : current.error);
    assert.ok(current.ok && current.value, "anchor-first dispatch must persist an active claim");
    const state = resolveState(root, undefined, { feature_id: featureId, run_key: "run-" + featureId + "-1" });
    assert.equal(state.state?.specification?.status, "claimed");
    assert.equal(state.state?.specification?.execution_claim_prepare_ref, null);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO mapping confirms and dispatches when authoritative teams are reordered", async () => {
  const root = makeProject();
  const featureIds = ["reordered-team-a", "reordered-team-b"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    const ctoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const reordered = JSON.parse(readFileSync(ctoStatePath, "utf8")) as Json;
    reordered.teams = (reordered.teams as Json[]).slice().reverse();
    writeFileSync(ctoStatePath, JSON.stringify(reordered) + String.fromCharCode(10), "utf8");
    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    assert.deepEqual((dispatched.outcomes as Json[]).map((outcome) => outcome.feature_id), featureIds);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO dispatch compensates a claim after a post-prepare foreign state mutation", async () => {
  const root = makeProject();
  const featureId = "post-prepare-foreign-mutation";
  let casCount = 0;
  let injected = false;
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        casCount += 1;
        if (casCount !== 2) return;
        injected = true;
        const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Json;
        state.state_revision = Number(state.state_revision ?? 0) + 1;
        writeFileSync(sourcePath, JSON.stringify(state, null, 2) + "\n", "utf8");
      },
    }, root);
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(injected, true, "the deterministic post-prepare mutation must run");
    assert.equal(dispatched.status, "blocked", detail(dispatched));
    const claims = readExecutionClaimStore(root, featureId);
    assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
    if (claims.ok) {
      const terminal = claims.value.at(-1);
      if (terminal) assert.equal(terminal.status, "released", "foreign mutation must compensate the created claim");
    }
    const current = readCurrentExecutionClaim(root, featureId);
    assert.equal(current.ok, true, current.ok ? "" : current.error);
    if (current.ok) assert.equal(current.value, null, "compensation must leave no active claim authority");
    const state = resolveState(root, undefined, { feature_id: featureId, run_key: "run-" + featureId + "-1" });
    assert.equal(state.state?.specification?.execution_claim_ref, null);
    assert.equal(state.state?.specification?.execution_claim_prepare_ref, null);
  } finally {
    setStateTransactionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO conformance producer persists a multi-feature matrix and replays by exact content identity", async () => {
  const root = makeProject();
  const featureIds = ["producer-feature-a", "producer-feature-b"];
  try {
    writeParallelFeatures(root, featureIds);
    for (const featureId of featureIds) rewriteHandoff(root, featureId, (handoff) => {
      (handoff.tasks as Json[])[0]!.parallel_safe = false;
    }, root);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const firstDispatch = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(firstDispatch.status, "dispatched", detail(firstDispatch));
    const firstClaimedFeatureIds = (firstDispatch.outcomes as Json[])
      .filter((outcome) => outcome.status === "claimed")
      .map((outcome) => String(outcome.feature_id));
    assert.ok(firstClaimedFeatureIds.length > 0, detail(firstDispatch));
    const leadContracts = new Map<string, string>();
    for (const outcome of firstDispatch.outcomes as Json[]) {
      if (outcome.status !== "claimed") continue;
      const featureId = String(outcome.feature_id);
      const claim = outcome.claim as Json;
      const state = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
      const workspace = state.state?.specification as Json;
      assertLeadEvidenceContract(outcome, featureId, String(claim.handoff_digest), String(claim.claim_id), String(workspace.profile_hash));
      leadContracts.set(featureId, JSON.stringify(outcome.lead_contract));
    }
    const ctoStateAfterFirstDispatch = readCtoState(RUN_ID, root);
    assert.ok(ctoStateAfterFirstDispatch, "dispatch must leave durable CTO state for restart replay");
    if (!ctoStateAfterFirstDispatch) throw new Error("durable CTO state is unavailable");
    completeMountedCtoExecutionTeams(root, { featureIds: firstClaimedFeatureIds });
    const secondDispatch = await spawnCtoDispatch(
      root,
      RUN_ID,
      String(frozen.mapping_id),
      String(frozen.mapping_hash),
    );
    assert.equal(secondDispatch.status, "dispatched", detail(secondDispatch));
    const secondClaimedFeatureIds = (secondDispatch.outcomes as Json[])
      .filter((outcome) => outcome.status === "claimed")
      .map((outcome) => String(outcome.feature_id));
    assert.deepEqual(secondClaimedFeatureIds, [featureIds.find((featureId) => !firstClaimedFeatureIds.includes(featureId))]);
    for (const outcome of secondDispatch.outcomes as Json[]) {
      if (outcome.status !== "claimed") continue;
      const featureId = String(outcome.feature_id);
      const claim = outcome.claim as Json;
      const state = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
      const workspace = state.state?.specification as Json;
      assertLeadEvidenceContract(outcome, featureId, String(claim.handoff_digest), String(claim.claim_id), String(workspace.profile_hash));
      leadContracts.set(featureId, JSON.stringify(outcome.lead_contract));
    }
    assert.equal(secondDispatch.conformance_binding, undefined, "partial dispatch must not issue terminal conformance authority");
    const ctoStateBeforeReplay = readCtoState(RUN_ID, root);
    assert.ok(ctoStateBeforeReplay, "second dispatch must leave durable CTO state for restart replay");
    if (!ctoStateBeforeReplay) throw new Error("durable CTO state is unavailable");
    completeMountedCtoExecutionTeams(root);
    const restartedDispatch = await spawnCtoDispatch(
      root,
      RUN_ID,
      String(frozen.mapping_id),
      String(frozen.mapping_hash),
    );
    assert.equal(restartedDispatch.status, "dispatched", detail(restartedDispatch));
    const initialClaims = (restartedDispatch.claims as Json[]).map((claim) => String(claim.claim_id));
    assert.equal(new Set(initialClaims).size, featureIds.length);
    assert.deepEqual(restartedDispatch.admitted_slices, []);
    const dispatched = restartedDispatch;
    assert.deepEqual((dispatched.claims as Json[]).map((claim) => String(claim.claim_id)), initialClaims);
    for (const outcome of restartedDispatch.outcomes as Json[]) {
      if (outcome.status !== "claimed") continue;
      const featureId = String(outcome.feature_id);
      const claim = outcome.claim as Json;
      const state = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
      const workspace = state.state?.specification as Json;
      assertLeadEvidenceContract(outcome, featureId, String(claim.handoff_digest), String(claim.claim_id), String(workspace.profile_hash));
      assert.equal(JSON.stringify(outcome.lead_contract), leadContracts.get(featureId), `${featureId}: replay preserves the exact lead contract`);
    }
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, featureIds);
    const beforeInvalidState = new Map(featureIds.map((featureId) => [
      featureId,
      readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"),
    ]));
    const beforeInvalidArtifacts = new Map(featureIds.map((featureId) => [
      featureId,
      readdirSync(join(root, ".work-state", "features", featureId, "artifacts")).sort(),
    ]));
    const invalid = tool.parameters.safeParse({ ...payload, binding: { capability_id: "cto-conformance-v2.invalid" } });
    assert.equal(invalid.success, false, "flattened caller binding must be rejected at the public schema");
    for (const featureId of featureIds) {
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeInvalidState.get(featureId));
      assert.deepEqual(readdirSync(join(root, ".work-state", "features", featureId, "artifacts")).sort(), beforeInvalidArtifacts.get(featureId));
    }
    const parsedPayload = tool.parameters.safeParse(payload) as { success: boolean; data?: Json };
    assert.equal(parsedPayload.success, true, JSON.stringify(parsedPayload));
    const first = mountedDetails(await tool.execute("conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(first.status, "ready", detail(first));
    assert.deepEqual(first.passing_feature_ids, featureIds);
    assert.deepEqual(first.blocked_feature_ids, []);
    const requiredFinalizers = first.required_next_tools as Json[];
    assert.equal(requiredFinalizers.length, featureIds.length);
    assert.deepEqual(requiredFinalizers.map((entry) => (entry.arguments as Json).feature_id), featureIds);
    assert.ok(requiredFinalizers.every((entry) => entry.name === "workflow_complete_specification_execution"));
    for (const entry of requiredFinalizers) {
      const arguments_ = entry.arguments as Json;
      assert.deepEqual(Object.keys(arguments_).sort(), [
        "conformance_id",
        "feature_id",
        "handoff_digest",
        "mapping_digest",
        "mapping_id",
        "owner_kind",
        "owner_run_key",
        "run_key",
        "wave_id",
      ]);
      assert.equal(arguments_.owner_kind, "cto");
      assert.equal(arguments_.owner_run_key, RUN_ID);
      assert.equal(arguments_.mapping_digest, dispatched.mapping_digest);
    }
    const firstFeatures = first.features as Json[];
    assert.equal(firstFeatures.length, featureIds.length);
    assert.ok(firstFeatures.every((feature) => feature.status === "persisted" && typeof feature.conformance_id === "string"));
    for (const featureId of featureIds) {
      const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
      assert.equal(selected.state?.specification?.implementation_conformance_ref, (firstFeatures.find((feature) => feature.feature_id === featureId) as Json).conformance_id);
    }
    const replay = mountedDetails(await tool.execute("conformance-replay", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "ready", detail(replay));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.passing_feature_ids, featureIds);
    assert.deepEqual((replay.features as Json[]).map((feature) => feature.conformance_id), firstFeatures.map((feature) => feature.conformance_id));
    const publicRuntimeState = testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID).readState(RUN_ID);
    const publicRuntimeTeam = (publicRuntimeState?.teams as Json[] | undefined)?.[0];
    assert.ok(publicRuntimeTeam, "public runtime projection must expose the terminal execution team");
    const publicRuntimeEnvelope = publicRuntimeTeam?.completion_envelope as Json | undefined;
    assert.ok(publicRuntimeEnvelope, "public runtime projection must expose the completion envelope shape");
    assert.equal(Object.hasOwn(publicRuntimeEnvelope ?? {}, "completed_by"), false, "public runtime projection must redact completion author metadata");
    const foreignFeatureId = featureIds[0]!;
    const foreignEnvelope = producedCompletionEnvelope(root, dispatched.mapping!, String(dispatched.mapping_digest), foreignFeatureId);
    const featureDirectory = join(root, ".work-state", "features", foreignFeatureId);
    const foreignCtoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const snapshotTree = (directory: string): Array<[string, string]> => {
      const rows: Array<[string, string]> = [];
      for (const name of readdirSync(directory).sort()) {
        const child = join(directory, name);
        if (statSync(child).isDirectory()) rows.push(...snapshotTree(child));
        else rows.push([child, readFileSync(child, "utf8")]);
      }
      return rows;
    };
    const beforeForeignFeature = snapshotTree(featureDirectory);
    const beforeForeignCtoState = readFileSync(foreignCtoStatePath, "utf8");
    const foreignRuntime = testRuntimeAccess(root, "foreign-completion-session", `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`);
    try {
      const foreign = completeSpecificationExecution(root, foreignEnvelope as never, {
        runtimeAccess: foreignRuntime,
        sessionId: "foreign-completion-session",
      });
      assert.equal(foreign.ok, false, "a foreign live session must not complete another session's execution");
      assert.deepEqual(snapshotTree(featureDirectory), beforeForeignFeature, "foreign completion must not mutate feature or claim bytes");
      assert.equal(readFileSync(foreignCtoStatePath, "utf8"), beforeForeignCtoState, "foreign completion must not mutate canonical CTO state bytes");
    } finally {
      closeTestRuntime(root, "foreign-completion-session");
    }
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    for (const featureId of featureIds) {
      const envelope = producedCompletionEnvelope(root, dispatched.mapping!, String(dispatched.mapping_digest), featureId);
      const completed = mountedDetails(await finalizer.execute(`complete-${featureId}`, envelope, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
      assert.equal(completed.ok, true, detail(completed));
      assert.equal((completed.workspace as Json).status, "completed");
      if (featureId === featureIds.at(-1)) {
        assert.ok(completed.required_next_tool, detail(completed));
        assert.equal((completed.required_next_tool as Json).name, "cto_close_specification_execution_wave");
        const closeArguments = (completed.required_next_tool as Json).arguments as Json;
        assert.equal(closeArguments.cto_run_id, RUN_ID);
        assert.equal(closeArguments.mapping_id, dispatched.mapping!.mapping_id);
        assert.equal(closeArguments.mapping_digest, dispatched.mapping_digest);
        assert.deepEqual((closeArguments.completions as Json[]).map((item) => item.feature_id), featureIds);
      } else {
        assert.match(String(completed.next_action), /finish every exact required CTO completion envelope/i);
      }
    }
    const beforeActiveReplayState = new Map(featureIds.map((featureId) => [
      featureId,
      readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"),
    ]));
    const beforeActiveReplayArtifacts = new Map(firstFeatures.map((feature) => {
      const featureId = String(feature.feature_id);
      const conformanceId = String(feature.conformance_id);
      const path = join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", `${conformanceId}.json`);
      return [featureId, readFileSync(path, "utf8")] as const;
    }));
    const activeReplayCtoStateBefore = readCtoState(RUN_ID, root);
    const activeTerminalReplay = mountedDetails(await tool.execute("after-finalizer", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(activeTerminalReplay.status, "blocked", detail(activeTerminalReplay));
    assert.equal(activeTerminalReplay.replayed, false);
    assert.equal(activeTerminalReplay.persisted, false, detail(activeTerminalReplay));
    assert.equal(Object.hasOwn(activeTerminalReplay, "required_next_tool"), false, detail(activeTerminalReplay));
    assert.equal(Object.hasOwn(activeTerminalReplay, "required_next_tools"), false, detail(activeTerminalReplay));
    assert.deepEqual(readCtoState(RUN_ID, root), activeReplayCtoStateBefore);
    for (const featureId of featureIds) {
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeActiveReplayState.get(featureId));
      const conformanceId = String(firstFeatures.find((feature) => feature.feature_id === featureId)?.conformance_id);
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", `${conformanceId}.json`), "utf8"), beforeActiveReplayArtifacts.get(featureId));
    }
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closePayload = {
      cto_run_id: RUN_ID,
      wave_id: String((dispatched.mapping!.execution as Json).wave_id),
      mapping_id: String(dispatched.mapping!.mapping_id),
      mapping_digest: String(dispatched.mapping_digest),
      completions: featureIds.map((featureId) => {
        const envelope = producedCompletionEnvelope(root, dispatched.mapping!, String(dispatched.mapping_digest), featureId);
        return {
          feature_id: featureId,
          run_key: String(envelope.run_key),
          handoff_digest: String(envelope.handoff_digest),
          conformance_id: String(envelope.conformance_id),
        };
      }),
    };
    assert.equal(closeTool.parameters.safeParse(closePayload).success, true);
    const mappingId = String((dispatched.mapping as Json).mapping_id ?? "");
    assert.ok(isSafeCtoExecutionId(mappingId), "close mapping fixture requires a safe canonical mapping id");
    const mappingRecordPath = `.work-state/cto/${RUN_ID}/specification-mappings/${mappingId}.json`;
    const mappingPath = join(root, mappingRecordPath);
    assert.equal(existsSync(mappingPath), true, "close mapping fixture requires the canonical mapping record to exist");
    const mappingBytes = readFileSync(mappingPath);
    const mappingRecord = JSON.parse(mappingBytes.toString("utf8")) as Json;
    const persistedMapping = mappingRecord.mapping as Json | undefined;
    assert.equal(persistedMapping?.mapping_id, mappingId, "close mapping fixture must read the exact selected mapping id");
    assert.equal(persistedMapping?.mapping_hash, String((dispatched.mapping as Json).mapping_hash), "close mapping fixture must read the exact selected mapping hash");
    const closeStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const stateBeforeInvalidMapping = readFileSync(closeStatePath, "utf8");
    writeFileSync(mappingPath, Buffer.from("{}\n", "utf8"));
    let invalidMappingClose: Awaited<ReturnType<typeof closeCtoSpecificationExecutionWave>>;
    try {
      invalidMappingClose = await closeCtoSpecificationExecutionWave(root, closePayload, { runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID), sessionId: DEFAULT_TEST_SESSION_ID });
    } finally {
      writeFileSync(mappingPath, mappingBytes);
    }
    assert.equal(invalidMappingClose.status, "blocked", JSON.stringify(invalidMappingClose));
    assert.match(JSON.stringify(invalidMappingClose.findings), /mapping|immutable|unreadable|record/i);
    assert.equal(readFileSync(closeStatePath, "utf8"), stateBeforeInvalidMapping, "invalid mapping must not mutate the CTO state");
    const closed = mountedDetails(await closeTool.execute("close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.closed, true);
    assert.equal(closed.replayed, false);
    assert.equal(closed.outcome, "pass");
    assert.deepEqual(closed.blocked_feature_ids, []);
    assert.deepEqual(closed.findings, []);
    const ctoRoot = PinnedProjectRoot.open(root);
    assert.ok(ctoRoot);
    const ctoAfterClose = readCtoStatePinned(RUN_ID, ctoRoot);
    ctoRoot.close();
    assert.equal(ctoAfterClose?.active_wave_id, undefined);
    const closedWave = ctoAfterClose?.wave_history?.find((wave) => wave.id === closePayload.wave_id);
    assert.equal(closedWave?.status, "done", JSON.stringify({ expected: closePayload.wave_id, state: ctoAfterClose }));
    assert.equal(typeof closedWave?.conformance_receipt_ref, "string", "closed CTO execution wave must retain its receipt pointer");
    const receiptRef = closedWave?.conformance_receipt_ref;
    if (typeof receiptRef !== "string") throw new Error("closed CTO execution wave receipt pointer is unavailable");
    const receiptRelativePath = ctoSpecificationConformanceReceiptRelativePath(RUN_ID, receiptRef);
    assert.ok(receiptRelativePath, "closed CTO execution wave receipt path must be canonical");
    if (!receiptRelativePath) throw new Error("closed CTO execution wave receipt path is invalid");
    const receiptPath = join(root, receiptRelativePath);
    const receiptBytes = readFileSync(receiptPath);
    const ctoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const terminalStateBeforeReceiptCorruption = readFileSync(foreignCtoStatePath, "utf8");
    unlinkSync(receiptPath);
    const missingReceipt = await closeCtoSpecificationExecutionWave(root, closePayload, { runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID), sessionId: DEFAULT_TEST_SESSION_ID });
    assert.equal(missingReceipt.status, "blocked", JSON.stringify(missingReceipt));
    assert.match(JSON.stringify(missingReceipt.findings), /receipt|recovery/i);
    assert.equal(readFileSync(foreignCtoStatePath, "utf8"), terminalStateBeforeReceiptCorruption);
    writeFileSync(receiptPath, receiptBytes);
    writeFileSync(receiptPath, Buffer.concat([receiptBytes, Buffer.from("tampered", "utf8")]));
    const tamperedReceipt = await closeCtoSpecificationExecutionWave(root, closePayload, { runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID), sessionId: DEFAULT_TEST_SESSION_ID });
    assert.equal(tamperedReceipt.status, "blocked", JSON.stringify(tamperedReceipt));
    assert.match(JSON.stringify(tamperedReceipt.findings), /receipt|canonical|invalid|digest/i);
    assert.equal(readFileSync(foreignCtoStatePath, "utf8"), terminalStateBeforeReceiptCorruption);
    writeFileSync(receiptPath, receiptBytes);
    const terminalStateBeforeForeignClose = readFileSync(foreignCtoStatePath, "utf8");
    const foreignClose = await closeCtoSpecificationExecutionWave(root, closePayload, {
      // Keep the authenticated facade bound to the owner session while forging
      // only the caller session selector; opening another fixture would race
      // the process-wide workflow-registration capability owner.
      runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID),
      sessionId: "foreign-close-session",
    });
    assert.equal(foreignClose.status, "blocked", JSON.stringify(foreignClose));
    assert.match(JSON.stringify(foreignClose.findings), /session|owner/i);
    assert.equal(readFileSync(foreignCtoStatePath, "utf8"), terminalStateBeforeForeignClose, "foreign terminal replay must not mutate canonical state");
    const terminalStateBeforeReplay = readFileSync(foreignCtoStatePath, "utf8");
    const replayClose = mountedDetails(await closeTool.execute("close-replay", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(readFileSync(foreignCtoStatePath, "utf8"), terminalStateBeforeReplay, "same-owner terminal replay must be byte-idempotent");
    const beforeTerminalReplayState = new Map(featureIds.map((featureId) => [
      featureId,
      readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"),
    ]));
    const beforeTerminalReplayArtifacts = new Map(firstFeatures.map((feature) => {
      const featureId = String(feature.feature_id);
      const conformanceId = String(feature.conformance_id);
      const path = join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", `${conformanceId}.json`);
      return [featureId, readFileSync(path, "utf8")] as const;
    }));
    const terminalReplay = mountedDetails(await tool.execute("terminal-replay", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(terminalReplay.status, "ready", detail(terminalReplay));
    assert.equal(terminalReplay.replayed, true);
    assert.deepEqual(terminalReplay.passing_feature_ids, featureIds);
    assert.deepEqual((terminalReplay.features as Json[]).map((feature) => feature.conformance_id), firstFeatures.map((feature) => feature.conformance_id));
    for (const featureId of featureIds) {
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeTerminalReplayState.get(featureId));
      const conformanceId = String(firstFeatures.find((feature) => feature.feature_id === featureId)?.conformance_id);
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", `${conformanceId}.json`), "utf8"), beforeTerminalReplayArtifacts.get(featureId));
    }
    assert.equal(replayClose.status, "closed", detail(replayClose));
    assert.equal(replayClose.replayed, true);
    const terminalStateBeforeConformanceTamper = readFileSync(foreignCtoStatePath, "utf8");
    const tamperedDoneState = readCtoState(RUN_ID, root);
    assert.ok(tamperedDoneState, "terminal conformance tamper fixture requires canonical state");
    if (!tamperedDoneState) throw new Error("terminal conformance tamper state is unavailable");
    const tamperedTeamIndex = tamperedDoneState.teams.findIndex((team) => team.status === "done" && team.work_identity);
    assert.ok(tamperedTeamIndex >= 0, "terminal conformance tamper fixture requires a done team identity");
    if (tamperedTeamIndex < 0) throw new Error("terminal conformance tamper team is unavailable");
    const tamperedTeam = tamperedDoneState.teams[tamperedTeamIndex]!;
    if (!tamperedTeam.work_identity) throw new Error("terminal conformance tamper team identity is unavailable");
    tamperedDoneState.teams[tamperedTeamIndex] = {
      ...tamperedTeam,
      work_identity: { ...tamperedTeam.work_identity, task_id: `${tamperedTeam.work_identity.task_id}-tampered` },
    };
    writeCtoState(tamperedDoneState, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const tamperedDoneStateBytes = readFileSync(foreignCtoStatePath, "utf8");
    const tamperedDone = mountedDetails(await tool.execute("terminal-done-projection-tamper", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(tamperedDone.status, "blocked", detail(tamperedDone));
    assert.match(JSON.stringify(tamperedDone.findings), /terminal|identity|mapping|stale|receipt/i);
    assert.equal(readFileSync(foreignCtoStatePath, "utf8"), tamperedDoneStateBytes, "tampered terminal projection must not mutate CTO state");
    const restoredDoneState = readCtoState(RUN_ID, root);
    assert.ok(restoredDoneState, "terminal conformance tamper fixture requires state restoration");
    if (!restoredDoneState) throw new Error("terminal conformance tamper restoration state is unavailable");
    const originalTerminalState = JSON.parse(terminalStateBeforeConformanceTamper) as CtoState;
    writeCtoState({ ...restoredDoneState, teams: structuredClone(originalTerminalState.teams) }, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const terminalStateBeforeReceiptTamper = readFileSync(foreignCtoStatePath, "utf8");
    writeFileSync(receiptPath, Buffer.concat([receiptBytes, Buffer.from("tampered-terminal-receipt", "utf8")]));
    const tamperedReceiptReplay = mountedDetails(await tool.execute("terminal-receipt-tamper", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(tamperedReceiptReplay.status, "blocked", detail(tamperedReceiptReplay));
    assert.match(JSON.stringify(tamperedReceiptReplay.findings), /receipt|canonical|invalid|digest|terminal/i);
    assert.equal(readFileSync(foreignCtoStatePath, "utf8"), terminalStateBeforeReceiptTamper, "tampered terminal receipt must not mutate CTO state");
    writeFileSync(receiptPath, receiptBytes);
    const terminalStateForRepair = readCtoState(RUN_ID, root);
    assert.ok(terminalStateForRepair, "terminal projection repair requires canonical state");
    if (!terminalStateForRepair) throw new Error("terminal projection repair state is unavailable");
    writeCtoState({
      ...terminalStateForRepair,
      integration: { ...terminalStateForRepair.integration, note: "stale terminal projection" },
    }, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const repairedClose = await closeCtoSpecificationExecutionWave(root, closePayload, { runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID), sessionId: DEFAULT_TEST_SESSION_ID });
    assert.equal(repairedClose.status, "closed", JSON.stringify(repairedClose));
    assert.equal(repairedClose.replayed, true);
    const repairedTerminalState = readCtoState(RUN_ID, root);
    assert.equal(repairedTerminalState?.integration.note, "CTO specification-execution run completed successfully.");
    const staleMapping = mountedDetails(await closeTool.execute("stale-mapping", {
      ...closePayload,
      mapping_digest: "f".repeat(64),
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(staleMapping.status, "blocked");
    assert.equal(staleMapping.closed, false);
    const forgedCompletion = mountedDetails(await closeTool.execute("forged-completion", {
      ...closePayload,
      completions: closePayload.completions.map((completion) => ({
        ...completion,
        conformance_id: `implementation-conformance.${"f".repeat(64)}`,
      })),
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(forgedCompletion.status, "blocked");
    assert.equal(forgedCompletion.closed, false);
  } finally {
    cleanupMountedConformanceTest(root);
  }
});

test("mounted CTO conformance blocks an extra runtime row before matrix persistence", async () => {
  const root = makeProject();
  const featureId = "producer-extra-runtime-row";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
    const runtimeId = `runtime_test_evidence-${featureId}`;
    const runtimePath = join(artifactsDir, `${runtimeId}.json`);
    const runtimeBody = JSON.parse(readFileSync(runtimePath, "utf8")) as Json;
    const extra = structuredClone((runtimeBody.entries as Json[])[0]);
    assert.ok(extra, "runtime fixture must contain one test row");
    extra!.evidence_id = `${String(extra!.evidence_id)}-extra`;
    extra!.subject_id = `${String(extra!.subject_id)}-extra`;
    (runtimeBody.entries as Json[]).push(extra!);
    const runtimeRef = writeArtifactWithReference(root, artifactsDir, runtimeId, runtimeBody, { schema_status: "met", quality_gate_status: "met" });
    const conformanceId = `conformance_evidence-${featureId}`;
    const conformancePath = join(artifactsDir, `${conformanceId}.json`);
    const conformanceBody = JSON.parse(readFileSync(conformancePath, "utf8")) as Json;
    const entries = (conformanceBody.entries as Json[]).map((entry) => entry.kind === "executed_test"
      ? { ...entry, test: { ...(entry.test as Json), evidence_ref: runtimeRef } }
      : entry);
    writeArtifactWithReference(root, artifactsDir, conformanceId, { ...conformanceBody, entries }, { schema_status: "met", quality_gate_status: "met" });
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const blocked = mountedDetails(await tool.execute("extra-runtime-row", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(blocked.status, "blocked", detail(blocked));
    assert.equal(blocked.persisted, false);
    assert.match(detail(blocked), /duplicate|runtime|outer/i);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "invalid runtime multiset must not mutate feature state");
    assert.equal(resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` }).state?.specification?.implementation_conformance_ref, null);
  } finally {
    cleanupMountedConformanceTest(root);
  }
});

test("mounted CTO conformance rejects an unused runtime artifact for intent-conflict evidence", async () => {
  const root = makeProject();
  const featureId = "producer-unused-runtime-artifact";
  try {
    writeFeature(root, featureId);
    const frozen = await preflight(root, [selection(featureId)]);
    assert.equal((await confirmTrusted(root, mapping(frozen))).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(mapping(frozen).mapping_id),
      expected_mapping_hash: String(mapping(frozen).mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId], null, featureId);
    const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
    const runtimeId = `runtime_test_evidence-${featureId}`;
    writeArtifactWithReference(root, artifactsDir, runtimeId, { schema_version: 1, artifact_id: runtimeId, entries: [] }, { schema_status: "met", quality_gate_status: "met" });
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const blocked = mountedDetails(await tool.execute("unused-runtime-artifact", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(blocked.status, "blocked", detail(blocked));
    assert.equal(blocked.persisted, false);
    assert.match(detail(blocked), /unused canonical runtime|unused.*runtime/i);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "unused runtime artifact must not mutate feature state");
    assert.equal(existsSync(join(artifactsDir, "implementation_conformance")), false);
  } finally {
    cleanupMountedConformanceTest(root);
  }
});

test("mounted CTO conformance rejects nonempty persisted quality references before persistence", async () => {
  const root = makeProject();
  const featureId = "producer-nonempty-quality-refs";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
    const qualityId = `quality_gate_evidence-${featureId}`;
    const qualityPath = join(artifactsDir, `${qualityId}.json`);
    const qualityBody = JSON.parse(readFileSync(qualityPath, "utf8")) as Json;
    const gate = (qualityBody.gates as Json[])[0]!;
    gate.evidence_refs = [{
      artifact_id: "persisted-quality-proof",
      path: `artifacts/${qualityId}.json`,
      sha256: "a".repeat(64),
      schema_status: "met",
      quality_gate_status: "met",
    }];
    writeArtifactWithReference(root, artifactsDir, qualityId, qualityBody, { schema_status: "met", quality_gate_status: "met" });
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const blocked = mountedDetails(await tool.execute("nonempty-quality-refs", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(blocked.status, "blocked", detail(blocked));
    assert.equal(blocked.persisted, false);
    assert.match(detail(blocked), /quality.*evidence_refs|empty evidence_refs/i);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "invalid quality envelope must not mutate feature state");
    assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);
  } finally {
    cleanupMountedConformanceTest(root);
  }
});

test("mounted CTO conformance rejects prose review verdicts before matrix persistence", async () => {
  const root = makeProject();
  const featureId = "producer-prose-review-verdict";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
    const conformanceId = `conformance_evidence-${featureId}`;
    const conformancePath = join(artifactsDir, `${conformanceId}.json`);
    const conformanceBody = JSON.parse(readFileSync(conformancePath, "utf8")) as Json;
    const review = (conformanceBody.entries as Json[]).find((entry) => entry.kind === "review");
    assert.ok(review, "worker fixture must contain a review entry");
    review!.review_verdict = "pass: reviewed implementation";
    writeArtifactWithReference(root, artifactsDir, conformanceId, conformanceBody, { schema_status: "met", quality_gate_status: "met" });
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const rejected = mountedDetails(await tool.execute("prose-review-verdict", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(rejected.status, "blocked", detail(rejected));
    assert.equal(rejected.persisted, false, detail(rejected));
    assert.match(detail(rejected), /review_verdict|pass.*fail|enum|exact/i);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "invalid review verdict must not mutate feature state");
    assert.equal(existsSync(join(artifactsDir, "implementation_conformance")), false);
  } finally {
    cleanupMountedConformanceTest(root);
  }
});

test("mounted CTO conformance rejects raw evidence identifiers before matrix persistence", async () => {
  const root = makeProject();
  const featureId = "producer-raw-evidence-id";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
    const conformanceId = `conformance_evidence-${featureId}`;
    const conformancePath = join(artifactsDir, `${conformanceId}.json`);
    const conformanceBody = JSON.parse(readFileSync(conformancePath, "utf8")) as Json;
    const entry = (conformanceBody.entries as Json[])[0];
    assert.ok(entry, "worker fixture must contain evidence");
    entry!.evidence_id = '{"raw":"worker output"}\n';
    writeArtifactWithReference(root, artifactsDir, conformanceId, conformanceBody, { schema_status: "met", quality_gate_status: "met" });
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const rejected = mountedDetails(await tool.execute("raw-evidence-id", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(rejected.status, "blocked", detail(rejected));
    assert.equal(rejected.persisted, false, detail(rejected));
    assert.match(detail(rejected), /evidence_id|safe bounded identifier|slug|identifier|schema pattern/i);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore, "raw evidence identifier must not mutate feature state");
    assert.equal(existsSync(join(artifactsDir, "implementation_conformance")), false);
  } finally {
    cleanupMountedConformanceTest(root);
  }
});

test("mounted CTO finalizer admits a quality-to-runtime-to-conformance evidence DAG", async () => {
  const root = makeProject();
  const featureId = "producer-three-level-dag";
  try {
    writeParallelFeatures(root, [featureId]);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    let dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    if (!dispatched.conformance_binding) {
      completeMountedCtoExecutionTeams(root);
      dispatched = await dispatchCtoSpecificationMapping(root, {
        cto_run_id: RUN_ID,
        mapping_id: String(frozen.mapping_id),
        expected_mapping_hash: String(frozen.mapping_hash),
      }, preparationRuntimeOptions(root)) as unknown as Result;
    }
    assert.ok(dispatched.mapping && dispatched.conformance_binding, detail(dispatched));
    mountedConformanceFixture(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    rewriteMountedConformanceThreeLevel(root, featureId);
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const conformance = mountedDetails(await tool.execute("three-level-dag", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(conformance.status, "ready", detail(conformance));
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    const finalizerArgs = ((conformance.required_next_tools as Json[])[0]!.arguments) as Json;
    const completed = mountedDetails(await finalizer.execute("three-level-dag-finalize", finalizerArgs, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    assert.equal((completed.workspace as Json).status, "completed");
  } finally {
    cleanupMountedConformanceTest(root);
  }
});
test("mounted CTO conformance rejects an invalid evidence envelope before any matrix or state mutation", async () => {
  const root = makeProject();
  const featureIds = ["producer-boundary-a", "producer-boundary-b"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, featureIds);
    const beforeFeatureStates = new Map(featureIds.map((featureId) => [
      featureId,
      readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"),
    ]));
    const beforeFeatureArtifacts = new Map(featureIds.map((featureId) => [
      featureId,
      readdirSync(join(root, ".work-state", "features", featureId, "artifacts")).sort(),
    ]));
    const beforeCtoState = readFileSync(join(root, ".work-state", "cto", RUN_ID, "state.json"), "utf8");
    for (const featureId of featureIds) {
      assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);
    }
    const envelopePath = join(root, ".work-state", "features", featureIds[0]!, "artifacts", `conformance_evidence-${featureIds[0]}.json`);
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as Json;
    envelope.provenance = { source: "forged" };
    writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

    const rejected = mountedDetails(await tool.execute("invalid-evidence-envelope", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(rejected.status, "blocked", detail(rejected));
    assert.equal(rejected.persisted, false, detail(rejected));
    assert.equal(rejected.next_action, "repair_conformance_evidence", detail(rejected));
    assert.match(detail(rejected), /provenance|additional|unexpected/i);
    assert.equal(readFileSync(join(root, ".work-state", "cto", RUN_ID, "state.json"), "utf8"), beforeCtoState);
    for (const featureId of featureIds) {
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeFeatureStates.get(featureId));
      assert.deepEqual(readdirSync(join(root, ".work-state", "features", featureId, "artifacts")).sort(), beforeFeatureArtifacts.get(featureId));
      assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);
    }
  } finally {
    cleanupMountedConformanceTest(root);
  }
});
test("CTO conformance retries valid-schema wrong-binding evidence without replaying a blocked matrix", async () => {
  const root = makeProject();
  const featureId = "producer-retry-a";
  try {
    writeParallelFeatures(root, [featureId]);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const beforeFeatureState = readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8");
    const beforeCtoState = readFileSync(join(root, ".work-state", "cto", RUN_ID, "state.json"), "utf8");
    const beforeArtifacts = readdirSync(join(root, ".work-state", "features", featureId, "artifacts")).sort();
    const envelopePath = join(root, ".work-state", "features", featureId, "artifacts", `conformance_evidence-${featureId}.json`);
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as Json;
    const entries = envelope.entries as Json[];
    entries[0] = { ...entries[0], subject_id: "not-a-frozen-subject" };
    envelope.entries = entries.filter((entry) => entry.subject_id !== "AC-1");
    writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    const rejected = mountedDetails(await tool.execute("retry-invalid-evidence", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(rejected.status, "blocked", detail(rejected));
    assert.equal(rejected.persisted, false, detail(rejected));
    assert.equal(rejected.next_action, "repair_conformance_evidence", detail(rejected));
    assert.match(detail(rejected), /subject|review|executed-test|evidence|hash|artifact/i);
    assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeFeatureState);
    assert.equal(readFileSync(join(root, ".work-state", "cto", RUN_ID, "state.json"), "utf8"), beforeCtoState);
    assert.deepEqual(readdirSync(join(root, ".work-state", "features", featureId, "artifacts")).sort(), beforeArtifacts);
    assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);

    mountedConformanceFixture(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const corrected = mountedDetails(await tool.execute("retry-corrected-evidence", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(corrected.status, "ready", detail(corrected));
    assert.equal(corrected.persisted, true, detail(corrected));
    assert.equal(corrected.replayed, false, detail(corrected));
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    const finalizerArgs = ((corrected.required_next_tools as Json[])[0]!.arguments) as Json;
    const completed = mountedDetails(await finalizer.execute("retry-complete", finalizerArgs, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closed = mountedDetails(await closeTool.execute("retry-close", (completed.required_next_tool as Json).arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.outcome, "pass", detail(closed));
  } finally {
    cleanupMountedConformanceTest(root);
  }
});
test("mounted CTO conformance producer reports per-feature failure without fabricating a passing matrix", async () => {
  const root = makeProject();
  const featureIds = ["producer-failure-a", "producer-failure-b"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const tool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, featureIds, "producer-failure-b");
    const beforeFeatureStates = new Map(featureIds.map((featureId) => [
      featureId,
      readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"),
    ]));
    const result = mountedDetails(await tool.execute("conformance-failure", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "blocked", detail(result));
    assert.equal(result.persisted, false, detail(result));
    assert.equal(result.next_action, "repair_conformance_evidence", detail(result));
    assert.deepEqual(result.passing_feature_ids, []);
    assert.deepEqual(result.blocked_feature_ids, featureIds);
    assert.match(detail(result), /evidence|review|executed-test/i);
    const outcomes = result.features as Json[];
    assert.deepEqual(outcomes.map((feature) => feature.status), ["blocked", "blocked"]);
    for (const featureId of featureIds) {
      assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeFeatureStates.get(featureId));
      assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);
    }
  } finally {
    cleanupMountedConformanceTest(root);
  }
});
test("mounted CTO mixed pass and blocked matrices close with an explicit blocked aggregate and replay idempotently", async () => {
  const root = makeProject();
  const featureIds = ["mixed-close-blocked", "mixed-close-pass"];
  const featureStatePath = join(root, ".work-state", "features", "mixed-close-blocked", "state.json");
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const stateBeforeConformance = readFileSync(featureStatePath);
    writeFileSync(featureStatePath, Buffer.concat([stateBeforeConformance, Buffer.alloc(1024 * 1024, 0x20)]));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const conformancePayload = mountedConformancePayload(
      root,
      dispatched.mapping!,
      dispatched.conformance_binding!,
      featureIds,
      null,
      "mixed-close-blocked",
    );
    const conformance = mountedDetails(await conformanceTool.execute("mixed-close-conformance", conformancePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(conformance.status, "blocked", detail(conformance));
    assert.deepEqual(conformance.passing_feature_ids, ["mixed-close-pass"]);
    assert.deepEqual(conformance.blocked_feature_ids, ["mixed-close-blocked"]);
    const finalizers = conformance.required_next_tools as Json[];
    assert.equal(finalizers.length, 1, detail(conformance));
    assert.equal((finalizers[0]!.arguments as Json).feature_id, "mixed-close-pass");
    assert.equal(finalizers.some((entry) => (entry.arguments as Json).feature_id === "mixed-close-blocked"), false, "blocked feature has no retry finalizer");
    const blockedMatrix = (conformance.features as Json[]).find((feature) => feature.feature_id === "mixed-close-blocked");
    assert.ok(["blocked", "changed_intent"].includes(String(blockedMatrix?.overall_status)), detail(conformance));
    assert.equal(blockedMatrix?.claim_action, "retain", detail(conformance));
    const completionTool = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await completionTool.execute(
      "mixed-close-complete-pass",
      finalizers[0]!.arguments,
      undefined,
      undefined,
      { cwd: root, sessionManager: TEST_SESSION_MANAGER },
    ));
    assert.equal(completed.ok, true, detail(completed));
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    assert.deepEqual(
      (closePayload.completions as Json[]).map((completion) => completion.feature_id),
      featureIds,
    );
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closed = mountedDetails(await closeTool.execute("mixed-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.closed, true);
    assert.equal(closed.replayed, false);
    assert.equal(closed.outcome, "blocked");
    assert.deepEqual(closed.blocked_feature_ids, ["mixed-close-blocked"]);
    assert.ok(Array.isArray(closed.findings) && closed.findings.length > 0, detail(closed));
    const ctoState = readCtoState(RUN_ID, root);
    const wave = ctoState?.wave_history?.find((candidate) => candidate.id === closePayload.wave_id);
    assert.equal(ctoState?.active_wave_id, undefined);
    assert.equal(wave?.status, "done");
    assert.equal(wave?.outcome, "blocked");
    assert.deepEqual(wave?.blocked_feature_ids, ["mixed-close-blocked"]);
    assert.deepEqual(wave?.findings, closed.findings);
    const replay = mountedDetails(await closeTool.execute("mixed-close-replay", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "closed", detail(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "blocked");
    assert.deepEqual(replay.blocked_feature_ids, ["mixed-close-blocked"]);
    assert.deepEqual(replay.findings, closed.findings);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted CTO repaired mixed fan-in persists terminal matrices and closes without a retry loop", async () => {
  const root = makeProject();
  const featureIds = ["repaired-fan-in-blocked", "repaired-fan-in-pass"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const initialPayload = mountedConformancePayload(
      root,
      dispatched.mapping!,
      dispatched.conformance_binding!,
      featureIds,
      "repaired-fan-in-blocked",
      null,
      "repaired-fan-in-pass",
    );
    const initial = mountedDetails(await conformanceTool.execute("repaired-fan-in-initial", initialPayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(initial.status, "blocked", detail(initial));
    assert.equal(initial.persisted, false, detail(initial));
    assert.deepEqual(initial.passing_feature_ids, []);
    assert.deepEqual(initial.blocked_feature_ids, featureIds);
    for (const featureId of featureIds) {
      assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);
    }

    // The bounded repair returns typed refs for both slices. The blocked slice
    // remains evidence-backed non-passing; the independent slice is passing.
    const repairedPayload = mountedConformancePayload(
      root,
      dispatched.mapping!,
      dispatched.conformance_binding!,
      featureIds,
      null,
      "repaired-fan-in-blocked",
    );
    const repaired = mountedDetails(await conformanceTool.execute("repaired-fan-in-repaired", repairedPayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(repaired.status, "blocked", detail(repaired));
    assert.deepEqual(repaired.passing_feature_ids, ["repaired-fan-in-pass"]);
    assert.deepEqual(repaired.blocked_feature_ids, ["repaired-fan-in-blocked"]);
    const repairedFeatures = repaired.features as Json[];
    assert.ok(repairedFeatures.every((feature) => feature.status === "persisted"), detail(repaired));
    const blockedMatrix = repairedFeatures.find((feature) => feature.feature_id === "repaired-fan-in-blocked");
    assert.equal(blockedMatrix?.claim_action, "retain", detail(repaired));
    assert.equal(blockedMatrix?.overall_status, "changed_intent", detail(repaired));
    const finalizers = repaired.required_next_tools as Json[];
    assert.deepEqual(finalizers.map((entry) => (entry.arguments as Json).feature_id), ["repaired-fan-in-pass"]);

    const blockedState = resolveState(root, undefined, { feature_id: "repaired-fan-in-blocked", run_key: "run-repaired-fan-in-blocked-1" });
    assert.equal((blockedState.state?.specification as Json)?.status, "claimed");
    const blockedClaim = readCurrentExecutionClaim(root, "repaired-fan-in-blocked");
    assert.equal(blockedClaim.ok, true, blockedClaim.ok ? "" : blockedClaim.error);
    assert.equal(blockedClaim.ok && blockedClaim.value?.status, "active");

    const completionTool = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await completionTool.execute(
      "repaired-fan-in-complete-pass",
      finalizers[0]!.arguments,
      undefined,
      undefined,
      { cwd: root, sessionManager: TEST_SESSION_MANAGER },
    ));
    assert.equal(completed.ok, true, detail(completed));
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    assert.deepEqual(
      (closePayload.completions as Json[]).map((completion) => completion.feature_id),
      featureIds,
    );
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closed = mountedDetails(await closeTool.execute("repaired-fan-in-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.closed, true);
    assert.equal(closed.outcome, "blocked");
    assert.deepEqual(closed.blocked_feature_ids, ["repaired-fan-in-blocked"]);
    const ctoState = readCtoState(RUN_ID, root);
    assert.equal(ctoState?.active_wave_id, undefined);
    assert.equal(ctoState?.wave_history?.find((wave) => wave.id === closePayload.wave_id)?.status, "done");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted CTO pass and changed-intent matrices close with blocked aggregate and replay", async () => {
  const root = makeProject();
  const featureIds = ["changed-close-intent", "changed-close-pass"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(
      root,
      dispatched.mapping!,
      dispatched.conformance_binding!,
      featureIds,
      null,
      "changed-close-intent",
    );
    const conformance = mountedDetails(await conformanceTool.execute("changed-close-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(conformance.status, "blocked", detail(conformance));
    assert.deepEqual(conformance.passing_feature_ids, ["changed-close-pass"]);
    assert.deepEqual(conformance.blocked_feature_ids, ["changed-close-intent"]);
    const changed = (conformance.features as Json[]).find((feature) => feature.feature_id === "changed-close-intent");
    assert.equal(changed?.overall_status, "changed_intent", detail(conformance));
    const finalizers = conformance.required_next_tools as Json[];
    assert.equal(finalizers.length, 1, detail(conformance));
    const completionTool = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await completionTool.execute("changed-close-complete-pass", finalizers[0]!.arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closed = mountedDetails(await closeTool.execute("changed-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.outcome, "blocked");
    assert.deepEqual(closed.blocked_feature_ids, ["changed-close-intent"]);
    const ctoState = readCtoState(RUN_ID, root);
    assert.equal(ctoState?.active_wave_id, undefined);
    assert.equal(ctoState?.wave_history?.find((wave) => wave.id === closePayload.wave_id)?.status, "done");
    const replay = mountedDetails(await closeTool.execute("changed-close-replay", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "closed", detail(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "blocked");
    assert.deepEqual(replay.blocked_feature_ids, ["changed-close-intent"]);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted CTO all-nonpassing matrices require close before replay", async () => {
  const root = makeProject();
  const featureIds = ["all-nonpassing-a", "all-nonpassing-b"];
  try {
    writeParallelFeatures(root, featureIds);
    const frozen = mapping(await preflight(root, featureIds.map((featureId) => selection(featureId))));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(
      root,
      dispatched.mapping!,
      dispatched.conformance_binding!,
      featureIds,
      null,
      featureIds,
    );
    const active = mountedDetails(await conformanceTool.execute("all-nonpassing-active", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(active.status, "blocked", detail(active));
    assert.equal(active.replayed, false, detail(active));
    assert.deepEqual(active.passing_feature_ids, []);
    assert.deepEqual(active.blocked_feature_ids, featureIds);
    assert.equal(Object.hasOwn(active, "required_next_tools"), false, detail(active));
    const closeDescriptor = active.required_next_tool as Json;
    assert.equal(closeDescriptor.name, "cto_close_specification_execution_wave");
    const closePayload = closeDescriptor.arguments as Json;
    assert.deepEqual((closePayload.completions as Json[]).map((completion) => completion.feature_id), featureIds);
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closed = mountedDetails(await closeTool.execute("all-nonpassing-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.replayed, false, detail(closed));
    assert.equal(closed.outcome, "blocked", detail(closed));
    assert.deepEqual(closed.blocked_feature_ids, featureIds);
    const replay = mountedDetails(await conformanceTool.execute("all-nonpassing-replay", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "blocked", detail(replay));
    assert.equal(replay.replayed, true, detail(replay));
    assert.deepEqual(replay.passing_feature_ids, []);
    assert.deepEqual(replay.blocked_feature_ids, featureIds);
    assert.equal((replay.required_next_tool as Json).name, "cto_close_specification_execution_wave");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("failed mandatory execution-profile gate permits blocked close and replay", async () => {
  const root = makeProject();
  const featureId = "failed-profile-gate";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const gatePath = join(root, ".work-state", "features", featureId, "artifacts", `quality_gate_evidence-${featureId}.json`);
    const gateArtifact = JSON.parse(readFileSync(gatePath, "utf8")) as Json;
    const gateValue = (gateArtifact.gates as Json[])[0]!;
    gateValue.status = "fail";
    gateValue.evidence_refs = [];
    gateValue.findings = [{ code: "EXECUTION_PROFILE_FAILED", subject_id: null, message: "profile gate failed", evidence_refs: [] }];
    const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
    const qualityRef = writeArtifactWithReference(root, artifactsDir, `quality_gate_evidence-${featureId}`, gateArtifact, { schema_status: "met", quality_gate_status: "met" });
    const runtimeId = `runtime_test_evidence-${featureId}`;
    const runtimePath = join(artifactsDir, `${runtimeId}.json`);
    const runtimeBody = JSON.parse(readFileSync(runtimePath, "utf8")) as Json;
    const runtimeEntries = (runtimeBody.entries as Json[]).map((entry) => ({ ...entry, test: { ...(entry.test as Json), evidence_ref: qualityRef } }));
    const runtimeRef = writeArtifactWithReference(root, artifactsDir, runtimeId, { ...runtimeBody, entries: runtimeEntries }, { schema_status: "met", quality_gate_status: "met" });
    const conformanceId = `conformance_evidence-${featureId}`;
    const conformancePath = join(artifactsDir, `${conformanceId}.json`);
    const conformanceBody = JSON.parse(readFileSync(conformancePath, "utf8")) as Json;
    const conformanceEntries = (conformanceBody.entries as Json[]).map((entry) => entry.kind === "executed_test"
      ? { ...entry, test: { ...(entry.test as Json), evidence_ref: runtimeRef } }
      : entry);
    writeArtifactWithReference(root, artifactsDir, conformanceId, { ...conformanceBody, entries: conformanceEntries }, { schema_status: "met", quality_gate_status: "met" });
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const produced = mountedDetails(await conformanceTool.execute("failed-profile-gate-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(produced.status, "blocked", detail(produced));
    assert.equal((produced.features as Json[])[0]!.overall_status, "blocked", detail(produced));
    const completion = prepareCtoCompletionEnvelope(root, featureId, "run-" + featureId + "-1", dispatched.mapping!, String(dispatched.mapping_digest));
    const closeResult = closeCtoSpecificationExecutionWave(root, {
      cto_run_id: RUN_ID,
      wave_id: String((dispatched.mapping!.execution as Json).wave_id),
      mapping_id: String(dispatched.mapping!.mapping_id),
      mapping_digest: String(dispatched.mapping_digest),
      completions: [completion],
    }, {
      runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID),
      sessionId: DEFAULT_TEST_SESSION_ID,
    });
    assert.equal(closeResult.status, "closed", JSON.stringify(closeResult));
    assert.equal(closeResult.outcome, "blocked", JSON.stringify(closeResult));
    const replay = mountedDetails(await conformanceTool.execute("failed-profile-gate-replay", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "blocked", detail(replay));
    assert.equal(replay.replayed, true, detail(replay));
    assert.deepEqual(replay.blocked_feature_ids, [featureId]);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO terminal replay rejects cross-feature handoff and profile matrix bindings", async () => {
  const root = makeProject();
  const featureId = "terminal-replay-binding";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const produced = mountedDetails(await conformanceTool.execute("terminal-binding-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(produced.status, "ready", detail(produced));
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await finalizer.execute("terminal-binding-complete", ((produced.required_next_tools as Json[])[0]!).arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    const closed = mountedDetails(await closeTool.execute("terminal-binding-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.outcome, "pass", detail(closed));

    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const originalStateBody = readFileSync(statePath, "utf8");
    const originalState = JSON.parse(originalStateBody) as Json;
    const workspace = originalState.specification as Json;
    const originalConformanceId = String(workspace.implementation_conformance_ref);
    const matrixPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", originalConformanceId + ".json");
    const originalMatrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Json;
    const cases: Array<{ label: string; mutate: (matrix: Json) => void }> = [
      { label: "feature", mutate: (matrix) => { matrix.feature_id = "foreign-feature"; } },
      { label: "handoff", mutate: (matrix) => { matrix.handoff_id = "foreign-handoff"; } },
      { label: "profile", mutate: (matrix) => { matrix.profile_hash = "f".repeat(64); } },
      { label: "missing-row", mutate: (matrix) => { matrix.entries = (matrix.entries as Json[]).slice(1); } },
      { label: "foreign-row", mutate: (matrix) => { (matrix.entries as Json[])[0]!.subject_id = "foreign-row"; } },
    ];
    for (const testCase of cases) {
      const forged = structuredClone(originalMatrix) as Json;
      testCase.mutate(forged);
      const forgedDigest = implementationConformanceMatrixDigest(forged);
      assert.ok(forgedDigest, testCase.label + " forged matrix must remain hashable");
      const forgedId = "implementation-conformance." + forgedDigest;
      forged.conformance_id = forgedId;
      const forgedPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", forgedId + ".json");
      writeFileSync(forgedPath, JSON.stringify(forged) + String.fromCharCode(10), "utf8");
      const forgedState = structuredClone(originalState) as Json;
      (forgedState.specification as Json).implementation_conformance_ref = forgedId;
      writeFileSync(statePath, JSON.stringify(forgedState) + String.fromCharCode(10), "utf8");
      const replay = mountedDetails(await conformanceTool.execute("terminal-binding-" + testCase.label, payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
      assert.equal(replay.replayed, false, testCase.label + " forged terminal image must not replay: " + detail(replay));
      assert.equal(replay.status, "blocked", detail(replay));
      assert.equal(replay.persisted, false, detail(replay));
      unlinkSync(forgedPath);
      writeFileSync(statePath, originalStateBody, "utf8");
    }
    const originalHandoffId = String(workspace.handoff_ref);
    const originalHandoffPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", originalHandoffId + ".json");
    const foreignHandoffId = originalHandoffId + "-foreign";
    const foreignHandoffPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff", foreignHandoffId + ".json");
    const duplicateHandoff = JSON.parse(readFileSync(originalHandoffPath, "utf8")) as Json;
    duplicateHandoff.handoff_id = foreignHandoffId;
    writeFileSync(foreignHandoffPath, JSON.stringify(duplicateHandoff) + String.fromCharCode(10), "utf8");
    const foreignHandoffState = structuredClone(originalState) as Json;
    (foreignHandoffState.specification as Json).handoff_ref = foreignHandoffId;
    writeFileSync(statePath, JSON.stringify(foreignHandoffState) + String.fromCharCode(10), "utf8");
    const duplicateHandoffReplay = mountedDetails(await conformanceTool.execute("terminal-binding-duplicate-handoff-id", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(duplicateHandoffReplay.status, "blocked", detail(duplicateHandoffReplay));
    assert.equal(duplicateHandoffReplay.replayed, false, detail(duplicateHandoffReplay));
    writeFileSync(statePath, originalStateBody, "utf8");
    unlinkSync(foreignHandoffPath);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto close revalidates pass matrix evidence after finalization", async () => {
  const root = makeProject();
  const featureId = "pass-evidence-tamper";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const initialConfirmation = await confirmTrusted(root, frozen);
    assert.equal(initialConfirmation.status, "confirmed", detail(initialConfirmation));
    const dispatched = await dispatchCtoSpecificationMapping(root, { cto_run_id: RUN_ID, mapping_id: String(frozen.mapping_id), expected_mapping_hash: String(frozen.mapping_hash) }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const produced = mountedDetails(await conformanceTool.execute("pass-evidence-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(produced.status, "ready", detail(produced));
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await finalizer.execute("pass-evidence-complete", ((produced.required_next_tools as Json[])[0]!).arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    const completion = (closePayload.completions as Json[])[0]!;
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const originalStateBody = readFileSync(statePath, "utf8");
    const originalMatrixId = String(completion.conformance_id);
    const matrixPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", originalMatrixId + ".json");
    const originalMatrixBody = readFileSync(matrixPath, "utf8");
    const rewrittenMatrix = JSON.parse(originalMatrixBody) as Json;
    rewrittenMatrix.forged_marker = "post-finalizer-rewrite";
    writeFileSync(matrixPath, JSON.stringify(rewrittenMatrix) + String.fromCharCode(10), "utf8");
    const rewritten = mountedDetails(await closeTool.execute("pass-evidence-rewrite", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(rewritten.status, "blocked", detail(rewritten));
    assert.equal(rewritten.closed, false);
    writeFileSync(matrixPath, originalMatrixBody, "utf8");

    const originalMatrix = JSON.parse(originalMatrixBody) as Json;
    const firstEntry = (originalMatrix.entries as Json[])[0]!;
    const firstTest = (firstEntry.test_evidence as Json[])[0]!;
    const nestedReference = firstTest.evidence_ref as Json;
    const nestedId = String(nestedReference.artifact_id);
    const nestedPath = join(root, String(nestedReference.path));
    const originalNestedBody = readFileSync(nestedPath, "utf8");
    const wrongNestedBody = JSON.stringify({
      schema_version: 1,
      artifact_id: nestedId,
      gates: [{ gate_id: "wrong-schema", source: "execution_profile", status: "pass", evidence_refs: [], findings: [], evaluated_at: new Date().toISOString() }],
    }) + String.fromCharCode(10);
    writeFileSync(nestedPath, wrongNestedBody, "utf8");
    const wrongMatrix = structuredClone(originalMatrix) as Json;
    for (const entry of wrongMatrix.entries as Json[]) {
      for (const test of entry.test_evidence as Json[]) {
        const reference = test.evidence_ref as Json;
        if (reference.artifact_id === nestedId) reference.sha256 = sha256Hex(wrongNestedBody);
      }
    }
    const wrongDigest = implementationConformanceMatrixDigest(wrongMatrix);
    assert.ok(wrongDigest);
    const wrongId = "implementation-conformance." + wrongDigest;
    wrongMatrix.conformance_id = wrongId;
    const wrongMatrixPath = join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", wrongId + ".json");
    writeFileSync(wrongMatrixPath, JSON.stringify(wrongMatrix) + String.fromCharCode(10), "utf8");
    const wrongState = JSON.parse(originalStateBody) as Json;
    (wrongState.specification as Json).implementation_conformance_ref = wrongId;
    writeFileSync(statePath, JSON.stringify(wrongState) + String.fromCharCode(10), "utf8");
    const wrongClosePayload = structuredClone(closePayload) as Json;
    ((wrongClosePayload.completions as Json[])[0]!).conformance_id = wrongId;
    const wrongSchema = mountedDetails(await closeTool.execute("pass-evidence-wrong-schema", wrongClosePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(wrongSchema.status, "blocked", detail(wrongSchema));
    assert.equal(wrongSchema.closed, false);
    unlinkSync(wrongMatrixPath);
    writeFileSync(statePath, originalStateBody, "utf8");
    writeFileSync(nestedPath, originalNestedBody, "utf8");
    const closed = mountedDetails(await closeTool.execute("pass-evidence-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.outcome, "pass", detail(closed));
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("CTO conformance rejects missing worker evidence before persisting a non-passing matrix", async () => {
  const root = makeProject();
  const featureId = "close-no-evidence";
  try {
    writeParallelFeatures(root, [featureId]);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId], null, null, featureId);
    const beforeState = readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8");
    const conformance = mountedDetails(await conformanceTool.execute("close-no-evidence-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(conformance.status, "blocked", detail(conformance));
    assert.equal(conformance.persisted, false, detail(conformance));
    assert.equal(conformance.next_action, "repair_conformance_evidence", detail(conformance));
    assert.equal(Object.hasOwn(conformance, "required_next_tools"), false, detail(conformance));
    assert.equal(Object.hasOwn(conformance, "required_next_tool"), false, detail(conformance));
    assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeState);
    assert.equal(existsSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance")), false);
    assert.equal(readCtoState(RUN_ID, root)?.active_wave_id, String(dispatched.mapping?.execution?.wave_id));
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto_close_specification_execution_wave blocks when a terminal matrix is missing", async () => {
  const root = makeProject();
  const featureId = "close-missing-matrix";
  try {
    writeParallelFeatures(root, [featureId]);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const payload = mountedConformancePayload(root, dispatched.mapping!, dispatched.conformance_binding!, [featureId]);
    const produced = mountedDetails(await conformanceTool.execute("missing-matrix-conformance", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(produced.status, "ready", detail(produced));
    const finalizers = produced.required_next_tools as Json[];
    const completionTool = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await completionTool.execute("missing-matrix-complete", finalizers[0]!.arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    const completion = (closePayload.completions as Json[])[0]!;
    unlinkSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_conformance", `${String(completion.conformance_id)}.json`));
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const blocked = mountedDetails(await closeTool.execute("missing-matrix-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(blocked.status, "blocked", detail(blocked));
    assert.equal(blocked.closed, false);
    assert.equal(readCtoState(RUN_ID, root)?.active_wave_id, closePayload.wave_id);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted CTO tools reject subagent and non-owner contexts before handlers and resolve session root", async () => {
  const root = makeProject();
  try {
    const subagentTools = publicCtoTools(root);
    const preflight = subagentTools.get("cto_preflight")!;
    const subagent = mountedDetails(await preflight.execute("subagent", mountedToolPayloads().cto_preflight, undefined, undefined, { cwd: "/ignored" }));
    assert.equal(subagent.code, "WORKFLOW_CONTEXT_REJECTED");
    assert.throws(
      () => publicCtoTools(root, { resolveCwd: () => root, owner: () => { throw new Error("foreign owner"); } }),
      /foreign owner/,
    );

    let sessionRoot = "";
    TEST_SESSION_MANAGER.cwd = root;
    const rootTools = publicCtoTools(root, {
      resolveCwd: (ctx) => {
        const value = (ctx as { cwd?: unknown }).cwd;
        const resolved = typeof value === "string" && value.length > 0 ? value : TEST_SESSION_MANAGER.getCwd();
        sessionRoot = resolved;
        return resolved === "." ? root : resolved;
      },
    });
    const unavailable = mountedDetails(await rootTools.get("cto_preflight")!.execute("root", mountedToolPayloads().cto_preflight, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(sessionRoot, root);
    assert.equal(unavailable.status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted cto_prepare is idempotent and blocks a changed payload", async () => {
  const root = makeProject();
  const featureId = "mounted-prepare-feature";
  const runKey = `run-${featureId}-1`;
  try {
    const payload = writeMountedPreparationFixture(root, featureId, runKey, "CTO-MOUNTED-PREPARE-RUN");
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const first = mountedDetails(await tool.execute("prepare-1", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(first.status, "ready", JSON.stringify(first));
    const second = mountedDetails(await tool.execute("prepare-2", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(second.status, "ready", JSON.stringify(second));
    assert.equal(second.wave_id, first.wave_id);
    assert.deepEqual(second.slices, first.slices);
    const changed = JSON.parse(JSON.stringify(payload)) as Json;
    changed.task = "changed preparation";
    const collision = mountedDetails(await tool.execute("prepare-3", changed, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(collision.status, "blocked", JSON.stringify(collision));
    assert.match(JSON.stringify(collision), /different preparation identity|takeover/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted cto_prepare binds a bounded identity task for a long resident request", async () => {
  const root = makeProject();
  const featureId = "mounted-long-anchor";
  const runKey = `run-${featureId}-1`;
  try {
    const payload = writeMountedPreparationFixture(root, featureId, runKey, "CTO-MOUNTED-LONG-ANCHOR");
    const request = `T094 resident CTO request ${"x".repeat(2048)}`;
    payload.task = request;
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const first = mountedDetails(await tool.execute("long-anchor-1", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(first.status, "ready", JSON.stringify(first));

    const featureStatePath = join(root, ".work-state", "features", featureId, "state.json");
    const featureState = JSON.parse(readFileSync(featureStatePath, "utf8")) as Json;
    const preparationHandoff = featureState.preparation_handoff as Json;
    assert.equal(typeof preparationHandoff.task, "string");
    assert.ok(String(preparationHandoff.task).length <= 256);
    assert.doesNotMatch(String(preparationHandoff.task), /[\u0000-\u001f\u007f\r\n]/u);
    assert.notEqual(preparationHandoff.task, request, "feature preparation must not copy the resident CTO request");

    const ctoStatePath = join(root, ".work-state", "cto", String(payload.cto_run_id), "state.json");
    const ctoState = JSON.parse(readFileSync(ctoStatePath, "utf8")) as Json;
    assert.equal(ctoState.task, request, "the full request remains at the canonical CTO layer");
    assert.match(String(ctoState.specification_execution_preparation_digest), /^[a-f0-9]{64}$/u);

    const replay = mountedDetails(await tool.execute("long-anchor-2", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "ready", JSON.stringify(replay));
    assert.deepEqual(replay.slices, first.slices, "anchor migration must replay the same execution identity");

    const changed = mountedDetails(await tool.execute("long-anchor-3", { ...payload, task: `${request} changed` }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(changed.status, "blocked", JSON.stringify(changed));
    assert.match(JSON.stringify(changed), /different preparation identity|takeover/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    projectFeatures.delete(root);
  }
});
test("mounted cto_prepare fails closed when anchor identities exceed the feature task bound", async () => {
  const root = makeProject();
  const featureId = `feature-${"f".repeat(92)}`;
  const runKey = `run-${"r".repeat(95)}`;
  const ctoRunId = `CTO-${"R".repeat(96)}`;
  try {
    const payload = writeMountedPreparationFixture(root, featureId, runKey, ctoRunId);
    const featureStatePath = join(root, ".work-state", "features", featureId, "state.json");
    const before = readFileSync(featureStatePath);
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const result = mountedDetails(await tool.execute("long-identity-1", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(JSON.stringify(result), /identity|bounded|single-line/i);
    assert.deepEqual(readFileSync(featureStatePath), before, "an unrepresentable identity must not migrate the feature state");
  } finally {
    rmSync(root, { recursive: true, force: true });
    projectFeatures.delete(root);
  }
});
test("cto_prepare enforces selector and aggregate bounds before mutation", () => {
  const root = makeProject();
  const tools = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }, false);
  const tool = tools.get("cto_prepare")!;
  const base = structuredClone(mountedToolPayloads().cto_prepare) as Json;
  const parse = (value: Json): boolean => tool.parameters.safeParse(value).success;
  try {
    assert.equal(parse({ ...base, cto_run_id: "a".repeat(MAX_CTO_SPECIFICATION_ID_BYTES) }), true);
    assert.equal(parse({ ...base, cto_run_id: "a".repeat(MAX_CTO_SPECIFICATION_ID_BYTES + 1) }), false);
    assert.equal(parse({ ...base, task: "x".repeat(MAX_CTO_SPECIFICATION_TEXT_BYTES) }), true);
    assert.equal(parse({ ...base, task: "x".repeat(MAX_CTO_SPECIFICATION_TEXT_BYTES + 1) }), false);
    assert.equal(parse({ ...base, task: "safe\u202econtrol" }), false);
    const exactSelections = Array.from({ length: MAX_CTO_SPECIFICATION_REQUESTS }, (_, index) => ({ feature_id: `feature-${index}`, run_key: `run-${index}` }));
    assert.equal(parse({ ...base, selections: exactSelections }), true);
    assert.equal(parse({ ...base, selections: [...exactSelections, { feature_id: "feature-over", run_key: "run-over" }] }), false);
    assert.equal(parse({ ...base, teams: [] }), false);
    assert.equal(parse({ ...base, handoff_id: "forged" }), false);
    assert.equal(parse({ ...base, aggregate_padding: "x" }), false, "unknown aggregate fields must be rejected");
    assert.equal(existsSync(join(root, ".work-state")), false, "rejected input must not create state or artifacts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto_preflight rejects oversized or unsafe direct selectors before state reads", async () => {
  const root = makeProject();
  try {
    const exactSelections = Array.from({ length: MAX_CTO_SPECIFICATION_REQUESTS }, (_, index) => ({
      feature_id: `feature-${index}`,
      run_key: `run-${index}`,
    }));
    const overLimit = await preflightCtoSpecificationExecutionGate(root, {
      cto_run_id: RUN_ID,
      selections: [...exactSelections, { feature_id: "feature-over", run_key: "run-over" }],
    });
    assert.equal(overLimit.status, "blocked", JSON.stringify(overLimit));
    assert.match(overLimit.findings.join("\n"), /at most|64/);
    assert.equal(existsSync(join(root, ".work-state")), false, "over-limit selectors must not read or create state");

    const unsafe = await preflightCtoSpecificationExecutionGate(root, {
      cto_run_id: RUN_ID,
      selections: [{ feature_id: "feature-one", run_key: "../escape" }],
    });
    assert.equal(unsafe.status, "blocked", JSON.stringify(unsafe));
    assert.match(unsafe.findings.join("\n"), /unsafe selector/i);
    assert.equal(existsSync(join(root, ".work-state")), false, "unsafe selectors must not read or create state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted workflow_prepare rejects oversized generic inputs before execution", () => {
  const root = makeProject();
  try {
    const tool = publicWorkflowTool("workflow_prepare", root);
    assert.ok(tool.parameters, "workflow_prepare exposes a mounted schema");
    const parse = (value: Json): boolean => tool.parameters!.safeParse(value).success;
    const base: Json = {
      task: "bounded task",
      branch: "feature/bounded",
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: true },
      files: [],
      issue: null,
      feature_id: "feature-one",
      run_key: "run-feature-one-1",
    };
    assert.equal(parse(base), true);
    assert.equal(parse({ ...base, task: "x".repeat(256) }), true, "legacy 256-byte preparation tasks remain accepted");
    assert.equal(parse({ ...base, task: "x".repeat(257) }), true, "preparation tasks may exceed the old 256-byte handoff bound");
    assert.equal(parse({ ...base, task: "x".repeat(MAX_PREPARATION_HANDOFF_TASK_BYTES) }), true, "the shared maximum preparation task is accepted");
    assert.equal(parse({ ...base, task: "x".repeat(MAX_PREPARATION_HANDOFF_TASK_BYTES + 1) }), false, "preparation tasks over the shared maximum are rejected");
    assert.equal(parse({ ...base, branch: "x".repeat(MAX_ADVANCE_FIELD_BYTES + 1) }), false);
    assert.equal(parse({
      ...base,
      classification: { ...(base.classification as Json), autonomous_reason: "r".repeat(MAX_ADVANCE_FIELD_BYTES) },
    }), true);
    assert.equal(parse({
      ...base,
      classification: { ...(base.classification as Json), autonomous_reason: "r".repeat(MAX_ADVANCE_FIELD_BYTES + 1) },
    }), false);
    assert.equal(parse({
      ...base,
      classification: { ...(base.classification as Json), workflow: "w".repeat(MAX_ADVANCE_FIELD_BYTES + 1) },
    }), false);
    assert.equal(parse({ ...base, files: Array.from({ length: 64 }, () => "file.txt") }), true);
    assert.equal(parse({ ...base, files: Array.from({ length: 65 }, () => "file.txt") }), false);
    assert.equal(parse({ ...base, files: ["a".repeat(1025)] }), false);
    assert.equal(parse({
      ...base,
      continuation: { feedback: "f".repeat(MAX_ADVANCE_EVIDENCE_BYTES), stageId: "stage-one" },
    }), true);
    assert.equal(parse({
      ...base,
      continuation: { feedback: "f".repeat(MAX_ADVANCE_EVIDENCE_BYTES + 1), stageId: "stage-one" },
    }), false);
    assert.equal(parse({
      ...base,
      continuation: { feedback: "feedback", stageId: "s".repeat(MAX_ADVANCE_FIELD_BYTES + 1) },
    }), false);
    assert.equal(parse({ ...base, feature_id: "f".repeat(129) }), false);
    assert.equal(parse({ ...base, run_key: "r".repeat(MAX_ADVANCE_FIELD_BYTES + 1) }), false);
    assert.equal(existsSync(join(root, ".work-state")), false, "schema rejection must not write workflow state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted cto_prepare partitions mixed selectors and preflights only eligible rows", async () => {
  const root = makeProject();
  const featureIds = ["readable-cto-passing", "readable-cto-blocked", "readable-cto-stale", "readable-cto-claimed"] as const;
  const runKeys = {
    "readable-cto-passing": "readable-cto-passing-run-001",
    "readable-cto-blocked": "readable-cto-blocked-run-001",
    "readable-cto-stale": "readable-cto-stale-run-001",
    "readable-cto-claimed": "readable-cto-claimed-run-001",
  } as const;
  try {
    const handoffs = new Map<string, Json>();
    for (const featureId of featureIds) {
      const prepared = writeFeature(root, featureId, runKeys[featureId], { stale: featureId === "readable-cto-stale" });
      handoffs.set(featureId, prepared.handoff);
    }
    for (const featureId of featureIds) rewriteHandoff(root, featureId, (handoff) => {
      (handoff.tasks as Json[])[0]!.affected_scope = [`src/${featureId}.ts`];
      handoff.scope = { ...(handoff.scope as Json), constraints: [] };
    });
    rewriteHandoff(root, "readable-cto-claimed", (handoff) => { handoff.execution_choices = ["cto", "do-work"]; });
    const claimedState = JSON.parse(readFileSync(join(root, ".work-state", "features", "readable-cto-claimed", "state.json"), "utf8")) as Json;
    const claimedWorkspace = claimedState.specification as Json;
    const claimedHandoff = JSON.parse(readFileSync(join(root, ".work-state", "features", "readable-cto-claimed", "artifacts", "implementation_handoff", `${String(claimedWorkspace.handoff_ref)}.json`), "utf8")) as Json;
    const claimed = acquireExecutionClaim(root, "readable-cto-claimed", {
      handoff: claimedHandoff as never,
      run_key: runKeys["readable-cto-claimed"],
      owner_kind: "do_work",
      owner_run_id: "existing-do-work-run",
    });
    assert.equal(claimed.ok, true, claimed.ok ? "" : claimed.error);

    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(featureIds.map((featureId) => ({
      id: `team-${featureId}`,
      name: featureId,
      scope: [`src/${featureId}.ts`],
      profile: "standard",
      lead: "developer",
      roster: ["developer"],
    }))), "utf8");
    const payload = {
      cto_run_id: "mixed-registered-prepare-run",
      task: "prepare mixed registered selectors",
      branch: "main",
      selections: featureIds.map((featureId) => ({ feature_id: featureId, run_key: runKeys[featureId] })),
    };
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const result = mountedDetails(await tool.execute("mixed-prepare", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.deepEqual(result.requested_selections, payload.selections);
    assert.deepEqual(result.eligible_selections, [
      { feature_id: "readable-cto-passing", run_key: runKeys["readable-cto-passing"] },
      { feature_id: "readable-cto-blocked", run_key: runKeys["readable-cto-blocked"] },
    ]);
    assert.deepEqual((result.excluded as Json[]).map((entry) => entry.feature_id), ["readable-cto-stale", "readable-cto-claimed"]);
    assert.match(JSON.stringify(result.excluded), /not ready|stale|active execution claim|execution claim/u);
    const next = result.required_next_tool as Json;
    assert.equal(next.name, "cto_preflight");
    assert.deepEqual((next.arguments as Json).selections, result.eligible_selections);
    const preflightTool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_preflight")!;
    const exactPreflight = mountedDetails(await preflightTool.execute("eligible-preflight", next.arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(exactPreflight.status, "ready", JSON.stringify(exactPreflight));
    assert.deepEqual((exactPreflight.mapping as Json).feature_ids, ["readable-cto-passing", "readable-cto-blocked"]);
    const wrongAll = mountedDetails(await preflightTool.execute("wrong-all-four", {
      cto_run_id: payload.cto_run_id,
      selections: payload.selections,
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(wrongAll.status, "blocked", JSON.stringify(wrongAll));
    assert.deepEqual((wrongAll.required_next_tool as Json).name, "cto_preflight");
    assert.deepEqual(((wrongAll.required_next_tool as Json).arguments as Json).selections, result.eligible_selections);
    assert.deepEqual((wrongAll.excluded as Json[]).map((entry) => entry.feature_id), ["readable-cto-stale", "readable-cto-claimed"]);
    assert.doesNotMatch(JSON.stringify(wrongAll), /checkpoint_ask|authorization Ask/i);
    const recovered = mountedDetails(await preflightTool.execute("eligible-preflight-replay", (wrongAll.required_next_tool as Json).arguments, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(recovered.status, "ready", JSON.stringify(recovered));
    assert.deepEqual((recovered.mapping as Json).feature_ids, ["readable-cto-passing", "readable-cto-blocked"]);
    const persisted = readCtoState("mixed-registered-prepare-run", root);
    assert.ok(persisted);
    assert.deepEqual(persisted?.specification_execution_requested_selections, payload.selections);
    assert.deepEqual(persisted?.specification_execution_exclusions, result.excluded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto_prepare preserves canonical team identities through four-way mixed dispatch and conformance close", async () => {
  const root = makeProject();
  const featureIds = ["identity-pass", "identity-blocked", "identity-stale", "identity-claimed"] as const;
  const eligibleFeatureIds = ["identity-pass", "identity-blocked"] as const;
  const runKeys = {
    "identity-pass": "run-identity-pass-1",
    "identity-blocked": "run-identity-blocked-1",
    "identity-stale": "run-identity-stale-1",
    "identity-claimed": "run-identity-claimed-1",
  } as const;
  try {
    for (const featureId of featureIds) writeFeature(root, featureId, runKeys[featureId], { stale: featureId === "identity-stale" });
    for (const featureId of eligibleFeatureIds) rewriteHandoff(root, featureId, (handoff) => {
      (handoff.tasks as Json[])[0]!.parallel_safe = true;
      (handoff.tasks as Json[])[0]!.affected_scope = [`src/${featureId}.ts`];
      handoff.scope = { ...(handoff.scope as Json), constraints: [] };
    });
    rewriteHandoff(root, "identity-claimed", (handoff) => { handoff.execution_choices = ["cto", "do-work"]; });
    const claimedState = JSON.parse(readFileSync(join(root, ".work-state", "features", "identity-claimed", "state.json"), "utf8")) as Json;
    const claimedWorkspace = claimedState.specification as Json;
    const claimedHandoff = JSON.parse(readFileSync(join(root, ".work-state", "features", "identity-claimed", "artifacts", "implementation_handoff", `${String(claimedWorkspace.handoff_ref)}.json`), "utf8")) as Json;
    const claimed = acquireExecutionClaim(root, "identity-claimed", {
      handoff: claimedHandoff as never,
      run_key: runKeys["identity-claimed"],
      owner_kind: "do_work",
      owner_run_id: "existing-do-work-run",
    });
    assert.equal(claimed.ok, true, claimed.ok ? "" : claimed.error);
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(featureIds.map((featureId) => ({
      id: `team-${featureId}`,
      name: featureId,
      scope: [`src/${featureId}.ts`],
      profile: "standard",
      lead: "developer",
      roster: ["developer"],
    }))), "utf8");
    const prepareTool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const prepared = mountedDetails(await prepareTool.execute("identity-prepare", {
      cto_run_id: RUN_ID,
      task: "preserve mixed canonical execution identities",
      branch: "main",
      wave_id: "WAVE-IDENTITY-EXECUTION-1",
      source_id: "SOURCE-IDENTITY-EXECUTION-1",
      selections: featureIds.map((featureId) => ({ feature_id: featureId, run_key: runKeys[featureId] })),
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(prepared.status, "ready", detail(prepared));
    assert.deepEqual((prepared.eligible_selections as Json[]).map((entry) => entry.feature_id), eligibleFeatureIds);
    const preflightTool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_preflight")!;
    const preflightArgs = (prepared.required_next_tool as Json).arguments as Json;
    const preflightResult = mountedDetails(await preflightTool.execute("identity-preflight", preflightArgs, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(preflightResult.status, "ready", detail(preflightResult));
    const frozen = preflightResult.mapping as Json;
    const mappingOwners = frozen.task_to_slice as Json[];
    const preparedState = readCtoState(RUN_ID, root);
    assert.ok(preparedState);
    for (const featureId of eligibleFeatureIds) {
      const owner = mappingOwners.find((candidate) => candidate.feature_id === featureId);
      const team = preparedState?.teams.find((candidate) => candidate.feature_id === featureId);
      assert.ok(owner, `mapping owner for ${featureId} must exist`);
      assert.ok(team, `prepared team for ${featureId} must exist`);
      assert.equal(team?.id, owner?.team_id, `${featureId} team id must be stable from prepare through mapping`);
      assert.equal(team?.slice_id, owner?.slice_id, `${featureId} slice id must be stable from prepare through mapping`);
      assert.equal(team?.task_id, owner?.task_id, `${featureId} task id must be stable from prepare through mapping`);
    }

    const askArgs = (preflightResult.required_next_tool as Json).arguments as Json;
    const derived = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: String(askArgs.cto_run_id),
      mapping_id: String(askArgs.mapping_id),
      mapping_hash: String(askArgs.mapping_hash),
    });
    assert.equal(derived.status, "ready", JSON.stringify(derived));
    const askMappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", String(askArgs.mapping_id) + ".json");
    const askMappingBeforeWaveTamper = readFileSync(askMappingPath, "utf8");
    const anchorStatePath = join(root, ".work-state", "features", "identity-pass", "state.json");
    const anchorStateBeforeWaveTamper = readFileSync(anchorStatePath, "utf8");
    const ctoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const ctoStateBeforeWaveTamper = readFileSync(ctoStatePath, "utf8");
    const forgedWaveState = JSON.parse(ctoStateBeforeWaveTamper) as Json;
    const forgedWave = (forgedWaveState.wave_history as Json[]).find((candidate) => candidate.id === forgedWaveState.active_wave_id);
    assert.ok(forgedWave);
    forgedWave.source_id = String(forgedWave.source_id) + "-forged";
    writeFileSync(ctoStatePath, JSON.stringify(forgedWaveState) + String.fromCharCode(10), "utf8");
    const prepareMappingAsk = (input: unknown) => prepareCtoSpecificationMappingAsk(root, input as never, preparationRuntimeOptions(root));
    const forgedAsk = prepareMappingAsk({ ...askArgs, feature_id: "identity-pass", run_key: runKeys["identity-pass"], stage_id: String(askArgs.stage_id) } as never);
    assert.equal(forgedAsk.status, "blocked", JSON.stringify(forgedAsk));
    assert.equal(readFileSync(askMappingPath, "utf8"), askMappingBeforeWaveTamper, "forged wave Ask must not persist mapping proof");
    assert.equal(readFileSync(anchorStatePath, "utf8"), anchorStateBeforeWaveTamper, "forged wave Ask must not mutate trusted-answer state");
    writeFileSync(ctoStatePath, ctoStateBeforeWaveTamper, "utf8");

    const nonAnchorAsk = {
      ...derived,
      feature_id: "identity-blocked",
      run_key: runKeys["identity-blocked"],
    };
    const nonAnchorPrepared = prepareMappingAsk(nonAnchorAsk as never);
    assert.equal(nonAnchorPrepared.status, "blocked", JSON.stringify(nonAnchorPrepared));
    assert.match(JSON.stringify(nonAnchorPrepared), /first exact frozen selection/u);
    const nonAnchorMappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", String(askArgs.mapping_id) + ".json");
    const mappingBeforeNonAnchorAsk = readFileSync(nonAnchorMappingPath, "utf8");
    const recordMappingAsk = (input: unknown) => recordCtoSpecificationMappingAsk(root, input as never, { ...preparationRuntimeOptions(root), trusted_host: { bridge: {}, question: "", options: [], session_id: DEFAULT_TEST_SESSION_ID } });
    const nonAnchorAnswered = recordMappingAsk({ ...nonAnchorAsk, decision: "approve_continue" } as never);
    assert.equal(nonAnchorAnswered.status, "blocked", JSON.stringify(nonAnchorAnswered));
    assert.match(JSON.stringify(nonAnchorAnswered), /first exact frozen selection/u);
    assert.equal(readFileSync(nonAnchorMappingPath, "utf8"), mappingBeforeNonAnchorAsk, "non-anchor Ask must not persist pending proof or mutate mapping");
    const malformedSelector = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: String(askArgs.cto_run_id),
      mapping_id: "not-safe",
      mapping_hash: String(askArgs.mapping_hash),
    });
    assert.equal(malformedSelector.status, "blocked", JSON.stringify(malformedSelector));
    const malformedRun = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: "not-safe",
      mapping_id: String(askArgs.mapping_id),
      mapping_hash: String(askArgs.mapping_hash),
    });
    assert.equal(malformedRun.status, "blocked", JSON.stringify(malformedRun));
    const malformedHash = prepareMappingAsk({
      ...askArgs,
      mapping_hash: "not-a-sha256",
    } as never);
    assert.equal(malformedHash.status, "blocked", JSON.stringify(malformedHash));
    const multilineRun = prepareMappingAsk({
      ...askArgs,
      run_key: `${String(askArgs.run_key)}\nforged`,
    } as never);
    assert.equal(multilineRun.status, "blocked", JSON.stringify(multilineRun));
    const multilineStage = prepareMappingAsk({
      ...askArgs,
      stage_id: `${String(askArgs.stage_id)}\nforged`,
    } as never);
    assert.equal(multilineStage.status, "blocked", JSON.stringify(multilineStage));
    const staleHash = prepareMappingAsk({
      ...askArgs,
      mapping_hash: "0".repeat(64),
    } as never);
    assert.equal(staleHash.status, "blocked", JSON.stringify(staleHash));

    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const mappingBeforeMutation = readFileSync(mappingPath, "utf8");
    const mutatedRecord = JSON.parse(mappingBeforeMutation) as Json;
    (mutatedRecord.mapping as Json).mapping_hash = "0".repeat(64);
    writeFileSync(mappingPath, `${JSON.stringify(mutatedRecord)}\n`, "utf8");
    const mutatedMapping = prepareMappingAsk(askArgs as never);
    assert.equal(mutatedMapping.status, "blocked", JSON.stringify(mutatedMapping));
    writeFileSync(mappingPath, mappingBeforeMutation, "utf8");

    const answered = await mountedCtoHostAsk(root, askArgs, "approve_continue");
    assert.equal(answered.status, "answered", JSON.stringify(answered));
    const replayAnswered = await mountedCtoHostAsk(root, askArgs, "approve_continue");
    assert.equal(replayAnswered.status, "answered", JSON.stringify(replayAnswered));
    assert.equal(replayAnswered.trusted_answer_ref, answered.trusted_answer_ref, "exact mapping Ask replay must reuse the original proof");
    assert.deepEqual(replayAnswered.trusted_proof, answered.trusted_proof, "exact mapping Ask replay must reuse the original proof");
    const confirmed = await confirmCtoSpecificationMappingForTest(root, {
      cto_run_id: answered.cto_run_id,
      mapping_id: answered.mapping_id,
      mapping_hash: answered.mapping_hash,
      answer_id: answered.trusted_answer_ref,
    });
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    let dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    if (!dispatched.conformance_binding) {
      completeMountedCtoExecutionTeams(root);
      dispatched = await dispatchCtoSpecificationMapping(root, {
        cto_run_id: RUN_ID,
        mapping_id: String(frozen.mapping_id),
        expected_mapping_hash: String(frozen.mapping_hash),
      }, preparationRuntimeOptions(root)) as unknown as Result;
      assert.equal(dispatched.status, "dispatched", detail(dispatched));
    }
    assert.ok(dispatched.conformance_binding, detail(dispatched));
    const dispatchedState = readCtoState(RUN_ID, root);
    assert.ok(dispatchedState);
    for (const featureId of eligibleFeatureIds) {
      const owner = mappingOwners.find((candidate) => candidate.feature_id === featureId)!;
      const team = dispatchedState?.teams.find((candidate) => candidate.feature_id === featureId)!;
      const claimRead = readCurrentExecutionClaim(root, featureId);
      const expectedHandoffDigest = (frozen.handoff_bindings as Json[]).find((binding) => binding.feature_id === featureId)?.handoff_digest;
      const dispatchedClaim = (dispatched.claims as Json[] | undefined)?.find((candidate) => candidate.handoff_digest === expectedHandoffDigest);
      assert.equal(team.id, owner.team_id);
      assert.equal(team.slice_id, owner.slice_id);
      assert.equal(team.task_id, owner.task_id);
      assert.equal(claimRead.ok, true, `${featureId} claim must be readable`);
      assert.ok(dispatchedClaim, `${featureId} dispatch claims: ${JSON.stringify({ expected: expectedHandoffDigest, claims: dispatched.claims })}`);
      assert.equal(dispatchedClaim?.owner_run_id, RUN_ID);
      assert.equal(dispatchedClaim?.handoff_digest, expectedHandoffDigest);
      assert.equal(team.work_identity?.run_id, RUN_ID);
      assert.equal(team.work_identity?.wave_id, (frozen.execution as Json).wave_id);
      assert.equal(team.work_identity?.slice_id, owner.slice_id);
    }

    const conformanceTool = publicCtoTools(root).get("cto_specification_conformance")!;
    const conformancePayload = mountedConformanceFixture(root, dispatched.mapping as Json, dispatched.conformance_binding!, eligibleFeatureIds, null, "identity-blocked");
    const conformanceSelectors = {
      cto_run_id: RUN_ID,
      mapping_id: String((dispatched.mapping as Json).mapping_id),
      mapping_hash: String((dispatched.mapping as Json).mapping_hash),
      wave_id: String(((dispatched.mapping as Json).execution as Json).wave_id),
    };
    const conformance = persistCtoSpecificationConformance({
      ...conformancePayload,
      project_root: root,
    } as never, {
      runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID),
      sessionId: DEFAULT_TEST_SESSION_ID,
    }) as unknown as Result;
    assert.equal(conformance.status, "blocked", detail(conformance));
    assert.deepEqual(conformance.passing_feature_ids, ["identity-pass"], detail(conformance));
    assert.deepEqual(conformance.blocked_feature_ids, ["identity-blocked"], detail(conformance));
    for (const featureId of eligibleFeatureIds) {
      const owner = mappingOwners.find((candidate) => candidate.feature_id === featureId)!;
      const outcome = (conformance.features as Json[]).find((candidate) => candidate.feature_id === featureId)!;
      assert.match(String(outcome.conformance_id), /^implementation-conformance\.[a-f0-9]{64}$/u);
      assert.equal(typeof outcome.artifact_ref, "object");
      assert.match(String((outcome.artifact_ref as Json).path), new RegExp(`features/${featureId}/artifacts/implementation_conformance/`));
      assert.equal(owner.team_id, dispatchedState?.teams.find((candidate) => candidate.feature_id === featureId)?.id);
    }
    assert.equal(readCurrentExecutionClaim(root, "identity-blocked").value?.status, "active", "blocked claim must remain retained after direct persistence");
    const conformanceReplay = mountedDetails(await conformanceTool.execute("identity-conformance", conformanceSelectors, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(conformanceReplay.replayed, false, detail(conformanceReplay));
    assert.deepEqual(conformanceReplay.features, conformance.features);
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    const completed = mountedDetails(await finalizer.execute("identity-complete-pass", producedCompletionEnvelope(root, dispatched.mapping as Json, String(dispatched.mapping_digest), "identity-pass"), undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(completed.ok, true, detail(completed));
    const completedState = resolveState(root, undefined, { feature_id: "identity-pass", run_key: runKeys["identity-pass"] });
    assert.equal(completedState.state?.specification?.status, "completed");
    assert.equal(
      completedState.state?.specification?.implementation_conformance_ref,
      (conformance.features as Json[]).find((feature) => feature.feature_id === "identity-pass")?.conformance_id,
    );
    const completedClaimHistory = readExecutionClaimStore(root, "identity-pass");
    assert.equal(completedClaimHistory.ok, true, completedClaimHistory.ok ? "" : completedClaimHistory.error);
    if (completedClaimHistory.ok) assert.equal(completedClaimHistory.value.at(-1)?.status, "completed");
    const closeTool = publicCtoTools(root).get("cto_close_specification_execution_wave")!;
    const closePayload = (completed.required_next_tool as Json).arguments as Json;
    const closed = mountedDetails(await closeTool.execute("identity-close", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closed.status, "closed", detail(closed));
    assert.equal(closed.outcome, "blocked");
    assert.equal(readCurrentExecutionClaim(root, "identity-blocked").value?.status, "active", "blocked claim remains retained after pass finalization and blocked wave close");
    const replay = mountedDetails(await conformanceTool.execute("identity-conformance-replay", conformanceSelectors, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(replay.status, "blocked", detail(replay));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.features, conformance.features);
    const closeReplay = mountedDetails(await closeTool.execute("identity-close-replay", closePayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(closeReplay.status, "closed", detail(closeReplay));
    assert.equal(closeReplay.replayed, true);
    assert.equal(closeReplay.outcome, "blocked");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted cto_prepare blocks all-ineligible selectors without creating a wave", async () => {
  const root = makeProject();
  const staleFeature = "all-ineligible-stale";
  const claimedFeature = "all-ineligible-claimed";
  const staleRunKey = "all-ineligible-stale-run-001";
  const claimedRunKey = "all-ineligible-claimed-run-001";
  try {
    writeFeature(root, staleFeature, staleRunKey, { stale: true });
    const claimed = writeFeature(root, claimedFeature, claimedRunKey);
    rewriteHandoff(root, claimedFeature, (handoff) => { handoff.execution_choices = ["cto", "do-work"]; });
    const claimedState = JSON.parse(readFileSync(join(root, ".work-state", "features", claimedFeature, "state.json"), "utf8")) as Json;
    const claimedWorkspace = claimedState.specification as Json;
    const claimedHandoff = JSON.parse(readFileSync(join(root, ".work-state", "features", claimedFeature, "artifacts", "implementation_handoff", `${String(claimedWorkspace.handoff_ref)}.json`), "utf8")) as Json;
    const acquired = acquireExecutionClaim(root, claimedFeature, {
      handoff: claimedHandoff as never,
      run_key: claimedRunKey,
      owner_kind: "do_work",
      owner_run_id: "existing-do-work-run",
    });
    assert.equal(acquired.ok, true, acquired.ok ? "" : acquired.error);
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify([
      { id: "team-stale", name: "stale", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] },
      { id: "team-claimed", name: "claimed", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] },
    ]), "utf8");
    const payload = {
      cto_run_id: "all-ineligible-prepare-run",
      task: "prepare all ineligible selectors",
      branch: "main",
      selections: [
        { feature_id: staleFeature, run_key: staleRunKey },
        { feature_id: claimedFeature, run_key: claimedRunKey },
      ],
    };
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_prepare")!;
    const result = mountedDetails(await tool.execute("all-ineligible", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.deepEqual(result.requested_selections, payload.selections);
    assert.deepEqual(result.eligible_selections, []);
    assert.equal((result.excluded as Json[]).length, 2);
    assert.match(JSON.stringify(result.findings), /stale|active execution claim|not ready|execution claim/u);
    assert.equal(readCtoState("all-ineligible-prepare-run", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted cto_confirm resolves the exact answer from the durable ledger", async () => {
  const root = makeProject();
  const featureId = "mounted-confirm-feature";
  const runKey = `run-${featureId}-1`;
  try {
    writeFeature(root, featureId, runKey);
    const frozen = mapping(await preflight(root, [selection(featureId, runKey)]));
    const context = executionContexts.get(root)!;
    alignCtoExecutionCapability(root, context);
    const askTool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_checkpoint_ask_selected")!;
    const asked = mountedDetails(await askTool.execute("fixture-host-ask", {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      mapping_version: frozen.mapping_version,
      feature_id: context.feature_id,
      run_key: context.run_key,
      stage_id: "execution",
    }, undefined, undefined, {
      cwd: root,
      sessionManager: TEST_SESSION_MANAGER,
      hasUI: true,
      ui: {
        askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
          const question = questions[0];
          if (!question) return undefined;
          return { kind: "submit" as const, results: [{ id: question.id, question: question.question, header: question.header, options: question.options.map((option) => option.label), multi: false, selectedOptions: [CONFIRMATION_DECISION] }] };
        },
      },
    }));
    assert.equal(asked.status, "answered", JSON.stringify(asked));
    assert.equal(typeof asked.trusted_answer_ref, "string");
    const tool = publicCtoTools(root, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd }).get("cto_confirm")!;
    const validInput = {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      answer_id: asked.trusted_answer_ref,
    };
    const missingContext = mountedDetails(await tool.execute("missing-context", { ...validInput, answer_id: "missing-answer" }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(missingContext.status, "blocked", JSON.stringify(missingContext));
    assert.equal((missingContext.required_next_tool as Json).name, "cto_checkpoint_ask_selected");
    assert.deepEqual((missingContext.required_next_tool as Json).arguments, {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      mapping_version: frozen.mapping_version,
      feature_id: featureId,
      run_key: runKey,
      stage_id: "execution",
    });
    const result = mountedDetails(await tool.execute("confirm", validInput, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(result.status, "confirmed", JSON.stringify(result));
    assert.equal((result.required_next_tool as Json).name, "cto_dispatch");
    assert.deepEqual((result.required_next_tool as Json).arguments, {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      expected_mapping_hash: frozen.mapping_hash,
    });
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function bindFixtureConstitution(root: string, featureId: string, runKey: string, binding: Json | null | undefined): void {
  if (!binding) return;
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
  assert.ok(selected.state && selected.statePath, "fixture state must be available for constitution binding");
  if (!selected.state || !selected.statePath) return;
  writeState(root, { ...selected.state, specification: { ...selected.state.specification, constitution_binding: binding } }, { target: selected });
  rewriteHandoff(root, featureId, (handoff) => { handoff.constitution_binding = binding; });
}

function enableDoWorkExecution(root: string, featureId: string): void {
  rewriteHandoff(root, featureId, (handoff) => {
    handoff.execution_choices = ["cto", "do-work"];
  });
}

function spawnPublicWorkflowBegin(root: string, featureId: string, runKey: string): Promise<Result> {
  const fixtureUrl = new URL("./fixtures/registrar-host.ts", import.meta.url).href;
  const registryHelperUrl = new URL("./fixtures/registry-activation.ts", import.meta.url).href;
  const script = `import { z as zod } from "zod";
import { TEST_CONTEXT, TEST_ON } from ${JSON.stringify(fixtureUrl)};
import { registerTestWorkflowTools } from ${JSON.stringify(registryHelperUrl)};
const tools = [];
const pi = { zod: { z: zod }, on: TEST_ON, registerTool(tool) { tools.push(tool); } };
registerTestWorkflowTools(process.env.BEGIN_ROOT!, pi, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd });
const begin = tools.find((tool) => tool.name === "workflow_begin");
const result = await begin.execute("child", { feature_id: process.env.BEGIN_FEATURE, run_key: process.env.BEGIN_RUN_KEY }, undefined, undefined, TEST_CONTEXT(process.env.BEGIN_ROOT!) );
process.stdout.write(JSON.stringify(result.details));`;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, BEGIN_ROOT: root, BEGIN_FEATURE: featureId, BEGIN_RUN_KEY: runKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectChild(new Error(stderr || `workflow_begin child exited with ${code}`));
        return;
      }
      try { resolveChild(JSON.parse(stdout) as Result); }
      catch (error) { rejectChild(new Error(`workflow_begin child returned invalid JSON: ${String(error)}\n${stderr}`)); }
    });
  });
}

function spawnCrashAfterMappingWrite(
  root: string,
  mode: "preflight" | "resume",
  input: Json,
  mutateConstitution = false,
): Promise<number> {
  const moduleUrl = new URL("../src/commands/cto.ts", import.meta.url).href;
  const runtimeFixtureUrl = new URL("./fixtures/registry-activation.ts", import.meta.url).href;
  const script = `import { writeFileSync } from "node:fs";
import { openTestCtoRuntime } from ${JSON.stringify(runtimeFixtureUrl)};
import { preflightCtoSpecificationExecution, resumeCtoSpecificationMapping, setCtoSpecificationMappingFailureInjector } from ${JSON.stringify(moduleUrl)};
const root = process.env.MAPPING_CRASH_ROOT;
const mode = process.env.MAPPING_CRASH_MODE;
setCtoSpecificationMappingFailureInjector((point, transactionId) => {
  if (point === "after_mapping_write" && transactionId.startsWith(mode + "-")) {
    if (process.env.MAPPING_CRASH_DRIFT === "1") {
      writeFileSync(root + "/CONSTITUTION.md", "# Project Constitution v2\\n\\nVersion: 2.0.0\\n\\n## I. Quality\\n\\nChanged policy.\\n", "utf8");
    }
    process.exit(73);
  }
}, root);
const input = JSON.parse(process.env.MAPPING_CRASH_INPUT);
const sessionId = process.env.MAPPING_CRASH_SESSION;
const runtime = openTestCtoRuntime(root, sessionId, process.env.MAPPING_CRASH_OWNER_ID);
try {
  const result = mode === "preflight"
    ? await preflightCtoSpecificationExecution(root, input, { runtimeAccess: runtime.access, sessionId })
    : resumeCtoSpecificationMapping(root, input, { runtimeAccess: runtime.access, sessionId });
  process.stdout.write(JSON.stringify(result));
  process.stdout.end(() => process.exit(0));
} finally { runtime.close(); }`;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAPPING_CRASH_ROOT: root,
        MAPPING_CRASH_MODE: mode,
        MAPPING_CRASH_INPUT: JSON.stringify(input),
        MAPPING_CRASH_DRIFT: mutateConstitution ? "1" : "0",
        MAPPING_CRASH_SESSION: DEFAULT_TEST_SESSION_ID,
        MAPPING_CRASH_OWNER_ID: `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (code) => {
      if (code === null) {
        rejectChild(new Error(`mapping crash child closed without an exit code: ${stderr}`));
        return;
      }
      if (code !== 73) {
        rejectChild(new Error(`mapping crash child exited with ${code}: ${stderr}`));
        return;
      }
      resolveChild(code);
    });
  });
}

function parseLeadingJsonResult(stdout: string): Result {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < stdout.length; index += 1) {
    const character = stdout[index]!;
    if (start < 0) {
      if (/\s/u.test(character)) continue;
      if (character !== "{") throw new Error("dispatch child output does not begin with a JSON object");
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(stdout.slice(start, index + 1)) as Result;
    }
  }
  throw new Error("dispatch child output ended before its JSON object closed");
}

function spawnCtoDispatch(
  root: string,
  ctoRunId: string,
  mappingId: string,
  mappingHash: string,
): Promise<Result> {
  const moduleUrl = new URL("../src/commands/cto.ts", import.meta.url).href;
  const runtimeFixtureUrl = new URL("./fixtures/registry-activation.ts", import.meta.url).href;
  const script = `import { dispatchCtoSpecificationMapping } from ${JSON.stringify(moduleUrl)};
import { openTestCtoRuntime } from ${JSON.stringify(runtimeFixtureUrl)};
const root = process.env.DISPATCH_ROOT;
const sessionId = process.env.DISPATCH_SESSION;
const runtime = openTestCtoRuntime(root, sessionId, process.env.DISPATCH_OWNER_ID);
try {
  const result = await dispatchCtoSpecificationMapping(root, {
    cto_run_id: process.env.DISPATCH_RUN,
    mapping_id: process.env.DISPATCH_MAPPING,
    expected_mapping_hash: process.env.DISPATCH_HASH,
  }, { runtimeAccess: runtime.access, sessionId });
  process.stdout.write(JSON.stringify(result));
} finally { runtime.close(); }`;
  const { promise, resolve: resolveChild, reject: rejectChild } = Promise.withResolvers<Result>();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISPATCH_ROOT: root,
        DISPATCH_RUN: ctoRunId,
        DISPATCH_MAPPING: mappingId,
        DISPATCH_HASH: mappingHash,
        DISPATCH_SESSION: DEFAULT_TEST_SESSION_ID,
        DISPATCH_OWNER_ID: `core-test-runtime-${digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16)}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectChild);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectChild(new Error(stderr || `cto dispatch child exited with ${code}`));
        return;
      }
      try { resolveChild(parseLeadingJsonResult(stdout)); }
      catch (error) { rejectChild(new Error(`cto dispatch child returned invalid JSON: ${String(error)}\n${stderr}`)); }
    });
  return promise;
}
test("public workflow_begin issues only a phase capability and never an execution claim", async () => {
  const root = makeProject();
  const featureId = "public-begin-phase";
  const runKey = `run-${featureId}-1`;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const constitution = ensureProjectConstitution(root, { origin_kind: "do_work_nested", origin_run_key: runKey, origin_stage: "do_work" }, { feature_id: featureId });
    assert.equal(constitution.ok, true, constitution.ok ? "" : constitution.error);
    writeFeature(root, featureId, runKey);
    bindFixtureConstitution(root, featureId, runKey, constitution.ok ? constitution.value.binding as unknown as Json : null);
    enableDoWorkExecution(root, featureId);
    ensureExecutionContext(root);
    const begin = publicWorkflowBeginTool(root);
    const result = await begin.execute("phase", { feature_id: featureId, run_key: runKey }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(result.details.ok, true, result.details.error ?? "phase workflow_begin must succeed");
    assert.ok(result.details.handoff, "phase workflow_begin returns its phase capability");
    const claims = readExecutionClaimStore(root, featureId);
    assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
    if (claims.ok) assert.equal(claims.value.filter((claim) => claim.status === "active").length, 0, "phase capability issuance never creates a do-work claim");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted do_work_claim admits and replays a native implementation handoff", async () => {
  const root = makeProject();
  const featureId = "mounted-native-claim";
  const runKey = `run-${featureId}-1`;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const constitution = ensureProjectConstitution(root, { origin_kind: "do_work_nested", origin_run_key: runKey, origin_stage: "do_work" }, { feature_id: featureId });
    assert.equal(constitution.ok, true, constitution.ok ? "" : constitution.error);
    const handoff = writeFeature(root, featureId, runKey);
    bindFixtureConstitution(root, featureId, runKey, constitution.ok ? constitution.value.binding as unknown as Json : null);
    enableDoWorkExecution(root, featureId);

    const currentHandoff = JSON.parse(readFileSync(join(root, handoff.handoffPath), "utf8")) as Json;
    const claim = publicDoWorkClaimTool(root);
    const valid = { feature_id: featureId, run_key: runKey };
    const first = await claim.execute("native", valid, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(first.details.ok, true, first.details.error ?? "native claim must succeed");
    const firstClaim = first.details.claim as Json;
    assert.equal(firstClaim.owner_kind, "do_work");
    assert.equal(firstClaim.owner_run_id, runKey);
    assert.equal(firstClaim.handoff_digest, currentHandoff.handoff_digest);
    const replay = await claim.execute("native-replay", valid, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(replay.details.ok, true, replay.details.error ?? "native claim replay must succeed");
    assert.equal((replay.details.claim as Json).claim_id, firstClaim.claim_id, "same run replays the exact claim");
    const claims = readExecutionClaimStore(root, featureId);
    assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
    if (claims.ok) assert.equal(claims.value.filter((candidate) => candidate.status === "active").length, 1);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted do_work_claim rejects a native handoff marked stale before admission", async () => {
  const root = makeProject();
  const featureId = "mounted-native-stale";
  const runKey = `run-${featureId}-1`;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const constitution = ensureProjectConstitution(root, { origin_kind: "do_work_nested", origin_run_key: runKey, origin_stage: "do_work" }, { feature_id: featureId });
    assert.equal(constitution.ok, true, constitution.ok ? "" : constitution.error);
    writeFeature(root, featureId, runKey);
    bindFixtureConstitution(root, featureId, runKey, constitution.ok ? constitution.value.binding as unknown as Json : null);
    enableDoWorkExecution(root, featureId);
    rewriteHandoff(root, featureId, (value) => {
      value.status = "stale";
    });
    const claim = publicDoWorkClaimTool(root);
    const result = await claim.execute("native-stale", { feature_id: featureId, run_key: runKey }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(result.details.ok, false, "changed native handoff must fail closed");
    const claims = readExecutionClaimStore(root, featureId);
    assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
    if (claims.ok) assert.equal(claims.value.filter((candidate) => candidate.status === "active").length, 0);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("mounted do_work_claim retries a benign state revision CAS seam without duplicating the claim", async () => {
  const root = makeProject();
  const featureId = "mounted-native-cas-race";
  const runKey = `run-${featureId}-1`;
  let injected = false;
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const constitution = ensureProjectConstitution(root, { origin_kind: "do_work_nested", origin_run_key: runKey, origin_stage: "do_work" }, { feature_id: featureId });
    assert.equal(constitution.ok, true, constitution.ok ? "" : constitution.error);
    writeFeature(root, featureId, runKey);
    bindFixtureConstitution(root, featureId, runKey, constitution.ok ? constitution.value.binding as unknown as Json : null);
    enableDoWorkExecution(root, featureId);
    migrateFeatureWorkspaceToSchema3(root, featureId, runKey);
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        if (injected) return;
        injected = true;
        const state = JSON.parse(readFileSync(sourcePath, "utf8")) as Json;
        state.state_revision = Number(state.state_revision ?? 0) + 1;
        writeFileSync(sourcePath, JSON.stringify(state, null, 2) + "\n", "utf8");
      },
    }, root);
    const claim = publicDoWorkClaimTool(root);
    const result = await claim.execute("native-cas-race", { feature_id: featureId, run_key: runKey }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(injected, true, "the deterministic CAS mutation must run");
    assert.equal(result.details.ok, true, "a benign state_revision-only mutation is retried against the unchanged workspace");
    assert.equal(result.details.transition, "claim");
    const claims = readExecutionClaimStore(root, featureId);
    assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
    if (claims.ok) {
      const latest = new Map(claims.value.map((candidate) => [candidate.claim_id, candidate]));
      const active = [...latest.values()].filter((candidate) => candidate.status === "active");
      assert.equal(active.length, 1, "the retry leaves exactly one active claim authority");
      assert.equal(active[0]?.claim_id, (result.details.claim as Json)?.claim_id, "the response names the sole active claim");
    }
    const current = readCurrentExecutionClaim(root, featureId);
    assert.equal(current.ok, true, current.ok ? "" : current.error);
    if (current.ok) assert.equal(current.value?.claim_id, (result.details.claim as Json)?.claim_id, "the active authority matches the claim response");
    const state = resolveState(root, { feature_id: featureId, run_key: runKey });
    assert.equal(state.state?.specification?.execution_claim_ref, (result.details.claim as Json)?.claim_id, "the retried admission leaves the canonical workspace claim reference");
    assert.equal(state.state?.specification?.execution_claim_prepare_ref ?? null, null, "claim preparation is clear after commit");
  } finally {
    setStateTransactionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});


function mapping(result: Result): Json {
  assert.ok(result.mapping, "ready preflight must expose the frozen mapping");
  return result.mapping as Json;
}

function checkpointRef(root: string, frozen: Json): string {
  const context = executionContexts.get(root)!;
  return "cto-specification-mapping-" + digestOf({ cto_run_id: RUN_ID, mapping_id: frozen.mapping_id, mapping_hash: frozen.mapping_hash, feature_id: context.feature_id, run_key: context.run_key, stage_id: STAGE_ID, decision: CONFIRMATION_DECISION, capability_id: context.capability_id, capability_epoch: context.capability_epoch });
}

function alignCtoExecutionCapability(root: string, context: { feature_id: string; run_key: string }): void {
  const fixtureState = resolveState(root, undefined, { feature_id: context.feature_id, run_key: context.run_key });
  if (!fixtureState.state || !fixtureState.statePath) throw new Error("trusted proof fixture state unavailable");
  const issuedFor = fixtureState.state.dispatch_capability?.issued_for;
  if (!issuedFor) throw new Error("trusted proof fixture capability unavailable");
  if (issuedFor.stage_cursor === "execution") return;
  writeState(root, {
    ...fixtureState.state,
    dispatch_capability: {
      ...fixtureState.state.dispatch_capability,
      issued_for: { ...issuedFor, stage_cursor: "execution" },
    },
  }, { target: fixtureState });
}

async function prepareTrustedConfirmation(root: string, frozen: Json, options: { mappingHash?: string } = {}): Promise<Json> {
  const context = executionContexts.get(root)!;
  alignCtoExecutionCapability(root, context);
  const asked = await mountedCtoHostAsk(root, {
    cto_run_id: RUN_ID,
    mapping_id: frozen.mapping_id,
    mapping_hash: options.mappingHash ?? frozen.mapping_hash,
    mapping_version: frozen.mapping_version,
    feature_id: context.feature_id,
    run_key: context.run_key,
    stage_id: "execution",
  }, CONFIRMATION_DECISION);
  if (asked.status !== "answered" || typeof asked.trusted_answer_ref !== "string") {
    throw new Error("trusted proof fixture host Ask did not return an answered durable proof: " + JSON.stringify(asked));
  }
  return {
    cto_run_id: RUN_ID,
    mapping_id: frozen.mapping_id,
    mapping_hash: options.mappingHash ?? frozen.mapping_hash,
    answer_id: asked.trusted_answer_ref,
  };
}

async function preflightCtoSpecificationExecutionForTest(root: string, input: Json, sessionId = DEFAULT_TEST_SESSION_ID): Promise<Result> {
  return await preflightCtoSpecificationExecution(root, input as never, { runtimeAccess: testRuntimeAccess(root, sessionId), sessionId }) as unknown as Result;
}
function resumeCtoSpecificationMappingForTest(root: string, input: Json, sessionId = DEFAULT_TEST_SESSION_ID): Result {
  return resumeCtoSpecificationMapping(root, input as never, { runtimeAccess: testRuntimeAccess(root, sessionId), sessionId }) as unknown as Result;
}

async function confirmCtoSpecificationMappingForTest(root: string, input: Json, sessionId = DEFAULT_TEST_SESSION_ID): Promise<Result> {
  return await confirmCtoSpecificationMapping(root, input as never, { runtimeAccess: testRuntimeAccess(root, sessionId), sessionId }) as unknown as Result;
}

async function confirmTrusted(root: string, frozen: Json, options: { mappingHash?: string; beforeInvoke?: () => void } = {}): Promise<Result> {
  const invoke = confirmCtoSpecificationMapping as unknown as (projectRoot: string, input: Json, options: { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string }) => unknown;
  const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
  try {
    const current = JSON.parse(readFileSync(mappingPath, "utf8")) as Json;
    const currentStatus = (current.mapping as Json | undefined)?.status;
    if ((currentStatus === "confirmed" || currentStatus === "awaiting_confirmation") && typeof current.trusted_answer_ref === "string") {
      const replayInput = {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: options.mappingHash ?? frozen.mapping_hash,
        answer_id: current.trusted_answer_ref,
      };
      options.beforeInvoke?.();
      return await invoke(root, replayInput, { runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID), sessionId: DEFAULT_TEST_SESSION_ID }) as Result;
    }
  } catch {
    // The operation below returns the canonical blocked result for unreadable state.
  }
  try {
    const input = await prepareTrustedConfirmation(root, frozen, options);
    options.beforeInvoke?.();
    return await invoke(root, input, { runtimeAccess: testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID), sessionId: DEFAULT_TEST_SESSION_ID }) as Result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("trusted proof fixture host Ask did not return")) {
      const detailJson = message.slice(message.indexOf(": ") + 2);
      try { return JSON.parse(detailJson) as Result; } catch { /* fall through to a stable blocked result */ }
    }
    throw error;
  }
}

// ── Preflight and frozen versions ────────────────────────────────────────────

test("preparation reads a >1MiB non-anchor feature state with the shared cap", () => {
  const root = makeProject();
  const anchorId = "prep-large-anchor";
  const largeId = "prep-large-secondary";
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  try {
    writeFeature(root, anchorId);
    writeFeature(root, largeId);
    const largeStatePath = join(root, ".work-state", "features", largeId, "state.json");
    const largeState = readFileSync(largeStatePath);
    writeFileSync(largeStatePath, Buffer.concat([largeState, Buffer.alloc(1024 * 1024, 0x20)]));
    const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
    const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
    const prepared = prepareCtoSpecificationExecution(root, {
      cto_run_id: "PREP-LARGE-SECONDARY", task: "prepare large secondary", branch: "main", classification,
      selections: [selection(anchorId), selection(largeId)],
      teams: [
        { team: teamDef.id, task_ref: { feature_id: anchorId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod },
        { team: teamDef.id, task_ref: { feature_id: largeId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod },
      ],
    }, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("preflight loads multiple explicit workspaces and freezes exact handoff digests", async () => {
  const root = makeProject();
  try {
    const native = writeFeature(root, "native-feature");
    const imported = writeFeature(root, "imported-feature");
    const result = await preflight(root, [selection("native-feature"), selection("imported-feature")]);
    assert.equal(result.status, "ready", detail(result));
    assert.equal(result.dispatched, false, "preflight never dispatches implementation");
    const frozen = mapping(result);
    assert.deepEqual(frozen.feature_ids, ["native-feature", "imported-feature"]);
    const bindings = frozen.handoff_bindings as Json[];
    assert.deepEqual(bindings.map((b) => [b.feature_id, b.handoff_digest]), [
      ["native-feature", native.handoff.handoff_digest],
      ["imported-feature", imported.handoff.handoff_digest],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("final CTO state publication rejects drift in a non-anchor workspace and retries after restoration", () => {
  const root = makeProject();
  const anchorId = "aggregate-anchor";
  const secondaryId = "aggregate-secondary";
  const runId = "AGGREGATE-SECONDARY-DRIFT";
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
  const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
  const preparationInput = {
    cto_run_id: runId, task: "reject aggregate workspace drift", branch: "main", classification,
    selections: [selection(anchorId), selection(secondaryId)],
    teams: [
      { team: teamDef.id, task_ref: { feature_id: anchorId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod },
      { team: teamDef.id, task_ref: { feature_id: secondaryId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod },
    ],
  };
  const secondaryStatePath = join(root, ".work-state", "features", secondaryId, "state.json");
  try {
    writeParallelFeatures(root, [anchorId, secondaryId]);
    const secondaryBefore = readFileSync(secondaryStatePath);
    let injected = false;
    setCtoSpecificationPreparationTestHooks({
      beforeAnchorBind: () => {
        if (injected) return;
        injected = true;
        const envelope = JSON.parse(readFileSync(secondaryStatePath, "utf8")) as Json;
        const workspace = envelope.specification as Json;
        workspace.constitution_gate_ref = "drifted-gate-identity";
        writeFileSync(secondaryStatePath, JSON.stringify(envelope));
      },
    }, root);
    const failed = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(injected, true, "the non-anchor workspace must be mutated at the final publication seam");
    assert.equal(failed.status, "blocked", JSON.stringify(failed));
    assert.match(JSON.stringify(failed), /aggregate-secondary.*changed before CTO execution state commit/u, "the aggregate final preCommit must report the non-anchor drift");
    setCtoSpecificationPreparationTestHooks(null, root);
    assert.notDeepEqual(readFileSync(secondaryStatePath), secondaryBefore, "the injected non-anchor drift remains observable rather than being overwritten");
    const failedState = readCtoState(runId, root);
    assert.ok(failedState, "the failed transaction leaves a durable recovery state");
    assert.equal(failedState?.specification_preparation_transaction?.status, "rolled_back");
    assert.equal(activeWave(failedState!), null, "failed aggregate validation must not publish an active wave");
    const executionArtifacts = join(root, ".work-state", "cto", runId, "artifacts");
    const remainingDoD = existsSync(executionArtifacts)
      ? readdirSync(executionArtifacts).filter((entry) => existsSync(join(executionArtifacts, entry, "dod.json")))
      : [];
    assert.deepEqual(remainingDoD, [], "failed aggregate validation must roll back generated DoD artifacts");

    writeFileSync(secondaryStatePath, secondaryBefore);
    const retry = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(retry.status, "ready", JSON.stringify(retry));
  } finally {
    setCtoSpecificationPreparationTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparation rejects unknown task dependencies without writing state", () => {
  const root = makeProject();
  const featureId = "unknown-dependency";
  const runId = "UNKNOWN-DEPENDENCY";
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
  const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
  try {
    writeFeature(root, featureId);
    const result = prepareCtoSpecificationExecution(root, {
      cto_run_id: runId, task: "reject unknown dependency", branch: "main", classification,
      selections: [selection(featureId)],
      teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: ["removed-predecessor"], dod }],
    }, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.deepEqual(result.requested_selections, [selection(featureId)]);
    assert.deepEqual(result.eligible_selections, [selection(featureId)]);
    assert.deepEqual(result.excluded, []);
    assert.match(JSON.stringify(result.findings), /unknown.*execution team|TeamDef|removed-predecessor/i);
    assert.equal(existsSync(join(root, ".work-state", "cto", runId, "state.json")), false, "unknown dependency must fail before CTO state publication");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation preserves selection report for post-eligibility failures", () => {
  const cases = [
    { name: "unknown TeamDef", mutate: (teams: Json[]) => { teams[0]!.team = "removed-team-def"; }, finding: /TeamDef/ },
    { name: "duplicate task", mutate: (teams: Json[]) => { teams.push({ ...teams[0] }); }, finding: /duplicate task_ref/ },
  ] as const;
  for (const [index, scenario] of cases.entries()) {
    const root = makeProject();
    const featureId = `report-failure-${index}`;
    const runId = `REPORT-FAILURE-${index}`;
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
    const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
    try {
      writeFeature(root, featureId);
      const teams: Json[] = [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod }];
      scenario.mutate(teams);
      const result = prepareCtoSpecificationExecution(root, {
        cto_run_id: runId, task: "preserve report", branch: "main", classification,
        selections: [selection(featureId)], teams,
      }, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.deepEqual(result.requested_selections, [selection(featureId)]);
      assert.deepEqual(result.eligible_selections, [selection(featureId)]);
      assert.deepEqual(result.excluded, []);
      assert.match(JSON.stringify(result.findings), scenario.finding);
      assert.equal(existsSync(join(root, ".work-state", "cto", runId, "state.json")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("multi-task same TeamDef preparation creates unique execution instances and replays", async () => {
  const root = makeProject();
  const featureId = "multi-task-same-def";
  const preparationRun = "MULTI-TASK-PREP";
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  try {
    writeFeature(root, featureId);
    rewriteHandoff(root, featureId, (handoff) => {
      const tasks = handoff.tasks as Json[];
      tasks.push({ task_id: "T-2", title: "Verify the outcome", requirement_ids: ["FR-1"], depends_on: ["T-1"], expected_outcome: "The outcome is verified.", affected_scope: ["src/other.ts"], completion_evidence: ["focused verification"], parallel_safe: true });
      const verification = (handoff.verification as Json[])[0]!;
      verification.task_ids = [...(verification.task_ids as string[]), "T-2"];
    }, root);
    ensureExecutionContext(root, { featureStateOnly: true });
    const featureStatePath = join(root, ".work-state", "features", featureId, "state.json");
    const selectedFeature = resolveState(root, undefined, selection(featureId));
    assert.ok(selectedFeature.state);
    if (!selectedFeature.state) return;
    selectedFeature.state.stages = Array.from({ length: 4096 }, (_, index) => ({
      id: index === 0 ? "execution" : "stage-" + index, status: index === 0 ? "in_progress" : "done", note: "x".repeat(400),
    }));
    writeState(root, selectedFeature.state, { featureSlug: featureId });
    assert.ok(statSync(featureStatePath).size > 1024 * 1024, "fixture must be writer-valid and exceed the retired 1MiB preparation cap");
    const stateBeforePreparation = readFileSync(featureStatePath);
    const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
    const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
    const preparationInput = {
      cto_run_id: preparationRun, task: "prepare multi-task execution", branch: "main", classification,
      selections: [selection(featureId)],
      teams: [
        { team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, scope: ["src/feature.ts"], classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod },
        { team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-2" }, scope: ["src/other.ts"], classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod },
      ],
    };
    let injected = false;
    setCtoSpecificationPreparationTestHooks({
      afterWrite: (point) => {
        if (point === "after_dod_write" && !injected) {
          injected = true;
          throw new Error("oversized-preparation-rollback");
        }
      },
    }, root);
    const interrupted = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root, "preparation-session") });
    assert.equal(interrupted.status, "blocked", JSON.stringify(interrupted));
    setCtoSpecificationPreparationTestHooks(null, root);
    assert.deepEqual(readFileSync(featureStatePath), stateBeforePreparation, "rollback must restore the >1MiB anchor preimage");
    const preimageDir = join(root, ".work-state", "cto", preparationRun, "preparation-preimages");
    assert.ok(existsSync(preimageDir) && readdirSync(preimageDir).some((name) => name.endsWith(".bin")), "rollback must retain a content-addressed preimage");
    const prepared = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root, "preparation-session") });
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    const replay = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root, "preparation-session") });
    assert.equal(replay.status, "ready", JSON.stringify(replay));
    if (prepared.status !== "ready") return;
    const preparedState = readCtoState(preparationRun, root);
    assert.ok(preparedState);
    if (!preparedState) return;
    assert.equal(new Set(preparedState.plan.teams.map((team) => team.team)).size, 2);
    assert.deepEqual(preparedState.plan.teams.map((team) => team.team_def_id), [teamDef.id, teamDef.id]);
    assert.deepEqual(preparedState.plan.teams[1]!.depends_on, [preparedState.plan.teams[0]!.team]);
    assert.deepEqual(preparedState.teams.map((team) => team.team_def_id), [teamDef.id, teamDef.id]);

  } finally {
    setCtoSpecificationPreparationTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("duplicate preflight selectors produce one actionable exact retry", async () => {
  const root = makeProject();
  const featureId = "duplicate-retry";
  try {
    writeFeature(root, featureId);
    const blocked = await preflight(root, [selection(featureId), selection(featureId)]);
    assert.equal(blocked.status, "blocked", detail(blocked));
    const retry = blocked.required_next_tool as Json;
    assert.equal(retry.name, "cto_preflight");
    const retrySelections = ((retry.arguments as Json).selections as Json[]);
    assert.deepEqual(retrySelections, [selection(featureId)]);
    const exact = await preflight(root, retrySelections);
    assert.equal(exact.status, "ready", detail(exact));
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
    setCtoSpecificationPreparationTestHooks(null, root);
});
test("preflight rejects artifact-version content changed behind an old frozen digest", async () => {
  const root = makeProject();
  try {
    const fixture = writeFeature(root, "frozen-version");
    const changed = JSON.parse(readFileSync(join(root, fixture.handoffPath), "utf8")) as Json;
    changed.artifact_versions = (changed.artifact_versions as Json[]).map((artifact) =>
      artifact.kind === "tasks" ? { ...artifact, version: Number(artifact.version) + 1 } : artifact,
    );
    writeFileSync(join(root, fixture.handoffPath), JSON.stringify(changed));
    const result = await preflight(root, [selection("frozen-version")]);
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /digest|version|artifact/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Confirmation boundary ───────────────────────────────────────────────────

test("preparation replay rejects progressed team lifecycle without mutation", () => {
  for (const status of ["in_progress", "done"] as const) {
    const root = makeProject();
    const featureId = "replay-progress-" + status;
    const runId = "REPLAY-PROGRESS-" + status.toUpperCase();
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    try {
      writeFeature(root, featureId);
      const input = {
        cto_run_id: runId, task: "replay lifecycle", branch: "main",
        classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true },
        selections: [selection(featureId)],
        teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, profile: "standard", worktree: "same_branch" as const, depends_on: [], dod: { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true } }],
      };
      const prepared = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      const statePath = join(root, ".work-state", "cto", runId, "state.json");
      const state = readCtoState(runId, root);
      assert.ok(state);
      if (!state) continue;
      state.teams[0]!.status = status;
      testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID).withRunTransaction(runId, (transaction) => { transaction.writeState(state); });
      const before = readFileSync(statePath, "utf8");
      const replay = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(replay.status, "blocked", JSON.stringify(replay));
      assert.match(JSON.stringify(replay), /already_started|lifecycle|takeover|identity/i);
      assert.equal(readFileSync(statePath, "utf8"), before, "progressed replay must not mutate state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("preparation replay rejects cross-swapped team identities without mutation", () => {
  const root = makeProject();
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  const featureIds = ["replay-swap-a", "replay-swap-b"];
  const runKeys = featureIds.map((featureId) => "run-" + featureId + "-1");
  const input = {
    cto_run_id: "REPLAY-SWAP", task: "replay identity swap", branch: "main",
    classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true },
    selections: featureIds.map((feature_id, index) => selection(feature_id, runKeys[index])),
    teams: featureIds.map((feature_id, index) => ({ team: teamDef.id, task_ref: { feature_id, task_id: "T-1" }, classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, profile: "standard", worktree: "same_branch" as const, depends_on: [], dod: { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true } })),
  };
  try {
    for (const [index, featureId] of featureIds.entries()) writeFeature(root, featureId, runKeys[index]);
    const prepared = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    const statePath = join(root, ".work-state", "cto", input.cto_run_id, "state.json");
    const state = readCtoState(input.cto_run_id, root);
    assert.ok(state);
    if (!state) return;
    const first = state.teams[0]!.work_identity;
    state.teams[0]!.work_identity = state.teams[1]!.work_identity;
    state.teams[1]!.work_identity = first;
    testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID).withRunTransaction(input.cto_run_id, (transaction) => { transaction.writeState(state); });
    const before = readFileSync(statePath, "utf8");
    const replay = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(replay.status, "blocked", JSON.stringify(replay));
    assert.match(JSON.stringify(replay), /identity|takeover|replay/i);
    assert.equal(readFileSync(statePath, "utf8"), before, "cross-swapped replay must not mutate state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO reconciliation rejects cross-bound identity receipts before team mutation", () => {
  const mutations = [
    ["run_id", (identity: Json) => ({ ...identity, run_id: "foreign-run" })],
    ["wave_id", (identity: Json) => ({ ...identity, wave_id: "foreign-wave" })],
    ["slice_id", (identity: Json) => ({ ...identity, slice_id: "foreign-slice", slot_id: "foreign-slice" })],
    ["capability_id", (identity: Json) => ({ ...identity, capability_id: "foreign-capability" })],
    ["task_id", (identity: Json) => ({ ...identity, task_id: "task-synthetic-mismatch" })],
  ] as const;
  for (const [label, mutateIdentity] of mutations) {
    const root = makeProject();
    const featureId = "reconcile-identity-" + label;
    const runId = "RECONCILE-IDENTITY-" + label.toUpperCase();
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    try {
      writeFeature(root, featureId);
      const input = {
        cto_run_id: runId, task: "reconcile identity", branch: "main", classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true },
        selections: [selection(featureId)],
        teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, profile: "standard", worktree: "same_branch" as const, depends_on: [], dod: { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true } }],
      };
      const prepared = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      const state = readCtoState(runId, root);
      assert.ok(state?.teams[0]?.work_identity);
      if (!state || !state.teams[0]?.work_identity) continue;
      state.teams[0].work_identity = mutateIdentity(state.teams[0].work_identity as unknown as Json) as unknown as CtoState["teams"][number]["work_identity"];
      testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID).withRunTransaction(runId, (transaction) => { transaction.writeState(state); });
      const before = readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8");
      const reconciled = reconcileCtoSpecificationExecutionTeams(root, runId, preparationRuntimeOptions(root));
      assert.equal(reconciled.status, "blocked", JSON.stringify(reconciled));
      assert.match(JSON.stringify(reconciled), /identity|wave|recovery|receipt/i);
      assert.equal(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8"), before, label + " reconciliation must not mutate the team");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("CTO reconciliation and authorization reject missing or extra wave slices", () => {
  const runCase = (label: "missing-team" | "extra-wave-slice") => {
    const root = makeProject();
    const featureId = "reconcile-cardinality-" + label;
    const runId = "RECONCILE-CARDINALITY-" + label.toUpperCase();
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    try {
      writeFeature(root, featureId);
      const input = { cto_run_id: runId, task: "reconcile cardinality", branch: "main", classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, selections: [selection(featureId)], teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, profile: "standard", worktree: "same_branch" as const, depends_on: [], dod: { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true } }] };
      const prepared = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      const state = readCtoState(runId, root);
      assert.ok(state);
      if (!state) return;
      const wave = state.wave_history?.find((candidate) => candidate.id === state.active_wave_id);
      assert.ok(wave);
      if (!wave) return;
      if (label === "missing-team") state.teams.splice(0, 1);
      else wave.slice_ids.push("slice-foreign-cardinality");
      persistCtoFixtureState(root, state);
      const statePath = join(root, ".work-state", "cto", runId, "state.json");
      const before = readFileSync(statePath, "utf8");
      const reconciled = reconcileCtoSpecificationExecutionTeams(root, runId, preparationRuntimeOptions(root));
      assert.equal(reconciled.status, "blocked", JSON.stringify(reconciled));
      assert.match(JSON.stringify(reconciled), /cardinality|slice|recovery/i);
      assert.equal(readFileSync(statePath, "utf8"), before, label + " reconciliation must not mutate state");
      const authorization = authorizeCtoSpecificationExecutionTask(root, { toolName: "task", toolCallId: "cardinality-" + label, input: { task: buildCtoSliceMarker(runId, String(state.teams[0]?.slice_id ?? "slice-foreign-cardinality")) } }, preparationRuntimeOptions(root));
      assert.equal(authorization.ok, false, JSON.stringify(authorization));
      assert.match(JSON.stringify(authorization), /cardinality|slice|recovery/i);
      assert.equal(readFileSync(statePath, "utf8"), before, label + " authorization must not mutate state");
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  runCase("missing-team");
  runCase("extra-wave-slice");
});

test("CTO reconciliation rejects incomplete selectors and unsupported lifecycle without mutation", () => {
  const runCase = (label: "missing-selector" | "unsupported-status") => {
    const root = makeProject();
    const featureId = "reconcile-complete-" + label;
    const runId = "RECONCILE-COMPLETE-" + label.toUpperCase();
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    try {
      writeFeature(root, featureId);
      const input = { cto_run_id: runId, task: "reconcile completeness", branch: "main", classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, selections: [selection(featureId)], teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, profile: "standard", worktree: "same_branch" as const, depends_on: [], dod: { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true } }] };
      const prepared = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      const state = readCtoState(runId, root);
      assert.ok(state?.teams[0]);
      if (!state?.teams[0]) return;
      if (label === "missing-selector") delete state.teams[0].feature_id;
      else state.teams[0].status = "parked";
      testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID).withRunTransaction(runId, (transaction) => { transaction.writeState(state); });
      const statePath = join(root, ".work-state", "cto", runId, "state.json");
      const before = readFileSync(statePath, "utf8");
      const result = reconcileCtoSpecificationExecutionTeams(root, runId, preparationRuntimeOptions(root));
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.match(JSON.stringify(result), /selector|lifecycle|status|feature|recovery/i);
      assert.equal(readFileSync(statePath, "utf8"), before, label + " reconciliation must not mutate state");
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  runCase("missing-selector");
  runCase("unsupported-status");
});

test("CTO task authorization rejects foreign marker identity without mutation", () => {
  const root = makeProject();
  const featureId = "authorize-identity-boundary";
  const runId = "AUTHORIZE-IDENTITY-BOUNDARY";
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  try {
    writeFeature(root, featureId);
    const input = {
      cto_run_id: runId, task: "authorize identity", branch: "main", classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true },
      selections: [selection(featureId)],
      teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification: { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true }, workflow: "standard" as const, profile: "standard", worktree: "same_branch" as const, depends_on: [], dod: { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true } }],
    };
    const prepared = prepareCtoSpecificationExecution(root, input, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    const state = readCtoState(runId, root);
    assert.ok(state?.teams[0]);
    if (!state?.teams[0]) return;
    const before = readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8");
    const result = authorizeCtoSpecificationExecutionTask(root, { toolName: "task", toolCallId: "authorize-foreign", input: { task: buildCtoSliceMarker(runId, "foreign-slice") } }, preparationRuntimeOptions(root));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /slice|identity|authenticated/i);
    assert.equal(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparation recovery fails closed on tampered or missing external preimages", () => {
  for (const corruption of ["tampered", "missing"] as const) {
    const root = makeProject();
    const featureId = "preimage-" + corruption;
    const runId = "PREIMAGE-" + corruption.toUpperCase();
    const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
    try {
      writeFeature(root, featureId);
      const statePath = join(root, ".work-state", "features", featureId, "state.json");
      writeFileSync(statePath, Buffer.concat([readFileSync(statePath), Buffer.alloc(1024 * 1024, 0x20)]));
      const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
      const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
      const preparationInput = {
        cto_run_id: runId, task: "preimage recovery", branch: "main", classification, selections: [selection(featureId)],
        teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod }],
      };
      let injected = false;
      setCtoSpecificationPreparationTestHooks({ afterWrite: (point) => {
        if (point !== "after_dod_write" || injected) return;
        injected = true;
        const ctoPath = join(root, ".work-state", "cto", runId, "state.json");
        const ctoState = JSON.parse(readFileSync(ctoPath, "utf8")) as Json;
        const tx = (ctoState.specification_preparation_transaction as Json);
        const ref = String(((tx.feature_state as Json).before as Json).preimage_ref);
        if (corruption === "missing") unlinkSync(join(root, ref)); else writeFileSync(join(root, ref), Buffer.from("forged-preimage"));
        throw new Error("preimage-corruption");
      } }, root);
      const failed = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(failed.status, "blocked", JSON.stringify(failed));
      setCtoSpecificationPreparationTestHooks(null, root);
      assert.match(JSON.stringify(failed), /preimage|content.address|missing|recover/i);
      const retry = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root) });
      assert.equal(retry.status, "blocked", JSON.stringify(retry));
      assert.match(JSON.stringify(retry), /preimage|content.address|missing|recover/i);
    } finally {
      setCtoSpecificationPreparationTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("legacy inline preparation preimages migrate to external refs during recovery", () => {
  const root = makeProject();
  const featureId = "legacy-preimage";
  const runId = "LEGACY-PREIMAGE";
  const teamDef = { id: "team-standard", name: "Standard", scope: ["src"], profile: "standard", lead: "developer", roster: ["developer"] };
  try {
    writeFeature(root, featureId);
    const classification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true };
    const dod = { items: [{ id: "dod-1", source: "handoff", criterion: "works", verify_method: "focused test", status: "pending", evidence: "" }], type_requirements_met: true };
    const preparationInput = { cto_run_id: runId, task: "legacy preimage recovery", branch: "main", classification, selections: [selection(featureId)], teams: [{ team: teamDef.id, task_ref: { feature_id: featureId, task_id: "T-1" }, classification, workflow: "standard", profile: "standard", worktree: "same_branch", depends_on: [], dod }] };
    let injected = false;
    setCtoSpecificationPreparationTestHooks({ afterWrite: (point) => {
      if (point !== "after_dod_write" || injected) return;
      injected = true;
      const ctoPath = join(root, ".work-state", "cto", runId, "state.json");
      const ctoState = JSON.parse(readFileSync(ctoPath, "utf8")) as Json;
      const tx = ctoState.specification_preparation_transaction as Json;
      const toLegacy = (image: Json) => {
        if (typeof image.preimage_ref !== "string") return;
        image.bytes_base64 = readFileSync(join(root, image.preimage_ref)).toString("base64");
        delete image.preimage_ref;
        delete image.byte_count;
      };
      toLegacy((tx.feature_state as Json).before);
      for (const file of tx.dod_files as Json[]) toLegacy(file.before);
      writeFileSync(ctoPath, JSON.stringify(ctoState));
      const proofRoot = PinnedProjectRoot.open(root);
      assert.ok(proofRoot, "legacy inline recovery proof root must be pinnable");
      if (!proofRoot) throw new Error("legacy inline recovery proof root is unavailable");
      try {
        assert.equal(writeCtoRuntimeStateProof(proofRoot, ctoState as unknown as CtoState), true, "legacy inline recovery must refresh the exact state proof");
      } finally {
        proofRoot.close();
      }
      throw new Error("legacy-inline-recovery");
    } }, root);
    const failed = prepareCtoSpecificationExecution(root, preparationInput, { defs: [teamDef], ...preparationRuntimeOptions(root) });
    assert.equal(failed.status, "blocked", JSON.stringify(failed));
    setCtoSpecificationPreparationTestHooks(null, root);
    const recovered = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as Json;
    const recoveredTx = recovered.specification_preparation_transaction as Json;
    assert.equal(recoveredTx.status, "rolled_back");
    assert.equal(Object.hasOwn((recoveredTx.feature_state as Json).before, "bytes_base64"), false);
    assert.match(String((recoveredTx.feature_state as Json).before.preimage_ref), /preparation-preimages/);
  } finally {
    setCtoSpecificationPreparationTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("dispatch is blocked until exact mapping hash and trusted confirmation exist", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "confirmation-boundary");
    const frozen = await preflight(root, [selection("confirmation-boundary")]);
    assert.equal(frozen.status, "ready", detail(frozen));
    const frozenMapping = mapping(frozen);
    const hash = frozenMapping.mapping_hash ?? frozenMapping.mapping_digest;
    assert.equal(typeof hash, "string");
    if (typeof hash !== "string") return;
    const before = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID, mapping_id: String(frozenMapping.mapping_id), expected_mapping_hash: hash,
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(before.status, "blocked", detail(before));
    assert.equal(before.dispatched, false);
    assert.match(detail(before), /confirm|checkpoint|trusted/i);
    const arbitrary = await confirmCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID, mapping_id: frozenMapping.mapping_id, mapping_hash: hash,
      checkpoint_ref: "checkpoint.cto.mapping.v1", trusted_answer_ref: "answer.user.mapping.v1",
    }) as Result;
    assert.equal(arbitrary.status, "blocked", "arbitrary legacy references cannot authorize");
    const confirmed = await confirmTrusted(root, frozenMapping);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const replay = await confirmTrusted(root, frozenMapping);
    assert.equal(replay.status, "confirmed", detail(replay));
    const after = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID, mapping_id: String(frozenMapping.mapping_id), expected_mapping_hash: hash,
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.notEqual(after.dispatched, false, detail(after));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("CTO specification mutators reject a foreign owner before durable writes", async () => {
  const root = makeProject();
  const foreignSession = "foreign-cto-owner-session";
  const featureId = "foreign-owner-feature";
  const runKey = "run-" + featureId + "-1";
  const featureStatePath = join(root, ".work-state", "features", featureId, "state.json");
  const ctoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
  const mappingDirectory = join(root, ".work-state", "cto", RUN_ID, "specification-mappings");
  const transactionDirectory = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
  const ownerId = "core-test-runtime-" + digestOf({ root, sessionId: DEFAULT_TEST_SESSION_ID }).slice(0, 16);
  let foreignRuntime: ReturnType<typeof openTestCtoRuntime> | undefined;
  const snapshotDirectory = (directory: string): Array<[string, string]> | null => {
    if (!existsSync(directory)) return null;
    return readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name), "utf8")]);
  };
  const snapshotDurable = (mappingPath?: string) => ({
    feature: readFileSync(featureStatePath, "utf8"),
    cto: readFileSync(ctoStatePath, "utf8"),
    mapping: mappingPath && existsSync(mappingPath) ? readFileSync(mappingPath, "utf8") : null,
    mappings: snapshotDirectory(mappingDirectory),
    transactions: snapshotDirectory(transactionDirectory),
  });
  try {
    writeFeature(root, featureId, runKey);
    ensureExecutionContext(root);
    // Keep both live facades under the same workflow owner principal. The
    // session identity is intentionally different; ownership is enforced by
    // the canonical CtoState owner_session, not by registry activation.
    foreignRuntime = openTestCtoRuntime(root, foreignSession, ownerId);
    const foreignOptions = {
      runtimeAccess: foreignRuntime.access,
      sessionId: foreignSession,
    };

    const intactCtoState = readFileSync(ctoStatePath, "utf8");
    const beforeForeignPreflight = snapshotDurable();
    const foreignPreflight = await preflightCtoSpecificationExecution(root, {
      cto_run_id: RUN_ID,
      selections: [selection(featureId, runKey)],
    } as never, foreignOptions) as unknown as Result;
    assert.equal(foreignPreflight.status, "blocked", detail(foreignPreflight));
    assert.deepEqual(snapshotDurable(), beforeForeignPreflight, "foreign preflight must not mutate feature, mapping, checkpoint, or transaction bytes");

    const forgedCtoState = JSON.parse(intactCtoState) as Json;
    forgedCtoState.work_identity = { ...(forgedCtoState.work_identity as Json), session_id: foreignSession };
    writeFileSync(ctoStatePath, JSON.stringify(forgedCtoState) + String.fromCharCode(10), "utf8");
    const beforeIdentityTamper = snapshotDurable();
    const identityTamperedPreflight = await preflightCtoSpecificationExecutionForTest(root, {
      cto_run_id: RUN_ID,
      selections: [selection(featureId, runKey)],
    });
    assert.equal(identityTamperedPreflight.status, "blocked", detail(identityTamperedPreflight));
    assert.deepEqual(snapshotDurable(), beforeIdentityTamper, "top-level identity mismatch must block before durable writes");
    writeFileSync(ctoStatePath, intactCtoState, "utf8");

    const ownerPreflight = await preflight(root, [selection(featureId, runKey)]);
    assert.equal(ownerPreflight.status, "ready", detail(ownerPreflight));
    const frozen = mapping(ownerPreflight);
    const askArgs = {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      mapping_version: frozen.mapping_version,
      feature_id: featureId,
      run_key: runKey,
      stage_id: "execution",
    } as Json;
    const mappingPath = join(mappingDirectory, String(frozen.mapping_id) + ".json");

    const beforeForeignPrepare = snapshotDurable(mappingPath);
    const foreignPrepare = prepareCtoSpecificationMappingAsk(root, askArgs as never, foreignOptions);
    assert.equal(foreignPrepare.status, "blocked", JSON.stringify(foreignPrepare));
    assert.deepEqual(snapshotDurable(mappingPath), beforeForeignPrepare, "foreign mapping preparation must not mutate durable bytes");
    const ownerPrepare = prepareCtoSpecificationMappingAsk(root, askArgs as never, preparationRuntimeOptions(root));
    assert.equal(ownerPrepare.status, "ready", JSON.stringify(ownerPrepare));
    alignCtoExecutionCapability(root, { feature_id: featureId, run_key: runKey });

    const recordInput = { ...askArgs, decision: "request_changes" as const, feedback: "Review the mapping." };
    const foreignRecordOptions = {
      ...foreignOptions,
      trusted_host: { bridge: {}, question: "foreign", options: ["request_changes"], session_id: foreignSession },
    } as Parameters<typeof recordCtoSpecificationMappingAsk>[2];
    const beforeForeignRecord = snapshotDurable(mappingPath);
    const foreignRecord = recordCtoSpecificationMappingAsk(root, recordInput as never, foreignRecordOptions);
    assert.equal(foreignRecord.status, "blocked", JSON.stringify(foreignRecord));
    assert.deepEqual(snapshotDurable(mappingPath), beforeForeignRecord, "foreign mapping Ask recording must not mutate durable bytes");

    const ownerAsk = await mountedCtoHostAsk(root, askArgs, "request_changes", "Review the mapping.");
    assert.equal(ownerAsk.status, "answered", detail(ownerAsk));
    const resumeInput = {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      mapping_version: frozen.mapping_version,
    };
    const beforeForeignResume = snapshotDurable(mappingPath);
    const foreignResume = resumeCtoSpecificationMapping(root, resumeInput as never, foreignOptions) as unknown as Result;
    assert.equal(foreignResume.status, "blocked", detail(foreignResume));
    assert.deepEqual(snapshotDurable(mappingPath), beforeForeignResume, "foreign mapping resume must not mutate durable bytes");
    const ownerResume = resumeCtoSpecificationMapping(root, resumeInput as never, preparationRuntimeOptions(root));
    assert.equal(ownerResume.status, "resumed", detail(ownerResume));

    const resumedAskArgs = {
      cto_run_id: ownerResume.cto_run_id,
      mapping_id: ownerResume.mapping_id,
      mapping_hash: ownerResume.mapping_hash,
      mapping_version: ownerResume.mapping_version,
      feature_id: ownerResume.feature_id,
      run_key: ownerResume.run_key,
      stage_id: ownerResume.stage_id,
    } as Json;
    const ownerContinuationAsk = await mountedCtoHostAsk(root, resumedAskArgs, "approve_continue");
    assert.equal(ownerContinuationAsk.status, "answered", detail(ownerContinuationAsk));
    const confirmationInput = {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      answer_id: ownerContinuationAsk.trusted_answer_ref,
    };
    const beforeForeignConfirm = snapshotDurable(mappingPath);
    const foreignConfirm = await confirmCtoSpecificationMapping(root, confirmationInput as never, foreignOptions) as unknown as Result;
    assert.equal(foreignConfirm.status, "blocked", detail(foreignConfirm));
    assert.deepEqual(snapshotDurable(mappingPath), beforeForeignConfirm, "foreign confirmation must not mutate durable bytes");
    const ownerConfirm = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
    assert.equal(ownerConfirm.status, "confirmed", detail(ownerConfirm));
    const beforeForeignDispatch = snapshotDurable(mappingPath);
    const foreignDispatch = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      expected_mapping_hash: frozen.mapping_hash,
    }, foreignOptions);
    assert.equal(foreignDispatch.status, "blocked", detail(foreignDispatch as unknown as Result));
    assert.deepEqual(snapshotDurable(mappingPath), beforeForeignDispatch, "foreign dispatch/replay admission must not mutate durable bytes");
  } finally {
    foreignRuntime?.close();
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-feature confirmation is anchored to first selection and ignores non-anchor answers", async () => {
  const root = makeProject();
  const firstFeature = "anchor-first";
  const secondFeature = "anchor-second";
  try {
    writeFeature(root, firstFeature);
    writeFeature(root, secondFeature);
    const frozen = mapping(await preflight(root, [selection(firstFeature), selection(secondFeature)]));
    const mappingId = String(frozen.mapping_id);
    const mappingHash = String(frozen.mapping_hash);
    const mappingFile = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${mappingId}.json`);
    const secondStateFile = join(root, ".work-state", "features", secondFeature, "state.json");
    const secondStateBefore = readFileSync(secondStateFile, "utf8");
    const firstInput = await prepareTrustedConfirmation(root, frozen);
    // A proof minted for a non-anchor feature is not a valid answer in the anchor ledger.
    const secondAttempt = await confirmCtoSpecificationMappingForTest(root, {
      ...firstInput,
      answer_id: `answer-${mappingId}-non-anchor`,
    }) as Result;
    assert.equal(secondAttempt.status, "blocked", detail(secondAttempt));
    assert.match(detail(secondAttempt), /first exact frozen selection|first selection|canonical ledger/i);
    assert.equal(readFileSync(secondStateFile, "utf8"), secondStateBefore, "rejecting a non-anchor confirmation must not mutate its feature state");

    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: mappingId,
      expected_mapping_hash: mappingHash,
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));

    const canonicalRecord = JSON.parse(readFileSync(mappingFile, "utf8")) as Json;
    const reorderedRecord = JSON.parse(JSON.stringify(canonicalRecord)) as Json;
    (reorderedRecord.selections as Json[]).reverse();
    const reorderedMapping = reorderedRecord.mapping as Json;
    (reorderedMapping.selections as Json[]).reverse();
    (reorderedMapping.feature_ids as string[]).reverse();
    writeFileSync(mappingFile, `${JSON.stringify(reorderedRecord, null, 2)}\n`, "utf8");
    const reorderedDispatch = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: mappingId,
      expected_mapping_hash: mappingHash,
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(reorderedDispatch.status, "blocked", detail(reorderedDispatch));
    assert.match(detail(reorderedDispatch), /mapping.*hash|immutable|selection/i);
    const reorderedConfirm = await confirmTrusted(root, frozen);
    assert.equal(reorderedConfirm.status, "blocked", detail(reorderedConfirm));

    writeFileSync(mappingFile, `${JSON.stringify(canonicalRecord, null, 2)}\n`, "utf8");
    const tamperedContext = JSON.parse(JSON.stringify(canonicalRecord)) as Json;
    (tamperedContext.confirmation_context as Json).feature_id = secondFeature;
    writeFileSync(mappingFile, `${JSON.stringify(tamperedContext, null, 2)}\n`, "utf8");
    const tamperedDispatch = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: mappingId,
      expected_mapping_hash: mappingHash,
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(tamperedDispatch.status, "blocked", detail(tamperedDispatch));
    assert.match(detail(tamperedDispatch), /confirmation context|first exact|exact.*context/i);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch rejects a mapping rewrite across the async admission seam", async () => {
  const root = makeProject();
  try {
    const feature = writeFeature(root, "mapping-admission-race");
    const frozen = mapping(await preflight(root, [selection("mapping-admission-race")]));
    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const mappingFile = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    let mutated = false;
    setCtoSpecificationExecutionTestHooks({
      afterAwait: () => {
        if (mutated) return;
        mutated = true;
        const record = JSON.parse(readFileSync(mappingFile, "utf8")) as Json;
        record.confirmed_at = "tampered-after-admission";
        writeFileSync(mappingFile, JSON.stringify(record));
      },
    }, root);
    const result = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /mapping record changed|admission/i);
    const claims = readExecutionClaimStore(root, "mapping-admission-race");
    assert.equal(claims.ok, true);
    if (claims.ok) assert.equal(claims.value.filter((claim) => claim.status === "active").length, 0);
  } finally {
    setCtoSpecificationExecutionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch compensates earlier claims when a later admission snapshot changes", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "admission-first");
    writeFeature(root, "admission-second");
    rewriteHandoff(root, "admission-first", (handoff) => { ((handoff.tasks as Json[])[0]!).affected_scope = ["src/admission-first.ts"]; });
    rewriteHandoff(root, "admission-second", (handoff) => { ((handoff.tasks as Json[])[0]!).affected_scope = ["src/admission-second.ts"]; });
    const frozen = mapping(await preflight(root, [selection("admission-first"), selection("admission-second")]));
    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const mappingFile = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    let awaits = 0;
    setCtoSpecificationExecutionTestHooks({
      afterAwait: () => {
        awaits += 1;
        if (awaits !== 2) return;
        const record = JSON.parse(readFileSync(mappingFile, "utf8")) as Json;
        record.confirmed_at = "tampered-before-second-claim";
        writeFileSync(mappingFile, JSON.stringify(record));
      },
    }, root);
    const result = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /mapping record changed|admission/i);
    const claims = readExecutionClaimStore(root, "admission-first");
    assert.equal(claims.ok, true);
    if (claims.ok) assert.equal(claims.value.at(-1)?.status, "released", `later admission failure rolls back earlier claim: ${detail(result)}`);
  } finally {
    setCtoSpecificationExecutionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("async confirmation contends without stalling an in-flight CTO preflight lock", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "mixed-lock");
    const frozen = mapping(await preflight(root, [selection("mixed-lock")]));
    const confirmationInput = await prepareTrustedConfirmation(root, frozen);
    const owner = withCtoRunLockAsync(root, RUN_ID, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "owner";
    }, root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    const confirmation = confirmCtoSpecificationMappingForTest(root, confirmationInput);
    const [ownerResult, confirmed] = await Promise.all([owner, confirmation]);
    assert.equal(ownerResult, "owner");
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < CONTENTION_BUDGET_MS, `confirmation contention exceeded the bounded integration budget (${elapsed}ms; limit ${CONTENTION_BUDGET_MS}ms)`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Ownership, dependencies, and shared contracts ───────────────────────────

test("mapping gives each task one owner and records dependency/shared-contract decisions", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "ownership-a");
    writeFeature(root, "ownership-b");
    const frozen = mapping(await preflight(root, [selection("ownership-a"), selection("ownership-b")]));
    const owners = frozen.task_to_slice as Json[];
    assert.ok(owners.length >= 2);
    const keys = owners.map((owner) => `${String(owner.feature_id)}:${String(owner.task_id)}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const owner of owners) {
      assert.equal(typeof owner.team_id, "string"); assert.equal(typeof owner.slice_id, "string");
      assert.ok(Array.isArray(owner.depends_on)); assert.ok(Array.isArray(owner.requirement_ids));
      assert.ok(Array.isArray(owner.verification_ids));
    }
    for (const contract of frozen.shared_contracts as Json[]) {
      assert.equal(contract.requires_serialization, true); assert.equal(typeof contract.owner, "string");
      assert.ok(Array.isArray(contract.task_ids)); assert.equal(typeof contract.reason, "string");
    }
    for (const decision of frozen.parallelization as Json[]) {
      assert.ok(["parallel", "serial"].includes(String(decision.decision)));
      assert.equal(typeof decision.reason, "string"); assert.ok(Array.isArray(decision.depends_on_slice_ids));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Boundary, stale, and claim conflicts ────────────────────────────────────

test("preflight rejects selections outside the authorized project boundary", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "boundary-safe");
    const result = await preflight(root, [selection("../outside")]);
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /boundary|path|unsafe|unknown|selector/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale handoffs block before confirmation or dispatch", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "stale-feature", "run-stale-feature-1", { stale: true });
    const result = await preflight(root, [selection("stale-feature")]);
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /stale|revalidat|approval/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an active claim owned by another executor blocks admission without takeover", async () => {
  const root = makeProject();
  try {
    const handoff = validImplementationHandoff({ featureId: "claimed-feature" }) as unknown as Json;
    const claim = validExecutionClaim({ handoffDigest: String(handoff.handoff_digest) }) as unknown as Json;
    const fixture = writeFeature(root, "claimed-feature", "run-claimed-feature-1", { claim });
    const before = readFileSync(join(root, fixture.handoffPath), "utf8");
    const result = await preflight(root, [selection("claimed-feature")]);
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /claim|owner|conflict|already/i);
    assert.equal(readFileSync(join(root, fixture.handoffPath), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Independent admission and idempotent mapping identity ────────────────────

test("same-digest active do_work claim blocks preflight with an exact eligible retry", async () => {
  const root = makeProject();
  try {
    const active = writeFeature(root, "same-digest-do-work");
    writeFeature(root, "same-digest-available");
    rewriteHandoff(root, "same-digest-do-work", (handoff) => { handoff.execution_choices = ["cto", "do-work"]; });
    const handoff = JSON.parse(readFileSync(join(root, active.handoffPath), "utf8")) as Json;
    const acquired = acquireExecutionClaim(root, "same-digest-do-work", {
      handoff: handoff as never,
      run_key: "run-same-digest-do-work-1",
      owner_kind: "do_work",
      owner_run_id: "foreign-do-work",
    });
    assert.equal(acquired.ok, true, acquired.ok ? undefined : acquired.error);
    ensureExecutionContext(root);
    const ctoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const stateBefore = readFileSync(ctoStatePath, "utf8");
    const result = await preflight(root, [selection("same-digest-do-work"), selection("same-digest-available")]);
    assert.equal(result.status, "blocked", detail(result));
    assert.equal(result.mapping, undefined, "claim conflict must not persist a mapping");
    assert.deepEqual(result.eligible_selections, [selection("same-digest-available")]);
    assert.deepEqual(result.excluded?.map((entry) => ({ feature_id: entry.feature_id, run_key: entry.run_key })), [selection("same-digest-do-work")]);
    assert.match(detail(result), /do_work|claim|conflict|already/i);
    assert.deepEqual(result.required_next_tool, {
      name: "cto_preflight",
      arguments: { cto_run_id: RUN_ID, selections: [selection("same-digest-available")] },
    });
    assert.equal(readFileSync(ctoStatePath, "utf8"), stateBefore, "blocked preflight must not mutate CTO state");
    assert.equal(existsSync(join(root, ".work-state", "cto", RUN_ID, "specification-mappings")), false, "blocked preflight must not create mapping state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a conflict in one workspace does not poison independent admission", async () => {
  const root = makeProject();
  try {
    const independent = writeFeature(root, "independent-feature");
    const blockedHandoff = validImplementationHandoff({ featureId: "blocked-feature" }) as unknown as Json;
    const blocked = writeFeature(root, "blocked-feature", "run-blocked-feature-1", {
      claim: validExecutionClaim({ handoffDigest: String(blockedHandoff.handoff_digest) }) as unknown as Json,
    });
    assert.equal((await preflight(root, [selection("independent-feature"), selection("blocked-feature")])).status, "blocked");
    const independentOnly = await preflight(root, [selection("independent-feature")]);
    assert.equal(independentOnly.status, "ready", detail(independentOnly));
    const bindings = mapping(independentOnly).handoff_bindings as Json[];
    assert.equal(bindings[0]?.handoff_digest, independent.handoff.handoff_digest);
    assert.notEqual(bindings[0]?.handoff_digest, blocked.handoff.handoff_digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("identical preflights produce one deterministic mapping identity", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "deterministic-feature");
    const first = await preflight(root, [selection("deterministic-feature")]);
    const second = await preflight(root, [selection("deterministic-feature")]);
    assert.equal(first.status, "ready", detail(first)); assert.equal(second.status, "ready", detail(second));
    const firstMapping = mapping(first); const secondMapping = mapping(second);
    assert.equal(firstMapping.mapping_id, secondMapping.mapping_id);
    assert.equal(firstMapping.mapping_hash ?? firstMapping.mapping_digest, secondMapping.mapping_hash ?? secondMapping.mapping_digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("confirmation rejects missing-ledger, tampered, altered-context, and decision replay without persisting mapping confirmation", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "proof-boundary");
    const frozen = mapping(await preflight(root, [selection("proof-boundary")]));
    const before = readFileSync(join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`), "utf8");
    const missing = await confirmCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID, mapping_id: frozen.mapping_id, mapping_hash: frozen.mapping_hash, answer_id: "missing-answer",
    }) as Result;
    assert.equal(missing.status, "blocked");
    const wrongHash = await confirmTrusted(root, frozen, { mappingHash: "f".repeat(64) });
    assert.equal(wrongHash.status, "blocked");
    const unknown = await confirmCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID, mapping_id: frozen.mapping_id, mapping_hash: frozen.mapping_hash, answer_id: "answer-from-another-mapping",
    }) as Result;
    assert.equal(unknown.status, "blocked");
    const storedBefore = readFileSync(join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`), "utf8");
    assert.equal(storedBefore, before, "unknown or stale answer handles must not mutate the mapping");
    const stored = JSON.parse(readFileSync(join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`), "utf8")) as Json;
    assert.equal((stored.mapping as Json).status, "awaiting_confirmation");
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mapping Ask rejects constitution drift before its WAL write", async () => {
  const root = makeProject();
  const featureId = "mapping-ask-constitution-drift";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const ask = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
    });
    assert.equal(ask.status, "ready", JSON.stringify(ask));
    if (ask.status !== "ready") return;
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const beforeState = readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8");
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v2\n\nVersion: 2.0.0\n\n## I. Quality\n\nChanged policy.\n", "utf8");
    const answered = recordCtoSpecificationMappingAsk(root, { ...ask, decision: "approve_continue" } as never, {
      ...preparationRuntimeOptions(root),
      trusted_host: { bridge: {}, question: "", options: [], session_id: DEFAULT_TEST_SESSION_ID },
    });
    assert.equal(answered.status, "blocked", JSON.stringify(answered));
    assert.match(detail(answered), /constitution|impact|changed|pending/i);
    assert.equal(readFileSync(mappingPath, "utf8"), beforeMapping, "constitution drift must not publish a mapping Ask WAL or mapping mutation");
    assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), beforeState, "constitution drift must not mutate feature state");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight direct mapping write rechecks constitution after its final hook", async () => {
  const root = makeProject();
  const featureId = "preflight-direct-write-constitution-drift";
  try {
    writeFeature(root, featureId);
    const constitutionPath = join(root, "CONSTITUTION.md");
    const originalConstitution = readFileSync(constitutionPath, "utf8");
    let invoked = false;
    setCtoSpecificationExecutionTestHooks({
      beforeMappingWrite: ({ operation }) => {
        if (operation !== "preflight" || invoked) return;
        invoked = true;
        writeFileSync(constitutionPath, "# Project Constitution v2\n\nVersion: 2.0.0\n\n## I. Quality\n\nChanged policy.\n", "utf8");
      },
    }, root);
    const first = await preflight(root, [selection(featureId)]);
    assert.equal(invoked, true, "preflight must invoke the deterministic direct-write hook");
    assert.equal(first.status, "blocked", detail(first));
    assert.match(detail(first), /constitution|impact|changed|pending/i);
    const mappingDir = join(root, ".work-state", "cto", RUN_ID, "specification-mappings");
    assert.equal(readdirSync(mappingDir).filter((name) => name.endsWith(".json")).length, 0, "constitution drift must not publish mapping bytes");
    setCtoSpecificationExecutionTestHooks(null, root);
    writeFileSync(constitutionPath, originalConstitution, "utf8");
    const retry = await preflight(root, [selection(featureId)]);
    assert.equal(retry.status, "ready", detail(retry));
  } finally {
    setCtoSpecificationExecutionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping resume direct CAS rechecks constitution after its final hook", async () => {
  const root = makeProject();
  const featureId = "resume-direct-cas-constitution-drift";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const fixtureState = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
    assert.ok(fixtureState.state && fixtureState.statePath);
    if (!fixtureState.state || !fixtureState.statePath) return;
    const dispatchCapability = fixtureState.state.dispatch_capability;
    assert.ok(dispatchCapability?.issued_for);
    if (!dispatchCapability?.issued_for) return;
    writeState(root, {
      ...fixtureState.state,
      dispatch_capability: {
        ...dispatchCapability,
        issued_for: { ...dispatchCapability.issued_for, stage_cursor: "execution" },
      },
    }, { target: fixtureState });
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const ask = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
    });
    assert.equal(ask.status, "ready", JSON.stringify(ask));
    if (ask.status !== "ready") return;
    const answered = await mountedCtoHostAsk(root, ask as Json, "request_changes", "Revise mapping.");
    assert.equal(answered.status, "answered", detail(answered));
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const constitutionPath = join(root, "CONSTITUTION.md");
    const originalConstitution = readFileSync(constitutionPath, "utf8");
    let invoked = false;
    setCtoSpecificationExecutionTestHooks({
      beforeMappingWrite: ({ operation }) => {
        if (operation !== "resume" || invoked) return;
        invoked = true;
        writeFileSync(constitutionPath, "# Project Constitution v2\n\nVersion: 2.0.0\n\n## I. Quality\n\nChanged policy.\n", "utf8");
      },
    }, root);
    const first = resumeCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
      mapping_version: 1,
    });
    assert.equal(invoked, true, "resume must invoke the deterministic direct-CAS hook");
    assert.equal(first.status, "blocked", JSON.stringify(first));
    assert.match(JSON.stringify(first), /constitution|impact|changed|pending/i);
    assert.equal(readFileSync(mappingPath, "utf8"), beforeMapping, "constitution drift must not change mapping bytes");
    setCtoSpecificationExecutionTestHooks(null, root);
    writeFileSync(constitutionPath, originalConstitution, "utf8");
    const retry = resumeCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
      mapping_version: 1,
    });
    assert.equal(retry.status, "resumed", JSON.stringify(retry));
  } finally {
    setCtoSpecificationExecutionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight direct mapping crash child replays the exact visible mapping", async () => {
  const root = makeProject();
  const featureId = "preflight-crash-child";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const input = { cto_run_id: RUN_ID, selections: [selection(featureId)] };
    const exitCode = await spawnCrashAfterMappingWrite(root, "preflight", input);
    assert.equal(exitCode, 73, "child must crash after the direct mapping write");
    const mappingDir = join(root, ".work-state", "cto", RUN_ID, "specification-mappings");
    const names = readdirSync(mappingDir).filter((name) => name.endsWith(".json"));
    assert.equal(names.length, 1, "the direct mapping must be visible before the crash");
    const before = readFileSync(join(mappingDir, names[0]!), "utf8");
    const retry = await preflight(root, [selection(featureId)]);
    assert.equal(retry.status, "ready", detail(retry));
    assert.equal(readFileSync(join(mappingDir, names[0]!), "utf8"), before, "replay must preserve exact mapping bytes");
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping WAL collision preserves a different incumbent descriptor", async () => {
  const root = makeProject();
  const featureId = "mapping-wal-collision";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const confirmationInput = await prepareTrustedConfirmation(root, frozen);
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const beforeState = readFileSync(statePath, "utf8");
    let incumbentPath = "";
    const incumbent = `${JSON.stringify({ incumbent: "different WAL" })}\r\n`;
    let injected = false;
    setCtoSpecificationMappingFailureInjector((point, transactionId) => {
      if (point !== "before_prepare" || injected) return;
      injected = true;
      incumbentPath = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions", `${transactionId}.json`);
      mkdirSync(dirname(incumbentPath), { recursive: true });
      writeFileSync(incumbentPath, incumbent);
    }, root);
    const result = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
    assert.equal(result.status, "blocked", detail(result));
    assert.match(detail(result), /CTO_SPEC_MAPPING_TRANSACTION_CONFLICT/);
    assert.equal(readFileSync(incumbentPath, "utf8"), incumbent, "a different incumbent WAL must not be overwritten");
    assert.equal(readFileSync(mappingPath, "utf8"), beforeMapping, "WAL collision must not mutate canonical mapping");
    assert.equal(readFileSync(statePath, "utf8"), beforeState, "WAL collision must not mutate canonical state");
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct mapping WAL replacement after parse cannot replay or delete a stale descriptor", async () => {
  const root = makeProject();
  const featureId = "direct-mapping-wal-race";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const input = { cto_run_id: RUN_ID, selections: [selection(featureId)] };
    let injected = false;
    setCtoSpecificationMappingFailureInjector((point) => {
      if (!injected && point === "after_mapping_write") {
        injected = true;
        throw new Error("simulated crash after direct mapping publication");
      }
    }, root);
    const interrupted = await preflight(root, [selection(featureId)]);
    assert.equal(interrupted.status, "blocked", detail(interrupted));
    assert.equal(injected, true);
    setCtoSpecificationMappingFailureInjector(null, root);

    const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
    const transactionFiles = readdirSync(transactionDir).filter((name) => name.endsWith(".json"));
    assert.equal(transactionFiles.length, 1);
    const transactionPath = join(transactionDir, transactionFiles[0]!);
    const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as Json;
    assert.equal(transaction.operation, "preflight");
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(transaction.mapping_id)}.json`);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const beforeState = readFileSync(statePath, "utf8");
    const originalWal = readFileSync(transactionPath, "utf8");
    const replacementWal = `${originalWal} `;
    let replacedAfterRead = false;
    setCtoSpecificationMappingFailureInjector((point, transactionId) => {
      if (point === "after_recovery_read" && !replacedAfterRead && transactionId === transaction.transaction_id) {
        replacedAfterRead = true;
        writeFileSync(transactionPath, replacementWal);
      }
    }, root);
    const retry = await preflight(root, input);
    assert.equal(retry.status, "blocked", detail(retry));
    assert.match(detail(retry), /CTO_SPEC_MAPPING_RECOVERY_REQUIRED/);
    assert.equal(replacedAfterRead, true);
    assert.equal(readFileSync(mappingPath, "utf8"), beforeMapping, "receipt mismatch must not replay a stale direct mapping WAL");
    assert.equal(readFileSync(statePath, "utf8"), beforeState, "direct mapping recovery must not touch feature state");
    assert.equal(readFileSync(transactionPath, "utf8"), replacementWal, "receipt mismatch must not delete a replacement WAL");
    assert.equal(existsSync(join(root, ".work-state", "cto", RUN_ID, "specification-mapping-quarantine")), false);
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct mapping recovery restores an unadopted postimage after child constitution drift", async () => {
  const root = makeProject();
  const featureId = "mapping-crash-constitution-drift";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const originalConstitution = readFileSync(join(root, "CONSTITUTION.md"), "utf8");
    const input = { cto_run_id: RUN_ID, selections: [selection(featureId)] };
    const exitCode = await spawnCrashAfterMappingWrite(root, "preflight", input, true);
    assert.equal(exitCode, 73, "child must crash after writing the mapping and changing constitution");
    const mappingDir = join(root, ".work-state", "cto", RUN_ID, "specification-mappings");
    assert.equal(readdirSync(mappingDir).filter((name) => name.endsWith(".json")).length, 1);
    const blocked = await preflight(root, [selection(featureId)]);
    assert.equal(blocked.status, "blocked", detail(blocked));
    assert.equal(readdirSync(mappingDir).filter((name) => name.endsWith(".json")).length, 0, "stale unadopted postimage must be restored to absent preimage");
    writeFileSync(join(root, "CONSTITUTION.md"), originalConstitution, "utf8");
    const retry = await preflight(root, [selection(featureId)]);
    assert.equal(retry.status, "ready", detail(retry));
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping resume crash child replays the exact visible CAS postimage", async () => {
  const root = makeProject();
  const featureId = "resume-crash-child";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const fixtureState = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
    assert.ok(fixtureState.state && fixtureState.statePath);
    if (!fixtureState.state || !fixtureState.statePath) return;
    const dispatchCapability = fixtureState.state.dispatch_capability;
    assert.ok(dispatchCapability?.issued_for);
    if (!dispatchCapability?.issued_for) return;
    writeState(root, {
      ...fixtureState.state,
      dispatch_capability: {
        ...dispatchCapability,
        issued_for: { ...dispatchCapability.issued_for, stage_cursor: "execution" },
      },
    }, { target: fixtureState });
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const ask = deriveCtoSpecificationMappingAskInput(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
    });
    assert.equal(ask.status, "ready", JSON.stringify(ask));
    if (ask.status !== "ready") return;
    const answered = await mountedCtoHostAsk(root, ask as Json, "request_changes", "Revise mapping.");
    assert.equal(answered.status, "answered", detail(answered));
    const resumeInput = {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
      mapping_version: 1,
    };
    const exitCode = await spawnCrashAfterMappingWrite(root, "resume", resumeInput);
    assert.equal(exitCode, 73, "child must crash after the direct resume CAS");
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const visible = readFileSync(mappingPath, "utf8");
    assert.equal((JSON.parse(visible) as Json).mapping && ((JSON.parse(visible) as Json).mapping as Json).status, "awaiting_confirmation");
    const retry = resumeCtoSpecificationMappingForTest(root, resumeInput);
    assert.equal(retry.status, "resumed", JSON.stringify(retry));
    assert.equal(readFileSync(mappingPath, "utf8"), visible, "resume replay must preserve exact mapping postimage");
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid confirmed proof with a staged WAL reopens through fresh trusted Ask", async () => {
  for (const corruption of ["missing", "tampered"] as const) {
    const root = makeProject();
    const featureId = `confirmed-proof-${corruption}`;
    try {
      writeFeature(root, featureId);
      const frozen = mapping(await preflight(root, [selection(featureId)]));
      const first = await confirmTrusted(root, frozen);
      assert.equal(first.status, "confirmed", detail(first));
      const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
      const confirmedBeforeCorruption = readFileSync(mappingPath, "utf8");
      const confirmedRecord = JSON.parse(confirmedBeforeCorruption) as Json;
      const proofRef = String(confirmedRecord.confirmation_proof_ref);
      const proofRelativePath = ctoMappingConfirmationProofRelativePath(RUN_ID, String(frozen.mapping_id), proofRef);
      assert.ok(proofRelativePath, "confirmed mapping must expose a safe proof sidecar path");
      if (!proofRelativePath) continue;
      const proofPath = join(root, proofRelativePath);
      const proofContent = readFileSync(proofPath, "utf8");
      if (corruption === "missing") unlinkSync(proofPath);
      else writeFileSync(proofPath, `${proofContent} `, "utf8");

      const reopened = resumeCtoSpecificationMappingForTest(root, {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
        mapping_version: frozen.mapping_version,
      });
      assert.equal(reopened.status, "resumed", `${corruption} proof must support authenticated resume: ${detail(reopened)}`);
      const awaiting = JSON.parse(readFileSync(mappingPath, "utf8")) as Json;
      assert.equal((awaiting.mapping as Json).status, "awaiting_confirmation");
      assert.equal(awaiting.confirmation_proof_ref, undefined, "resume must strip the invalid proof reference");
      assert.equal(awaiting.trusted_answer_ref, null, "resume must strip the consumed answer reference");

      const freshAsk = deriveCtoSpecificationMappingAskInput(root, {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
      });
      assert.equal(freshAsk.status, "ready", `${corruption} proof recovery must emit a fresh Ask: ${detail(freshAsk)}`);
      const freshAnswer = await prepareTrustedConfirmation(root, frozen);
      const stagedMap = JSON.parse(readFileSync(mappingPath, "utf8")) as Json;
      assert.equal((stagedMap.mapping as Json).status, "awaiting_confirmation");

      let injected = false;
      setCtoSpecificationMappingFailureInjector((point) => {
        if (!injected && point === "after_mapping_write") {
          injected = true;
          throw new Error(`staged ${corruption} proof WAL`);
        }
      }, root);
      const interrupted = await confirmCtoSpecificationMappingForTest(root, freshAnswer);
      assert.equal(interrupted.status, "blocked", detail(interrupted));
      assert.equal(injected, true);
      setCtoSpecificationMappingFailureInjector(null, root);

      const stagedBytes = readFileSync(mappingPath, "utf8");
      const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
      const transactionFiles = readdirSync(transactionDir).filter((name) => name.endsWith(".json"));
      assert.equal(transactionFiles.length, 1, "the staged confirmation must leave one pending WAL");
      const transactionPath = join(transactionDir, transactionFiles[0]!);
      const transactionRaw = readFileSync(transactionPath, "utf8");
      const transaction = JSON.parse(transactionRaw) as Json;
      assert.equal(transaction.operation, "confirm");
      assert.equal(transaction.status, "pending");
      const stagedProofRef = String((JSON.parse(stagedBytes) as Json).confirmation_proof_ref);
      const stagedProofRelativePath = ctoMappingConfirmationProofRelativePath(RUN_ID, String(frozen.mapping_id), stagedProofRef);
      assert.ok(stagedProofRelativePath);
      if (!stagedProofRelativePath) continue;
      const stagedProofPath = join(root, stagedProofRelativePath);
      if (corruption === "missing") unlinkSync(stagedProofPath);
      else writeFileSync(stagedProofPath, `${readFileSync(stagedProofPath, "utf8")} `, "utf8");
      const statePath = join(root, ".work-state", "features", featureId, "state.json");
      const stateBeforeRecovery = readFileSync(statePath, "utf8");
      const proofBeforeRecovery = existsSync(stagedProofPath) ? readFileSync(stagedProofPath, "utf8") : null;

      const recovery = await preflightCtoSpecificationExecutionForTest(root, { cto_run_id: RUN_ID, selections: [] });
      assert.equal(recovery.status, "blocked", detail(recovery));
      assert.match(detail(recovery), /RECOVERY_REQUIRED|proof/i);
      assert.equal(readFileSync(mappingPath, "utf8"), stagedBytes, "invalid proof recovery must not mutate the canonical confirmed map");
      assert.equal(readFileSync(statePath, "utf8"), stateBeforeRecovery, "invalid proof recovery must not mutate canonical feature state");
      if (proofBeforeRecovery === null) assert.equal(existsSync(stagedProofPath), false, "deleted proof must remain absent after WAL archive");
      else assert.equal(readFileSync(stagedProofPath, "utf8"), proofBeforeRecovery, "tampered proof bytes must remain unchanged after WAL archive");
      assert.equal(existsSync(transactionPath), false, "invalid confirmation WAL must be archived, not replayed");
      const quarantineDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-quarantine");
      const quarantineName = readdirSync(quarantineDir).find((name) => name.includes(String(transaction.transaction_id)) && name.endsWith("-confirm-proof-invalid.json"));
      assert.ok(quarantineName, "invalid confirmation WAL must have an exact audit archive");
      assert.equal(readFileSync(join(quarantineDir, quarantineName!), "utf8"), transactionRaw, "WAL archive must preserve exact bytes");

      const resumed = resumeCtoSpecificationMappingForTest(root, {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
        mapping_version: frozen.mapping_version,
      });
      assert.equal(resumed.status, "resumed", `${corruption} staged WAL must be recoverable by one authenticated resume: ${detail(resumed)}`);
      const reopenedAfterWal = JSON.parse(readFileSync(mappingPath, "utf8")) as Json;
      assert.equal((reopenedAfterWal.mapping as Json).status, "awaiting_confirmation");
      const nextAsk = deriveCtoSpecificationMappingAskInput(root, {
        cto_run_id: RUN_ID,
        mapping_id: frozen.mapping_id,
        mapping_hash: frozen.mapping_hash,
      });
      assert.equal(nextAsk.status, "ready", `${corruption} recovery must make a fresh Ask available: ${detail(nextAsk)}`);
      const finalAnswer = await prepareTrustedConfirmation(root, frozen);
      const confirmedAgain = await confirmCtoSpecificationMappingForTest(root, finalAnswer);
      assert.equal(confirmedAgain.status, "confirmed", `${corruption} fresh answer must reconfirm: ${detail(confirmedAgain)}`);
    } finally {
      setCtoSpecificationMappingFailureInjector(null, root);
      executionContexts.delete(root);
      projectFeatures.delete(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("valid confirmed proof rejects resume without trusting forged confirmation WALs", async () => {
  const root = makeProject();
  const featureId = "confirmed-proof-valid";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const confirmedRecord = JSON.parse(beforeMapping) as Json;
    const proofPath = ctoMappingConfirmationProofRelativePath(RUN_ID, String(frozen.mapping_id), String(confirmedRecord.confirmation_proof_ref));
    assert.ok(proofPath, "valid confirmed mapping must expose a safe proof path");
    if (!proofPath) return;
    const beforeProof = readFileSync(join(root, proofPath), "utf8");
    const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
    mkdirSync(transactionDir, { recursive: true });
    for (const [transactionId, mappingId] of [["forged-confirm-same", String(frozen.mapping_id)], ["forged-confirm-unrelated", "forged-unrelated-mapping"]] as const) {
      writeFileSync(join(transactionDir, `${transactionId}.json`), JSON.stringify({
        schema_version: 1,
        transaction_id: transactionId,
        cto_run_id: RUN_ID,
        operation: "confirm",
        mapping_id: mappingId,
        confirmation_transaction_hmac: "forged",
      }) + "\n", "utf8");
    }
    const rejected = resumeCtoSpecificationMappingForTest(root, {
      cto_run_id: RUN_ID,
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      mapping_version: frozen.mapping_version,
    });
    assert.equal(rejected.status, "blocked", detail(rejected));
    assert.match(detail(rejected), /valid durable proof|takeover/i);
    assert.equal(readFileSync(mappingPath, "utf8"), beforeMapping, "valid confirmed mapping bytes must remain unchanged");
    assert.equal(readFileSync(join(root, proofPath), "utf8"), beforeProof, "forged WALs must not mutate a valid confirmation proof sidecar");
    assert.equal(readdirSync(transactionDir).filter((name) => name.endsWith(".json")).length, 0, "forged WALs must not remain replayable");
    const quarantineDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-quarantine");
    assert.equal(readdirSync(quarantineDir).filter((name) => name.endsWith("-confirm-invalid.json")).length, 2, "same and unrelated forged WALs must be archived");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending mapping WAL remains recoverable and unapplied after constitution drift", async () => {
  const root = makeProject();
  const featureId = "mapping-recovery-constitution-drift";
  try {
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    const confirmationInput = await prepareTrustedConfirmation(root, frozen);
    let injected = false;
    setCtoSpecificationMappingFailureInjector((point) => {
      if (point === "after_prepare" && !injected) { injected = true; throw new Error("constitution-drift-recovery"); }
    }, root);
    const first = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
    assert.equal(first.status, "blocked", detail(first));
    assert.equal(injected, true, "confirmation must leave a pending WAL after the injected crash seam");
    setCtoSpecificationMappingFailureInjector(null, root);
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const beforeMapping = readFileSync(mappingPath, "utf8");
    const beforeState = readFileSync(statePath, "utf8");
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v2\n\nVersion: 2.0.0\n\n## I. Quality\n\nChanged policy.\n", "utf8");
    const recovery = await preflight(root, []);
    assert.equal(recovery.status, "blocked", detail(recovery));
    assert.match(detail(recovery), /constitution|impact|changed|pending/i);
    assert.equal(readFileSync(mappingPath, "utf8"), beforeMapping, "constitution drift recovery must not apply the staged mapping");
    assert.equal(readFileSync(statePath, "utf8"), beforeState, "constitution drift recovery must not consume the trusted answer");
    const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
    const files = readdirSync(transactionDir).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, "constitution drift must retain one recoverable WAL");
    const transaction = JSON.parse(readFileSync(join(transactionDir, files[0]!), "utf8")) as Json;
    assert.equal(transaction.status, "pending", "constitution drift must not terminally abort the WAL");
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping confirmation WAL recovers proof consumption across every mapping/state write boundary", async () => {
  const failurePoints = [
    "before_prepare",
    "after_prepare",
    "before_mapping_write",
    "after_mapping_write",
    "before_state_write",
    "after_state_write",
    "after_commit",
  ] as const;
  for (const failurePoint of failurePoints) {
    const root = makeProject();
    try {
      writeFeature(root, `mapping-recovery-${failurePoint}`);
      const frozen = mapping(await preflight(root, [selection(`mapping-recovery-${failurePoint}`)]));
      let injected = false;
      setCtoSpecificationMappingFailureInjector((point) => {
        if (!injected && point === failurePoint) {
          injected = true;
          throw new Error(`injected ${point}`);
        }
      }, root);
      const first = await confirmTrusted(root, frozen);
      assert.equal(first.status, "blocked", `${failurePoint} must leave a recoverable transaction`);
      setCtoSpecificationMappingFailureInjector(null, root);

      let retry = await confirmTrusted(root, frozen);
      if (failurePoint === "after_mapping_write" || failurePoint === "before_state_write") {
        assert.equal(retry.status, "blocked", `${failurePoint} must fail closed with an unapplied answer WAL: ${JSON.stringify(retry)}`);
        assert.match(detail(retry), /trusted answer|recovery_required|canonical ledger/i);
        continue;
      }
      if (retry.status === "blocked" && /ANSWER_RECOVERY_REQUIRED|recovery_required/i.test(detail(retry))) {
        retry = await confirmTrusted(root, frozen);
      }
      assert.equal(retry.status, "confirmed", `${failurePoint} retry must converge confirmation: ${JSON.stringify(retry)}`);
      const stored = JSON.parse(readFileSync(join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`), "utf8")) as Json;
      assert.equal((stored.mapping as Json).status, "confirmed");
      const context = executionContexts.get(root)!;
      const selected = resolveState(root, undefined, { feature_id: context.feature_id, run_key: context.run_key });
      const trustedAnswerRef = (stored as Json).trusted_answer_ref;
      assert.equal(typeof trustedAnswerRef, "string");
      assert.ok(selected.state?.trusted_checkpoint_answers?.find((answer) => answer.answer_id === trustedAnswerRef)?.consumed_at);
    } finally {
      setCtoSpecificationMappingFailureInjector(null, root);
      rmSync(root, { recursive: true, force: true });
      executionContexts.delete(root);
      projectFeatures.delete(root);
    }
  }
});

test("mapping WAL enforces serialized byte cap before publication", async () => {
  for (const answerCount of [20, 70]) {
    const root = makeProject();
    try {
      const featureId = "mapping-wal-size-" + answerCount;
      writeFeature(root, featureId);
      testRuntimeAccess(root, DEFAULT_TEST_SESSION_ID);
      const frozen = mapping(await preflight(root, [selection(featureId)]));
      const confirmationInput = await prepareTrustedConfirmation(root, frozen);
      let selected = resolveState(root, undefined, selection(featureId));
      assert.ok(selected.state && selected.statePath, "size fixture needs a canonical feature state");
      if (!selected.state || !selected.statePath) continue;
      const baseAnswer = selected.state.trusted_checkpoint_answers?.find((answer) => answer.answer_id === confirmationInput.answer_id);
      assert.ok(baseAnswer, "size fixture host Ask must leave an authenticated answer");
      if (!baseAnswer) continue;
      let padded = selected.state;
      for (let index = 0; index < answerCount; index += 1) {
        padded = {
          ...padded,
          trusted_checkpoint_answers: [
            ...(padded.trusted_checkpoint_answers ?? []),
            { ...baseAnswer, answer_id: "padding-answer-" + index, reference: "padding/" + String(index) + "/" + "x".repeat(3900) },
          ],
        };
      }
      writeState(root, padded, { target: selected });
      const before = readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8");
      if (answerCount === 20) {
        let injected = false;
        setCtoSpecificationMappingFailureInjector((point) => { if (point === "after_prepare" && !injected) { injected = true; throw new Error("size-boundary-recovery"); } }, root);
        const interrupted = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
        assert.equal(interrupted.status, "blocked", detail(interrupted));
        setCtoSpecificationMappingFailureInjector(null, root);
        const txDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
        const txFiles = readdirSync(txDir).filter((name) => name.endsWith(".json"));
        assert.equal(txFiles.length, 1, "under-cap transaction must remain recoverable after injected WAL interruption");
        assert.ok(statSync(join(txDir, txFiles[0]!)).size <= 512 * 1024, "recoverable transaction must remain within reader cap");
        const retry = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
        assert.equal(retry.status, "confirmed", detail(retry));
      } else {
        const rejected = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
        assert.equal(rejected.status, "blocked", detail(rejected));
        assert.match(detail(rejected), /transaction WAL exceeds|mapping confirmation persistence failed/i);
        assert.equal(readFileSync(join(root, ".work-state", "features", featureId, "state.json"), "utf8"), before, "oversized transaction must not mutate feature state");
        const txDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
        assert.deepEqual(existsSync(txDir) ? readdirSync(txDir).filter((name) => name.endsWith(".json")) : [], [], "oversized transaction must not publish a WAL");
      }
    } finally {
      setCtoSpecificationMappingFailureInjector(null, root);
      executionContexts.delete(root);
      projectFeatures.delete(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("mapping commit rejects a root swap without writing the replacement root", async () => {
  const root = makeProject();
  const outside = makeProject();
  const moved = root + ".opened";
  let swapped = false;
  const originalOpen = PinnedProjectRoot.open;
  try {
    writeFeature(root, "mapping-root-swap");
    const frozen = mapping(await preflight(root, [selection("mapping-root-swap")]));
    const result = await confirmTrusted(root, frozen, {
      beforeInvoke: () => {
        PinnedProjectRoot.open = (projectRoot, hooks = {}) => originalOpen(projectRoot, {
          ...hooks,
          beforeRename: (relativePath) => {
            hooks.beforeRename?.(relativePath);
            if (swapped) return;
            swapped = true;
            renameSync(root, moved);
            symlinkSync(outside, root, "dir");
          },
        });
      },
    });
    assert.equal(result.status, "blocked", detail(result));
    assert.equal(swapped, true, "the mapping commit must reach the pinned write boundary");
    assert.deepEqual(readdirSync(outside), [], "replacement root must remain untouched by mapping commit/rollback");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    executionContexts.delete(root);
    projectFeatures.delete(root);
  }
});

test("confirmation WAL and commit reject root swaps without touching the replacement root", async () => {
  for (const swapPoint of ["before_prepare", "after_prepare"] as const) {
    const root = makeProject();
    const outside = makeProject();
    const moved = root + ".opened";
    let swapped = false;
    try {
      const featureId = "wal-root-swap-" + swapPoint;
      writeFeature(root, featureId);
      const frozen = mapping(await preflight(root, [selection(featureId)]));
      setCtoSpecificationMappingFailureInjector((point) => {
        if (point !== swapPoint || swapped) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      }, root);
      const result = await confirmTrusted(root, frozen);
      assert.equal(result.status, "blocked", swapPoint + " root swap must fail closed: " + detail(result));
      assert.equal(swapped, true, swapPoint + " seam must execute");
      assert.deepEqual(readdirSync(outside), [], swapPoint + " replacement root must remain untouched");
    } finally {
      setCtoSpecificationMappingFailureInjector(null, root);
      if (swapped) {
        rmSync(root, { recursive: true, force: true });
        renameSync(moved, root);
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      executionContexts.delete(root);
      projectFeatures.delete(root);
    }
  }
});

test("mapping state CAS preserves a concurrent canonical mutation instead of overwriting it", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "mapping-state-race");
    writeFeature(root, "mapping-state-race-other");
    const frozen = mapping(await preflight(root, [selection("mapping-state-race"), selection("mapping-state-race-other")]));
    let mutated = false;
    let mutationSucceeded = false;
    setCtoSpecificationMappingFailureInjector((point) => {
      if (point !== "before_state_write" || mutated) return;
      mutated = true;
      const selected = resolveState(root, undefined, selection("mapping-state-race"));
      assert.ok(selected.state && selected.statePath);
      if (!selected.state || !selected.statePath) return;
      const updated = updateStateAtomically<null>(
        root,
        (snapshot) => snapshot.state
          ? { op: "commit", state: { ...snapshot.state, task: "concurrent canonical update" }, value: null }
          : { op: "fail", code: "state_missing", error: "mapping race state missing" },
        { selector: { feature_id: "mapping-state-race", run_key: "run-mapping-state-race-1" } },
      );
      mutationSucceeded = updated.ok;
    }, root);
    const result = await confirmTrusted(root, frozen);
    assert.equal(mutated, true, "the deterministic interleaving must reach the production state transaction boundary");
    assert.equal(mutationSucceeded, true, "the concurrent canonical mutation uses the production state transaction");
    assert.equal(result.status, "blocked", "mapping confirmation must fail closed after a concurrent state mutation");
    setCtoSpecificationMappingFailureInjector(null, root);
    const selected = resolveState(root, undefined, selection("mapping-state-race"));
    assert.equal(selected.state?.task, "concurrent canonical update", "the concurrent canonical update must survive the rejected staged commit");
    assert.equal(selected.state?.trusted_checkpoint_answers?.find((answer) => answer.answer_id === `answer-${String(frozen.mapping_id)}`)?.consumed_at, undefined, "state CAS failure must not consume the trusted proof");
    const mappingFile = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    const restored = JSON.parse(readFileSync(mappingFile, "utf8")) as Json;
    assert.equal((restored.mapping as Json).status, "awaiting_confirmation", "state CAS conflict must restore the prior awaiting mapping");
    const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
    const transactionFiles = readdirSync(transactionDir).filter((name) => name.endsWith(".json"));
    assert.equal(transactionFiles.length, 1, "terminal abort WAL must remain as audit history");
    const transaction = JSON.parse(readFileSync(join(transactionDir, transactionFiles[0]!), "utf8")) as Json;
    assert.equal(transaction.status, "aborted");
    assert.equal(transaction.terminal_disposition, "aborted");
    assert.equal(typeof transaction.abort_reason, "string");
    assert.equal(typeof transaction.terminal_at, "string");
    assert.equal((transaction.mapping_before_content as string).length > 0, true);
    assert.deepEqual(transaction.staged_mapping_identity as Json, {
      mapping_id: frozen.mapping_id,
      mapping_hash: frozen.mapping_hash,
      content_digest: transaction.mapping_after_digest,
    });
    const staleDispatch = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(staleDispatch.status, "blocked", "a conflicted mapping must not dispatch before fresh confirmation");
    const retryPreflight = await preflight(root, [selection("mapping-state-race"), selection("mapping-state-race-other")]);
    assert.equal(retryPreflight.status, "ready", detail(retryPreflight));
    assert.equal((await confirmTrusted(root, mapping(retryPreflight))).status, "confirmed", "fresh confirmation must consume the still-unconsumed proof");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping WAL quarantines a self-consistent unrelated staged state before any state write", async () => {
  const root = makeProject();
  try {
    const featureId = "mapping-forged-state";
    writeFeature(root, featureId);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    let forged = false;
    setCtoSpecificationMappingFailureInjector((point) => {
      if (point !== "after_prepare" || forged) return;
      forged = true;
      const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
      const transactionFile = readdirSync(transactionDir).find((name) => name.endsWith(".json"));
      assert.ok(transactionFile);
      const transactionPath = join(transactionDir, transactionFile!);
      const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as Json;
      const forgedState = { ...(transaction.state as Json), task: "unrelated forged TeamState" };
      const stateDigestBody = { ...forgedState };
      delete stateDigestBody.updated_at;
      delete stateDigestBody.state_revision;
      transaction.state = forgedState;
      transaction.state_after_digest = sha256Hex(canonicalJson(stateDigestBody));
      writeFileSync(transactionPath, JSON.stringify(transaction, null, 2) + "\n");
      throw new Error("injected forged WAL");
    }, root);
    const first = await confirmTrusted(root, frozen);
    assert.equal(first.status, "blocked", detail(first));
    assert.equal(forged, true, `the test must interrupt after publishing the forged WAL: ${detail(first)}`);
    setCtoSpecificationMappingFailureInjector(null, root);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateAfterInterruptedCommit = readFileSync(statePath, "utf8");
    const recovery = prepareCtoSpecificationMappingAsk(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      mapping_hash: String(frozen.mapping_hash),
      mapping_version: Number(frozen.mapping_version),
      feature_id: featureId,
      run_key: `run-${featureId}-1`,
      stage_id: "execution",
      decision: "approve_continue",
    } as Json, preparationRuntimeOptions(root));
    assert.equal(recovery.status, "blocked", detail(recovery));
    assert.match(detail(recovery), /ANSWER_RECOVERY_REQUIRED|recovery_required|fresh trusted terminal Ask/i);
    assert.equal(readFileSync(statePath, "utf8"), stateAfterInterruptedCommit, "invalid WAL recovery must not mutate feature state");
    const quarantineDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-quarantine");
    assert.equal(readdirSync(quarantineDir).some((name) => name.endsWith("-invalid.json")), true, "invalid WAL must be retained in quarantine");
    assert.equal(readdirSync(join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions")).filter((name) => name.endsWith(".json")).length, 0, "invalid WAL must not remain replayable");
  } finally {
    setCtoSpecificationMappingFailureInjector(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("state CAS abort recovery is idempotent across every abort boundary", async () => {
  const failurePoints = [
    "before_abort",
    "before_abort_prepare",
    "after_abort_prepare",
    "before_abort_mapping_write",
    "after_abort_mapping_write",
    "before_abort_terminal",
    "after_abort_terminal",
  ] as const;
  for (const failurePoint of failurePoints) {
    const root = makeProject();
    try {
      const feature = `mapping-abort-${failurePoint}`;
      writeFeature(root, feature);
      const frozen = mapping(await preflight(root, [selection(feature)]));
      const confirmationInput = await prepareTrustedConfirmation(root, frozen);
      let mutated = false;
      let injected = false;
      setCtoSpecificationMappingFailureInjector((point) => {
        if (point === "before_state_write" && !mutated) {
          mutated = true;
          const changed = updateStateAtomically<null>(
            root,
            (snapshot) => snapshot.state
              ? { op: "commit", state: { ...snapshot.state, task: "abort boundary concurrent update" }, value: null }
              : { op: "fail", code: "state_missing", error: "abort boundary state missing" },
            { selector: { feature_id: feature, run_key: `run-${feature}-1` } },
          );
          assert.equal(changed.ok, true);
        }
        if (point === failurePoint && !injected) {
          injected = true;
          throw new Error(`injected ${point}`);
        }
      }, root);
      const first = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
      assert.equal(first.status, "blocked", `${failurePoint} must fail before recovery`);
      setCtoSpecificationMappingFailureInjector(null, root);
      const retry = await confirmCtoSpecificationMappingForTest(root, confirmationInput);
      assert.equal(retry.status, "confirmed", `${failurePoint} retry must converge: ${JSON.stringify(retry)}`);
      const transactionDir = join(root, ".work-state", "cto", RUN_ID, "specification-mapping-transactions");
      const files = readdirSync(transactionDir).filter((name) => name.endsWith(".json"));
      assert.equal(files.length, 1);
      const terminal = JSON.parse(readFileSync(join(transactionDir, files[0]!), "utf8")) as Json;
      assert.equal(terminal.status, "aborted");
      assert.equal(typeof terminal.abort_reason, "string");
      assert.equal(typeof terminal.terminal_at, "string");
    } finally {
      setCtoSpecificationMappingFailureInjector(null, root);
      rmSync(root, { recursive: true, force: true });
      executionContexts.delete(root);
      projectFeatures.delete(root);
    }
  }
});

test("cross-feature overlapping and ancestor scopes share one qualified contract and admit one owner at a time", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "scope-parent");
    writeFeature(root, "scope-child");
    rewriteHandoff(root, "scope-parent", (handoff) => { (handoff.tasks as Json[])[0]!.affected_scope = ["src/shared"]; handoff.scope = { ...(handoff.scope as Json), constraints: [] }; });
    rewriteHandoff(root, "scope-child", (handoff) => { (handoff.tasks as Json[])[0]!.affected_scope = ["src/shared/file.ts"]; handoff.scope = { ...(handoff.scope as Json), constraints: [] }; });
    // The engine anchor is one exact frozen ready selection; keep it first.
    const frozen = mapping(await preflight(root, [selection("scope-child"), selection("scope-parent")]));
    const overlap = (frozen.shared_contracts as Json[]).find((contract) => String(contract.contract).includes("src/shared"));
    assert.ok(overlap);
    const qualified = overlap.task_ids as string[];
    assert.deepEqual(qualified.map((identity) => (JSON.parse(identity) as Json).feature_id).sort(), ["scope-child", "scope-parent"]);
    const constrained = (frozen.parallelization as Json[]).filter((decision) => (decision.shared_contract_ids as string[]).includes(String(overlap.contract_id)));
    assert.equal(constrained.length, 2, "the same deterministic contract is attached to every owner slice");
    assert.match(String(overlap.reason), /scope-child|scope-parent|owner/i);
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, { cto_run_id: RUN_ID, mapping_id: String(frozen.mapping_id), expected_mapping_hash: String(frozen.mapping_hash) }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    assert.equal((dispatched.admitted_slices as string[]).length, 1, "shared owners are never claimed simultaneously");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mapping and handoff symlinks fail closed", async () => {
  const root = makeProject();
  const outside = makeProject();
  try {
    const fixture = writeFeature(root, "symlink-boundary");
    ensureExecutionContext(root);
    const mappingDir = join(root, ".work-state", "cto", RUN_ID, "specification-mappings");
    symlinkSync(outside, mappingDir);
    const mappingBlocked = await preflightCtoSpecificationExecutionForTest(root, { cto_run_id: RUN_ID, selections: [selection("symlink-boundary")] }) as Result;
    assert.equal(mappingBlocked.status, "blocked");
    unlinkSync(mappingDir);
    const outsideHandoff = join(outside, "handoff.json");
    writeFileSync(outsideHandoff, readFileSync(join(root, fixture.handoffPath)));
    unlinkSync(join(root, fixture.handoffPath));
    symlinkSync(outsideHandoff, join(root, fixture.handoffPath));
    const handoffBlocked = await preflight(root, [selection("symlink-boundary")]);
    assert.equal(handoffBlocked.status, "blocked");
    assert.match(detail(handoffBlocked), /symlink|boundary|outside|artifact/i);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("canonical handoff reads enforce max and max+1 byte boundaries before JSON parsing", async () => {
  const root = makeProject();
  const featureId = "handoff-byte-boundary";
  const limit = 8 * 1024 * 1024;
  try {
    const fixture = writeFeature(root, featureId);
    ensureExecutionContext(root);
    const handoffPath = join(root, fixture.handoffPath);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const stateBefore = readFileSync(statePath);
    const invoke = () => preflightCtoSpecificationExecutionForTest(
      root,
      { cto_run_id: RUN_ID, selections: [selection(featureId)] },
    ) as Result;

    const largeState = Buffer.concat([stateBefore, Buffer.alloc(1024 * 1024, 0x20)]);
    writeFileSync(statePath, largeState);
    const largeStateResult = await invoke();
    assert.doesNotMatch(detail(largeStateResult), /exceeds the bounded read limit/i, "feature state over 1MiB must use the shared 8MiB reader cap");
    assert.equal(largeStateResult.status, "ready", detail(largeStateResult));
    writeFileSync(statePath, stateBefore);

    // Exactly the limit is read and then rejected by strict JSON parsing.
    writeFileSync(handoffPath, Buffer.alloc(limit, 0x20));
    const atLimit = await invoke();
    assert.equal(atLimit.status, "blocked");
    assert.match(detail(atLimit), /invalid JSON|unreadable|invalid/i);
    assert.doesNotMatch(detail(atLimit), /exceeds the bounded read limit/i);
    assert.deepEqual(readFileSync(statePath), stateBefore, "preflight must not mutate feature state");

    // truncateSync creates a sparse file without allocating its body; max+1
    // must fail before a bounded reader allocates or parses the content.
    truncateSync(handoffPath, limit + 1);
    assert.equal(statSync(handoffPath).size, limit + 1);
    const overLimit = await invoke();
    assert.equal(overLimit.status, "blocked");
    assert.match(detail(overLimit), /exceeds the bounded read limit|bounded read limit/i);
    assert.deepEqual(readFileSync(statePath), stateBefore, "oversized preflight must not mutate feature state");

    writeFileSync(handoffPath, Buffer.from([0xff, 0xfe, 0x7b]));
    const malformedUtf8 = await invoke();
    assert.equal(malformedUtf8.status, "blocked");
    assert.match(detail(malformedUtf8), /UTF-8/i);
    assert.deepEqual(readFileSync(statePath), stateBefore, "malformed input must not mutate feature state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects legacy workspace migration without persisting and repeats deterministically", async () => {
  const root = makeProject();
  const featureId = "legacy-preflight";
  try {
    writeFeature(root, featureId);
    ensureExecutionContext(root);
    const statePath = join(root, ".work-state", "features", featureId, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    const workspace = state.specification as Json;
    workspace.schema_version = 2;
    delete workspace.path_binding;
    writeFileSync(statePath, JSON.stringify(state));
    const beforeBytes = readFileSync(statePath);
    const beforeStat = statSync(statePath);
    const first = await preflight(root, [selection(featureId)]);
    const second = await preflight(root, [selection(featureId)]);
    assert.equal(first.status, "blocked", detail(first));
    assert.equal(second.status, "blocked", detail(second));
    assert.deepEqual(second, first, "repeated migration-required preflights must be deterministic");
    assert.match(detail(first), /migration|required/i);
    assert.deepEqual(readFileSync(statePath), beforeBytes, "pure preflight must not persist legacy workspace migration");
    const afterStat = statSync(statePath);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStat.ctimeMs, beforeStat.ctimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical handoff reads reject parent and project-root swaps", async () => {
  const root = makeProject();
  const featureId = "handoff-path-race";
  const parent = join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff");
  const displacedParent = `${parent}.displaced`;
  const displacedRoot = `${root}.displaced`;
  try {
    const fixture = writeFeature(root, featureId);
    ensureExecutionContext(root);
    const invoke = () => preflightCtoSpecificationExecutionForTest(
      root,
      { cto_run_id: RUN_ID, selections: [selection(featureId)] },
    ) as Result;

    setCtoGateHandoffReadTestHooks({
      afterRead: ({ relative_path }) => {
        if (relative_path !== fixture.handoffPath) return;
        renameSync(parent, displacedParent);
        mkdirSync(parent, { recursive: true });
      },
    }, root);
    const parentSwap = await invoke();
    assert.equal(parentSwap.status, "blocked");
    assert.match(detail(parentSwap), /changed|missing|artifact|symlink/i);
    setCtoGateHandoffReadTestHooks(null, root);
    rmSync(parent, { recursive: true, force: true });
    renameSync(displacedParent, parent);

    setCtoGateHandoffReadTestHooks({
      afterRead: ({ relative_path }) => {
        if (relative_path !== fixture.handoffPath) return;
        renameSync(root, displacedRoot);
        mkdirSync(root, { recursive: true });
      },
    }, root);
    const rootSwap = await invoke();
    assert.equal(rootSwap.status, "blocked");
    assert.match(detail(rootSwap), /changed|root|artifact/i);
  } finally {
    setCtoGateHandoffReadTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
    rmSync(displacedRoot, { recursive: true, force: true });
    rmSync(displacedParent, { recursive: true, force: true });
  }
});

test("replayed active claims survive a later admission failure", async () => {
  const root = makeProject();
  const outside = makeProject();
  const activeFeature = "replay-active-a";
  const failingFeature = "replay-failing-b";
  try {
    writeFeature(root, activeFeature);
    writeFeature(root, failingFeature);
    for (const feature of [activeFeature, failingFeature]) rewriteHandoff(root, feature, (handoff) => {
      (handoff.tasks as Json[])[0]!.parallel_safe = true;
      (handoff.tasks as Json[])[0]!.affected_scope = [`src/${feature}.ts`];
      handoff.scope = { ...(handoff.scope as Json), constraints: [] };
    });
    migrateFeatureWorkspaceToSchema3(root, activeFeature, `run-${activeFeature}-1`);
    migrateFeatureWorkspaceToSchema3(root, failingFeature, `run-${failingFeature}-1`);
    const frozen = mapping(await preflight(root, [selection(activeFeature), selection(failingFeature)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const bOwner = (frozen.task_to_slice as Json[]).find((owner) => owner.feature_id === failingFeature);
    const aOwner = (frozen.task_to_slice as Json[]).find((owner) => owner.feature_id === activeFeature);
    assert.ok(bOwner, "the frozen mapping must contain the later feature slice");
    assert.ok(aOwner, "the frozen mapping must contain the active feature slice");
    if (!bOwner || !aOwner) return;
    const setSliceStatus = (sliceId: string, status: "pending" | "done") => {
      const state = readCtoState(RUN_ID, root);
      assert.ok(state, "active CTO state must remain readable");
      if (!state) return;
      writeCtoState({ ...state, teams: state.teams.map((team) => team.slice_id === sliceId ? { ...team, status } : team) }, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    };
    const first = await dispatchCtoSpecificationMapping(root, { cto_run_id: RUN_ID, mapping_id: String(frozen.mapping_id), expected_mapping_hash: String(frozen.mapping_hash) }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(first.status, "dispatched", detail(first));
    completeMountedCtoExecutionTeams(root, { featureIds: [failingFeature], failedFeatureIds: [failingFeature] });
    setSliceStatus(String(aOwner.slice_id), "pending");
    assert.equal((first.admitted_slices as string[]).length, 2, "the first dispatch admits both slices before the later failing admission");
    const firstClaims = readExecutionClaimStore(root, activeFeature);
    assert.equal(firstClaims.ok, true, firstClaims.ok ? "" : firstClaims.error);
    if (firstClaims.ok) assert.equal(firstClaims.value.at(-1)?.status, "active");
    // The real claim path is pre-created during schema-3 migration; replace
    // that directory explicitly before installing the attack symlink.
    rmSync(join(root, ".work-state", "features", failingFeature, "artifacts", "execution_claim"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".work-state", "features", failingFeature, "artifacts", "execution_claim"), "dir");
    const retry = await dispatchCtoSpecificationMapping(root, { cto_run_id: RUN_ID, mapping_id: String(frozen.mapping_id), expected_mapping_hash: String(frozen.mapping_hash) }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(retry.status, "blocked", detail(retry));
    const retryOutcomes = retry.outcomes as Json[];
    assert.equal(retryOutcomes.find((outcome) => outcome.feature_id === activeFeature)?.status, "claimed");
    assert.match(detail(retry), new RegExp(`${failingFeature}.*not pending dispatch.*failed`, "i"));
    const activeAfterReplay = readCurrentExecutionClaim(root, activeFeature);
    assert.equal(activeAfterReplay.ok, true, activeAfterReplay.ok ? "" : activeAfterReplay.error);
    if (activeAfterReplay.ok) assert.equal(activeAfterReplay.value?.status, "active", "exact replay must not be compensated");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("per-feature late claim persistence failure reports live successes and retry claims the repaired feature", async () => {
  const root = makeProject();
  const outside = makeProject();
  try {
    writeFeature(root, "atomic-a"); writeFeature(root, "atomic-b");
    for (const feature of ["atomic-a", "atomic-b"]) rewriteHandoff(root, feature, (handoff) => { (handoff.tasks as Json[])[0]!.parallel_safe = true; (handoff.tasks as Json[])[0]!.affected_scope = [`src/${feature}.ts`]; handoff.scope = { ...(handoff.scope as Json), constraints: [] }; });
    migrateFeatureWorkspaceToSchema3(root, "atomic-a", "run-atomic-a-1");
    migrateFeatureWorkspaceToSchema3(root, "atomic-b", "run-atomic-b-1");
    const frozen = mapping(await preflight(root, [selection("atomic-a"), selection("atomic-b")]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const brokenClaimDir = join(root, ".work-state", "features", "atomic-b", "artifacts", "execution_claim");
    const originalClaimDir = `${brokenClaimDir}.original`;
    renameSync(brokenClaimDir, originalClaimDir);
    symlinkSync(outside, brokenClaimDir);
    const first = await dispatchCtoSpecificationMapping(root, { cto_run_id: RUN_ID, mapping_id: String(frozen.mapping_id), expected_mapping_hash: String(frozen.mapping_hash) }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(first.status, "blocked", detail(first));
    const firstOutcomes = first.outcomes as Json[];
    assert.equal(firstOutcomes.find((outcome) => outcome.feature_id === "atomic-a")?.status, "claimed");
    assert.equal(firstOutcomes.find((outcome) => outcome.feature_id === "atomic-b")?.status, "blocked");
    const rolledBack = readExecutionClaimStore(root, "atomic-a");
    assert.equal(rolledBack.ok, true, rolledBack.ok ? "" : rolledBack.error);
    if (rolledBack.ok) {
      assert.equal(rolledBack.value.at(-1)?.status, "released", "rollback leaves a terminal audit record");
      const current = readCurrentExecutionClaim(root, "atomic-a");
      assert.equal(current.ok, true, current.ok ? "" : current.error);
      if (current.ok) assert.equal(current.value, null, "released claim is terminal audit history, not live authority");
    }
    rmSync(brokenClaimDir, { recursive: true, force: true });
    renameSync(originalClaimDir, brokenClaimDir);
    const repairedBeforeRetry = readExecutionClaimStore(root, "atomic-b");
    if (repairedBeforeRetry.ok) assert.equal(repairedBeforeRetry.value.at(-1)?.status, "released", "repair restores the pre-existing schema3 journal without an orphan claim");
    const retried = await dispatchCtoSpecificationMapping(root, { cto_run_id: RUN_ID, mapping_id: String(frozen.mapping_id), expected_mapping_hash: String(frozen.mapping_hash) }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(retried.status, "dispatched", detail(retried));
    assert.equal((retried.outcomes as Json[]).find((outcome) => outcome.feature_id === "atomic-a")?.status, "claimed");
    assert.equal((retried.outcomes as Json[]).find((outcome) => outcome.feature_id === "atomic-b")?.status, "claimed");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("split plan metadata hydrates state and migrates legacy execution rows", () => {
  const root = makeProject();
  try {
    const plan = { id: "MIGRATION-RUN", task: "legacy execution", teams: [{ team: "execution-team-1", team_def_id: "team-standard", scope: ["src"], slice: "slice-1", profile: "standard", worktree: "same_branch" as const, depends_on: [] }], created_at: new Date().toISOString() };
    const hydrated = newCtoState({ id: "MIGRATION-RUN", task: "legacy execution", branch: "main", autonomous: true, plan });
    assert.equal(hydrated.teams[0]!.team_def_id, "team-standard");
    hydrated.teams = [{ id: "execution-team-1", status: "pending", escalations: {}, slice_id: "slice-1", feature_id: "migration-feature", run_key: "run-migration-feature-1", task_id: "T-1", team_def_id: "team-standard" }];
    writeCtoState(hydrated, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const statePath = join(root, ".work-state", "cto", "MIGRATION-RUN", "state.json");
    const legacy = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    const legacyPlan = legacy.plan as Json;
    const legacyTeam = (legacyPlan.teams as Json[])[0]!;
    legacyTeam.team = "team-standard";
    delete legacyTeam.team_def_id;
    writeFileSync(statePath, JSON.stringify(legacy));
    const migrated = readCtoState("MIGRATION-RUN", root);
    assert.equal(migrated?.plan.teams[0]?.team, "execution-team-1");
    assert.equal(migrated?.plan.teams[0]?.team_def_id, "team-standard");
    const bytesBeforeRead = readFileSync(statePath);
    const normalized = readCtoState("MIGRATION-RUN", root);
    assert.equal(normalized?.plan.teams[0]?.team_def_id, "team-standard");
    assert.deepEqual(readFileSync(statePath), bytesBeforeRead, "legacy plan normalization must not rewrite authoritative bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("specification execution plan rows without TeamDef metadata are rejected", () => {
  const root = makeProject();
  try {
    const plan = { id: "SPEC-MISSING-DEF", task: "spec execution", teams: [{ team: "execution-team-1", scope: ["src"], slice: "slice-1", profile: "standard", worktree: "same_branch" as const, depends_on: [] }], created_at: new Date().toISOString() };
    const state = newCtoState({ id: "SPEC-MISSING-DEF", task: "spec execution", branch: "main", autonomous: true, plan });
    state.wave_history = [{ id: "wave-1", source: "specification-execution", source_id: "source-1", task: "spec execution", slice_ids: ["slice-1"], status: "active", started_at: new Date().toISOString() }];
    state.active_wave_id = "wave-1";
    state.teams = [{ id: "execution-team-1", status: "pending", escalations: {}, slice_id: "slice-1" }];
    const statePath = join(root, ".work-state", "cto", "SPEC-MISSING-DEF", "state.json");
    mkdirSync(join(root, ".work-state", "cto", "SPEC-MISSING-DEF"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
    assert.equal(readCtoState("SPEC-MISSING-DEF", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("preflight requires a nonterminal execution wave and rejects a preparation wave before persistence", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "wave-gate");
    const invoke = preflightCtoSpecificationExecutionForTest;
    const missing = await invoke(root, { cto_run_id: RUN_ID, selections: [selection("wave-gate")] }) as Result;
    assert.equal(missing.status, "blocked");
    ensureExecutionContext(root);
    const statePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Json;
    (state.wave_history as Json[])[0]!.source = "specification-preparation";
    writeFileSync(statePath, JSON.stringify(state));
    const preparation = await invoke(root, { cto_run_id: RUN_ID, selections: [selection("wave-gate")] }) as Result;
    assert.equal(preparation.status, "blocked");
    assert.match(detail(preparation), /execution wave|preparation/i);
    assert.equal(readdirSync(join(root, ".work-state", "cto", RUN_ID)).includes("specification-mappings"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan validation rejects malformed arrays, duplicate teams, and invalid callback depths", async () => {
  const team = { id: "lead", name: "Lead", scope: ["src"], profile: "standard", lead: "lead-agent", roster: ["developer"] };
  assert.equal(buildTeamPlan({ id: "run", task: "t", teams: [{ team: "lead", scope: ["src"], slice: "slice-1", profile: "standard" }, { team: "lead", scope: ["src"], slice: "slice-2", profile: "standard" }] }, { lead: team }).ok, false);
  const built = buildTeamPlan({ id: "run", task: "t", teams: [{ team: "lead", scope: ["src"], slice: "slice-1", profile: "standard" }] }, { lead: team });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(validateDecompositionDepth(built.plan, () => Number.NaN).ok, false);
  assert.equal(validateDecompositionDepth(built.plan, () => -1).ok, false);
  const malformed = buildTeamPlan({ id: "run", task: "t", teams: [{ team: "lead", scope: null as unknown as string[], slice: "slice-1", profile: "standard" }] }, { lead: team });
  assert.equal(malformed.ok, false);
  const unsafeExecutionId = buildTeamPlan({ id: "run", task: "t", teams: [{ team: "../escape", team_def_id: "lead", scope: ["src"], slice: "slice-1", profile: "standard" }] }, { lead: team });
  assert.equal(unsafeExecutionId.ok, false, "unsafe execution team IDs must be rejected before plan publication");
});


test("mapping identities cannot collide through prefixes, colons, or concatenated feature/task pairs", async () => {
  const make = (featureId: string, taskId: string) => {
    const handoff = validImplementationHandoff({ featureId });
    handoff.tasks[0]!.task_id = taskId;
    handoff.verification[0]!.task_ids = [taskId];
    handoff.execution_choices = ["cto"];
    return handoff;
  };
  const mapped = buildCtoSpecificationMapping({ cto_run_id: RUN_ID, execution: { wave_id: "wave-1", capability_id: "cap-1", capability_epoch: "epoch-1", choice: "cto" }, selections: [
    { feature_id: "a-b", run_key: "r1", handoff: make("a-b", "c") },
    { feature_id: "a", run_key: "r2", handoff: make("a", "b-c") },
    { feature_id: "team-feature", run_key: "r3", handoff: make("team-feature", "T:1") },
  ] });
  assert.equal(new Set(mapped.task_to_slice.map((owner) => owner.slice_id)).size, 3);
  assert.equal(new Set(mapped.task_to_slice.map((owner) => owner.team_id)).size, 3);
  assert.ok(mapped.task_to_slice.every((owner) => /^[a-z0-9-]+$/.test(owner.slice_id)));
  for (const contract of mapped.shared_contracts) for (const identity of contract.task_ids) {
    const parsed = JSON.parse(identity) as Json;
    assert.equal(typeof parsed.feature_id, "string");
    assert.equal(typeof parsed.task_id, "string");
  }
});


test("handoff must explicitly authorize CTO execution", async () => {
  const root = makeProject();
  try {
    writeFeature(root, "do-work-only");
    rewriteHandoff(root, "do-work-only", (handoff) => { handoff.execution_choices = ["do-work"]; });
    const result = await preflight(root, [selection("do-work-only")]);
    assert.equal(result.status, "blocked");
    assert.match(detail(result), /CTO execution|authorize|allow/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("official CTO completion envelope completes every selected feature and replays exactly", async () => {
  const root = makeProject();
  try {
    writeParallelFeatures(root, ["completion-feature-a", "completion-feature-b"]);
    const frozen = mapping(await preflight(root, [selection("completion-feature-a"), selection("completion-feature-b")]));
    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    completeMountedCtoExecutionTeams(root);
    await produceCtoCompletionConformance(root, dispatched.mapping!, dispatched.conformance_binding!);
    const mappingDigest = String(dispatched.mapping_digest);
    const envelopes = ["completion-feature-a", "completion-feature-b"].map((featureId) =>
      prepareCtoCompletionEnvelope(root, featureId, `run-${featureId}-1`, dispatched.mapping!, mappingDigest));
    for (const envelope of envelopes) {
      const completed = completeCtoSpecificationExecutionForTest(root, envelope);
      assert.equal(completed.ok, true, completed.ok ? "" : completed.error);
      if (completed.ok) assert.equal(completed.workspace.status, "completed");
    }
    for (const envelope of envelopes) {
      const replay = completeCtoSpecificationExecutionForTest(root, envelope);
      assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
      if (replay.ok) assert.equal(replay.replayed, true);
    }
    for (const featureId of ["completion-feature-a", "completion-feature-b"]) {
      const selected = resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` });
      assert.equal(selected.state?.specification?.status, "completed");
    }
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});
test("CTO task receipts bind exact dispatches across multi-task terminal replay", async () => {
  const root = makeProject();
  const featureId = "multi-task-receipts";
  try {
    writeFeature(root, featureId);
    rewriteHandoff(root, featureId, (handoff) => {
      const firstTask = (handoff.tasks as Json[])[0]!;
      handoff.tasks = [firstTask, { ...firstTask, task_id: "T-2" }];
    });
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const before = readCtoState(RUN_ID, root);
    assert.equal(before?.teams.length, 2, "multi-task fixture must admit both task rows");
    completeMountedCtoExecutionTeams(root);
    const terminal = readCtoState(RUN_ID, root);
    assert.ok(terminal?.teams.every((team) => team.status === "done" && team.pending === undefined), "both terminal teams must clear pending provider lifecycle");
    if (!terminal) throw new Error("multi-task receipt fixture state disappeared after host results");
    const receipts = terminal.teams.map((team) => {
      assert.ok(team.feature_id && team.run_key && team.work_identity, "terminal task must retain exact receipt selectors");
      if (!team.feature_id || !team.run_key || !team.work_identity) throw new Error("terminal task identity is unavailable");
      const toolCallId = `completion-host-${team.slice_id}`;
      const receipt = readTrustedTaskResultReceipt(root, {
        feature_id: team.feature_id,
        run_key: team.run_key,
        cto_run_id: RUN_ID,
        dispatch_id: team.work_identity.dispatch_id,
        tool_call_id: toolCallId,
        provider_ref: `host-task:${toolCallId}`,
        expected_work_identity: team.work_identity,
      });
      assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.error);
      if (!receipt.ok) throw new Error(receipt.error);
      return receipt.receipt;
    });
    assert.equal(new Set(receipts.map((receipt) => receipt.dispatch_id)).size, 2, "each task must have a distinct terminal receipt dispatch");
    const crossDispatch = verifyTrustedTaskResultReceipt(root, receipts[0]!, {
      feature_id: receipts[0]!.feature_id,
      run_key: receipts[0]!.run_key,
      cto_run_id: RUN_ID,
      dispatch_id: receipts[1]!.dispatch_id,
    });
    assert.equal(crossDispatch.ok, false, "a receipt must not replay against a sibling task dispatch");
    if (!crossDispatch.ok) assert.match(crossDispatch.error, /selector binding|dispatch/i);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    testRuntimeFixtures.get(`${root}\0${DEFAULT_TEST_SESSION_ID}`)?.close();
    testRuntimeFixtures.delete(`${root}\0${DEFAULT_TEST_SESSION_ID}`);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO completion refuses nested runtime recovery before appending a terminal claim", async () => {
  const root = makeProject();
  try {
    const featureId = "nested-recovery";
    writeParallelFeatures(root, [featureId]);
    const frozen = mapping(await preflight(root, [selection(featureId)]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    await produceCtoCompletionConformance(root, dispatched.mapping!, dispatched.conformance_binding!);
    const mappingDigest = String(dispatched.mapping_digest);
    const envelope = prepareCtoCompletionEnvelope(root, featureId, `run-${featureId}-1`, dispatched.mapping!, mappingDigest);
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    let injected = false;
    setExecutionClaimCompletionTestHooks({
      afterWorkspaceCasBeforeJournalAppend: ({ feature_id }) => {
        if (feature_id !== featureId || injected) return;
        injected = true;
        throw new Error("simulated crash after completed workspace CAS");
      },
    }, root);
    const firstAttempt = mountedDetails(await finalizer.execute("nested-runtime-crash", envelope, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(firstAttempt.ok, false, detail(firstAttempt));
    setExecutionClaimCompletionTestHooks(null, root);
    const historyBefore = readExecutionClaimStore(root, featureId);
    assert.equal(historyBefore.ok, true, historyBefore.ok ? "" : historyBefore.error);
    if (!historyBefore.ok) return;
    assert.equal(historyBefore.value.at(-1)?.status, "active", "crash leaves the claim active before recovery");

    unlinkSync(join(root, ".work-state", "features", featureId, "artifacts", `runtime_test_evidence-${featureId}.json`));
    const retry = mountedDetails(await finalizer.execute("nested-runtime-recovery", envelope, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(retry.ok, false, detail(retry));
    assert.match(detail(retry), /runtime|artifact|evidence|canonical/i);
    const historyAfter = readExecutionClaimStore(root, featureId);
    assert.equal(historyAfter.ok, true, historyAfter.ok ? "" : historyAfter.error);
    if (historyAfter.ok) {
      assert.deepEqual(historyAfter.value, historyBefore.value, "invalid nested evidence must not append a terminal claim");
      assert.equal(historyAfter.value.at(-1)?.status, "active");
    }
    assert.equal(resolveState(root, undefined, { feature_id: featureId, run_key: `run-${featureId}-1` }).state?.specification?.status, "completed", "the crash-created workspace state remains unchanged while claim recovery is blocked");
  } finally {
    setExecutionClaimCompletionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO completion rejects an oversized mapping record before any terminal mutation", async () => {
  const root = makeProject();
  try {
    writeParallelFeatures(root, ["oversized-completion"]);
    const frozenResult = await preflight(root, [selection("oversized-completion")]);
    assert.equal(frozenResult.status, "ready", detail(frozenResult));
    const frozen = mapping(frozenResult);
    const confirmed = await confirmTrusted(root, frozen);
    assert.equal(confirmed.status, "confirmed", detail(confirmed));
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    await produceCtoCompletionConformance(root, dispatched.mapping!, dispatched.conformance_binding!);
    const envelope = prepareCtoCompletionEnvelope(root, "oversized-completion", "run-oversized-completion-1", dispatched.mapping!, String(dispatched.mapping_digest));
    const mappingPath = join(root, ".work-state", "cto", RUN_ID, "specification-mappings", `${String(frozen.mapping_id)}.json`);
    writeFileSync(mappingPath, `${readFileSync(mappingPath, "utf8")}${" ".repeat(1024 * 1024)}`);
    const rejected = completeCtoSpecificationExecutionForTest(root, envelope);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.error, /mapping record.*(unreadable|limit|bound)/i);
    assert.notEqual(resolveState(root, undefined, { feature_id: "oversized-completion", run_key: "run-oversized-completion-1" }).state?.specification?.status, "completed");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO completion rejects stale, forged, and cross-feature envelopes without mutating terminal state", async () => {
  const root = makeProject();
  try {
    writeParallelFeatures(root, ["forged-completion-a", "forged-completion-b"]);
    const frozen = mapping(await preflight(root, [selection("forged-completion-a"), selection("forged-completion-b")]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    await produceCtoCompletionConformance(root, dispatched.mapping!, dispatched.conformance_binding!);
    const digest = String(dispatched.mapping_digest);
    const valid = prepareCtoCompletionEnvelope(root, "forged-completion-a", "run-forged-completion-a-1", dispatched.mapping!, digest);
    const stale = completeCtoSpecificationExecutionForTest(root, { ...valid, mapping_digest: "0".repeat(64) });
    assert.equal(stale.ok, false);
    const forged = completeCtoSpecificationExecutionForTest(root, { ...valid, owner_run_key: "foreign-cto-run" });
    assert.equal(forged.ok, false);
    const crossFeature = completeCtoSpecificationExecutionForTest(root, {
      ...valid,
      feature_id: "forged-completion-b",
      run_key: "run-forged-completion-b-1",
    } as never);
    assert.equal(crossFeature.ok, false);
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    const featureStatePath = join(root, ".work-state", "features", "forged-completion-a", "state.json");
    const ctoStatePath = join(root, ".work-state", "cto", RUN_ID, "state.json");
    const featureStateBefore = readFileSync(featureStatePath, "utf8");
    const claimsBefore = readExecutionClaimStore(root, "forged-completion-a");
    assert.equal(claimsBefore.ok, true, claimsBefore.ok ? "" : claimsBefore.error);
    const ctoStateBefore = readFileSync(ctoStatePath, "utf8");
    const waveId = String((dispatched.mapping!.execution as Json).wave_id);
    const identityTamperCases = [
      { label: "source-id", mutate: (ctoState: Json) => {
        const wave = (ctoState.wave_history as Json[]).find((candidate) => candidate.id === waveId);
        assert.ok(wave);
        wave.source_id = String(wave.source_id) + "-forged";
      } },
      { label: "work-identity", mutate: (ctoState: Json) => {
        const wave = (ctoState.wave_history as Json[]).find((candidate) => candidate.id === waveId);
        assert.ok(wave && wave.work_identity);
        wave.work_identity = { ...(wave.work_identity as Json), capability_epoch: "forged-capability-epoch" };
      } },
      { label: "orphan-active-wave", mutate: (ctoState: Json) => { ctoState.active_wave_id = "orphan-wave"; } },
    ];
    for (const testCase of identityTamperCases) {
      const forgedCtoState = JSON.parse(ctoStateBefore) as Json;
      testCase.mutate(forgedCtoState);
      writeFileSync(ctoStatePath, JSON.stringify(forgedCtoState) + String.fromCharCode(10), "utf8");
      const rejectedByFinalizer = mountedDetails(await finalizer.execute("forged-wave-" + testCase.label, valid, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
      assert.equal(rejectedByFinalizer.ok, false, testCase.label + " forged wave identity must be rejected: " + detail(rejectedByFinalizer));
      assert.equal(readFileSync(featureStatePath, "utf8"), featureStateBefore, testCase.label + " must not mutate feature workspace");
      const claimsAfter = readExecutionClaimStore(root, "forged-completion-a");
      assert.deepEqual(claimsAfter, claimsBefore, testCase.label + " must not mutate claim history");
      writeFileSync(ctoStatePath, ctoStateBefore, "utf8");
    }
    const acceptedByFinalizer = mountedDetails(await finalizer.execute("valid-mounted-completion", valid, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(acceptedByFinalizer.ok, true, detail(acceptedByFinalizer));
    const state = resolveState(root, undefined, { feature_id: "forged-completion-a", run_key: "run-forged-completion-a-1" });
    assert.equal(state.state?.specification?.status, "completed");
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO completion resumes deterministically after a crash following the first feature", async () => {
  const root = makeProject();
  try {
    writeParallelFeatures(root, ["resume-completion-a", "resume-completion-b"]);
    const frozen = mapping(await preflight(root, [selection("resume-completion-a"), selection("resume-completion-b")]));
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    await produceCtoCompletionConformance(root, dispatched.mapping!, dispatched.conformance_binding!);
    const digest = String(dispatched.mapping_digest);
    const envelopes = ["resume-completion-a", "resume-completion-b"].map((featureId) =>
      prepareCtoCompletionEnvelope(root, featureId, `run-${featureId}-1`, dispatched.mapping!, digest));
    const finalizer = publicWorkflowTool("workflow_complete_specification_execution", root);
    let injected = false;
    setExecutionClaimCompletionTestHooks({
      afterWorkspaceCasBeforeJournalAppend: ({ feature_id }) => {
        if (feature_id !== "resume-completion-a" || injected) return;
        injected = true;
        throw new Error("simulated crash after completed workspace CAS");
      },
    }, root);
    const firstAttempt = mountedDetails(await finalizer.execute("completion-crash", envelopes[0]!, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(firstAttempt.ok, false, detail(firstAttempt));
    assert.equal(resolveState(root, undefined, { feature_id: "resume-completion-a", run_key: "run-resume-completion-a-1" }).state?.specification?.status, "completed");
    setExecutionClaimCompletionTestHooks(null, root);
    const forgedRecovery = mountedDetails(await finalizer.execute("completion-forged-recovery", { ...envelopes[0]!, owner_run_key: "foreign-cto-run" }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(forgedRecovery.ok, false, detail(forgedRecovery));
    const splitHistory = readExecutionClaimStore(root, "resume-completion-a");
    assert.equal(splitHistory.ok, true, splitHistory.ok ? "" : splitHistory.error);
    if (splitHistory.ok) assert.equal(splitHistory.value.at(-1)?.status, "active", "unauthenticated recovery must not append a terminal claim");
    const recovered = mountedDetails(await finalizer.execute("completion-retry", envelopes[0]!, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(recovered.ok, true, detail(recovered));
    assert.equal(resolveState(root, undefined, { feature_id: "resume-completion-a", run_key: "run-resume-completion-a-1" }).state?.specification?.status, "completed");
    assert.equal(resolveState(root, undefined, { feature_id: "resume-completion-b", run_key: "run-resume-completion-b-1" }).state?.specification?.status, "executing");
    const resumed = mountedDetails(await finalizer.execute("completion-resume", envelopes[1]!, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER }));
    assert.equal(resumed.ok, true, detail(resumed));
  } finally {
    setExecutionClaimCompletionTestHooks(null, root);
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("bound CTO worker task gate admits only the dispatched marker and current claim", async () => {
  const root = makeProject();
  try {
    const featureId = "bound-worker-gate";
    writeParallelFeatures(root, [featureId]);
    ensureExecutionContext(root);
    assert.ok(readCtoState(RUN_ID, root), "fixture must persist canonical CtoState before preflight");
    const preflightResult = await preflight(root, [selection(featureId)]);
    assert.ok(preflightResult.mapping, detail(preflightResult));
    const frozen = preflightResult.mapping as Json;
    assert.equal((await confirmTrusted(root, frozen)).status, "confirmed");
    const dispatched = await dispatchCtoSpecificationMapping(root, {
      cto_run_id: RUN_ID,
      mapping_id: String(frozen.mapping_id),
      expected_mapping_hash: String(frozen.mapping_hash),
    }, preparationRuntimeOptions(root)) as unknown as Result;
    assert.equal(dispatched.status, "dispatched", detail(dispatched));
    const ctoState = readCtoState(RUN_ID, root);
    assert.ok(ctoState, "dispatch must persist CTO state");
    if (!ctoState) throw new Error("dispatch did not persist CTO state");
    const team = ctoState.teams.find((candidate) => candidate.feature_id === featureId);
    assert.ok(team, "dispatch must persist a feature-bound team");
    if (!team) throw new Error("dispatch did not persist the feature-bound team");
    const marker = (runId: string, sliceId: string) => `<!-- omp-cto-slice run=${runId} slice=${sliceId} -->`;
    const event = { toolName: "task", input: { task: marker(RUN_ID, team.slice_id) } };
    const gate = (text: string) => ctoSliceTaskGate({ toolName: "task", input: { task: text } }, { cwd: root, sessionManager: TEST_SESSION_MANAGER });

    assert.equal(gate(marker(RUN_ID, team.slice_id)), undefined, "the exact dispatched marker and active claim must pass");
    const activeFeaturePath = join(root, ".work-state", ".active-feature");
    if (existsSync(activeFeaturePath)) unlinkSync(activeFeaturePath);
    assert.equal(existsSync(join(root, ".work-state", "team-state.json")), false, "isolated CTO execution has no legacy team state");
    assert.equal(existsSync(join(root, ".work-state", ".active-feature")), false, "isolated CTO execution has no active-feature pointer");
    assert.equal(classificationToolGate(event, { cwd: root, sessionManager: TEST_SESSION_MANAGER }), undefined, "classification gate admits a valid CTO marker without legacy state");
    assert.equal(dispatchGate(event, { cwd: root, sessionManager: TEST_SESSION_MANAGER }), undefined, "dispatch gate admits a valid CTO marker without legacy state");
    const malformedFeature = "malformed-active-feature";
    mkdirSync(join(root, ".work-state", "features", malformedFeature), { recursive: true });
    writeFileSync(join(root, ".work-state", "features", malformedFeature, "state.json"), "{ malformed");
    writeFileSync(join(root, ".work-state", ".active-feature"), `${malformedFeature}\n`);
    assert.equal(classificationToolGate(event, { cwd: root, sessionManager: TEST_SESSION_MANAGER }), undefined, "classification gate must defer to strict CTO marker admission");
    assert.equal(dispatchGate(event, { cwd: root, sessionManager: TEST_SESSION_MANAGER }), undefined, "dispatch gate must defer to strict CTO marker admission");
    const forgedEvent = { toolName: "task", input: { task: marker(RUN_ID, `${team.slice_id}-forged`) } };
    assert.equal(classificationToolGate(forgedEvent, { cwd: root, sessionManager: TEST_SESSION_MANAGER })?.block, true, "classification gate rejects a forged CTO slice marker");
    assert.equal(dispatchGate(forgedEvent, { cwd: root, sessionManager: TEST_SESSION_MANAGER })?.block, true, "dispatch gate rejects a forged CTO slice marker");

    const mappingTeamTamper = readCtoState(RUN_ID, root);
    assert.ok(mappingTeamTamper, "mapping ownership tamper requires canonical state");
    if (mappingTeamTamper) {
      const forgedTeamId = `${team.id}-mapping-forged`;
      mappingTeamTamper.teams = mappingTeamTamper.teams.map((candidate) => candidate.id === team.id ? { ...candidate, id: forgedTeamId } : candidate);
      mappingTeamTamper.plan = { ...mappingTeamTamper.plan, teams: mappingTeamTamper.plan.teams.map((candidate) => candidate.slice === team.slice_id ? { ...candidate, team: forgedTeamId } : candidate) };
      writeCtoState(mappingTeamTamper, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
      const mappingTeamRejected = gate(marker(RUN_ID, team.slice_id));
      assert.equal(mappingTeamRejected?.block, true);
      assert.match(mappingTeamRejected?.reason ?? "", /confirmed task scope|mapping|bound/i);
      const restored = readCtoState(RUN_ID, root);
      assert.ok(restored, "mapping ownership tamper restore requires canonical state");
      if (restored) {
        restored.teams = restored.teams.map((candidate) => candidate.id === forgedTeamId ? { ...candidate, id: team.id } : candidate);
        restored.plan = { ...restored.plan, teams: restored.plan.teams.map((candidate) => candidate.slice === team.slice_id ? { ...candidate, team: team.id } : candidate) };
        writeCtoState(restored, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
      }
    }

    const claimedStatePath = join(root, ".work-state", "features", featureId, "state.json");
    const claimedState = JSON.parse(readFileSync(claimedStatePath, "utf8")) as Json;
    claimedState.state_revision = Number(claimedState.state_revision) + 1;
    writeFileSync(claimedStatePath, JSON.stringify(claimedState));
    const stalePostClaimRevision = gate(marker(RUN_ID, team.slice_id));
    assert.equal(stalePostClaimRevision?.block, true);
    assert.match(stalePostClaimRevision?.reason ?? "", /state revision is stale or mismatched/i);
    const staleClassification = classificationToolGate(event, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(staleClassification?.block, true);
    assert.match(staleClassification?.reason ?? "", /state revision is stale or mismatched/i);
    const staleDispatch = dispatchGate(event, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(staleDispatch?.block, true);
    assert.match(staleDispatch?.reason ?? "", /state revision is stale or mismatched/i);

    const forged = gate(marker(RUN_ID, `${team.slice_id}-forged`));
    assert.equal(forged?.block, true);
    assert.match(forged?.reason ?? "", /unknown slice|not uniquely admitted/i);

    const wrongRun = gate(marker("foreign-cto-run", team.slice_id));
    assert.equal(wrongRun?.block, true);
    assert.match(wrongRun?.reason ?? "", /no CtoState|run mismatch|cannot dispatch/i);

    const writeVariant = (mutate: (current: CtoState) => CtoState): void => {
      const current = readCtoState(RUN_ID, root);
      assert.ok(current, "variant mutation requires current CTO state");
      if (!current) throw new Error("variant mutation lost CTO state");
      writeCtoState(mutate(current), root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    };
    writeVariant(({ active_wave_id: _activeWaveId, ...current }) => ({ ...current, wave_history: current.wave_history?.map((wave) => ({ ...wave, status: "done" as const, finished_at: wave.finished_at ?? new Date().toISOString() })) }));
    const staleWave = gate(marker(RUN_ID, team.slice_id));
    assert.equal(staleWave?.block, true);
    assert.match(staleWave?.reason ?? "", /no active wave|not active/i);
    writeVariant((current) => ({ ...current, active_wave_id: ctoState.active_wave_id, wave_history: ctoState.wave_history }));

    writeVariant((current) => ({
      ...current,
      teams: current.teams.map((candidate) => candidate.slice_id === team.slice_id ? { ...candidate, feature_id: "foreign-feature" } : candidate),
    }));
    const wrongFeature = gate(marker(RUN_ID, team.slice_id));
    assert.equal(wrongFeature?.block, true);
    assert.match(wrongFeature?.reason ?? "", /claim|feature|binding/i);
    writeVariant((current) => ({ ...current, teams: ctoState.teams, active_wave_id: ctoState.active_wave_id, wave_history: ctoState.wave_history }));

    writeVariant(({ active_wave_id: _activeWaveId, ...current }) => ({ ...current, wave_history: current.wave_history?.map((wave) => ({ ...wave, status: "done" as const, finished_at: wave.finished_at ?? new Date().toISOString() })) }));
    const missingWave = gate(marker(RUN_ID, team.slice_id));
    assert.equal(missingWave?.block, true);
    assert.match(missingWave?.reason ?? "", /no active wave|not active/i);
  } finally {
    executionContexts.delete(root);
    projectFeatures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});


test("CTO host terminal receipts clear pending lifecycle for successful and failed team results", async () => {
  const cases = [
    { suffix: "success", isError: false, status: "done" as const },
    { suffix: "failure", isError: true, status: "failed" as const },
  ];
  for (const testCase of cases) {
    const root = makeProject();
    const featureId = `host-terminal-${testCase.suffix}`;
    const runId = RUN_ID;
    const sessionId = DEFAULT_TEST_SESSION_ID;
    const originalSessionId = TEST_SESSION_MANAGER.getSessionId;
    (TEST_SESSION_MANAGER as { getSessionId: () => string }).getSessionId = () => sessionId;
    try {
      writeFeature(root, featureId);
      const preflightResult = await preflight(root, [selection(featureId)]);
      assert.equal(preflightResult.status, "ready", detail(preflightResult));
      const frozen = mapping(preflightResult);
      const confirmation = await confirmTrusted(root, frozen);
      assert.equal(confirmation.status, "confirmed", detail(confirmation));
      const dispatched = await dispatchCtoSpecificationMapping(root, {
        cto_run_id: runId,
        mapping_id: String(frozen.mapping_id),
        expected_mapping_hash: String(frozen.mapping_hash),
      }, { sessionId, runtimeAccess: testRuntimeAccess(root, sessionId) }) as unknown as Result;
      assert.equal(dispatched.status, "dispatched", detail(dispatched));
      const dispatchedState = readCtoState(runId, root);
      assert.ok(dispatchedState, "host terminal proof requires a dispatched CTO state");
      if (!dispatchedState) continue;
      const team = dispatchedState.teams.find((candidate) => candidate.feature_id === featureId);
      assert.ok(team?.slice_id && team.work_identity, "dispatched team must carry an execution identity");
      if (!team?.slice_id || !team.work_identity) continue;
      const context = TEST_CONTEXT(root);
      const hooks = mountedTaskHooks(root, sessionId);
      const toolCallId = `host-call-${testCase.suffix}`;
      const marker = buildCtoSliceMarker(runId, team.slice_id);
      const call = await hooks.toolCall({ toolName: "task", toolCallId, input: { task: marker } }, context);
      assert.equal((call as Json | undefined)?.block, undefined, `exact CTO marker must be admitted by the mounted host: ${JSON.stringify(call)}`);
      await hooks.toolResult({ toolName: "task", toolCallId, isError: testCase.isError, content: [{ type: "text", text: testCase.isError ? "worker failed" : "worker completed" }] }, context);
      const terminal = readCtoState(runId, root);
      assert.ok(terminal, "host result reconciliation must leave a readable CTO state");
      if (!terminal) continue;
      const terminalTeam = terminal.teams.find((candidate) => candidate.id === team.id);
      assert.equal(terminalTeam?.status, testCase.status);
      assert.equal(terminalTeam?.pending, undefined, "terminal receipt must consume pending provider lifecycle");
      assert.deepEqual(terminalTeam?.completion_envelope?.identity, team.work_identity, "terminal evidence keeps the exact work identity");
      assert.equal(terminalTeam?.completion_envelope?.outcome, testCase.isError ? "failed" : "succeeded");
    } finally {
      TEST_SESSION_MANAGER.getSessionId = originalSessionId;
      executionContexts.delete(root);
      projectFeatures.delete(root);
      testRuntimeFixtures.get(`${root}\0${sessionId}`)?.close();
      testRuntimeFixtures.delete(`${root}\0${sessionId}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
